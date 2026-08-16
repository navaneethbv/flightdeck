import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { FleetManager } from '../../fleet/manager.js';
import { FleetActions, type FleetActionResult } from '../../fleet/actions.js';
import { Tmux } from '../../fleet/tmux.js';
import { ArgusManager } from '../../argus/manager.js';
import { TaskBoard } from '../../argus/board.js';
import { budgetState } from '../../argus/budget.js';
import { TablesStore } from '../../tables/store.js';
import { reduceConsoleState, type ConsoleBounds, type ConsoleEffect, type FleetConsoleState } from '../../fleet/console-state.js';
import { projectRootOf, handleError, printJson, promptConfirm } from '../util.js';
import type { Task } from '../../core/types.js';

export interface ConsoleSnapshot {
  sessions: ReturnType<FleetManager['fleetSessions']>;
  argusId: string | null;
  tasks: Task[];
  reviewQueueDepth: number;
  nextBudgetResetAt: number | null;
  spent: number;
  ceiling: number;
  tier: string;
  progress: string[];
  fleetError: string | null;
  tick: number;
}

const TASK_ORDER: Record<string, number> = {
  assigned: 0,
  reported: 1,
  gating: 2,
  revising: 3,
  in_review: 4,
  pending: 5,
  done: 6,
  blocked: 7,
};

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      (TASK_ORDER[a.status] ?? 99) - (TASK_ORDER[b.status] ?? 99) ||
      (b.priority - a.priority) ||
      (a.createdAt - b.createdAt)
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function loadSnapshot(projectRoot: string): Omit<ConsoleSnapshot, 'tick'> {
  const fleet = new FleetManager(projectRoot);
  fleet.reconcile();
  const empty = {
    sessions: fleet.fleetSessions(),
    argusId: null,
    tasks: [] as Task[],
    reviewQueueDepth: 0,
    nextBudgetResetAt: null,
    spent: 0,
    ceiling: 0,
    tier: 'normal',
    progress: [] as string[],
    fleetError: null as string | null,
  };
  const fleets = new ArgusManager(projectRoot).list();
  if (fleets.length === 0) {
    return { ...empty, fleetError: 'no argus fleet exists in this project' };
  }
  if (fleets.length > 1) {
    return {
      ...empty,
      sessions: fleet.fleetSessions(),
      fleetError: 'multiple fleets exist; drive them from the CLI with --argus <id> until a fleet selector exists',
    };
  }
  const argus = fleets[0];
  const all = new TaskBoard(projectRoot).list(argus.id);
  const budget = budgetState(projectRoot, argus.id);
  const progress = new TablesStore(projectRoot)
    .query('argus_progress', { where: { argus_id: argus.id }, limit: 8 })
    .map((r) => {
      const event = typeof r.event === 'string' ? r.event : '';
      const detail = typeof r.detail === 'string' ? r.detail : '';
      return `${event} ${detail}`;
    });
  return {
    sessions: fleet.fleetSessions(),
    argusId: argus.id,
    tasks: sortTasks(all),
    reviewQueueDepth: budget.reviewQueueDepth,
    nextBudgetResetAt: budget.nextResetAt,
    spent: budget.spent,
    ceiling: budget.ceiling,
    tier: budget.tier,
    progress,
    fleetError: null,
  };
}

/** A zero-I/O placeholder shown for the single frame before the first real
 * snapshot loads, so the static section headers paint immediately instead of
 * waiting behind loadSnapshot's tmux subprocess calls and DB queries. */
function emptySnapshot(): Omit<ConsoleSnapshot, 'tick'> {
  return {
    sessions: [],
    argusId: null,
    tasks: [],
    reviewQueueDepth: 0,
    nextBudgetResetAt: null,
    spent: 0,
    ceiling: 0,
    tier: 'normal',
    progress: [],
    fleetError: null,
  };
}

