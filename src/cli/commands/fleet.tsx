import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { useEffect, useState, type ReactElement } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { FleetManager } from '../../fleet/manager.js';
import { FleetActions, type FleetActionResult } from '../../fleet/actions.js';
import { Tmux } from '../../fleet/tmux.js';
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
  reviewQueueDepth: number;
  nextBudgetResetAt: number | null;
  progress: string[];
  tick: number;
}

function useConsoleSnapshot(projectRoot: string): ConsoleSnapshot {
  const [snap, setSnap] = useState<ConsoleSnapshot>({
    sessions: [], argusId: null, counts: {}, spent: 0, ceiling: 0, tier: 'normal',
    reviewQueueDepth: 0, nextBudgetResetAt: null, progress: [], tick: 0,
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
        let reviewQueueDepth = 0;
        let nextBudgetResetAt: number | null = null;
        let progress: string[] = [];
        if (argus) {
          for (const task of new TaskBoard(projectRoot).list(argus.id)) {
            counts[task.status] = (counts[task.status] ?? 0) + 1;
          }
          const budget = budgetState(projectRoot, argus.id);
          spent = budget.spent;
          ceiling = budget.ceiling;
          tier = budget.tier;
          reviewQueueDepth = budget.reviewQueueDepth;
          nextBudgetResetAt = budget.nextResetAt;
          progress = new TablesStore(projectRoot)
            .query('argus_progress', { where: { argus_id: argus.id }, limit: 8 })
            .map((r) => {
              const event = typeof r.event === 'string' ? r.event : '';
              const detail = typeof r.detail === 'string' ? r.detail : '';
              return `${event} ${detail}`;
            });
        }
        setSnap((prev) => ({
          sessions: fleet.fleetSessions(),
          argusId: argus?.id ?? null,
          counts, spent, ceiling, tier, reviewQueueDepth, nextBudgetResetAt, progress,
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
      new FleetActions(projectRoot)
        .forceReview(snap.argusId)
        .then((r) => setMessage(r.message))
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
        <Text>{`  queued=${snap.reviewQueueDepth}`}</Text>
        {snap.nextBudgetResetAt !== null && (
          <Text>{`  next reset ${new Date(snap.nextBudgetResetAt).toLocaleTimeString()}`}</Text>
        )}
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

/**
 * Explicit Argus selection for task overrides. The newest fleet is never
 * guessed: zero fleets fail, and more than one fleet requires `--argus`.
 */
function resolveArgusId(projectRoot: string, argusId: string | undefined): string {
  if (argusId !== undefined) return argusId;
  const fleets = new ArgusManager(projectRoot).list();
  if (fleets.length === 0) throw new Error('no argus fleet exists in this project');
  if (fleets.length > 1) throw new Error('multiple fleets exist; pass --argus <id>');
  return fleets[0].id;
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
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const result = await new FleetActions(projectRoot).claim(sessionId);
        if (opts.json) printJson(result);
        else console.log(result.message);
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('release <sessionId>')
    .description('End a claim and return the pane to following the log')
    .option('--resume', 'restart the worker headless after releasing')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const result = await new FleetActions(projectRoot).release(sessionId, Boolean(opts.resume));
        if (opts.json) printJson(result);
        else console.log(result.message);
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('kill <sessionId>')
    .description('Stop a worker and block its active task while preserving the worktree')
    .option('--yes', 'confirm the destructive action')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        if (!opts.yes) {
          // In a non-interactive process there is no terminal to confirm on,
          // so the destructive action refuses without an explicit --yes.
          if (!process.stdin.isTTY) {
            throw new Error('refusing to kill without --yes in a non-interactive process');
          }
        }
        const result = await new FleetActions(projectRoot).kill(sessionId);
        if (opts.json) printJson(result);
        else console.log(result.message);
      } catch (err) {
        handleError(err);
      }
    });

  const worker = fleet.command('worker').description('Manual worker controls');
  worker
    .command('start')
    .description('Spawn one worker for the highest-priority dispatchable task')
    .requiredOption('--argus <id>', 'Argus fleet id')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const result = await new FleetActions(projectRoot).spawnNext(String(opts.argus));
        if (opts.json) printJson(result);
        else console.log(result.message);
      } catch (err) {
        handleError(err);
      }
    });

  const override = fleet.command('override').description('Human overrides of brain decisions');

  const withOverride = (
    name: string,
    description: string,
    run: (actions: FleetActions, taskId: string, argusId: string, extra: string) => FleetActionResult
  ): void => {
    override
      .command(`${name} <taskId> [reason]`)
      .description(description)
      .option('--argus <id>', 'Argus fleet id (required when more than one fleet exists)')
      .option('--json', 'output JSON')
      .option('--project <path>', 'project root (default: current directory)')
      .action((taskId: string, reason: string | undefined, opts: Record<string, string | boolean>) => {
        try {
          const projectRoot = projectRootOf(opts.project as string | undefined);
          const argusId = resolveArgusId(projectRoot, opts.argus as string | undefined);
          const result = run(new FleetActions(projectRoot), taskId, argusId, reason ?? '');
          if (opts.json) printJson(result);
          else console.log(result.message);
        } catch (err) {
          handleError(err);
        }
      });
  };

  withOverride('accept', 'Force a task to done', (a, id, argusId) => a.accept(id, argusId));
  withOverride('reject', 'Force a task back to the worker', (a, id, argusId, reason) =>
    a.reject(id, reason || 'rejected by human', argusId)
  );
  withOverride('unblock', 'Return a blocked task to pending', (a, id, argusId) => a.unblock(id, argusId));
  withOverride('prioritize', 'Dispatch a task first', (a, id, argusId) => a.prioritize(id, argusId));

  // The console's [f] key must have a CLI equivalent: anything reachable from
  // a dashboard is reachable from the CLI.
  override
    .command('force-review')
    .description('Drain the review queue now, ignoring batching but not the budget ceiling')
    .option('--argus <id>', 'Argus fleet id (required when more than one fleet exists)')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const argusId = resolveArgusId(projectRoot, opts.argus as string | undefined);
        const result = await new FleetActions(projectRoot).forceReview(argusId);
        if (opts.json) printJson(result);
        else console.log(result.message);
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
        // tmux is resolved through PATH by convention, and attachArgs is fixed
        // code, so this is not attacker-controlled input.
        const result = spawnSync('tmux', manager.attachArgs(insideTmux), { stdio: 'inherit' }); // NOSONAR: S4036
        process.exitCode = result.status ?? 0;
      } catch (err) {
        handleError(err);
      }
    })
    .option('--project <path>', 'project root (default: current directory)');
}
