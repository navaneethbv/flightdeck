import { Command } from 'commander';
import { HARNESSES } from '../../core/types.js';
import { adapters } from '../../sessions/harness.js';
import { gitVersion } from '../../worktrees/manager.js';
import { spawnSync } from 'node:child_process';
import { printJson, handleError, projectRootOf } from '../util.js';
import { repairProject } from '../../core/repair.js';

type Opts = Record<string, string | boolean | undefined>;

/**
 * tmux 3.0 introduced `respawn-pane -e`, which is how claim passes environment
 * without putting a session token in argv where `ps` would expose it. An older
 * tmux is reported as not usable rather than silently downgraded.
 */
function tmuxCheck(): { name: string; ok: boolean; detail: string } {
  // tmux is resolved through PATH by convention, and the argv is fixed, so
  // this is not attacker-controlled input.
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' }); // NOSONAR: S4036
  if (result.status !== 0 || !result.stdout) {
    return { name: 'tmux', ok: false, detail: 'not installed (only `deck fleet` needs it)' };
  }
  const version = result.stdout.trim();
  const major = Number(/tmux (\d+)/.exec(version)?.[1] ?? 0);
  if (major < 3) {
    return { name: 'tmux', ok: false, detail: `${version}, but 3.0 or newer is required` };
  }
  return { name: 'tmux', ok: true, detail: version };
}

function runDoctorChecks(root: string): { name: string; ok: boolean; detail: string }[] {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const git = gitVersion();
  checks.push({ name: 'git', ok: !git.includes('not found'), detail: git });
  for (const kind of HARNESSES) {
    const adapter = adapters[kind];
    const detected = adapter.detect();
    checks.push({ name: `harness:${kind}`, ok: detected, detail: detected ? `${adapter.binary} detected` : 'not installed' });
  }
  checks.push(tmuxCheck());
  const repo = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  const isRepo = repo.status === 0;
  checks.push({ name: 'git-repo', ok: isRepo, detail: isRepo ? root : 'current directory is not a git repo' });
  return checks;
}

function printDoctorResults(checks: { name: string; ok: boolean; detail: string }[], repair: ReturnType<typeof repairProject> | null): void {
  if (repair) {
    process.stdout.write(`repair: ${repair.ok ? 'success' : 'warnings'}\n`);
    for (const f of repair.fixed) process.stdout.write(`  [fixed] ${f}\n`);
    for (const w of repair.warnings) process.stdout.write(`  [warn]  ${w}\n`);
    process.stdout.write('\n');
  }
  for (const c of checks) {
    process.stdout.write(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(16)} ${c.detail}\n`);
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check the environment: harnesses, git, repo state')
    .option('--fix', 'automatically repair common project state issues')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const root = projectRootOf(opts.project as string | undefined);
        const repair = opts.fix ? repairProject(root) : null;
        const checks = runDoctorChecks(root);

        if (opts.json) {
          printJson({ ok: checks.every((c) => c.ok), checks, repair });
          return;
        }
        printDoctorResults(checks, repair);
        process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('repair')
    .description('Self-heal project directories, worktree references, and dead sessions')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const root = projectRootOf(opts.project as string | undefined);
        const result = repairProject(root);
        if (opts.json) {
          printJson(result);
          return;
        }
        process.stdout.write(`project repair: ${result.ok ? 'ok' : 'completed with warnings'}\n`);
        for (const f of result.fixed) process.stdout.write(`  [fixed] ${f}\n`);
        for (const w of result.warnings) process.stdout.write(`  [warn]  ${w}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}
