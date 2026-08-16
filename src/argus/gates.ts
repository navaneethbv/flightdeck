import { spawnSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import type { GateResult } from '../core/types.js';

export interface GateCommands {
  test: string;
  lint: string;
}

const TAIL_LINES = 40;
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

export function gateCommandsFromConfig(): GateCommands {
  const { argus } = loadConfig();
  return { test: argus.gateTestCommand, lint: argus.gateLintCommand };
}

function tail(text: string): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.slice(-TAIL_LINES).join('\n');
}

/** Runs one gate command. An empty command is a skipped gate, reported as null. */
function runOne(cwd: string, command: string): { code: number | null; output: string } {
  if (command.trim() === '') return { code: null, output: '' };
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS,
    env: { ...process.env, CI: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // A timeout or spawn failure yields a null status; treat it as a gate failure
  // rather than a pass, so unverifiable work never reaches the brain.
  const code = result.status === null ? 1 : result.status;
  return { code, output };
}

/**
 * Tier 0 of review. Runs entirely in TypeScript and costs no brain tokens,
 * which is the point: objectively broken work must never reach a
 * rate-limited reviewer.
 */
export function runGates(worktreePath: string, cmds: GateCommands): GateResult {
  const testRun = runOne(worktreePath, cmds.test);
  const lintRun = runOne(worktreePath, cmds.lint);

  const failures: string[] = [];
  if (testRun.code !== null && testRun.code !== 0) failures.push(testRun.output);
  if (lintRun.code !== null && lintRun.code !== 0) failures.push(lintRun.output);

  return {
    testExitCode: testRun.code,
    lintExitCode: lintRun.code,
    failureTail: failures.length > 0 ? tail(failures.join('\n')) : '',
  };
}

/**
 * `git diff --stat` against HEAD, including untracked files. This is what the
 * brain sees instead of the diff itself at tier 1.
 */
export function computeDiffstat(worktreePath: string): string {
  const result = spawnSync('git', ['diff', '--stat', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}
