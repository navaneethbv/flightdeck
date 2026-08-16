# Runtime Readiness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the test suite from spawning real, authenticated, auto-approving coding agents that outlive the run, then close the correctness gaps PR #18 left behind: a red CI job, an unbounded brain-call loop after a failed answer, review batching that never batches, a console that guesses which fleet it is driving, and a destructive kill with no confirmation.

**Architecture:** Every fix stays inside the boundaries PR #18 established.
A spawn-time guard makes it impossible for a test process, or any child process a test spawns, to execute a coding-agent binary that is not a fixture stub.
`ArgusManager.runForever` stops its children before it exits, so a signalled manager never orphans a fleet.
`QuestionQueue` gains a terminal state so the 250 ms scheduler cannot re-ask a question the brain already abandoned.
The task board records when a task entered the review queue, so budget batching measures the queue and not the mission plan.
`FleetActions` and the pure console reducer stay the only action boundary; the console gains the same explicit fleet selection the CLI already has.

**Tech Stack:** TypeScript ESM, `node:sqlite`, commander, React 19, Ink 7, tmux, vitest.

**Spec:** [docs/superpowers/specs/2026-08-15-orchestrator-brain-design.md](../specs/2026-08-15-orchestrator-brain-design.md) and [docs/superpowers/specs/2026-08-15-fleet-window-design.md](../specs/2026-08-15-fleet-window-design.md)

## Incident: the test suite spawned 79 real coding agents

This plan opens with a containment task because the review turned up an active incident, not a hypothetical.

**Observed, on this machine, at the time of review:**

- 79 live `opencode run --format json --print-logs --auto -- You are a coding agent working autonomously in an isolated git worktree...` processes, the oldest running for 11 hours 16 minutes, together holding 6834 CPU-seconds.
- 62 live fake-harness bash processes from `flightdeck-bin-*` fixture directories.
- Every one of them was spawned from a deleted test fixture (`/T/flightdeck-repo-*/.flightdeck/worktrees/...`), with worktree names `e2e-1-login`, `e2e-2-tests`, and `e2e-dashboard-2-short-name`.
- No parent `dist/cli/index.js` process remains: every manager exited and left its workers behind.

These are real, authenticated OpenCode agents. `profileEnv` only redirects a harness config directory when `profileDir` is configured, so each one inherited the developer's `HOME` and ran against real credentials. `--auto` is OpenCode's own "auto-approve permissions that are not explicitly denied (dangerous!)" flag. Their worktrees and `.flightdeck` state were deleted underneath them by `fixture.cleanup()`, so every `ask_manager` and `report_done` call fails and the agent retries, which is why they are still burning tokens hours later.

**The chain that produced them, each link verified in the code:**

