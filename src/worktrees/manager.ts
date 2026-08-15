import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hooksDir, worktreesDir, worktreePath } from '../core/paths.js';

export interface WorktreeInfo {
  name: string;
  path: string;
  branch: string;
}

export function assertGitRepo(projectRoot: string): void {
  const result = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`"${projectRoot}" is not inside a Git work tree`);
  }
}

export function createWorktree(projectRoot: string, name: string, sessionId?: string): WorktreeInfo {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (fs.existsSync(dir)) {
    throw new Error(`worktree "${name}" already exists at ${dir}`);
  }
  fs.mkdirSync(worktreesDir(projectRoot), { recursive: true });
  const branch = `flightdeck/${name}`;
  const result = spawnSync(
    'git',
    ['-C', projectRoot, 'worktree', 'add', '-b', branch, dir],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
  runPostCreateHooks(projectRoot, dir, sessionId);
  return { name, path: dir, branch };
}

export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  assertGitRepo(projectRoot);
  const result = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return [];
  const out: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> & { path?: string } = {};
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      let p = line.slice('worktree '.length);
      try {
        p = fs.realpathSync(p);
      } catch {
        // keep the raw path
      }
      current = { path: p };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line.trim() === '') {
      if (current.path) {
        let wtDir = worktreesDir(projectRoot);
        try {
          wtDir = fs.realpathSync(wtDir);
        } catch {
          // keep as-is
        }
        const rel = path.relative(wtDir, current.path);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
          out.push({ name: rel, path: current.path, branch: current.branch ?? '' });
        }
      }
      current = {};
    }
  }
  return out;
}

export function removeWorktree(projectRoot: string, name: string): void {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (!fs.existsSync(dir)) {
    throw new Error(`worktree "${name}" does not exist`);
  }
  const result = spawnSync('git', ['-C', projectRoot, 'worktree', 'remove', dir], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git worktree remove failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
}

export function runPostCreateHooks(projectRoot: string, worktreeDir: string, sessionId?: string): void {
  const dir = hooksDir(projectRoot);
  if (!fs.existsSync(dir)) return;
  const scripts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sh'))
    .sort((a, b) => a.localeCompare(b));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLIGHTDECK_WORKTREE: worktreeDir,
  };
  if (sessionId) env.FLIGHTDECK_SESSION = sessionId;
  for (const script of scripts) {
    const scriptPath = path.join(dir, script);
    const result = spawnSync('/bin/bash', [scriptPath], {
      cwd: worktreeDir,
      env,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `post-create hook "${script}" failed (exit ${result.status}): ${result.stderr?.trim() || result.stdout?.trim()}`
      );
    }
  }
}

export function ensureFlightdeckDirIgnored(projectRoot: string): void {
  assertGitRepo(projectRoot);
  const ignoreFile = path.join(projectRoot, '.gitignore');
  const rule = '.flightdeck/';
  let content = '';
  if (fs.existsSync(ignoreFile)) {
    content = fs.readFileSync(ignoreFile, 'utf8');
  }
  const lines = content.split('\n');
  if (!lines.some((l) => l.trim() === rule)) {
    fs.appendFileSync(ignoreFile, (content.endsWith('\n') ? '' : '\n') + rule + '\n');
  }
}

export function worktreeStatus(
  projectRoot: string,
  name: string
): {
  name: string;
  path: string;
  branch: string;
  clean: boolean;
  modified: string[];
  untracked: string[];
  ahead: number;
} {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (!fs.existsSync(dir)) throw new Error(`worktree "${name}" does not exist`);

  const branchRes = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const branch = branchRes.stdout?.trim() || `flightdeck/${name}`;

  const statusRes = spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  const lines = (statusRes.stdout || '').split('\n').filter((l) => l.trim().length > 0);

  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === '??') untracked.push(file);
    else modified.push(file);
  }

  let ahead = 0;
  const aheadRes = spawnSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD', '^main'], { encoding: 'utf8' });
  if (aheadRes.status === 0) {
    ahead = Number.parseInt(aheadRes.stdout.trim(), 10) || 0;
  }

  return {
    name,
    path: dir,
    branch,
    clean: modified.length === 0 && untracked.length === 0,
    modified,
    untracked,
    ahead,
  };
}

export function worktreeDiff(
  projectRoot: string,
  name: string,
  baseBranch = 'main'
): { name: string; branch: string; diff: string; filesChanged: number } {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (!fs.existsSync(dir)) throw new Error(`worktree "${name}" does not exist`);

  const branchRes = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const branch = branchRes.stdout?.trim() || `flightdeck/${name}`;

  let diffRes = spawnSync('git', ['-C', dir, 'diff', `${baseBranch}...HEAD`], { encoding: 'utf8' });
  if (diffRes.status !== 0 || !diffRes.stdout.trim()) {
    diffRes = spawnSync('git', ['-C', dir, 'diff', 'HEAD'], { encoding: 'utf8' });
  }

  const diff = diffRes.stdout || '';
  const fileCount = (diff.match(/^diff --git/gm) || []).length;

  return {
    name,
    branch,
    diff,
    filesChanged: fileCount,
  };
}

export function worktreeMerge(
  projectRoot: string,
  name: string,
  opts: { targetBranch?: string; dryRun?: boolean } = {}
): { merged: boolean; output: string } {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (!fs.existsSync(dir)) throw new Error(`worktree "${name}" does not exist`);

  const target = opts.targetBranch ?? 'main';
  const branch = `flightdeck/${name}`;

  if (opts.dryRun) {
    const res = spawnSync('git', ['-C', projectRoot, 'merge-tree', '--write-tree', target, branch], {
      encoding: 'utf8',
    });
    return {
      merged: res.status === 0,
      output: res.status === 0 ? 'Dry-run merge succeeded without conflicts' : `Merge conflict: ${res.stderr || res.stdout}`,
    };
  }

  const checkoutRes = spawnSync('git', ['-C', projectRoot, 'checkout', target], { encoding: 'utf8' });
  if (checkoutRes.status !== 0) {
    throw new Error(`Failed to checkout target branch "${target}": ${checkoutRes.stderr}`);
  }

  const mergeRes = spawnSync('git', ['-C', projectRoot, 'merge', '--no-ff', '-m', `Merge worktree ${name}`, branch], {
    encoding: 'utf8',
  });

  return {
    merged: mergeRes.status === 0,
    output: mergeRes.status === 0 ? mergeRes.stdout : mergeRes.stderr || mergeRes.stdout,
  };
}

export function gitVersion(): string {
  try {
    return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return 'not found';
  }
}
