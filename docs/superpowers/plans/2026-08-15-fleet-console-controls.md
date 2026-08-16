# Fleet Console Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the approved Fleet console as an operational control surface with selectable workers and tasks, claim, release, kill, task-backed worker spawn, and all five human overrides.

**Architecture:** A new `FleetActions` service becomes the shared action boundary for the Ink console and CLI commands.
The console owns only selection and input state.
Worker creation always claims the highest-priority dispatchable board task, so the action cannot create an untracked agent with no task semantics.

**Tech Stack:** TypeScript ESM, React 19, Ink 7, commander, tmux, vitest.

**Spec:** [docs/superpowers/specs/2026-08-15-fleet-window-design.md](../specs/2026-08-15-fleet-window-design.md)

## Global Constraints

- Complete `2026-08-15-orchestrator-contract-completion.md` first.
- Every console action must call the same service method as its CLI equivalent.
- The console must not shell out to `tmux` directly.
- `src/fleet/tmux.ts` remains the only tmux wrapper.
- A manual new-worker action always consumes one dispatchable task.
- A kill action must not silently lose task ownership or delete its worktree.
- Claimed sessions keep token usage and spend blank.
- Destructive keyboard actions require an explicit confirmation keystroke.
- Every list or detail CLI command supports `--json`.
- Keep console key handling independently testable without requiring a real tmux installation.
- Run `npm run build` before direct Vitest commands.
- Do not add native dependencies.
- Do not add co-author trailers to commits.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/fleet/actions.ts` | Shared claim, release, kill, spawn-next, and override operations. |
| `src/fleet/console-state.ts` | Pure selection, focus, and confirmation reducer for keyboard input. |
| `test/unit/fleet-actions.test.ts` | Shared action semantics against fake managers. |
| `test/unit/fleet-console-state.test.ts` | Keyboard and selection state without Ink or tmux. |

**Modified:**

| File | Responsibility |
| --- | --- |
| `src/argus/manager.ts` | Public `spawnNextWorker(argusId)` operation using normal dispatch rules. |
| `src/argus/board.ts` | Lookup helpers used by kill and console selection. |
| `src/fleet/manager.ts` | Stop a selected session without deciding task semantics. |
| `src/sessions/manager.ts` | Prevent a stopped headless child from overwriting a claimed session's state. |
| `src/server/index.ts` | Suppress stale spend in the dashboard projection while a session is claimed. |
| `src/web/public/app.js` | Render claimed state and blank spend. |
| `src/cli/commands/fleet.tsx` | Complete console UI and CLI equivalents. |
| `test/integration/fleet-claim.test.ts` | Real child-process claim and release state ordering. |
| `test/integration/web-server.test.ts` | Claimed dashboard projection. |
| `test/unit/fleet-manager.test.ts` | Stop delegation. |
| `test/e2e/fleet-cli.test.ts` | All CLI actions and JSON responses. |
| `test/e2e/fleet-tmux.test.ts` | Real tmux selection and pane stability smoke coverage. |
| `README.md` | Fleet command and key reference. |

**Dependency order:** Task 1 must land first.
Task 2 depends on Task 1.
Task 3 can be developed after Task 1 and before Task 2 is complete.
Task 4 depends on Tasks 1 through 3.

---

### Task 1: Stabilize claim state and define shared action semantics

**Files:**

- Create: `src/fleet/actions.ts`
- Create: `test/unit/fleet-actions.test.ts`
- Modify: `src/argus/manager.ts`
- Modify: `src/argus/board.ts`
- Modify: `src/fleet/manager.ts`
- Modify: `src/sessions/manager.ts`
- Modify: `src/server/index.ts`
- Modify: `src/web/public/app.js`
- Modify: `test/unit/fleet-manager.test.ts`
- Modify: `test/integration/fleet-claim.test.ts`
- Modify: `test/integration/web-server.test.ts`

**Interfaces:**

- Consumes: `FleetManager`, `ArgusManager`, `TaskBoard`, and `Override`.
- Produces: race-safe claim state, blank claimed spend, `FleetActions`, and `ArgusManager.spawnNextWorker(argusId)`.

- [ ] **Step 1: Reproduce claim and release state drift with a real child process**

Extend `test/integration/fleet-claim.test.ts` with a fake harness process that stays alive until `SIGTERM`.
Start it through `SessionManager.startSession`, claim it through a fake tmux runner, wait for the old child's `close` callback, and assert the database row remains `status: 'running'` with non-null `claimedAt`.

Add a release-without-resume case and assert the row becomes `status: 'stopped'`, `claimedAt: null`, and has a non-null `endedAt`.
Add a release-with-resume case and assert the row returns to `status: 'running'` with `claimedAt: null`.

- [ ] **Step 2: Reproduce stale spend in the dashboard projection**

Seed a claimed session with non-null telemetry and fetch `/api/state`.
Assert the public session keeps its claimed marker but returns `costUsd: null` while claimed.
Render that projection through the dashboard client and assert the card contains `CLAIMED` and an inert spend dash.

- [ ] **Step 3: Run focused claim tests and verify they fail**

Run:

```bash
npm run build
npx vitest run test/integration/fleet-claim.test.ts test/integration/web-server.test.ts
```

Expected: the old headless close callback can overwrite claimed status, release without resume leaves stale running state, and claimed telemetry remains visible.

- [ ] **Step 4: Make claim and release state ordering race-safe**

In the headless `finish` callback, update the terminal process status only when `claimed_at IS NULL`:

```sql
UPDATE sessions
SET status = ?, ended_at = ?, exit_code = ?, last_activity_at = ?
WHERE id = ? AND claimed_at IS NULL
```

This handles both event orders.
If `close` happens before claim records `claimed_at`, claim's final update restores running state.
If `close` happens afterward, the guarded finish update cannot overwrite the claimed row.

In `FleetManager.release`, atomically clear `claimed_at` and set `status = 'stopped'`, `pid = NULL`, `ended_at`, and `last_activity_at` before respawning the pane as a log follower.
When `--resume` is selected, let `restartSession` perform the later transition back to running.

- [ ] **Step 5: Suppress stale claimed spend at the server projection boundary**

When mapping dashboard sessions, return the stored telemetry for an unclaimed session.
For a claimed session, preserve model and progress but set token counters and `costUsd` to null in the public projection.
Do not overwrite the stored telemetry row because it remains valid historical data after release.
Render a `CLAIMED` badge in the session card and keep spend as the existing inert dash.

- [ ] **Step 6: Write failing action-semantic tests**

Test the service contract:

```typescript
expect(await actions.claim(worker.id)).toEqual({ action: 'claim', sessionId: worker.id });
expect(await actions.release(worker.id, true)).toEqual({ action: 'release', sessionId: worker.id, resumed: true });
expect(await actions.spawnNext(argus.id)).toMatchObject({ action: 'spawn', taskId: highPriority.id });
expect(board.get(highPriority.id)?.status).toBe('assigned');
```

Add kill assertions:

```typescript
const result = await actions.kill(worker.id);
expect(result).toMatchObject({ action: 'kill', sessionId: worker.id, taskId: task.id });
expect(sessions.get(worker.id)?.status).toBe('stopped');
expect(board.get(task.id)?.status).toBe('blocked');
expect(board.get(task.id)?.verdictReason).toContain('killed by human');
expect(fs.existsSync(worker.cwd)).toBe(true);
```

Add spawn rejection cases for no Argus row, no dispatchable task, and a full child limit.

- [ ] **Step 7: Run the focused action tests and verify they fail to import**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-actions.test.ts test/unit/fleet-manager.test.ts
```