1. `test/setup.ts` isolates `FLIGHTDECK_HOME` and nothing else. There is no PATH sandbox and no spawn guard, so whether a test executes a real coding agent depends entirely on the test author remembering to prepend a fake bin directory.
2. `makeFakeHarness` writes `echo "fake ${binName} ran with: $@"`, which echoes the argv, and the argv contains the brain prompt. `extractJson` ([brain.ts:101](../../../src/argus/brain.ts#L101)) deliberately takes the **last** balanced JSON object in the stream. The plan prompt embeds `{"tasks":[{"title":"short name","spec":"what to do and how to verify it","depends_on":[]}]}` as its format example ([manager.ts:391](../../../src/argus/manager.ts#L391)). So the echoing stub returns a schema-valid plan, and the leaked worktree named `e2e-dashboard-2-short-name` is that example task, dispatched for real.
3. `ArgusManager.dispatch()` then spawned workers with the default `workerHarnesses: ['opencode']`, resolving the real `/opt/homebrew/bin/opencode`, because nothing shadowed it.
4. `runForever`'s signal handler ([manager.ts:280](../../../src/argus/manager.ts#L280)) updates two database rows and calls `process.exit(0)`. It never calls `this.stop(id)`, which is the method that stops children. So SIGTERM to the manager orphans every worker it spawned. This is a production bug, not only a test bug: `Ctrl+C` on `deck argus start` leaks the whole fleet the same way.
5. Node does not reap grandchildren, vitest has no `globalTeardown`, and `fixture.cleanup()` only deletes directories. Nothing ever kills them.
6. `budgetState` sums only `policy = 'brain'` sessions, so worker spend is invisible to the budget and no ceiling could have stopped this.

The author hit this and patched one symptom rather than the cause: [test/e2e/dashboard.test.ts:497](../../../test/e2e/dashboard.test.ts#L497) now carries the comment "pin it to the fake claude so no real opencode process is spawned and then orphaned when the fixture is torn down". That fix protects exactly one test. Task 0 makes the class of failure impossible.

**Immediate operator action, before any code change:**

```bash
pkill -f 'opencode run --format json --print-logs --auto'
pkill -f 'flightdeck-bin-'
ps -eo pid,etime,command | grep -E 'opencode run|flightdeck-bin-' | grep -v grep
```

The third command must print nothing.

## Global Constraints

- Node 22.5 or newer is required.
- No test, and no process a test spawns, may execute a coding-agent binary outside a fixture stub directory.
- No process spawned by a test may outlive the test run.
- A manager that is signalled stops its children before it exits.
- Keep the existing inline SQLite migration pattern in `src/core/state.ts`; there is no migration directory.
- The brain is invoked only for planning, review, or an uncached worker question. A scheduler tick must never cause a repeat invocation of a call that already failed.
- Gates and dispatcher polling spend no model tokens.
- Unknown values stay null and render blank. Never fabricate a zero.
- Every console action calls the same `FleetActions` method as its CLI equivalent.
- Multiple Argus fleets never cause an implicit newest-row selection, in the CLI or the console.
- Destructive actions require an explicit confirmation.
- Run `npm run build` before direct Vitest commands: integration and e2e tests spawn `dist/cli/index.js`.
- Do not add native dependencies.
- Do not add co-author trailers to commits.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `test/global-teardown.ts` | Reap any harness process a test run left behind. |
| `test/unit/harness-spawn-guard.test.ts` | The real-binary spawn guard. |
| `test/unit/question-queue-failure.test.ts` | Terminal question state and pending-set exclusion. |
| `test/unit/prompt-confirm.test.ts` | The shared y/N confirmation helper. |

**Modified:**

| File | Responsibility |
| --- | --- |
| `src/sessions/manager.ts` | Refuse to spawn a real harness binary under the test guard. |
| `test/setup.ts` | Set the guard for every test process and its children. |
| `test/helpers.ts` | A fake harness that never echoes its argv. |
| `vitest.config.ts` | Register the global teardown. |
| `src/core/state.ts` | `questions.failed_at` and `tasks.review_queued_at` columns. |
| `src/core/types.ts` | `Question.failedAt` and `Task.reviewQueuedAt`. |
| `src/argus/questions.ts` | `markFailed()` and a `pending()` that excludes abandoned questions. |
| `src/argus/manager.ts` | Terminal answer failure, scheduler back-off, and queue-age measurement. |
| `src/argus/board.ts` | Stamp and clear `review_queued_at` on review-queue transitions. |
| `src/argus/budget.ts` | Measure `oldestReviewAgeSec` from queue entry. |
| `src/fleet/tmux.ts` | Optional explicit window size on `newSession`. |
| `src/fleet/console-state.ts` | Spawn without a selected worker; never act on a null fleet. |
| `src/cli/commands/fleet.tsx` | Explicit fleet selection in the console, TTY kill confirmation, dead-code removal. |
| `src/cli/commands/tools.ts` | Use the shared `promptConfirm`. |
| `src/cli/util.ts` | Export the shared `promptConfirm`. |
| `test/e2e/fleet-tmux.test.ts` | Deterministic pane geometry and diagnostic failure output. |
| `test/unit/tmux.test.ts` | `newSession` argv with and without a size. |
| `test/unit/fleet-console-state.test.ts` | Empty-worker spawn and null-fleet cases. |
| `test/unit/fleet-console-view.test.tsx` | Ambiguous-fleet rendering. |
| `test/unit/budget.test.ts` | Queue-age source. |
| `test/unit/board.test.ts` | `review_queued_at` transitions. |
| `test/integration/orchestration.test.ts` | Abandoned-question containment under repeated scheduler passes. |
| `README.md` | Correct the console fleet-selection and kill-confirmation description. |

**Dependency order:** Task 0 lands first and blocks everything else. Do not run the suite for any later task until Task 0 is committed.
Task 1 unblocks CI.
Task 2 is independent.
Task 3 is independent.
Task 4 precedes Task 5 (both touch `src/cli/commands/fleet.tsx`).
Task 6 depends on Tasks 0 through 5.

---

### Task 0: Make it impossible for a test to spawn a real coding agent

Four independent links had to hold for the incident above to happen. This task breaks all four, because breaking one leaves the class of failure alive.

**Files:**

- Modify: `src/sessions/manager.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/setup.ts`
- Modify: `test/helpers.ts`
- Modify: `test/unit/telemetry.test.ts`
- Create: `test/unit/harness-spawn-guard.test.ts`
- Create: `test/global-teardown.ts`
- Modify: `vitest.config.ts`

**Interfaces:**

- Consumes: `FLIGHTDECK_FORBID_REAL_HARNESS`, read at spawn time and inherited by every child process because `runCli` and `spawnCli` spread `process.env`.
- Produces: a spawn guard in `SessionManager.startSession`, a child-stopping shutdown in `ArgusManager.runForever`, a non-echoing `makeFakeHarness`, and a vitest global teardown.

- [ ] **Step 1: Write the failing guard test**

Create `test/unit/harness-spawn-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('real harness spawn guard', () => {
  it('refuses to start a session whose binary is not a fixture stub', async () => {
    const fixture = makeRepo();
    try {
      const sessions = new SessionManager(fixture.root);
      const session = sessions.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      // No stub on PATH: this would otherwise resolve the real binary.
      await expect(
        sessions.startSession(session.id, { headless: true, prompt: 'x', waitForExit: true })
      ).rejects.toThrow(/refusing to spawn the real "opencode" binary/);
    } finally {
      fixture.cleanup();
    }
  });

  it('allows a stub inside the temporary fixture directory', async () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const sessions = new SessionManager(fixture.root);
      const session = sessions.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      await expect(
        sessions.startSession(session.id, { headless: true, prompt: 'x', waitForExit: true })
      ).resolves.toBeDefined();
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it and watch the first case spawn a real agent**

```bash
npm run build
npx vitest run test/unit/harness-spawn-guard.test.ts
```

Expected: the first case fails because no guard exists. Before moving on, confirm with `ps -eo command | grep 'opencode run'` that the run left a real process behind, and kill it. That is the bug, reproduced deliberately and exactly once.

- [ ] **Step 3: Implement the guard at the single spawn site**

In `src/sessions/manager.ts`, above `startSession`:

```typescript
/**
 * Under test, a coding-agent binary may only be executed from a fixture stub
 * inside the OS temporary directory. Every fake harness in the suite is
 * created with `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, and no real
 * install lives there, so this is a precise rule with no false positives.
 *
 * The check lives here, at the one place a harness is ever spawned, and the
 * environment variable is inherited by child CLI processes. That matters:
 * the agents this guard exists to prevent were spawned by a child
 * `deck argus start`, which an in-process-only guard would never have seen.
 */
function assertHarnessSpawnAllowed(binary: string): void {
  if (process.env.FLIGHTDECK_FORBID_REAL_HARNESS !== '1') return;
  let resolved: string;
  try {
    resolved = execFileSync('which', [binary], { encoding: 'utf8' }).trim();
  } catch {
    return; // not resolvable at all; the spawn will fail on its own
  }
  const tmp = fs.realpathSync(os.tmpdir());
  if (!fs.realpathSync(resolved).startsWith(`${tmp}${path.sep}`)) {
    throw new Error(
      `refusing to spawn the real "${binary}" binary at ${resolved} from a test; ` +
        'create a fixture stub with makeFakeHarness and prepend its directory to PATH'
    );
  }
}
```

Call it as the first statement of `startSession` after the adapter is resolved:

```typescript
assertHarnessSpawnAllowed(adapter.binary);
```

Add the `os` and `execFileSync` imports if the file does not already have them.

- [ ] **Step 4: Turn the guard on for every test process**

Append to `test/setup.ts`:

```typescript
// No test, and no child process a test spawns, may execute a real coding
// agent. `runCli` and `spawnCli` spread `process.env`, so this reaches the
// child `deck argus start` processes that spawn workers.
process.env.FLIGHTDECK_FORBID_REAL_HARNESS = '1';
```

The opt-in live test at `test/e2e/argus-live.test.ts` genuinely needs real binaries. Give it the only exemption, inside its own `try`, and restore it in the `finally`:

```typescript
const previousGuard = process.env.FLIGHTDECK_FORBID_REAL_HARNESS;
delete process.env.FLIGHTDECK_FORBID_REAL_HARNESS;
// ... existing body ...
// in finally:
if (previousGuard !== undefined) process.env.FLIGHTDECK_FORBID_REAL_HARNESS = previousGuard;
```

- [ ] **Step 5: Stop the fake harness from echoing a valid plan**

In `test/helpers.ts`, replace the script in `makeFakeHarness`:

```typescript
export function makeFakeHarness(binName: string): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  // Never echo "$@". The argv carries the brain prompt, and that prompt
  // contains a JSON format example. `extractJson` takes the last balanced
  // JSON object in the stream, so echoing argv returns a schema-valid plan
  // and the manager dispatches real workers for a task nobody asked for.
  const script = `#!/bin/bash\necho "flightdeck fake ${binName}" >&2\nexit 0\n`;
  fs.writeFileSync(path.join(binDir, binName), script, { mode: 0o755 });
  return {
    binDir,
    cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }),
  };
}
```

Run the whole suite after this change. Any test that silently depended on the echoed plan will now fail honestly; fix each by having its stub print the exact JSON that test needs, never by restoring the echo.

- [ ] **Step 6: Move the one out-of-tmpdir stub**

`test/unit/telemetry.test.ts:371` creates its bin directory inside the repository (`path.join(import.meta.dirname, '..', '..', 'tmp-bin-')`), which the guard will reject. Change it to `fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'))` like every other fixture, and add the `os` import.

