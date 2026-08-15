import path from 'node:path';
import { assertGitRepo } from '../worktrees/manager.js';
import { normalizeProjectRoot } from '../core/paths.js';

export function projectRootOf(projectPath?: string): string {
  return normalizeProjectRoot(path.resolve(projectPath ?? process.cwd()));
}

export function requireGitProject(projectRoot: string): void {
  assertGitRepo(projectRoot);
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function handleError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${message}\n`);
  process.exitCode = 1;
  throw err;
}

const DURATION_MULTIPLIERS: Record<string, number> = {
  h: 3600,
  m: 60,
  s: 1,
};

export function parseSeconds(value: string): number {
  const m = /^(\d+)([smh])?$/.exec(value);
  if (!m) throw new Error(`invalid duration "${value}" (use 30s, 5m, 2h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const multiplier = DURATION_MULTIPLIERS[unit] ?? 1;
  return n * multiplier;
}