Expected: `src/fleet/actions.ts` is missing and there is no public spawn-next operation.

- [ ] **Step 8: Add `spawnNextWorker` through the normal dispatcher path**

Refactor the existing private dispatch code so both the automatic pulse and manual action use one method.

```typescript
async spawnNextWorker(id: string): Promise<{ task: Task; session: Session }> {
  const argus = this.get(id);
  if (!argus) throw new Error(`argus "${id}" not found`);
  const active = this.children(argus).filter((child) => child.session?.status === 'running');
  if (active.length >= argus.childLimit) throw new Error('fleet is already at its child limit');
  const task = this.board.dispatchable(id)[0];
  if (!task) throw new Error('no dispatchable task is available');
  const harnesses = this.workerHarnessesFor(id);
  const sequence = this.children(argus).length + 1;
  const session = await this.spawnWorker(argus, task, harnesses[(sequence - 1) % harnesses.length], sequence);
  return { task, session };
}
```

Change `spawnWorker` to return the created `Session`.
Make automatic `dispatch()` call `spawnNextWorker()` until no slot or task remains.
Preserve dependency and priority ordering from `TaskBoard.dispatchable()`.

Add the helper used above:

```typescript
private workerHarnessesFor(id: string): WorkerHarness[] {
  const argus = this.get(id);
  if (!argus) throw new Error(`argus "${id}" not found`);
  return argus.workerHarnesses;
}
```

