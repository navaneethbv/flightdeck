# Orchestrator Contract Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the Argus control loop so questions wake the brain promptly, failed or rejected tasks return to their worker, budget rules are enforced exactly, and tier 2 review reads only safe requested files.

**Architecture:** `ArgusManager` remains the lifecycle coordinator.
Pure policy and file-loading helpers keep timing, budget, and path-security decisions independently testable.
The existing task board remains the source of truth, while every model call still goes through `invokeBrain` as a short-lived `policy: 'brain'` session.

**Tech Stack:** TypeScript ESM, `node:sqlite`, zod, vitest, existing harness adapters.

**Spec:** [docs/superpowers/specs/2026-08-15-orchestrator-brain-design.md](../specs/2026-08-15-orchestrator-brain-design.md)

## Global Constraints

- Complete `2026-08-15-codex-opencode-runtime-readiness.md` first.
- The brain is invoked only for planning, review, or an uncached worker question.
- Gates and dispatcher polling spend no model tokens.
- Tier 1 review never receives file contents.
- Tier 2 review is allowed only below 60 percent of the configured token ceiling.
- A force-review action may ignore batching and the 95 percent review pause, but it may not run at or above 100 percent of the ceiling.
- Never read a requested review path outside the assigned worker worktree.
- Never attach generated MCP configuration, `.flightdeck` state, Git internals, or environment files to a brain prompt.
- Keep unknown usage and unknown reset time nullable.
- Preserve task changes in the existing worker worktree when re-prompting.
- Stop after the configured attempt limit and surface the task as blocked.
- Run `npm run build` before direct Vitest commands.
- Do not add native dependencies.
- Do not add co-author trailers to commits.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/argus/review-files.ts` | Validate and load bounded tier 2 file attachments from one worker worktree. |
| `test/unit/review-files.test.ts` | Path containment, secret exclusions, symlink handling, and size limits. |

**Modified:**

| File | Responsibility |
| --- | --- |
| `src/core/state.ts` | Store the optional conventions note id on an Argus row. |
| `src/core/types.ts` | Expose `conventionsNoteId` and enriched budget state. |
| `src/argus/board.ts` | Explicit revision resume and orphan recovery transitions. |
| `src/argus/budget.ts` | Pure drain policy plus queue depth and next-reset projection. |
| `src/argus/manager.ts` | Context assembly, prompt wake-up, revision restart, exact batching, and tier 2 review. |
| `src/argus/override.ts` | Call the manager's true force-review path. |
| `src/mcp/tools.ts` | Return project conventions from `task_get`. |
| `src/cli/commands/argus.ts` | Accept `--conventions` and surface paused-queue details. |
| `src/cli/commands/fleet.tsx` | Show review backlog and reset time without fabricated values. |
| `test/unit/board.test.ts` | Revision transitions. |
| `test/unit/budget.test.ts` | Every threshold and batching condition. |
| `test/unit/worker-tools.test.ts` | Worker conventions contract. |
| `test/integration/orchestration.test.ts` | Closed-loop revisions, prompt wake-up, and two-tier review. |
| `test/e2e/argus.test.ts` | Full fake-harness lifecycle through report, gates, review, and revision. |

**Dependency order:** Task 1 is independent.
Task 2 is independent of Tasks 3 and 4.
Task 3 precedes Task 5.
Task 4 precedes Task 5.
Task 6 depends on Tasks 3 through 5.
Task 7 depends on all earlier tasks.

---

### Task 1: Bind a project conventions note into every relevant contract

**Files:**

- Modify: `src/core/state.ts`
- Modify: `src/core/types.ts`
- Modify: `src/argus/manager.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/cli/commands/argus.ts`
- Modify: `test/unit/schema.test.ts`
- Modify: `test/unit/worker-tools.test.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: a note id selected through `deck argus start --conventions <note-id>`.
- Produces: `Argus.conventionsNoteId`, consistent plan and answer context, and `task_get.projectConventions`.

- [ ] **Step 1: Write failing schema, worker-tool, and prompt tests**

Add a schema assertion for `argus.conventions_note_id`.
Add this worker-tool assertion after seeding an Argus row and conventions note:

```typescript
const result = await registry.call('task_get', {});
expect(result).toMatchObject({
  id: task.id,
  projectConventions: 'Use strict ESM and run npm test.',
});
```

Add plan and answer prompt assertions to `test/integration/orchestration.test.ts`:

```typescript
expect(brain.prompts.plan).toContain('Project conventions:\nUse strict ESM and run npm test.');
expect(brain.prompts.answer).toContain('Project conventions:\nUse strict ESM and run npm test.');
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts test/unit/worker-tools.test.ts test/integration/orchestration.test.ts
```

Expected: the column, returned field, and prompt sections are absent.

- [ ] **Step 3: Add the schema and typed field**

Add `conventions_note_id TEXT` to the base `CREATE TABLE argus` statement and to the late `ALTER TABLE` migration list.
Add `conventionsNoteId: string | null` to `Argus` and `conventionsNoteId?: string` to `StartArgusOptions`.
Persist and map the field through the same code path introduced by the runtime-readiness plan.

- [ ] **Step 4: Validate the selected note and centralize context loading**

Before creating any row, reject a supplied id that `NotesStore.readNote()` cannot resolve:

```typescript
if (opts.conventionsNoteId && !this.notes.readNote(opts.conventionsNoteId)) {
  throw new Error(`conventions note "${opts.conventionsNoteId}" not found`);
}
```

Add one private helper to `ArgusManager`:

```typescript
private contextFor(argus: Argus): { mission: string; conventions: string } {
  const mission = argus.missionNoteId ? this.notes.readNote(argus.missionNoteId)?.body ?? '' : '';
  const conventions = argus.conventionsNoteId
    ? this.notes.readNote(argus.conventionsNoteId)?.body ?? ''
    : '';
  return { mission, conventions };
}
```

Use it in `plan()` and `answerQuestions()`.
Include a `Project conventions:` section only when the body is non-empty.
Do not guess conventions from README, CLAUDE.md, or an arbitrary note title.

- [ ] **Step 5: Return conventions through `task_get`**

Resolve the caller's session, then its `argus_parent`, then `conventions_note_id`.
Return `projectConventions: string | null` beside the task fields.
Do not expose the mission note through this tool because the task spec is the worker's scoped assignment.

- [ ] **Step 6: Add the CLI flag and verify**

Register:

```typescript
.option('--conventions <note-id>', 'project conventions note id')
```

Pass it as `conventionsNoteId`.
Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts test/unit/worker-tools.test.ts test/integration/orchestration.test.ts test/e2e/orchestrator-cli.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/state.ts src/core/types.ts src/argus/manager.ts src/mcp/tools.ts src/cli/commands/argus.ts test/unit/schema.test.ts test/unit/worker-tools.test.ts test/integration/orchestration.test.ts
git commit -m "feat(argus): include project conventions in brain and worker context"
```

---

### Task 2: Wake questions, gates, and reviews independently of the normal pulse interval

**Files:**

- Modify: `src/argus/manager.ts`
- Modify: `test/integration/orchestration.test.ts`
- Modify: `test/e2e/argus.test.ts`

**Interfaces:**

- Consumes: unresolved rows from `QuestionQueue.pending(argusId)` and tasks in `reported`.
- Produces: a manager loop that notices worker events within 250 ms while retaining the configured mission pulse interval.

- [ ] **Step 1: Add a failing long-pulse question test**

Start the Argus loop in a child process with `pulse_sec = 3600`, a fake answer brain, and `question_timeout_sec = 3`.
After the initial planning pulse, enqueue a question through the real `ask_manager` MCP tool.
Assert the tool returns the fake answer within three seconds and the brain receives exactly one answer call.

- [ ] **Step 2: Run the test and verify the current timeout behavior**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "answers a question before a long mission pulse"
```

Expected: the tool returns the proceed-on-best-judgment timeout directive because the manager sleeps for an hour.

- [ ] **Step 3: Separate cheap scheduler checks from mission pulses**

Replace the single long sleep in `runForever()` with a 250 ms scheduler interval.
Only call `pulse()` when the next configured pulse is due.
Between pulses, process pending questions and reported work.
When gates move reported work to `in_review`, drain that review queue in the same event-processing pass.

The loop must have this behavior:

```typescript
let nextPulseAt = 0;
while (true) {
  const current = Date.now();
  if (current >= nextPulseAt) {
    await this.pulse(id);
    nextPulseAt = Date.now() + argus.pulseSec * 1000;
  } else if (this.hasPendingEvents(id)) {
    await this.processPendingEvents(id);
  }
  await sleep(Math.min(250, Math.max(1, nextPulseAt - Date.now())));
}
```

This polls only local SQLite state.
It does not poll a model.
Keep the loop sequential so two answer calls cannot race within one manager process.

`processPendingEvents(id)` must run phases in this order:

1. Answer queued questions.
2. Run gates for reported tasks.
3. Resume or block gate failures.
4. Drain review-ready tasks under the budget policy.
5. Resume or block review revisions.

`hasPendingEvents(id)` is a read-only check for pending questions or `reported` tasks.
It must not treat an intentionally batched `in_review` queue as continuous work, or the 250 ms loop would repeatedly reconsider a queue that is waiting for four tasks or 30 minutes.
The normal mission pulse remains responsible for reconsidering an aged batched queue.

- [ ] **Step 4: Verify prompt wake-up and no idle brain calls**

Add an assertion that a two-second idle interval causes zero additional brain calls.
Add a second long-pulse test where a worker calls `report_done`.
Assert gates start within one second, the task reaches `in_review`, and review runs without waiting for the next mission pulse.
Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts test/e2e/argus.test.ts
```

Expected: the long-pulse question is answered, reported work reaches gates and review promptly, and the idle brain call count stays unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/argus/manager.ts test/integration/orchestration.test.ts test/e2e/argus.test.ts
git commit -m "fix(argus): process worker events between mission pulses"
```

---

### Task 3: Run explicit gates and resume failed or rejected tasks in the same worker worktree

**Files:**

- Modify: `src/argus/board.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/unit/board.test.ts`
- Modify: `test/integration/orchestration.test.ts`
- Modify: `test/e2e/argus.test.ts`

**Interfaces:**

- Consumes: tasks in `revising` plus their existing assignee session and `verdictReason`.
- Produces: explicit `reported -> gating` and `revising -> assigned` transitions, `ArgusManager.resumeRevisions(argusId)`, and attempt-limit enforcement for gate and review failures.

- [ ] **Step 1: Write failing board transition tests**

Add:

```typescript
it('returns a revision to assigned without clearing feedback or attempts', () => {
  const revised = board.toRevising(task.id, 'tests failed');
  const resumed = board.resumeRevision(task.id);
  expect(resumed.status).toBe('assigned');
  expect(resumed.assigneeSession).toBe(worker.id);
  expect(resumed.attempts).toBe(revised.attempts);
  expect(resumed.verdictReason).toBe('tests failed');
});
```

Also assert that `beginGating(task.id)` accepts only a `reported` task and returns status `gating`.
Assert `recordGates` accepts a `gating` task and moves it to `in_review` or `revising`.

- [ ] **Step 2: Add a failing closed-loop integration test**

Use a fake worker executable that records each prompt to a file.
Seed an assigned task, report it, return a failed gate, and run one manager pulse.
Assert the same session id and worktree are reused, the second prompt contains the task spec and failure tail, and the task is `assigned` again.

Add the same assertion for a brain `revise` verdict.

- [ ] **Step 3: Implement explicit board transitions**

Add:

```typescript
beginGating(taskId: string): Task {
  const task = this.get(taskId);
  if (!task) throw new Error(`task "${taskId}" not found`);
  if (task.status !== 'reported') {
    throw new Error(`task "${taskId}" is ${task.status}, expected reported`);
  }
  return this.update(taskId, { status: 'gating' });
}

resumeRevision(taskId: string): Task {
  const task = this.get(taskId);
  if (!task) throw new Error(`task "${taskId}" not found`);
  if (task.status !== 'revising') {
    throw new Error(`task "${taskId}" is ${task.status}, expected revising`);
  }
  return this.update(taskId, { status: 'assigned' });
}
```

