import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { useEffect, useState, type ReactElement } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { FleetManager } from '../../fleet/manager.js';
import { Tmux } from '../../fleet/tmux.js';
import { Override } from '../../argus/override.js';
import { ArgusManager } from '../../argus/manager.js';
import { TaskBoard } from '../../argus/board.js';
import { budgetState } from '../../argus/budget.js';
import { TablesStore } from '../../tables/store.js';
import { projectRootOf, handleError, printJson } from '../util.js';

interface ConsoleSnapshot {
  sessions: ReturnType<FleetManager['fleetSessions']>;
  argusId: string | null;
  counts: Record<string, number>;
  spent: number;
  ceiling: number;
  tier: string;
  progress: string[];
  tick: number;
}

function useConsoleSnapshot(projectRoot: string): ConsoleSnapshot {
  const [snap, setSnap] = useState<ConsoleSnapshot>({
    sessions: [], argusId: null, counts: {}, spent: 0, ceiling: 0, tier: 'normal', progress: [], tick: 0,
  });

  useEffect(() => {
    const load = (): void => {
      try {
        const fleet = new FleetManager(projectRoot);
        fleet.reconcile();
        const argus = new ArgusManager(projectRoot).list()[0] ?? null;
        const counts: Record<string, number> = {};
        let spent = 0;
        let ceiling = 0;
        let tier = 'normal';
        let progress: string[] = [];
        if (argus) {
          for (const task of new TaskBoard(projectRoot).list(argus.id)) {
            counts[task.status] = (counts[task.status] ?? 0) + 1;
          }
          const budget = budgetState(projectRoot, argus.id);
          spent = budget.spent;
          ceiling = budget.ceiling;
          tier = budget.tier;
          progress = new TablesStore(projectRoot)
            .query('argus_progress', { where: { argus_id: argus.id }, limit: 8 })
            .map((r) => `${String(r.event)} ${String(r.detail ?? '')}`);
        }
        setSnap((prev) => ({
          sessions: fleet.fleetSessions(),
          argusId: argus?.id ?? null,
          counts, spent, ceiling, tier, progress,
          tick: prev.tick + 1,
        }));
      } catch {
        // transient lock or missing tmux session; retry on the next tick
      }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [projectRoot]);

  return snap;
}

function FleetConsole({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const snap = useConsoleSnapshot(projectRoot);
  const [message, setMessage] = useState('');

  useInput((input) => {
    if (input === 'q') process.exit(0);
    if (input === 'f' && snap.argusId) {
      const manager = new ArgusManager(projectRoot);
      new Override(projectRoot)
        .forceReview(snap.argusId, manager)
        .then(() => setMessage('review drained'))
        .catch((err: Error) => setMessage(err.message));
    }
  });

  const countsLabel = Object.entries(snap.counts)
    .map(([status, count]) => `${status}=${count}`)
    .join('  ');

  // A claimed session reports no parseable usage, so its spend renders blank
  // rather than zero. Zero would be fabricated data.
  const spendLabel = snap.ceiling > 0
    ? `${snap.spent} / ${snap.ceiling} (${((snap.spent / snap.ceiling) * 100).toFixed(0)}%)`
    : '';

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{'flightdeck fleet  '}</Text>
        <Text dimColor>{projectRoot}</Text>
      </Box>

      <Text bold underline>Board</Text>
      <Box marginBottom={1}>
        {countsLabel === ''
          ? <Text dimColor>{'  (no tasks)'}</Text>
          : <Text>{`  ${countsLabel}`}</Text>}
      </Box>

      <Text bold underline>Brain budget</Text>
      <Box marginBottom={1}>
        <Text>{`  ${spendLabel}  `}</Text>
        <Text color={snap.tier === 'paused' ? 'red' : 'green'}>{snap.tier}</Text>
      </Box>

      <Text bold underline>Workers</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.sessions.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.sessions.map((s) => (
          <Text key={s.id}>
            <Text color={s.status === 'running' ? 'green' : 'yellow'}>{`  ${s.status.padEnd(8)}`}</Text>
            <Text>{`${s.name.padEnd(20)} ${s.harness.padEnd(9)}`}</Text>
            {s.claimedAt !== null && <Text color="magenta">CLAIMED</Text>}
          </Text>
        ))}
      </Box>

      <Text bold underline>Decisions</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.progress.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.progress.map((line, i) => (
          <Text key={`${line}-${i}`} dimColor>{`  ${line}`}</Text>
        ))}
      </Box>

      {message !== '' && <Text color="yellow">{message}</Text>}
      <Text dimColor>{`refresh #${snap.tick}  [f] force review  [q] quit`}</Text>
    </Box>
  );
}