- [ ] **Step 7: Make a signalled manager stop its fleet**

In `src/argus/manager.ts`, `runForever`'s handler currently writes two rows and calls `process.exit(0)`, orphaning every worker. Replace it:

```typescript
let stopping = false;
const stop = (): void => {
  if (stopping) return; // a second signal must not race the first shutdown
  stopping = true;
  void (async () => {
    try {
      // Stops every child session this fleet spawned. Without it, SIGTERM to
      // the manager leaves autonomous agents running with no supervisor.
      await this.stop(id);
    } catch (err) {
      log.error(`argus ${id}: failed to stop children on shutdown: ${(err as Error).message}`);
    }
    if (argus.managerSessionId) {
      this.db
        .prepare("UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?")
        .run(now(), now(), argus.managerSessionId);
    }
    this.writeProgress(id, null, 'argus_stopped', '');
    process.exit(0);
  })();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
```

`ArgusManager.stop(id)` already sets the Argus row to stopped and stops running children, so the duplicated status write is removed rather than kept.

- [ ] **Step 8: Add the failing shutdown test**

Add to `test/e2e/argus.test.ts`, using the existing fake fleet harness:

```typescript
it('stops its worker sessions when the manager is signalled', async () => {
  // ... spawn `argus start` with the fake harness on PATH, wait until at
  // least one child session row reaches status 'running' ...
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('close', resolve));

  const sessions = new SessionManager(fixture.root).list().filter((s) => s.policy === 'child');
  expect(sessions.length).toBeGreaterThan(0);
  for (const s of sessions) {
    expect(s.status, `child ${s.name} was orphaned`).not.toBe('running');
  }
});
```

- [ ] **Step 9: Reap anything the run still leaves behind**

Create `test/global-teardown.ts`:

```typescript
import { execFileSync } from 'node:child_process';

/**
 * Last line of defence. Even with the spawn guard, a crashed test can leave a
 * stub process behind, and a stub that hangs is still a leaked process. This
 * kills anything whose argv points at a fixture directory from this run.
 */
export default function teardown(): void {
  for (const pattern of ['flightdeck-repo-', 'flightdeck-bin-', 'flightdeck-test-home-']) {
    try {
      execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' });
    } catch {
      // pkill exits non-zero when nothing matched, which is the good case.
    }
  }
}
```

Register it in `vitest.config.ts`:

```typescript
globalSetup: ['./test/global-teardown.ts'],
```

Vitest runs a `globalSetup` module's default export at start and its returned function at end; export the teardown as the returned function if the installed vitest version requires that shape. Verify the shape against the installed version rather than guessing, and confirm the teardown actually runs by leaving a stub process behind on purpose once.

- [ ] **Step 10: Prove containment**

```bash
npm run build
npm test
ps -eo pid,etime,command | grep -E 'opencode run|codex exec|flightdeck-bin-' | grep -v grep
```

Expected: the suite passes and the process listing is empty. Run it twice and check the listing after each run.

- [ ] **Step 11: Commit**

```bash
git add src/sessions/manager.ts src/argus/manager.ts test/setup.ts test/helpers.ts test/global-teardown.ts vitest.config.ts test/unit/harness-spawn-guard.test.ts test/unit/telemetry.test.ts test/e2e/argus.test.ts test/e2e/argus-live.test.ts
git commit -m "fix(test): forbid real harness spawns and reap leaked agents"
```

---

### Task 1: Make the real-tmux console test deterministic

CI job `test` fails on `keeps panes stable while the console selects workers and tasks` with `console pane never rendered`, while the same test passes on a developer machine.
A detached tmux session defaults to an 80x24 window; three tiled panes give the console pane roughly 40x11.
`FleetConsoleView` renders well over twenty lines, so the `Workers` header scrolls out of the region `capture-pane` returns.
The fix is an explicit window size and a failure message that shows what the pane actually contained.

