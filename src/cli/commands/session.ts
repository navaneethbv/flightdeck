import { Command } from 'commander';
import { projectRootOf, requireGitProject, printJson, handleError } from '../util.js';
import { SessionManager } from '../../sessions/manager.js';
import { getAdapter } from '../../sessions/harness.js';
import { isHarnessKind } from '../../core/types.js';
import { getDefaultHarness } from '../../core/config.js';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  worktreeStatus,
  worktreeDiff,
  worktreeMerge,
} from '../../worktrees/manager.js';
import type { Session } from '../../core/types.js';
import { exportSessionToFile } from '../../sessions/export.js';
import { followSessionLogs } from '../../sessions/stream.js';

export function registerSession(program: Command): void {
  const session = program
    .command('session')
    .description('Manage coding-agent sessions');

  session
    .command('start')
    .description('Start a session (interactive by default; --headless runs the agent non-interactively)')
    .argument('[name]', 'session name')
    .option('--harness <claude|codex|opencode|gemini>', 'harness to use')
    .option('--worktree <name>', 'run in an existing worktree')
    .option('--worktree-new <name>', 'create a new worktree and run in it')
    .option('--task <text>', 'task description')
    .option('--headless', 'run non-interactively')
    .option('--prompt <text>', 'prompt for headless mode')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (name: string | undefined, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        requireGitProject(projectRoot);
        const harness = opts.harness
          ? (opts.harness as string)
          : getDefaultHarness();
        if (!isHarnessKind(harness)) throw new Error(`unknown harness "${harness}"`);
        if (!getAdapter(harness).detect()) {
          throw new Error(`harness "${harness}" is not installed`);
        }
        const manager = new SessionManager(projectRoot);
        let worktree: string | null = null;
        let cwd = projectRoot;
        if (opts.worktreeNew) {
          const created = createWorktree(projectRoot, String(opts.worktreeNew));
          worktree = created.name;
          cwd = created.path;
        } else if (opts.worktree) {
          worktree = String(opts.worktree);
          cwd = `${projectRoot}/.flightdeck/worktrees/${worktree}`;
        }
        const sessionName = name ?? (worktree ? `session-${worktree}` : 'session');
        const sessionRec = manager.createSession({
          name: sessionName,
          harness,
          worktree,
          cwd,
          task: opts.task !== undefined ? String(opts.task) : null,
        });
        const started = await manager.startSession(sessionRec.id, {
          headless: opts.headless === true,
          prompt: opts.prompt !== undefined ? String(opts.prompt) : undefined,
          waitForExit: true,
        });
        if (opts.json) printJson(started);
        else {
          process.stdout.write(`session ${started.id} (${started.harness}) exited with status ${started.status}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('list')
    .description('List sessions')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const sessions = new SessionManager(projectRoot).list();
        if (opts.json) {
          printJson(sessions);
          return;
        }
        for (const s of sessions) {
          process.stdout.write(`${s.status.padEnd(8)} ${s.id.slice(0, 8)}  ${s.harness.padEnd(8)}  ${s.name}  ${s.worktree ?? '(root)'}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('stop')
    .description('Stop a running session')
    .argument('<id>', 'session id')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | boolean>) => {
      try {
        await new SessionManager(projectRootOf(opts.project as string | undefined)).stopSession(id);
        process.stdout.write(`stopped ${id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('restart')
    .description('Restart a session')
    .argument('<id>', 'session id')
    .option('--headless', 'run non-interactively')
    .option('--prompt <text>', 'prompt for headless mode')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (id: string, opts: Record<string, string | boolean>) => {
      try {
        const manager = new SessionManager(projectRootOf(opts.project as string | undefined));
        const sessionRec = await manager.restartSession(id, {
          headless: opts.headless === true,
          prompt: opts.prompt !== undefined ? String(opts.prompt) : undefined,
        });
        if (opts.json) printJson(sessionRec);
        else process.stdout.write(`session ${id} restarted (${sessionRec.status})\n`);
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('logs')
    .description('View recent session logs')
    .argument('<id>', 'session id')
    .option('--tail <n>', 'number of lines to tail', '100')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const manager = new SessionManager(projectRootOf(opts.project as string | undefined));
        const logs = manager.getLogs(id, Number.parseInt(String(opts.tail), 10) || 100);
        if (logs) {
          const suffix = logs.endsWith('\n') ? '' : '\n';
          process.stdout.write(logs + suffix);
        } else {
          process.stdout.write('no logs found\n');
        }
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('follow')
    .description('Follow session output logs in real-time (Spectator Mode)')
    .argument('<id>', 'session id')
    .option('--tail <n>', 'initial lines to tail', '50')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        process.stdout.write(`following logs for session ${id} (Ctrl+C to detach)...\n\n`);
        const handle = followSessionLogs(projectRoot, id, {
          tailLines: Number.parseInt(String(opts.tail), 10) || 50,
          onChunk: (chunk) => process.stdout.write(chunk),
          onExit: (status) => {
            process.stdout.write(`\n[session ${id} exited with status ${status}]\n`);
            process.exit(0);
          },
        });
        process.on('SIGINT', () => {
          handle.stop();
          process.stdout.write('\ndetached.\n');
          process.exit(0);
        });
      } catch (err) {
        handleError(err);
      }
    });

  session
    .command('export')
    .description('Export complete session state, logs, diffs, notes, and messages to a bundle')
    .argument('<id>', 'session id')
    .option('--out <file>', 'output JSON file path')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const result = exportSessionToFile(
          projectRoot,
          id,
          opts.out !== undefined ? String(opts.out) : undefined
        );
        if (opts.json) printJson(result);
        else process.stdout.write(`exported session ${id} to ${result.path}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

export function registerWorktree(program: Command): void {
  const wt = program.command('worktree').description('Manage isolated Git worktrees');

  wt.command('create')
    .description('Create a worktree and run post-create hooks')
    .argument('<name>', 'worktree name')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const info = createWorktree(projectRoot, name);
        if (opts.json) printJson(info);
        else process.stdout.write(`created worktree ${info.name} at ${info.path}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  wt.command('list')
    .description('List worktrees')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        requireGitProject(projectRoot);
        const list = listWorktrees(projectRoot);
        if (opts.json) {
          printJson(list);
          return;
        }
        for (const w of list) process.stdout.write(`${w.name.padEnd(24)} ${w.branch}  ${w.path}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  wt.command('status')
    .description('Show git status of a worktree')
    .argument('<name>', 'worktree name')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const status = worktreeStatus(projectRoot, name);
        if (opts.json) printJson(status);
        else {
          process.stdout.write(`worktree: ${status.name} [${status.branch}]\n`);
          process.stdout.write(`state: ${status.clean ? 'clean' : 'modified'} (${status.ahead} commits ahead)\n`);
          if (status.modified.length) process.stdout.write(`modified:\n  ${status.modified.join('\n  ')}\n`);
          if (status.untracked.length) process.stdout.write(`untracked:\n  ${status.untracked.join('\n  ')}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  wt.command('diff')
    .description('Show git diff of a worktree against the base branch')
    .argument('<name>', 'worktree name')
    .option('--base <branch>', 'base branch to compare against', 'main')
    .option('--project <path>', 'project root (default: current directory)')
    .action((name: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const diffRes = worktreeDiff(projectRoot, name, String(opts.base ?? 'main'));
        process.stdout.write(diffRes.diff || 'no changes\n');
      } catch (err) {
        handleError(err);
      }
    });

  wt.command('merge')
    .description('Merge worktree branch into the base branch')
    .argument('<name>', 'worktree name')
    .option('--target <branch>', 'target branch to merge into', 'main')
    .option('--dry-run', 'test merge without modifying repository state')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((name: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const mergeRes = worktreeMerge(projectRoot, name, {
          targetBranch: opts.target !== undefined ? String(opts.target) : 'main',
          dryRun: opts.dryRun === true,
        });
        if (opts.json) printJson(mergeRes);
        else process.stdout.write(`${mergeRes.merged ? 'ok' : 'FAILED'}: ${mergeRes.output}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  wt.command('remove')
    .description('Remove a worktree')
    .argument('<name>', 'worktree name')
    .option('--project <path>', 'project root (default: current directory)')
    .action((name: string, opts: Record<string, string | boolean>) => {
      try {
        removeWorktree(projectRootOf(opts.project as string | undefined), name);
        process.stdout.write(`removed worktree ${name}\n`);
      } catch (err) {
        handleError(err);
      }
    });
}

export function sessionToJson(session: Session): Session {
  return session;
}

export { parseSeconds } from '../util.js';