function useConsoleSnapshot(projectRoot: string): ConsoleSnapshot {
  // The initial state does no I/O, so Ink's first frame paints immediately.
  // loadSnapshot() (several blocking tmux subprocess calls plus DB queries)
  // only ever runs inside the effect below, after that first paint, and on
  // its own 2 second cadence after that, never on every re-render.
  const [snap, setSnap] = useState<ConsoleSnapshot>(() => ({
    ...emptySnapshot(),
    tick: 0,
  }));

  useEffect(() => {
    const load = (): void => {
      try {
        setSnap((prev) => ({ ...loadSnapshot(projectRoot), tick: prev.tick + 1 }));
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

function initialState(): FleetConsoleState {
  return { focus: 'workers', workerIndex: 0, taskIndex: 0, pendingAction: null, rejectReason: '' };
}

function boundsOf(snap: ConsoleSnapshot): ConsoleBounds {
  return {
    argusId: snap.argusId,
    workerIds: snap.sessions.map((s) => s.id),
    taskIds: snap.tasks.map((t) => t.id),
  };
}

/** Renders the pending confirmation or reject-reason prompt, or null. */
function pendingPrompt(state: FleetConsoleState): string | null {
  if (state.pendingAction?.kind === 'kill') {
    return `Kill ${state.pendingAction.sessionId} and block its task?  [y] confirm  [n/Esc] cancel`;
  }
  if (state.pendingAction?.kind === 'reject') {
    return `Reject ${state.pendingAction.taskId}: ${state.rejectReason}  [Enter] confirm  [Esc] cancel`;
  }
  return null;
}

function taskStatusColor(status: Task['status']): string | undefined {
  if (status === 'blocked') return 'red';
  if (status === 'done') return 'dim';
  return undefined;
}

/**
 * The console as a pure view. All state and data arrive as props, so tests can
 * render any snapshot without a tmux session or a live fleet. The parent wires
 * the reducer and calls the returned effect through the shared FleetActions.
 */
export function FleetConsoleView({
  snap,
  state,
  message,
}: {
  readonly snap: ConsoleSnapshot;
  readonly state: FleetConsoleState;
  readonly message: string;
}): ReactElement {
  const countsLabel = Object.entries(
    snap.tasks.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {})
  )
    .map(([status, count]) => `${status}=${count}`)
    .join('  ');

  // The ceiling can be zero only for a corrupt row, and a zero-denominator
  // percentage would be fabricated, so the label renders blank instead.
  const spendLabel = snap.ceiling > 0
    ? `${snap.spent} / ${snap.ceiling} (${((snap.spent / snap.ceiling) * 100).toFixed(0)}%)`
    : '';

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{'flightdeck fleet  '}</Text>
        <Text dimColor>{'select with Tab/arrows  '}</Text>
      </Box>

      {snap.fleetError !== null && <Text color="red">{snap.fleetError}</Text>}

      <Text bold underline>Workers</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.sessions.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.sessions.map((s, i) => {
          const marker = state.focus === 'workers' && i === state.workerIndex ? '>' : ' ';
          const selected = state.focus === 'workers' && i === state.workerIndex;
          return (
            <Text key={s.id} color={selected ? 'white' : undefined}>
              <Text color={selected ? 'cyan' : 'dim'}>{marker}</Text>
              <Text color={s.status === 'running' ? 'green' : 'yellow'}>{` ${s.status.padEnd(8)}`}</Text>
              <Text>{` ${s.name.padEnd(20)} ${s.harness.padEnd(9)}`}</Text>
              {s.claimedAt !== null && <Text color="magenta">CLAIMED</Text>}
            </Text>
          );
        })}
      </Box>

      <Text bold underline>Tasks</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.tasks.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.tasks.map((t, i) => {
          const marker = state.focus === 'tasks' && i === state.taskIndex ? '>' : ' ';
          const selected = state.focus === 'tasks' && i === state.taskIndex;
          const attempts = t.attempts > 0 ? ` a${t.attempts}` : '';
          const priority = t.priority !== 0 ? ` p${t.priority}` : '';
          return (
            <Box key={t.id} flexDirection="column">
              <Text color={selected ? 'white' : undefined}>
                <Text color={selected ? 'cyan' : 'dim'}>{marker}</Text>
                <Text color={taskStatusColor(t.status)}>{` ${t.status.padEnd(9)}`}</Text>
                <Text>{` ${shortId(t.id)}  ${t.title}${attempts}${priority}`}</Text>
              </Text>
              {t.status === 'blocked' && t.verdictReason !== null && (
                <Text color="red" dimColor>{`   ${t.verdictReason}`}</Text>
              )}
            </Box>
          );
        })}
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

      <Text bold underline>Decisions</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.progress.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.progress.map((line, i) => (
          <Text key={`${line}-${i}`} dimColor>{`  ${line}`}</Text>
        ))}
      </Box>

      {message !== '' && <Text color="yellow">{message}</Text>}
      {pendingPrompt(state) !== null && <Text color="yellow">{pendingPrompt(state)}</Text>}
      {countsLabel !== '' && <Text dimColor>{countsLabel}</Text>}
      <Text dimColor>{`refresh #${snap.tick}  [c]laim [r]elease [R]esume [k]ill [n]ew [a]ccept [x]reject [u]nblock [p]rioritize [f]orce [q]uit`}</Text>
    </Box>
  );
}