`WorkerHarness` and `Argus.workerHarnesses` come from the required runtime-readiness plan.

- [ ] **Step 9: Add a narrow stop operation to `FleetManager`**

```typescript
async stopWorker(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`session "${sessionId}" not found`);
  if (session.policy === 'brain' || session.policy === 'manager') {
    throw new Error(`session "${sessionId}" is not a worker`);
  }
  await this.sessions.stopSession(sessionId);
}
```

This method stops the process only.
It does not mutate tasks or remove the worktree.

- [ ] **Step 10: Implement `FleetActions` as the shared business boundary**

Use this public shape:

```typescript
export class FleetActions {
  constructor(
    projectRoot: string,
    deps?: {
      fleet?: FleetManager;
      argus?: ArgusManager;
      board?: TaskBoard;
      override?: Override;
    }
  );
  claim(sessionId: string): Promise<FleetActionResult>;
  release(sessionId: string, resume?: boolean): Promise<FleetActionResult>;
  kill(sessionId: string): Promise<FleetActionResult>;
  spawnNext(argusId: string): Promise<FleetActionResult>;
  accept(taskId: string, argusId: string): FleetActionResult;
  reject(taskId: string, reason: string, argusId: string): FleetActionResult;
  unblock(taskId: string, argusId: string): FleetActionResult;
  prioritize(taskId: string, argusId: string): FleetActionResult;
  forceReview(argusId: string): Promise<FleetActionResult>;
}
```

Define its stable return type in the same module:

```typescript
export interface FleetActionResult {
  action: 'claim' | 'release' | 'kill' | 'spawn' | 'accept' | 'reject' | 'unblock' | 'prioritize' | 'force-review';
  message: string;
  argusId?: string;
  sessionId?: string;
  taskId?: string | null;
  resumed?: boolean;
}
```

For `kill`, find an active task assigned to the session.
Stop the worker, block that task with `worker killed by human; inspect the preserved worktree before unblocking`, and write `human_kill` to `argus_progress`.
If there is no active task, stop the worker and return `taskId: null`.

Each method returns a plain JSON-serializable result with `action`, affected ids, and a human-readable `message`.

- [ ] **Step 11: Verify shared semantics**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-actions.test.ts test/unit/fleet-manager.test.ts test/unit/override.test.ts test/unit/board.test.ts test/integration/fleet-claim.test.ts test/integration/web-server.test.ts
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/fleet/actions.ts src/argus/manager.ts src/argus/board.ts src/fleet/manager.ts src/sessions/manager.ts src/server/index.ts src/web/public/app.js test/unit/fleet-actions.test.ts test/unit/fleet-manager.test.ts test/integration/fleet-claim.test.ts test/integration/web-server.test.ts
git commit -m "feat(fleet): stabilize claims and centralize fleet actions"
```

---

### Task 2: Add CLI equivalents for kill and task-backed worker spawn

**Files:**

- Modify: `src/cli/commands/fleet.tsx`
- Modify: `test/e2e/fleet-cli.test.ts`

**Interfaces:**

- Consumes: `FleetActions` from Task 1.
- Produces: `deck fleet kill`, `deck fleet worker start`, and existing commands routed through the shared service.

- [ ] **Step 1: Write failing CLI tests**

Add tests for:

```bash
deck fleet kill <session-id> --yes --json
deck fleet worker start --argus <argus-id> --json
deck fleet claim <session-id> --json
deck fleet release <session-id> --resume --json
deck fleet override accept <task-id> --argus <argus-id> --json
deck fleet override reject <task-id> "reason" --argus <argus-id> --json
deck fleet override unblock <task-id> --argus <argus-id> --json
deck fleet override prioritize <task-id> --argus <argus-id> --json
deck fleet override force-review --argus <argus-id> --json
```

Assert each JSON object has the same shape returned by `FleetActions`.
Assert `kill` without `--yes` refuses in a non-interactive test process.
Assert every override targets the explicit `--argus` id instead of silently selecting the newest fleet.

- [ ] **Step 2: Run the CLI tests and verify commands are absent or incomplete**

Run:

```bash
npm run build
npx vitest run test/e2e/fleet-cli.test.ts
```

Expected: kill and worker-start are unknown, existing actions lack JSON, and overrides implicitly use the newest Argus row.

- [ ] **Step 3: Route every existing action through `FleetActions`**

Remove direct construction of `FleetManager` and `Override` from action handlers except for read-only fleet status.
Add `--json` to claim, release, and every override.
Use `printJson(result)` for JSON mode and `console.log(result.message)` otherwise.

- [ ] **Step 4: Add explicit Argus selection**

Add `--argus <id>` to all task overrides and force-review.
If omitted, accept the only Argus row in the project.
If zero rows exist, fail.
If more than one row exists, fail with `multiple fleets exist; pass --argus <id>`.
Do not guess the newest row.

- [ ] **Step 5: Add kill and worker-start commands**

Register:

```typescript
fleet
  .command('kill <sessionId>')
  .description('Stop a worker and block its active task while preserving the worktree')
  .option('--yes', 'confirm the destructive action')
  .option('--json', 'output JSON');