**Files:**

- Modify: `src/fleet/tmux.ts`
- Modify: `test/e2e/fleet-tmux.test.ts`
- Modify: `test/unit/tmux.test.ts`

**Interfaces:**

- Consumes: `Tmux.newSession(name, cwd, command)`.
- Produces: `Tmux.newSession(name, cwd, command, size?: { width: number; height: number })` and a diagnostic `waitForConsole`.

- [ ] **Step 1: Write the failing argv test**

Add to `test/unit/tmux.test.ts`:

```typescript
it('creates a detached session with an explicit window size when one is given', () => {
  const calls: string[][] = [];
  const tmux = new Tmux((args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  tmux.newSession('fd-1', '/tmp/p', ['node', 'cli.js'], { width: 200, height: 50 });
  expect(calls[0]).toEqual([
    'new-session', '-d', '-s', 'fd-1', '-c', '/tmp/p', '-x', '200', '-y', '50', '--', 'node', 'cli.js',
  ]);
});

it('omits the size flags when no size is given', () => {
  const calls: string[][] = [];
  const tmux = new Tmux((args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  tmux.newSession('fd-1', '/tmp/p', ['node', 'cli.js']);
  expect(calls[0]).toEqual(['new-session', '-d', '-s', 'fd-1', '-c', '/tmp/p', '--', 'node', 'cli.js']);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npm run build
npx vitest run test/unit/tmux.test.ts
```

Expected: the first case fails because `newSession` takes no size argument.

- [ ] **Step 3: Add the optional size to the tmux wrapper**

In `src/fleet/tmux.ts`:

```typescript
newSession(name: string, cwd: string, command: string[], size?: { width: number; height: number }): void {
  const sizeFlags = size ? ['-x', String(size.width), '-y', String(size.height)] : [];
  this.run(['new-session', '-d', '-s', name, '-c', cwd, ...sizeFlags, '--', ...command]);
}
```

Do not change `FleetManager.ensureSession()`: a real operator session is sized by the attaching client, and forcing a size there would fight the terminal.

- [ ] **Step 4: Make the e2e test create its own correctly sized session**

In `test/e2e/fleet-tmux.test.ts`, replace the second test's `fleet.ensureSession()` with an explicitly sized session created through the same wrapper, so three tiled panes each stay tall enough to hold the console frame:

```typescript
const fleet = new FleetManager(fixture.root);
created.push(fleet.tmuxSessionName());
new Tmux().newSession(
  fleet.tmuxSessionName(),
  fixture.root,
  [process.execPath, cliEntryPath(), 'fleet', 'console', '--project', fixture.root],
  { width: 200, height: 60 }
);
fleet.reconcile();
```

Import `cliEntryPath` from `../../src/core/cliEntry.js`.

- [ ] **Step 5: Make the wait diagnostic instead of silent**

Replace `waitForConsole` with a version that reports what the pane held and whether its process is still alive:

```typescript
async function waitForConsole(paneId: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    last = tmux.run(['capture-pane', '-t', paneId, '-p', '-S', '-200']).stdout;
    if (last.includes('Workers')) return;
    const alive = tmux.run(['list-panes', '-t', paneId, '-F', '#{pane_dead}']).stdout.trim();
    if (alive === '1') throw new Error(`console pane exited early; pane contents:\n${last}`);
    if (Date.now() > deadline) throw new Error(`console pane never rendered; pane contents:\n${last}`);
    await sleep(250);
  }
}
```

Update the call site to `await waitForConsole(consolePane!.paneId);` and delete the now-unused `session` parameter from `sendKeys` as well.

- [ ] **Step 6: Verify locally and in a constrained window**

```bash
npm run build
npx vitest run test/unit/tmux.test.ts test/e2e/fleet-tmux.test.ts
```

Expected: both pass.
Then confirm the previous failure mode is genuinely gone rather than hidden by a fast machine: temporarily change the test size to `{ width: 80, height: 24 }`, re-run, and confirm the failure message now prints the captured pane contents. Restore `{ width: 200, height: 60 }` before committing.

- [ ] **Step 7: Commit**

```bash
git add src/fleet/tmux.ts test/e2e/fleet-tmux.test.ts test/unit/tmux.test.ts
git commit -m "test(fleet): stabilize the real-tmux console assertion"
```

---

### Task 2: Give an abandoned question a terminal state

`ArgusManager.answerQuestions()` records `question_failed` and leaves `answer` null.
`QuestionQueue.pending()` filters only on `answer IS NULL`, and `hasPendingEvents()` runs the same predicate, so the 250 ms scheduler calls `processPendingEvents()` forever and `answerQuestions()` re-invokes the brain twice per pass, roughly four times a second, against a rate-limited model.
The same stuck predicate also drives `drainReviews()` on every tick, writing a `review_paused` or `review_batched` row four times a second.

**Files:**

- Modify: `src/core/state.ts`
- Modify: `src/core/types.ts`
- Modify: `src/argus/questions.ts`
- Modify: `src/argus/manager.ts`
- Create: `test/unit/question-queue-failure.test.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: `BrainContractError` from `src/argus/brain.ts`.
- Produces: `Question.failedAt`, `QuestionQueue.markFailed(id, reason)`, a `pending()` that excludes failed questions, and `ArgusManager.runGatesForReported()` returning the number of tasks promoted to `in_review`.

- [ ] **Step 1: Write the failing queue test**

Create `test/unit/question-queue-failure.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { QuestionQueue } from '../../src/argus/questions.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { makeRepo } from '../helpers.js';