function requireTmux(): void {
  if (!new Tmux().hasTmux()) {
    throw new Error('tmux is not installed or is older than 3.0; run `deck doctor` for details');
  }
}

export function registerFleet(program: Command): void {
  const fleet = program.command('fleet').description('tmux window onto a running fleet');

  fleet
    .command('console', { isDefault: false })
    .description('Interactive fleet control pane (runs inside a tmux pane)')
    .option('--project <path>', 'project root (default: current directory)')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        render(<FleetConsole projectRoot={projectRoot} />, { exitOnCtrlC: true });
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('status')
    .description('Show fleet panes and sessions')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new FleetManager(projectRoot);
        const payload = {
          tmux: new Tmux().hasTmux(),
          tmuxSession: manager.tmuxSessionName(),
          sessions: manager.fleetSessions(),
        };
        if (opts.json) {
          printJson(payload);
          return;
        }
        console.log(`tmux        ${payload.tmux ? 'available' : 'not installed'}`);
        console.log(`session     ${payload.tmuxSession}`);
        if (payload.sessions.length === 0) {
          console.log('(no sessions)');
          return;
        }
        for (const s of payload.sessions) {
          const claimed = s.claimedAt !== null ? '  CLAIMED' : '';
          console.log(`${s.status.padEnd(9)} ${s.name.padEnd(20)} ${s.harness}${claimed}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('claim <sessionId>')
    .description('Take over a worker in its pane')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new FleetManager(projectRoot).claim(sessionId);
        console.log(`claimed ${sessionId}`);
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('release <sessionId>')
    .description('End a claim and return the pane to following the log')
    .option('--resume', 'restart the worker headless after releasing')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new FleetManager(projectRoot).release(sessionId, { resume: Boolean(opts.resume) });
        console.log(`released ${sessionId}`);
      } catch (err) {
        handleError(err);
      }
    });

  const override = fleet.command('override').description('Human overrides of brain decisions');

  const withOverride = (
    name: string,
    description: string,
    run: (o: Override, taskId: string, argusId: string | undefined, extra: string) => void
  ): void => {
    override
      .command(`${name} <taskId> [reason]`)
      .description(description)
      .option('--project <path>', 'project root (default: current directory)')
      .action((taskId: string, reason: string | undefined, opts: Record<string, string | boolean>) => {
        try {
          const projectRoot = projectRootOf(opts.project as string | undefined);
          const argusId = new ArgusManager(projectRoot).list()[0]?.id;
          run(new Override(projectRoot), taskId, argusId, reason ?? '');
          console.log(`${name} ${taskId}`);
        } catch (err) {
          handleError(err);
        }
      });
  };

  withOverride('accept', 'Force a task to done', (o, id, argusId) => o.acceptTask(id, argusId));
  withOverride('reject', 'Force a task back to the worker', (o, id, argusId, reason) =>
    o.rejectTask(id, reason || 'rejected by human', argusId)
  );
  withOverride('unblock', 'Return a blocked task to pending', (o, id, argusId) => o.unblockTask(id, argusId));
  withOverride('prioritize', 'Dispatch a task first', (o, id, argusId) => o.prioritizeTask(id, argusId));

  // The console's [f] key must have a CLI equivalent: anything reachable from
  // a dashboard is reachable from the CLI.
  override
    .command('force-review')
    .description('Drain the review queue now, ignoring batching but not the budget ceiling')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new ArgusManager(projectRoot);
        const argus = manager.list()[0];
        if (!argus) throw new Error('no argus fleet exists in this project');
        await new Override(projectRoot).forceReview(argus.id, manager);
        console.log('review queue drained');
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .action((opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new FleetManager(projectRoot);
        manager.ensureSession();
        manager.reconcile();
        // Hand the terminal to tmux. Nothing is emulated: tmux owns the TTY.
        // Inside an existing tmux client, switch rather than attach; attaching
        // would refuse to nest and error out.
        const insideTmux = Boolean(process.env.TMUX);
        const result = spawnSync('tmux', manager.attachArgs(insideTmux), { stdio: 'inherit' });
        process.exitCode = result.status ?? 0;
      } catch (err) {
        handleError(err);
      }
    })
    .option('--project <path>', 'project root (default: current directory)');
}