Also add `clearAssigneeAndRequeue(taskId)` for the rare case where the assigned session row no longer exists.
That method sets `status = 'pending'` and `assignee_session = NULL` while preserving attempts and feedback.
Change `runGatesForReported` to call `beginGating` before it starts either command.
Change `recordGates` to require `gating`.
At manager startup, move any task left in `gating` by an interrupted process back to `reported` and write `gates_recovered` to progress.

- [ ] **Step 4: Implement `resumeRevisions()`**

For each revising task:

1. Block it when `attempts >= max_attempts_per_task`.
2. Requeue it when the assignee session row is missing.
3. Leave it in `revising` when the session is claimed by a human.
4. Stop the old headless process if it is still running.
5. Restart the same session id in the same worktree with autonomy enabled.
6. Include the original task spec, `verdictReason`, and gate failure tail in the prompt.
7. Move the task back to `assigned` only after `startSession()` returns successfully.
8. Write `worker_reprompted`, `revision_waiting_for_human`, or `task_blocked` to `argus_progress`.

Use this prompt structure:

```typescript
const prompt = [
  'Your task requires revision in the same worktree.',
  '',
  `Task: ${task.title}`,
  task.spec,
  '',
  'Feedback:',
  task.verdictReason ?? 'Revision requested.',
  task.gateResult?.failureTail ? `\nGate output:\n${task.gateResult.failureTail}` : '',
  '',
  'Fix the issue, rerun the relevant checks, then call `report_done` again.',
].join('\n');
```

- [ ] **Step 5: Recover workers that exit without reporting**

Before dispatch, scan assigned tasks whose session status is `stopped` or `failed`.
Move each to `revising` with `worker exited before report_done`, increment attempts once, and let `resumeRevisions()` restart it.
Do not treat a task already in `reported`, `in_review`, or `done` as orphaned.

- [ ] **Step 6: Integrate the transition into every path**

Call `resumeRevisions(id)` after gates and after review decisions in `pulse()`.
Ensure the force-review path also resumes any revisions it creates.
Apply the maximum-attempt rule to gate failures, review revisions, `need_files` fallback, and orphan recovery through one helper.
At `runForever` startup, inspect `gateCommandsFromConfig()`.
When both commands are empty, write one `gates_disabled` progress row and emit one warning that work will go directly to brain review.

- [ ] **Step 7: Verify the closed loop**

Run:

```bash
npm run build
npx vitest run test/unit/board.test.ts test/integration/orchestration.test.ts test/e2e/argus.test.ts
```

Expected: gating is explicit and recoverable, failures re-prompt the same worker, claimed workers are not interrupted, empty gates warn once, and tasks block at the exact configured limit.

- [ ] **Step 8: Commit**

```bash
git add src/argus/board.ts src/argus/manager.ts test/unit/board.test.ts test/integration/orchestration.test.ts test/e2e/argus.test.ts
git commit -m "fix(argus): close the worker revision loop"
```

---

### Task 4: Enforce the budget degradation ladder and true force-review semantics

**Files:**