type ActionKey = 'c' | 'r' | 'R' | 'k' | 'y' | 'n' | 'a' | 'x' | 'u' | 'p' | 'f';
const CONSOLE_ACTIONS = new Set<string>(['c', 'r', 'R', 'k', 'y', 'n', 'a', 'x', 'u', 'p', 'f']);

function eventFromKey(key: { tab?: boolean; upArrow?: boolean; downArrow?: boolean; escape?: boolean; return?: boolean; backspace?: boolean }): Parameters<typeof reduceConsoleState>[1] | null {
  if (key.tab) return { type: 'tab' };
  if (key.upArrow) return { type: 'up' };
  if (key.downArrow) return { type: 'down' };
  if (key.escape) return { type: 'cancel' };
  if (key.return) return { type: 'confirm' };
  if (key.backspace) return { type: 'backspace' };
  return null;
}

function resolveConsoleEvent(
  input: string,
  key: { tab?: boolean; upArrow?: boolean; downArrow?: boolean; escape?: boolean; return?: boolean; backspace?: boolean; ctrl?: boolean },
  pending: FleetConsoleState['pendingAction']
): Parameters<typeof reduceConsoleState>[1] | 'quit' | null {
  const keyEvent = eventFromKey(key);
  if (keyEvent) return keyEvent;
  if (input === 'q') return pending ? { type: 'cancel' } : 'quit';
  if (CONSOLE_ACTIONS.has(input)) return { type: 'action', key: input as ActionKey };
  if (pending?.kind === 'reject' && input.length > 0 && !key.ctrl) {
    return { type: 'text', value: input };
  }
  return null;
}

function FleetConsole({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const snap = useConsoleSnapshot(projectRoot);
  const [state, setState] = useState<FleetConsoleState>(initialState);
  const [message, setMessage] = useState('');
  const busyRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const snapRef = useRef(snap);
  snapRef.current = snap;

  const runEffect = useCallback((effect: ConsoleEffect) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const actions = new FleetActions(projectRoot);
    let promise: Promise<FleetActionResult>;
    switch (effect.kind) {
      case 'claim':
        promise = actions.claim(effect.sessionId);
        break;
      case 'release':
        promise = actions.release(effect.sessionId, effect.resume);
        break;
      case 'kill':
        promise = actions.kill(effect.sessionId);
        break;
      case 'spawn':
        promise = actions.spawnNext(effect.argusId);
        break;
      case 'accept':
        promise = Promise.resolve(actions.accept(effect.taskId, effect.argusId));
        break;
      case 'reject':
        promise = Promise.resolve(actions.reject(effect.taskId, effect.reason, effect.argusId));
        break;
      case 'unblock':
        promise = Promise.resolve(actions.unblock(effect.taskId, effect.argusId));
        break;
      case 'prioritize':
        promise = Promise.resolve(actions.prioritize(effect.taskId, effect.argusId));
        break;
      case 'force-review':
        promise = actions.forceReview(effect.argusId);
        break;
    }
    promise
      .then((r) => setMessage(r.message))
      .catch((err: Error) => setMessage(err.message))
      .finally(() => {
        busyRef.current = false;
      });
  }, [projectRoot]);

  useInput((input, key) => {
    const current = stateRef.current;
    const currentSnap = snapRef.current;
    const resolved = resolveConsoleEvent(input, key, current.pendingAction);
    if (!resolved) return;
    if (resolved === 'quit') process.exit(0);
    if (busyRef.current && resolved.type !== 'cancel') return;
    const { state: next, effect } = reduceConsoleState(current, resolved, boundsOf(currentSnap));
    setState(next);
    if (effect) runEffect(effect);
  });

  return (
    <FleetConsoleView
      snap={snap}
      state={state}
      message={message}
    />
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
          if (!process.stdin.isTTY) {
            throw new Error('refusing to kill without --yes in a non-interactive process');
          }
          const ok = await promptConfirm(
            `Kill ${sessionId} and block its active task? The worktree is preserved.`
          );
          if (!ok) {
            console.log('cancelled');
            return;
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
