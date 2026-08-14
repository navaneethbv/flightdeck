import { Command } from 'commander';
import { projectRootOf, printJson, handleError } from '../util.js';
import { WatchdogManager } from '../../watchdog/manager.js';

type Opts = Record<string, string | boolean | undefined>;

export function registerWatchdog(program: Command): void {
  const watchdog = program.command('watchdog').description('Monitor and supervise agent sessions');

  watchdog
    .command('list')
    .description('List hung or stuck sessions')
    .option('--timeout <seconds>', 'inactivity timeout in seconds', '300')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const timeout = parseInt(String(opts.timeout ?? '300'), 10) || 300;
        const hung = new WatchdogManager(projectRootOf(opts.project as string | undefined)).listHung(timeout);
        if (opts.json) printJson(hung);
        else {
          if (!hung.length) {
            process.stdout.write('no hung sessions detected\n');
            return;
          }
          for (const s of hung) {
            process.stdout.write(`[HUNG] ${s.id.slice(0, 8)} ${s.name} (${s.harness}) last active ${Math.floor((Date.now() - s.lastActivityAt) / 1000)}s ago\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  watchdog
    .command('inspect')
    .description('Inspect a session health, logs, and waiting prompts')
    .argument('<id>', 'session id')
    .option('--timeout <seconds>', 'inactivity timeout in seconds', '300')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const timeout = parseInt(String(opts.timeout ?? '300'), 10) || 300;
        const inspection = new WatchdogManager(projectRootOf(opts.project as string | undefined)).inspect(id, timeout);
        if (opts.json) printJson(inspection);
        else {
          process.stdout.write(`session: ${inspection.session.id} (${inspection.session.name})\n`);
          process.stdout.write(`status: ${inspection.session.status} | harness: ${inspection.session.harness}\n`);
          process.stdout.write(`last active: ${inspection.lastActiveSecAgo}s ago | stuck: ${inspection.isStuck ? 'YES' : 'no'}\n`);
          process.stdout.write(`prompt waiting: ${inspection.hasPrompt ? 'YES' : 'no'}\n`);
          if (inspection.recentLogs) {
            process.stdout.write(`\nrecent logs:\n${inspection.recentLogs}\n`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  watchdog
    .command('kill-hung')
    .description('Kill all hung sessions exceeding the inactivity timeout')
    .option('--timeout <seconds>', 'inactivity timeout in seconds', '300')
    .option('--project <path>', 'project root (default: current directory)')
    .option('--json', 'emit machine-readable output')
    .action(async (opts: Opts) => {
      try {
        const timeout = parseInt(String(opts.timeout ?? '300'), 10) || 300;
        const result = await new WatchdogManager(projectRootOf(opts.project as string | undefined)).killHung(timeout);
        if (opts.json) printJson(result);
        else {
          process.stdout.write(`killed ${result.killed.length} hung sessions\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