- Modify: `src/argus/budget.ts`
- Modify: `src/argus/manager.ts`
- Modify: `src/argus/override.ts`
- Modify: `src/cli/commands/argus.ts`
- Modify: `src/cli/commands/fleet.tsx`
- Modify: `test/unit/budget.test.ts`
- Modify: `test/unit/override.test.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: `BudgetState`, queued task timestamps, current time, and `force`.
- Produces: `reviewBatchSize(...)`, `nextResetAt`, backlog depth, and `drainReviews(id, { force })`.

- [ ] **Step 1: Write table-driven failing policy tests**

Add a pure helper contract:

```typescript
expect(reviewBatchSize(normal, 1, 0, false)).toBe(1);
expect(reviewBatchSize(conserve, 7, 0, false)).toBe(4);
expect(reviewBatchSize(batch, 3, 31 * 60_000, false)).toBe(3);
expect(reviewBatchSize(batch, 3, 29 * 60_000, false)).toBe(0);
expect(reviewBatchSize(batch, 4, 1_000, false)).toBe(4);
expect(reviewBatchSize(pausedBelowCeiling, 8, 1_000, false)).toBe(0);
expect(reviewBatchSize(pausedBelowCeiling, 8, 1_000, true)).toBe(8);
expect(() => reviewBatchSize(atCeiling, 8, 1_000, true)).toThrow(/exhausted/);
```

Use complete `BudgetState` fixtures rather than positional booleans in the real test.

- [ ] **Step 2: Add failing force-review integration coverage**

Seed eight `in_review` tasks and telemetry at 96 percent of the ceiling.
Assert normal drain makes zero brain calls.
Assert `Override.forceReview` makes one batched brain call containing all eight task ids.
Seed telemetry at 100 percent and assert force-review throws without a brain call.

- [ ] **Step 3: Implement the pure batch decision**

```typescript
export function reviewBatchSize(
  budget: BudgetState,
  queuedCount: number,
  oldestAgeMs: number,
  force: boolean
): number {
  if (force) {
    if (budget.spent >= budget.ceiling) throw new Error('brain budget exhausted for this window');
    return queuedCount;
  }
  if (!budget.policy.reviewsAllowed) return 0;
  if (budget.tier === 'normal') return Math.min(1, queuedCount);
  if (budget.tier === 'conserve') return Math.min(4, queuedCount);
  if (queuedCount >= 4 || oldestAgeMs >= 30 * 60_000) return queuedCount;
  return 0;
}
```

- [ ] **Step 4: Calculate honest backlog and reset projection**

Extend `BudgetState` with:

```typescript
reviewQueueDepth: number;
oldestReviewAgeSec: number | null;
nextResetAt: number | null;
```

Set `nextResetAt` to the oldest in-window brain session's `started_at + budget_window_sec * 1000`.
Return null when no in-window brain usage exists.
Do not claim that the full budget resets at once in a rolling window.

- [ ] **Step 5: Make force a manager option, not an override-side approximation**

Change the signature to:

```typescript
async drainReviews(id: string, opts: { force?: boolean } = {}): Promise<void>
```

Use `reviewBatchSize` to select the batch.
Change `Override.forceReview` to call `manager.drainReviews(argusId, { force: true })`.
Remove its duplicated pre-check.

- [ ] **Step 6: Surface paused state without invented values**

In `deck argus budget`, print queue depth and `next reset` only when non-null.
In the Fleet console, show the same fields and render a blank or `unknown` label when no reset can be calculated.

- [ ] **Step 7: Verify all budget paths**

Run:

```bash
npm run build
npx vitest run test/unit/budget.test.ts test/unit/override.test.ts test/integration/orchestration.test.ts
```

Expected: every threshold, wait condition, and force path passes.

- [ ] **Step 8: Commit**

```bash
git add src/argus/budget.ts src/argus/manager.ts src/argus/override.ts src/cli/commands/argus.ts src/cli/commands/fleet.tsx test/unit/budget.test.ts test/unit/override.test.ts test/integration/orchestration.test.ts
git commit -m "fix(argus): enforce review budget batching and force semantics"
```

---

### Task 5: Implement bounded and path-safe tier 2 file review

**Files:**

- Create: `src/argus/review-files.ts`
- Create: `test/unit/review-files.test.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: worker worktree, brain-requested relative paths, and the tier 1 task context.
- Produces: `loadReviewFiles(worktree, paths): ReviewFile[]` and one bounded tier 2 brain call using `brain_plan_model`.

- [ ] **Step 1: Write failing file-loader security tests**

Define:

```typescript
export interface ReviewFile {
  path: string;
  content: string | null;
  error: string | null;
  truncated: boolean;
}
```

Test all of these cases:

- A normal `src/a.ts` file is returned.
- `../outside.txt` is rejected.
- An absolute path is rejected.
- A symlink inside the worktree that resolves outside is rejected.
- `.git/config`, `.flightdeck/state.db`, `.mcp.json`, `mcp.json`, `opencode.json`, `.gemini/settings.json`, and `.env.local` are rejected.
- A file larger than 32 KiB is truncated and marked `truncated: true`.
- More than eight requested paths produces only eight entries.
- The combined attached content never exceeds 128 KiB.

- [ ] **Step 2: Run the new unit test and verify it fails to import**

Run:

```bash
npm run build
npx vitest run test/unit/review-files.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement the loader**

Use `path.resolve(worktree, requested)` and `fs.realpathSync`.
Require both the resolved candidate and real path to start with `${realWorktree}${path.sep}`.
Normalize returned path separators to `/`.
Read UTF-8 regular files only.
Return a per-path error string instead of throwing for a missing or denied path so one bad request does not discard safe attachments from the same verdict.

Use constants:

```typescript
const MAX_FILES = 8;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;
```

- [ ] **Step 4: Add failing two-call review coverage**

Seed one task in review and make the fake brain return `need_files` from tier 1 and `accept` from tier 2.
Assert:

```typescript
expect(brain.calls).toHaveLength(2);
expect(brain.calls[0].model).toBe('review-model');
expect(brain.calls[0].prompt).not.toContain(sourceContents);
expect(brain.calls[1].model).toBe('plan-model');
expect(brain.calls[1].prompt).toContain('File: src/a.ts');
expect(brain.calls[1].prompt).toContain(sourceContents);
expect(board.get(task.id)?.status).toBe('done');
```

Add cases where tier 2 is disabled, where the path is denied, and where tier 2 itself returns `need_files`.
The disabled and repeated-request cases must move the task to `revising` once and must not leave it in `in_review`.

- [ ] **Step 5: Implement tier 2 in `drainReviews`**

After a tier 1 `need_files` verdict:

1. Recalculate budget state after the tier 1 invocation.
2. If tier 2 is no longer allowed, record one revision explaining that requested file review was unavailable under the current budget.
3. Resolve the task's assignee session and use its `cwd` as the only file root.
4. Load the requested files with `loadReviewFiles`.
5. Build a prompt containing only that task's tier 1 context and the bounded file entries.
6. Invoke the brain with `brain_plan_model` and label `review-files`.
7. Accept or revise from the tier 2 verdict.
8. Convert a second `need_files` result into one concrete revision to prevent an unbounded model loop.

Do not combine tier 2 requests from different worktrees into one prompt.

- [ ] **Step 6: Verify tier 1 privacy and tier 2 behavior**

Run:

```bash
npm run build
npx vitest run test/unit/review-files.test.ts test/integration/orchestration.test.ts test/unit/brain-contract.test.ts
```

Expected: tier 1 contains no file contents, tier 2 contains only allowed bounded files, and every `need_files` path terminates.

- [ ] **Step 7: Commit**

```bash
git add src/argus/review-files.ts test/unit/review-files.test.ts src/argus/manager.ts test/integration/orchestration.test.ts
git commit -m "feat(argus): add bounded tier two file review"
```

---

### Task 6: Contain a brain that returns malformed output twice

**Files:**

- Modify: `src/argus/brain.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/unit/brain-contract.test.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: the existing one-retry `brainJson` path.
- Produces: `BrainContractError` and terminal, non-repeating handling for plan, review, tier 2, and answer failures.

- [ ] **Step 1: Write failing containment tests**

Add one test per call type where the fake brain returns malformed output twice.
Assert:

- Planning makes exactly two calls, records `brain_abandoned`, marks the Argus row stopped, and throws a human-readable error to the foreground CLI.
- Tier 1 review makes exactly two calls, blocks every task in that batch with a malformed-review reason, and later scheduler checks make no more calls.
- Tier 2 review makes exactly two tier 2 attempts, blocks only the affected task, and does not repeat.
- Answer makes exactly two calls, records `question_failed`, leaves the answer null so the waiting worker receives its normal timeout directive, and does not stop the manager.

Add review contract cases where the response omits one requested task id, repeats a task id, or returns an id outside the requested batch.
Each must be treated as malformed output and receive exactly one correction attempt.