const worker = fleet.command('worker').description('Manual worker controls');
worker
  .command('start')
  .description('Spawn one worker for the highest-priority dispatchable task')
  .requiredOption('--argus <id>', 'Argus fleet id')
  .option('--json', 'output JSON');
```

Require `--yes` for kill when stdin is not a TTY.
For an interactive terminal, use the repository's existing confirmation pattern rather than adding a new prompt utility.

- [ ] **Step 6: Verify CLI behavior**

Run:

```bash
npm run build
npx vitest run test/e2e/fleet-cli.test.ts test/e2e/orchestrator-cli.test.ts
```

Expected: every action passes and JSON is stable.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/fleet.tsx test/e2e/fleet-cli.test.ts
git commit -m "feat(cli): add complete fleet action commands"
```

---

### Task 3: Build a pure console selection and confirmation state machine

**Files:**

- Create: `src/fleet/console-state.ts`
- Create: `test/unit/fleet-console-state.test.ts`

**Interfaces:**

- Consumes: keyboard events plus current worker and task counts.
- Produces: a pure `reduceConsoleState(state, event, bounds)` function.

- [ ] **Step 1: Write failing reducer tests**

Use these types:

```typescript
export type ConsoleFocus = 'workers' | 'tasks';
export type PendingAction =
  | { kind: 'kill'; sessionId: string }
  | { kind: 'reject'; taskId: string }
  | null;

export interface FleetConsoleState {
  focus: ConsoleFocus;
  workerIndex: number;
  taskIndex: number;
  pendingAction: PendingAction;
  rejectReason: string;
}
```

Define bounds and effects so the reducer can stay pure while telling the Ink layer exactly which service call to make:

```typescript
export interface ConsoleBounds {
  argusId: string | null;
  workerIds: string[];
  taskIds: string[];
}

export type ConsoleEffect =
  | { kind: 'claim'; sessionId: string }
  | { kind: 'release'; sessionId: string; resume: boolean }
  | { kind: 'kill'; sessionId: string }
  | { kind: 'spawn'; argusId: string }
  | { kind: 'accept' | 'unblock' | 'prioritize'; taskId: string; argusId: string }
  | { kind: 'reject'; taskId: string; argusId: string; reason: string }
  | { kind: 'force-review'; argusId: string };

export interface ConsoleTransition {
  state: FleetConsoleState;
  effect: ConsoleEffect | null;
}
```

Test:

- Tab switches focus.
- Up and down clamp indexes to current list bounds.
- A list shrinking clamps a previously valid selection.
- `k` enters kill confirmation only with a selected worker.
- `y` confirms and `n` or Escape cancels.
- `x` enters reject-reason mode only with a selected task.
- Backspace edits the reason.
- Enter confirms only when the trimmed reason is non-empty.
- Unknown keys leave state unchanged.

Assert a confirmed action emits exactly one effect and clears `pendingAction` in the returned state.

- [ ] **Step 2: Run the new test and verify module-not-found failure**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-console-state.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the pure reducer**

Represent key input as a discriminated union rather than importing Ink into the reducer:

```typescript
export type ConsoleEvent =
  | { type: 'tab' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'action'; key: 'c' | 'r' | 'k' | 'n' | 'a' | 'x' | 'u' | 'p' | 'f' }
  | { type: 'text'; value: string }
  | { type: 'backspace' }
  | { type: 'confirm' }
  | { type: 'cancel' };
```

The reducer returns `ConsoleTransition`.
It must not call services, exit the process, or read SQLite.

- [ ] **Step 4: Verify reducer behavior**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-console-state.test.ts
```

Expected: all reducer tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/console-state.ts test/unit/fleet-console-state.test.ts
git commit -m "feat(fleet): add console selection state machine"
```

---

