import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProjectRoot, worktreesDir, hooksDir, notesDir, playbooksDir } from './paths.js';
import { getDb, now } from './state.js';
import { ensureFlightdeckDirIgnored } from '../worktrees/manager.js';

export interface RepairResult {
  ok: boolean;
  fixed: string[];
  warnings: string[];
}

export function repairProject(projectRoot: string): RepairResult {
  const root = normalizeProjectRoot(projectRoot);
  const fixed: string[] = [];
  const warnings: string[] = [];

  // 1. Ensure .gitignore has .flightdeck/
  try {
    ensureFlightdeckDirIgnored(root);
    fixed.push('verified .flightdeck/ in .gitignore');
  } catch (err) {
    warnings.push(`failed to update .gitignore: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Ensure project directories exist
  const dirs = [
    path.join(root, '.flightdeck'),
    notesDir(root),
    worktreesDir(root),
    playbooksDir(root),
    hooksDir(root),
    path.join(root, '.flightdeck', 'logs', 'sessions'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      fixed.push(`created directory ${path.relative(root, d)}`);
    }
  }

  // 3. Check SQLite integrity and cleanup stale running processes
  try {
    const db = getDb(root);
    const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    if (integrity && integrity.integrity_check !== 'ok') {
      warnings.push(`sqlite integrity issue: ${integrity.integrity_check}`);
    }

    const runningSessions = db
      .prepare("SELECT id, pid, status FROM sessions WHERE status = 'running'")
      .all() as { id: string; pid: number | null; status: string }[];

    for (const sess of runningSessions) {
      let isAlive = false;
      if (sess.pid) {
        try {
          process.kill(sess.pid, 0);
          isAlive = true;
        } catch {
          isAlive = false;
        }
      }
      if (!isAlive) {
        db.prepare(
          "UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?"
        ).run(now(), now(), sess.id);
        fixed.push(`repaired dead running session ${sess.id} (pid ${sess.pid ?? 'none'}) -> stopped`);
      }
    }
  } catch (err) {
    warnings.push(`database check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Prune git worktrees
  try {
    const pruneRes = spawnSync('git', ['-C', root, 'worktree', 'prune'], { encoding: 'utf8' });
    if (pruneRes.status === 0) {
      fixed.push('pruned stale git worktree references');
    }
  } catch {
    // git error
  }

  return {
    ok: warnings.length === 0,
    fixed,
    warnings,
  };
}