- [ ] **Step 2: Run the tests and verify repeated or crashing behavior**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "malformed"
```

Expected: current review and answer errors escape the manager path, and review work remains eligible to consume more calls later.

- [ ] **Step 3: Add a typed terminal contract error**

In `src/argus/brain.ts`, export:

```typescript
export class BrainContractError extends Error {
  constructor(
    readonly label: string,
    readonly causeMessage: string
  ) {
    super(`brain ${label} output was malformed twice: ${causeMessage}`);
    this.name = 'BrainContractError';
  }
}
```

In `brainJson`, catch the second parse failure, write `brain_abandoned`, and throw `BrainContractError`.
Do not add a third model call.

Add a batch-aware validator after `parseReview`:

```typescript
function validateReviewCoverage(tasks: Task[], verdicts: Verdict[]): Verdict[] {
  const expected = new Set(tasks.map((task) => task.id));
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    if (!expected.has(verdict.taskId)) throw new Error(`unexpected task id ${verdict.taskId}`);
    if (seen.has(verdict.taskId)) throw new Error(`duplicate verdict for ${verdict.taskId}`);
    seen.add(verdict.taskId);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`missing verdicts for ${missing.join(', ')}`);
  return verdicts;
}
```

Pass this validator inside the `brainJson` parse callback so semantic failures receive the same single correction attempt as invalid JSON.
Use the same validator with a one-task array for tier 2.

- [ ] **Step 4: Handle each call type once**

Use narrow catches around the call sites:

- `plan`: set Argus and manager session status to stopped, then rethrow for the foreground CLI.
- Tier 1 review: block every task in the attempted batch and record `review_failed`.
- Tier 2 review: block the one affected task and record `review_files_failed`.
- Answer: record `question_failed` and continue to the next pending question without marking the failed question answered.

Do not use a broad catch around the whole pulse.
Unexpected database, filesystem, or process errors must still surface normally.

- [ ] **Step 5: Verify containment**

Run:

```bash
npm run build
npx vitest run test/unit/brain-contract.test.ts test/integration/orchestration.test.ts
```

Expected: every malformed path makes exactly two calls and reaches a state that cannot be retried automatically.

- [ ] **Step 6: Commit**

```bash
git add src/argus/brain.ts src/argus/manager.ts test/unit/brain-contract.test.ts test/integration/orchestration.test.ts
git commit -m "fix(argus): contain malformed brain responses"
```

---

### Task 7: Prove the complete lifecycle and update operator documentation

**Files:**

- Modify: `test/e2e/argus.test.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: Tasks 1 through 6.
- Produces: one hermetic end-to-end lifecycle test and accurate operator documentation.

- [ ] **Step 1: Add a full fake-harness E2E**

Drive this exact sequence through real CLI processes and real MCP calls against a disposable repository:

1. The fake brain plans one task.
2. The fake worker calls `task_get` and sees conventions.
3. The fake worker changes a file and calls `report_done`.
4. The test gate fails once.
5. The same worker session receives a revision prompt in the same worktree.
6. The worker fixes the gate and reports again.
7. Tier 1 requests one source file.
8. Tier 2 receives that file and accepts.
9. The task reaches `done` with `attempts = 1`.
10. Brain invocation count is exactly three: plan, tier 1, and tier 2.

- [ ] **Step 2: Add a paused-budget E2E**

Seed the manager above 95 percent but below 100 percent.
Assert workers and gates continue, review stays queued, queue depth and next reset appear in `deck argus budget --json`, and a force-review drains the queue.

- [ ] **Step 3: Update README and CLAUDE.md narrowly**

Document:

- `--conventions`.
- The revision loop and attempt limit.
- The exact budget bands.
- The distinction between tier 1 summaries and tier 2 bounded files.
- The fact that worker questions wake independently of the mission pulse.

Remove any stale description of bullet-indexed Argus scheduling.

- [ ] **Step 4: Run every gate**

Run:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: every command exits zero and no test is skipped except explicit live-harness or missing-tmux guards.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/argus.test.ts README.md CLAUDE.md
git commit -m "test(argus): cover the complete orchestrator lifecycle"
```

---

## Acceptance Gate

The plan is complete only when all of the following are true:

- The plan and answer brain calls receive the selected project conventions note.
- `task_get` returns those conventions to the assigned worker.
- An uncached question is answered within its timeout even when the mission pulse is much longer.
- A gate failure or review rejection re-prompts the same session in the same worktree.
- Review and orphan failures block at the configured attempt limit.
- The 80 to 95 percent tier waits for four queued tasks or a 30-minute-old task.
- Force-review drains below 100 percent and refuses at 100 percent.
- Tier 1 never contains file contents.
- Tier 2 reads only bounded, non-secret files inside the assigned worktree.
- A repeated `need_files` verdict cannot create an unbounded brain loop.
- A brain response that is malformed twice reaches a visible terminal state after exactly two calls.
- The full hermetic lifecycle and all repository gates pass.