describe('QuestionQueue failure state', () => {
  it('drops a failed question from the pending set without answering it', () => {
    const fixture = makeRepo();
    try {
      const argus = new ArgusManager(fixture.root, async () => '{}').start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'what is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');

      expect(queue.pending(argus.id)).toHaveLength(1);
      queue.markFailed(asked.id, 'brain answer output was malformed twice');

      expect(queue.pending(argus.id)).toHaveLength(0);
      const row = queue.get(asked.id);
      expect(row?.answer).toBeNull();
      expect(row?.failedAt).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('does not serve a failed question from the FAQ cache', () => {
    const fixture = makeRepo();
    try {
      const argus = new ArgusManager(fixture.root, async () => '{}').start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'what is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');
      queue.markFailed(asked.id, 'malformed');

      const again = queue.ask(argus.id, 'worker-2', 'what is the test command?');
      expect(again.hit).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

```bash
npm run build
npx vitest run test/unit/question-queue-failure.test.ts
```

Expected: `markFailed` is not a function.

- [ ] **Step 3: Add the column and the typed field**

In `src/core/state.ts`, add `failed_at INTEGER` to the base `CREATE TABLE questions` statement (it currently ends at `answered_at INTEGER`).

There is no late `ALTER TABLE` list for `questions` yet; only `argusColumns` exists. Add one directly beneath it, mirroring that exact pattern so an existing database migrates on open:

```typescript
const questionColumns = ['failed_at INTEGER'];
for (const col of questionColumns) {
  try {
    db.exec(`ALTER TABLE questions ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}
```

Match the surrounding `try`/`catch` shape exactly as `argusColumns` uses it; copy it rather than inventing a variation.

In `src/core/types.ts`, add to `Question`:

```typescript
failedAt: number | null;
```

- [ ] **Step 4: Implement the terminal state**

In `src/argus/questions.ts`, map the field in `rowToQuestion`:

```typescript
failedAt: row.failed_at === null || row.failed_at === undefined ? null : Number(row.failed_at),
```

Add the method:

```typescript
/**
 * Marks a question the brain could not answer. The answer stays null so the
 * waiting worker still receives its normal timeout directive and the FAQ is
 * never poisoned with a failure, but the question leaves the pending set so
 * the scheduler cannot re-invoke a brain that already failed twice.
 */
markFailed(id: number, reason: string): void {
  this.db
    .prepare('UPDATE questions SET failed_at = ?, faq_key = ? WHERE id = ?')
    .run(...([now(), `failed:${reason.slice(0, 80)}`, id] as SQLInputValue[]));
}
```

Change `pending()` to:

```typescript
pending(argusId: string): Question[] {
  const rows = this.db
    .prepare(
      'SELECT * FROM questions WHERE argus_id = ? AND answer IS NULL AND failed_at IS NULL ORDER BY id ASC'
    )
    .all(argusId) as Record<string, unknown>[];
  return rows.map(rowToQuestion);
}
```

`answered()` already filters on `answer IS NOT NULL`, so a failed question stays out of the FAQ cache with no further change.

- [ ] **Step 5: Call it from the manager and stop the scheduler spin**

In `src/argus/manager.ts`, inside the `BrainContractError` branch of `answerQuestions`, add before `continue`:

```typescript
this.questions.markFailed(question.id, err.causeMessage);
```

Change `hasPendingEvents` to use the same predicate as the queue:

```typescript
private hasPendingEvents(id: string): boolean {
  const question = this.db
    .prepare('SELECT 1 FROM questions WHERE argus_id = ? AND answer IS NULL AND failed_at IS NULL LIMIT 1')
    .get(id);
  if (question) return true;
  const reported = this.db
    .prepare('SELECT 1 FROM tasks WHERE argus_id = ? AND status = ? LIMIT 1')
    .get(id, 'reported');
  return Boolean(reported);
}
```

Change `runGatesForReported` to return how many tasks it promoted, so an event pass only touches the review queue when it actually created review work:

```typescript
async runGatesForReported(id: string, cmds: GateCommands = gateCommandsFromConfig()): Promise<number> {
  // ... existing body, with a counter ...
  let promoted = 0;
  // inside the loop, after recordGates:
  if (updated.status === 'in_review') promoted += 1;
  // ... at the end:
  return promoted;
}
```

Change `processPendingEvents` to:

```typescript
private async processPendingEvents(id: string): Promise<void> {
  await this.answerQuestions(id);
  const promoted = await this.runGatesForReported(id);
  await this.resumeRevisions(id);
  if (promoted > 0) {
    await this.drainReviews(id);
    await this.resumeRevisions(id);
  }
}
```

The mission pulse remains responsible for reconsidering an aged batched queue, exactly as before.

- [ ] **Step 6: Add the failing scheduler-loop integration test**

Add to `test/integration/orchestration.test.ts`, replacing the vacuous
`expect(manager.get(argus.id)?.status).toBe('stopped')` assertion in
`keeps the manager alive when answering a question with malformed output twice`
(that value is `stopped` from `start()` and proves nothing) with a real
containment assertion:

```typescript
it('abandons a question after exactly two calls even under the scheduler loop', async () => {
  const fixture = makeRepo();
  try {
    let answerCalls = 0;
    const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
      if (opts.label === 'answer') answerCalls += 1;
      return 'not json';
    });
    const argus = manager.start({ name: 'fleet' });
    const queue = new QuestionQueue(fixture.root);
    const asked = queue.ask(argus.id, 'worker-1', 'help?');
    if (asked.hit) throw new Error('expected a cache miss');

    // Ten scheduler passes stand in for the 250 ms loop running for seconds.
    for (let i = 0; i < 10; i++) {
      await manager.answerQuestions(argus.id);
    }

    expect(answerCalls).toBe(2);
    expect(queue.get(asked.id)?.answer).toBeNull();
    expect(queue.pending(argus.id)).toHaveLength(0);
    const progress = new TablesStore(fixture.root).query('argus_progress', {
      where: { argus_id: argus.id }, limit: 50,
    });
    expect(progress.filter((r) => String(r.event) === 'question_failed')).toHaveLength(1);
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 7: Verify containment**

```bash
npm run build
npx vitest run test/unit/question-queue-failure.test.ts test/unit/questions.test.ts test/integration/orchestration.test.ts
```

Expected: exactly two brain calls survive ten passes, and every existing question test still passes.

- [ ] **Step 8: Commit**

```bash
git add src/core/state.ts src/core/types.ts src/argus/questions.ts src/argus/manager.ts test/unit/question-queue-failure.test.ts test/integration/orchestration.test.ts
git commit -m "fix(argus): abandon a question the brain cannot answer"
```

---

### Task 3: Measure review-queue age from queue entry

`budgetState` and `drainReviews` both use the task's `created_at`, which is stamped when the brain plans the mission, not when the task entered review.
In the 80 to 95 percent band `reviewBatchSize` drains the whole queue as soon as `oldestAgeMs >= 30 * 60_000`, so on any mission planned more than thirty minutes ago the batching band never batches and the conservation ladder is inert.

**Files:**

- Modify: `src/core/state.ts`
- Modify: `src/core/types.ts`
- Modify: `src/argus/board.ts`
- Modify: `src/argus/budget.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/unit/board.test.ts`
- Modify: `test/unit/budget.test.ts`

**Interfaces:**

- Consumes: the `reported -> gating -> in_review` transition in `TaskBoard.recordGates`.
- Produces: `Task.reviewQueuedAt: number | null`, stamped on entry to `in_review` and cleared on exit.

- [ ] **Step 1: Write the failing board and budget tests**

Add to `test/unit/board.test.ts`, following the fixture style already used there (inline gate objects, a `makeRepo()` fixture per test):

```typescript
it('stamps the review queue entry time and clears it on revision', () => {
  const fixture = makeRepo();
  try {
    const board = new TaskBoard(fixture.root);
    const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
    board.assign(task.id, 'w1');
    board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
    board.beginGating(task.id);

    const queued = board.recordGates(
      task.id,
      { testExitCode: 0, lintExitCode: 0, failureTail: '' },
      ' src/a.ts | 2 +-'
    );
    expect(queued.status).toBe('in_review');
    expect(queued.reviewQueuedAt).not.toBeNull();
    expect(queued.reviewQueuedAt!).toBeGreaterThanOrEqual(queued.createdAt);

    const revising = board.toRevising(task.id, 'needs work');
    expect(revising.reviewQueuedAt).toBeNull();
  } finally {
    fixture.cleanup();
  }
});
```

Add to `test/unit/budget.test.ts` a case that seeds one `in_review` task whose `created_at` is two hours old but whose `review_queued_at` is one minute old, and assert:

```typescript
expect(state.oldestReviewAgeSec).toBeLessThan(120);
expect(reviewBatchSize(batchTierState, 1, (state.oldestReviewAgeSec ?? 0) * 1000, false)).toBe(0);
```

- [ ] **Step 2: Run and verify failure**

```bash
npm run build
npx vitest run test/unit/board.test.ts test/unit/budget.test.ts
```

Expected: `reviewQueuedAt` does not exist and the age is computed from `created_at`.

- [ ] **Step 3: Add the column and the typed field**

In `src/core/state.ts`, add `review_queued_at INTEGER` to the base `CREATE TABLE tasks` statement (it currently ends at `priority INTEGER NOT NULL DEFAULT 0`).

As with `questions` in Task 2, there is no late `ALTER TABLE` list for `tasks`. Add one in the same place and shape:

```typescript
const taskColumns = ['review_queued_at INTEGER'];
for (const col of taskColumns) {
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}
```

In `src/core/types.ts`, add to `Task`:

```typescript
reviewQueuedAt: number | null;
```

In `src/argus/board.ts`, map it in `rowToTask`:

```typescript
reviewQueuedAt:
  row.review_queued_at === null || row.review_queued_at === undefined
    ? null
    : Number(row.review_queued_at),
```

- [ ] **Step 4: Stamp and clear it on the two transitions that matter**

In `TaskBoard.recordGates`, the passing branch becomes:

```typescript
return this.update(taskId, { status: 'in_review', review_queued_at: now() });
```

In `TaskBoard.toRevising`, add `review_queued_at: null` to the update, so a task that comes back for a second review is aged from its second queue entry rather than its first.
`recordVerdict`'s accept branch leaves the stamp in place; a `done` task is never queued again.

- [ ] **Step 5: Read the stamp in both consumers**

In `src/argus/budget.ts`, change the queue query to:

```typescript
const queued = db
  .prepare(
    'SELECT COUNT(*) AS n, MIN(COALESCE(review_queued_at, created_at)) AS oldest FROM tasks WHERE argus_id = ? AND status = ?'
  )
  .get(...([argusId, 'in_review'] as SQLInputValue[])) as { n: number; oldest: number | null };
```

`COALESCE` keeps a legacy row from a pre-migration database readable without a backfill.

In `ArgusManager.drainReviews`, change:

```typescript
const oldest = Math.min(...queued.map((t) => t.reviewQueuedAt ?? t.createdAt));
```

- [ ] **Step 6: Verify the ladder actually holds**

```bash
npm run build
npx vitest run test/unit/board.test.ts test/unit/budget.test.ts test/integration/orchestration.test.ts test/e2e/argus.test.ts
```

Expected: all pass, and the batch-tier tests still exercise both the four-task and the thirty-minute escape.

- [ ] **Step 7: Commit**

```bash
git add src/core/state.ts src/core/types.ts src/argus/board.ts src/argus/budget.ts src/argus/manager.ts test/unit/board.test.ts test/unit/budget.test.ts
git commit -m "fix(argus): age the review queue from queue entry"
```

---

### Task 4: Stop the console from guessing a fleet, and let it spawn the first worker

`loadSnapshot` takes `new ArgusManager(projectRoot).list()[0]`, which is the newest row, contradicting the fleet-window acceptance gate that multiple fleets never cause an implicit newest-row selection.
`reduceKey`'s `n` case also requires a selected worker before it emits a spawn effect, so on an empty fleet, which is the main reason to press it, the key does nothing.

**Files:**

- Modify: `src/fleet/console-state.ts`
- Modify: `src/cli/commands/fleet.tsx`
- Modify: `test/unit/fleet-console-state.test.ts`
- Modify: `test/unit/fleet-console-view.test.tsx`

**Interfaces:**

- Consumes: `ConsoleBounds.argusId`, which is null when zero or more than one fleet exists.
- Produces: `ConsoleSnapshot.fleetError: string | null` and a reducer that emits no effect without a fleet id.

- [ ] **Step 1: Write the failing reducer tests**

Add to `test/unit/fleet-console-state.test.ts`:

```typescript
it('spawns the next task even when no worker exists yet', () => {
  const s = reduce(initial(), { type: 'action', key: 'n' }, bounds({ workerIds: [] }));
  expect(s.effect).toEqual({ kind: 'spawn', argusId: 'a1' });
});

it('emits no effect for any fleet action when the fleet is ambiguous', () => {
  const none = bounds({ argusId: null });
  for (const key of ['n', 'a', 'u', 'p', 'f'] as const) {
    expect(reduce(initial(), { type: 'action', key }, none).effect).toBeNull();
  }
  const rejecting = reduce(
    { ...initial(), focus: 'tasks', pendingAction: { kind: 'reject', taskId: 't1' }, rejectReason: 'no' },
    { type: 'confirm' },
    none
  );
  expect(rejecting.effect).toBeNull();
});
```

- [ ] **Step 2: Run and verify failure**

```bash
npm run build
npx vitest run test/unit/fleet-console-state.test.ts
```

Expected: the empty-worker spawn yields a null effect, and the ambiguous-fleet cases emit effects carrying an empty `argusId`.

- [ ] **Step 3: Fix the reducer**

In `src/fleet/console-state.ts`, replace the `n` case:

```typescript
case 'n':
  if (state.pendingAction) {
    return { state: { ...state, pendingAction: null, rejectReason: '' }, effect: null };
  }
  return bounds.argusId
    ? { state, effect: { kind: 'spawn', argusId: bounds.argusId } }
    : { state, effect: null };
```

Change the `confirm` branch for a reject so it requires a fleet:

```typescript
if (pending?.kind === 'reject' && clamped.rejectReason.trim() !== '' && bounds.argusId) {
  return {
    state: { ...clamped, pendingAction: null, rejectReason: '' },
    effect: { kind: 'reject', taskId: pending.taskId, argusId: bounds.argusId, reason: clamped.rejectReason.trim() },
  };
}
```

Remove every remaining `bounds.argusId ?? ''` fallback. No effect may carry an empty fleet id.

While in this file, replace the meaningless conditional type on `reduceKey`'s `key` parameter with the plain union:

```typescript
key: 'c' | 'r' | 'k' | 'n' | 'a' | 'x' | 'u' | 'p' | 'f' | 'R' | 'y',
```

- [ ] **Step 4: Make the console refuse to guess a fleet**

In `src/cli/commands/fleet.tsx`, add `fleetError: string | null` to `ConsoleSnapshot` and set it in `loadSnapshot`:

```typescript
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
```

Every early return must set `fleetError`, and the single-fleet return sets it to `null`.
`argusId` stays null whenever `fleetError` is non-null, which is what makes the reducer inert.

In `FleetConsoleView`, render it above the sections:

```tsx
{snap.fleetError !== null && <Text color="red">{snap.fleetError}</Text>}
```

- [ ] **Step 5: Remove the dead console surface found in review**

Delete the unused `onEffect` prop from `FleetConsoleView` and its call site: the parent already wires effects through `useInput`.
Either render `snap.blockedTasks` or delete the field; the task list already renders blocked rows in red with their `verdictReason`, so delete it and the now-unused sort.
Fix the misplaced comment above `spendLabel`, which describes claimed-session spend on what is actually the brain budget:

```typescript
// The ceiling can be zero only for a corrupt row, and a zero-denominator
// percentage would be fabricated, so the label renders blank instead.
```

- [ ] **Step 6: Add console rendering coverage for the ambiguous fleet**

Add to `test/unit/fleet-console-view.test.tsx` a case rendering a snapshot with `fleetError` set and `argusId: null`, asserting the error text appears and no task section rows are drawn.

- [ ] **Step 7: Verify**

```bash
npm run build
npx vitest run test/unit/fleet-console-state.test.ts test/unit/fleet-console-view.test.tsx test/e2e/fleet-tmux.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/fleet/console-state.ts src/cli/commands/fleet.tsx test/unit/fleet-console-state.test.ts test/unit/fleet-console-view.test.tsx
git commit -m "fix(fleet): require an explicit fleet in the console"
```

---

### Task 5: Confirm a destructive kill on a terminal

`deck fleet kill <id>` checks `--yes` only when stdin is not a TTY.
On an interactive terminal it stops the worker and blocks its task with no prompt at all, against the fleet-window gate that destructive actions require confirmation.
The repository already has a confirmation prompt in `src/cli/commands/tools.ts`; it moves to `src/cli/util.ts` rather than being duplicated.

**Files:**

- Modify: `src/cli/util.ts`
- Modify: `src/cli/commands/tools.ts`
- Modify: `src/cli/commands/fleet.tsx`
- Create: `test/unit/prompt-confirm.test.ts`

**Interfaces:**

- Consumes: `process.stdin.isTTY`.
- Produces: `promptConfirm(prompt: string, input?: NodeJS.ReadableStream): Promise<boolean>` exported from `src/cli/util.ts`.

`test/e2e/fleet-cli.test.ts` already covers both non-interactive paths (`refuses to kill without --yes in a non-interactive process` and `kills a worker and blocks its active task with --yes --json`). Do not duplicate them; they are the regression guard that this change must not break.

- [ ] **Step 1: Write the failing prompt test**

The interactive branch cannot be driven through `runCli`, because a spawned test process has no TTY. Make the prompt's input stream injectable and test it directly.

Create `test/unit/prompt-confirm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { promptConfirm } from '../../src/cli/util.js';

function answer(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  setImmediate(() => stream.write(`${text}\n`));
  return stream;
}

describe('promptConfirm', () => {
  it('accepts y and Y', async () => {
    expect(await promptConfirm('go?', answer('y'))).toBe(true);
    expect(await promptConfirm('go?', answer('Y'))).toBe(true);
  });

  it('treats an empty answer and anything else as no', async () => {
    expect(await promptConfirm('go?', answer(''))).toBe(false);
    expect(await promptConfirm('go?', answer('nope'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npm run build
npx vitest run test/unit/prompt-confirm.test.ts
```

Expected: `promptConfirm` is not exported from `src/cli/util.ts`.

- [ ] **Step 3: Move the prompt into the shared CLI utility**

Add to `src/cli/util.ts`:

```typescript
import readline from 'node:readline';

/**
 * Interactive y/N confirmation. The prompt goes to stderr so `--json` stdout
 * stays parseable. The input stream is injectable so the branch is testable
 * without a real TTY.
 */
export function promptConfirm(
  prompt: string,
  input: NodeJS.ReadableStream = process.stdin
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output: process.stderr });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith('y'));
    });
  });
}
```

Delete the local copy in `src/cli/commands/tools.ts` and import the shared one, leaving its two call sites unchanged.

- [ ] **Step 4: Require confirmation on both paths in `fleet kill`**

```typescript
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
```

- [ ] **Step 5: Verify**

```bash
npm run build
npx vitest run test/unit/prompt-confirm.test.ts test/e2e/fleet-cli.test.ts test/unit/playbooks.test.ts
```

Expected: all pass. The two existing non-interactive kill tests must still pass unchanged, and the playbook confirmation path still works through the moved helper.

- [ ] **Step 6: Commit**

```bash
git add src/cli/util.ts src/cli/commands/tools.ts src/cli/commands/fleet.tsx test/unit/prompt-confirm.test.ts
git commit -m "fix(cli): confirm a destructive fleet kill on a terminal"
```

---

### Task 6: Track the plans, correct the documentation, and run every gate

The three plans PR #18 implements are untracked working-tree files, so nothing on GitHub lets a reviewer read the contract the code was written against, while the two earlier plans are committed.
The README also describes console behavior this plan just changed.

**Files:**

- Create (track): `docs/superpowers/plans/2026-08-15-codex-opencode-runtime-readiness.md`
- Create (track): `docs/superpowers/plans/2026-08-15-fleet-console-controls.md`
- Create (track): `docs/superpowers/plans/2026-08-15-orchestrator-contract-completion.md`
- Create (track): `docs/superpowers/plans/2026-08-16-runtime-readiness-remediation.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: Tasks 1 through 5.
- Produces: a repository where every shipped plan is reviewable from the PR.

- [ ] **Step 1: Track the plan documents**

```bash
git add docs/superpowers/plans/2026-08-15-codex-opencode-runtime-readiness.md \
        docs/superpowers/plans/2026-08-15-fleet-console-controls.md \
        docs/superpowers/plans/2026-08-15-orchestrator-contract-completion.md \
        docs/superpowers/plans/2026-08-16-runtime-readiness-remediation.md
```

Do not edit their contents. They are the historical record of what was asked for, including where the implementation diverged.

- [ ] **Step 2: Correct the README fleet section**

Document exactly three changed behaviors, and nothing else:

- The console drives a single fleet. With zero or more than one Argus row it shows an error and directs the operator to the CLI with `--argus <id>`.
- `n` spawns a worker for the highest-priority dispatchable task whether or not a worker is currently selected.
- `deck fleet kill <session-id>` prompts for confirmation on a terminal and requires `--yes` in a non-interactive process.

Do not rewrite unrelated README sections.

- [ ] **Step 3: Run every gate**

```bash
npm run typecheck
npm run lint
npm test
git diff --check
ps -eo pid,etime,command | grep -E 'opencode run|codex exec|claude -p|flightdeck-bin-' | grep -v grep
```

Expected: the first four commands exit zero, `npm test` reports no failed files with only the explicit live-harness skip, and the process listing is empty. A non-empty listing means Task 0 regressed and this task is not done.

- [ ] **Step 4: Confirm CI is green before requesting review**

```bash
git push
gh pr checks 18 --watch
```

Expected: the `test` job passes. A red `test` job means Task 1 did not fix the real cause and must be reopened rather than retried.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans README.md
git commit -m "docs: track the runtime readiness plans and correct the fleet reference"
```

---

## Deferred, not in this plan

These were found in the same review and are deliberately out of scope. Each needs its own decision before it gets a plan:

- **Worker spend is invisible to the budget.** `budgetState` sums only `policy = 'brain'` sessions, so the 79 leaked workers consumed tokens that no ceiling, tier, or pause could ever have seen. The brain budget protects the reviewer's rate limit and nothing else. Deciding whether workers get their own budget, a shared one, or only a concurrency ceiling is a design question that belongs in the orchestrator spec before it becomes a plan.
- **There is no fleet-wide reaper.** Nothing outside a live manager process can find and stop agents belonging to this project. `deck fleet kill` needs an explicit session id, and a manager that died takes its knowledge with it. A `deck fleet reap` that stops every `policy: 'child'` session whose manager is gone would have turned this incident into a one-command cleanup.
- **Gemini worker path is unverified.** `deck argus start --worker-harness gemini` is now a validated, advertised option, but the adapter emits `gemini run <prompt> --auto-approve`, which does not match the Gemini CLI's actual contract, and `loginArgs()` guesses `gemini login`. Either verify against an installed binary and correct the adapter, or drop `gemini` from `WorkerHarness` until it is verified.
- **`deck login` and the dashboard capability-token gate** landed in PR #18 without a plan and are not mentioned in its summary. `deck login --json` pipes stdio into an interactive OAuth flow with no timeout, which will hang. This needs its own design pass.
- **`deck argus status --json` prints the Argus `cap`**, the capability secret that gates `isManager`. Pre-existing, but the JSON payload grew in this PR and now travels further.
- **The budget ladder is written twice**: `tierPolicy().batchSize` returns 1, 4, and `MAX_SAFE_INTEGER`, while `reviewBatchSize()` hardcodes the same 1 and 4 independently. `policy.batchSize` is now dead for drain decisions and should either drive `reviewBatchSize` or be deleted.
- **The full-lifecycle test sits one level below its acceptance gate.** The orchestrator-contract plan asked for the ten-step lifecycle "through real CLI processes and real MCP calls"; it landed as an in-process integration test with a stubbed `BrainFn`.
