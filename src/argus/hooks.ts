import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/logger.js';

function onEventHooksDir(projectRoot: string): string {
  return path.join(projectRoot, '.flightdeck', 'hooks', 'on-event');
}

/**
 * Runs every `.flightdeck/hooks/on-event/*.sh` script for one Argus progress
 * event, in sorted order, mirroring the existing post-create hook mechanism
 * in `src/worktrees/manager.ts`. Unlike a post-create hook, whose failure
 * legitimately blocks worktree creation, a broken alert script must never
 * take the scheduler down with it: every failure is caught and logged as a
 * warning, never thrown.
 */
export function runOnEventHooks(
  projectRoot: string,
  event: string,
  argusId: string,
  sessionId: string | null,
  detail: string
): void {
  const dir = onEventHooksDir(projectRoot);
  if (!fs.existsSync(dir)) return;
  let scripts: string[];
  try {
    scripts = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sh'))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    log.warn(`failed to list on-event hooks: ${(err as Error).message}`);
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLIGHTDECK_EVENT: event,
    FLIGHTDECK_ARGUS_ID: argusId,
    FLIGHTDECK_MESSAGE: detail,
  };
  if (sessionId) env.FLIGHTDECK_SESSION = sessionId;
  for (const script of scripts) {
    const scriptPath = path.join(dir, script);
    try {
      const result = spawnSync('/bin/bash', [scriptPath], { cwd: projectRoot, env, encoding: 'utf8' });
      if (result.status !== 0) {
        log.warn(
          `on-event hook "${script}" failed (exit ${result.status}): ${result.stderr?.trim() || result.stdout?.trim()}`
        );
      }
    } catch (err) {
      log.warn(`on-event hook "${script}" threw: ${(err as Error).message}`);
    }
  }
}