### Task 4: Finish the Ink console and real tmux acceptance

**Files:**

- Modify: `src/cli/commands/fleet.tsx`
- Modify: `test/e2e/fleet-cli.test.ts`
- Modify: `test/e2e/fleet-tmux.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: `FleetActions`, the pure console reducer, `ConsoleSnapshot`, and existing polling.
- Produces: every action required by the Fleet Window spec through a selectable terminal UI.

- [ ] **Step 1: Enrich the console snapshot with selectable task data**

Add:

```typescript
tasks: Task[];
blockedTasks: Task[];
reviewQueueDepth: number;
nextBudgetResetAt: number | null;
```

Sort tasks by status group, then priority descending, then creation time.
Do not discard full ids from state even when rendering short ids.
If multiple Argus fleets exist, display a clear error directing the user to the CLI with `--argus` until a fleet selector is designed.

- [ ] **Step 2: Render focus and selection visibly**

Render two selectable sections:

- Workers show status, name, harness, claim state, and a `>` marker for the selected row.
- Tasks show status, short id, title, attempts, priority, and a `>` marker for the selected row.

Render blocked tasks in red with their `verdictReason` on the following line.
Render review queue depth and budget reset time in the budget section.
Do not show `0` for unknown spend or reset time.

- [ ] **Step 3: Wire keys through the reducer and shared service**

Use this key map:

| Key | Action |
| --- | --- |
| `Tab` | Switch worker/task focus. |
| Up/Down | Move the current selection. |
| `c` | Claim selected worker. |
| `r` | Release selected worker without headless resume. |
| `R` | Release selected worker and resume headless. |
| `k` | Confirm, then kill selected worker and block its task. |
| `n` | Spawn a worker for the next dispatchable task. |
| `a` | Accept selected task. |
| `x` | Enter a reject reason, then reject selected task. |
| `u` | Unblock selected task. |
| `p` | Prioritize selected task. |
| `f` | Force review for the selected fleet. |
| `q` | Quit only when no confirmation or text input is active. |

Every handler calls one `FleetActions` method.
Disable repeat input while an async action is in flight.
After completion, show the returned message and let the next snapshot refresh authoritative state.

- [ ] **Step 4: Add console rendering coverage**

Export `FleetConsole` for tests.
Use Ink's test renderer or the smallest compatible renderer already available to send keys and inspect output.
If a new dev dependency is required, add only `ink-testing-library` and keep it in `devDependencies`.

Cover:

- Empty workers and tasks.
- Selection moving in both sections.
- Kill confirmation and cancellation.
- Reject reason entry.
- Service failure rendered as a visible error.
- A list shrinking during polling without an out-of-range crash.

- [ ] **Step 5: Extend real tmux E2E**

Under the existing tmux skip guard:

1. Create a Fleet tmux session.
2. Seed two worker sessions and two tasks.
3. Reconcile panes.
4. Send keys to the console pane with `tmux send-keys` to change selection.
5. Assert pane count and pane-session metadata remain stable.
6. Exercise one non-destructive action, such as prioritize, through the console.
7. Kill the disposable tmux session in cleanup.

Do not use a real model in this test.

- [ ] **Step 6: Update README key and command reference**

Document the exact key table and the new CLI equivalents.
Explain that `new worker` means dispatching the highest-priority ready task and that kill preserves the worktree while blocking the active task.

- [ ] **Step 7: Run every gate**

Run:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: every command exits zero.
The real tmux test runs where tmux is installed and skips cleanly elsewhere.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/fleet.tsx test/e2e/fleet-cli.test.ts test/e2e/fleet-tmux.test.ts README.md package.json package-lock.json
git commit -m "feat(fleet): finish interactive console controls"
```

---

## Acceptance Gate

The plan is complete only when all of the following are true:

- The console visibly selects workers and tasks.
- A claimed session remains running after the old headless process closes, and release without resume records it stopped.
- Claimed session spend renders blank while historical telemetry stays stored.
- Claim, release, kill, new worker, accept, reject, unblock, prioritize, and force-review all work from the console.
- Every console action has a CLI equivalent that calls the same `FleetActions` method.
- New worker consumes the highest-priority dispatchable task and respects dependencies and child limits.
- Kill blocks the active task and preserves its worktree.
- Destructive actions require confirmation.
- Multiple fleets never cause an implicit newest-row selection.
- Blocked tasks, review depth, budget tier, and next reset are visible without fabricated values.
- Unit, integration, CLI, and guarded real-tmux tests pass.
