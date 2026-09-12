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

function parseWorktreePath(line: string): string {
  const p = line.slice('worktree '.length);
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function normalizeWorktreesDir(projectRoot: string): string {
  const dir = worktreesDir(projectRoot);
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function finalizeWorktreeEntry(
  current: Partial<WorktreeInfo> & { path?: string },
  wtDir: string,
  out: WorktreeInfo[]
): void {
  if (!current.path) return;
  const rel = path.relative(wtDir, current.path);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    out.push({ name: rel, path: current.path, branch: current.branch ?? '' });
  }
}

export function listWorktrees(projectRoot: string): WorktreeInfo[] {
  assertGitRepo(projectRoot);
  const result = spawnSync('git', ['-C', projectRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`git worktree list failed: ${result.stderr?.trim() || result.error?.message || 'unknown Git error'}`);
  const out: WorktreeInfo[] = [];
  const wtDir = normalizeWorktreesDir(projectRoot);
  let current: Partial<WorktreeInfo> & { path?: string } = {};

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: parseWorktreePath(line) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line.trim() === '') {
      finalizeWorktreeEntry(current, wtDir, out);
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

function inspectGit(dir: string, args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || 'unknown Git error'}`);
  }
  return result.stdout;
}

function defaultBase(projectRoot: string): string {
  const remote = spawnSync('git', ['-C', projectRoot, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (remote.status === 0) return remote.stdout.trim();
  for (const branch of ['main', 'master']) {
    const result = spawnSync('git', ['-C', projectRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (result.status === 0) return branch;
  }
  return inspectGit(projectRoot, ['symbolic-ref', '--short', 'HEAD']).trim();
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
  const branch = inspectGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const entries = inspectGit(dir, ['status', '--porcelain', '-z']).split('\0');
  const modified: string[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === '??') untracked.push(file);
    else modified.push(file);
    // Porcelain -z supplies the source path as a second record for renames.
    if (code.includes('R') || code.includes('C')) index++;
  }
  const base = defaultBase(projectRoot);
  const ahead = Number(inspectGit(dir, ['rev-list', '--count', `HEAD`, `^${base}`, '--']).trim());
  return { name, path: dir, branch, clean: modified.length === 0 && untracked.length === 0, modified, untracked, ahead };
}

export function worktreeDiff(
  projectRoot: string,
  name: string,
  baseBranch?: string
): { name: string; branch: string; diff: string; filesChanged: number; base: string; comparison: string } {
  assertGitRepo(projectRoot);
  const dir = worktreePath(projectRoot, name);
  if (!fs.existsSync(dir)) throw new Error(`worktree "${name}" does not exist`);
  const branch = inspectGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const base = baseBranch ?? defaultBase(projectRoot);
  const mergeBase = inspectGit(dir, ['merge-base', '--', base, 'HEAD']).trim();
  // One comparison includes branch commits plus staged and unstaged changes.
  // Untracked files remain listed separately in worktreeStatus.
  const diff = inspectGit(dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', mergeBase, '--']);
  return {
    name,
    branch,
    diff,
    filesChanged: (diff.match(/^diff --git/gm) || []).length,
    base,
    comparison: `Tracked working tree compared with merge base of ${base} and HEAD (${mergeBase.slice(0, 12)}); untracked files listed separately`,
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
