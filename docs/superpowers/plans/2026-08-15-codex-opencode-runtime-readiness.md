# Codex Brain and OpenCode Worker Runtime Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the approved Codex-brain and OpenCode-worker topology selectable from the CLI and prove that both harnesses start with valid, writable, telemetry-friendly arguments.

**Architecture:** Harness argument construction stays in `src/sessions/harness.ts`.
Argus role and budget choices are stored on the existing `argus` row, exposed through the `Argus` type, and supplied through `deck argus start`.
The manager validates role restrictions before it creates any session or database row.

**Tech Stack:** TypeScript ESM, commander, `node:sqlite`, vitest, Codex CLI, OpenCode CLI.

**Spec:** [docs/superpowers/specs/2026-08-15-orchestrator-brain-design.md](../specs/2026-08-15-orchestrator-brain-design.md)

## Global Constraints

- Node 22.5 or newer is required.
- Keep the existing SQLite migration pattern in `src/core/state.ts`.
- Brain harnesses are exactly `claude` or `codex`.
- Worker harnesses are exactly `opencode` or `gemini`.
- Preserve the existing defaults of Claude for the brain and OpenCode for workers when flags are omitted.
- Validate all input before creating the manager session or Argus row.
- Never pass a session token in process arguments except inside the generated MCP server configuration already required by the isolation model.
- Unknown telemetry stays null and renders blank.
- Run `npm run build` before direct Vitest commands.
- Do not add native dependencies.
- Do not add co-author trailers to commits.

## File Structure

**Modified:**

| File | Responsibility |
| --- | --- |
| `src/core/types.ts` | Typed brain and worker roles plus the complete public `Argus` configuration. |
| `src/argus/manager.ts` | Validate and persist role, model, budget, and retry configuration. |
| `src/sessions/harness.ts` | Emit valid current Codex and OpenCode arguments. |
| `src/cli/commands/argus.ts` | Parse role and budget flags for `deck argus start`. |
| `test/unit/harness.test.ts` | Exact harness argument contracts. |
| `test/unit/schema.test.ts` | Public `Argus` mapping and persisted defaults. |
| `test/e2e/orchestrator-cli.test.ts` | CLI validation and configured start behavior. |
| `test/e2e/argus-live.test.ts` | Opt-in real Codex and OpenCode smoke test. |
| `README.md` | Document the selectable topology and flags. |
| `CLAUDE.md` | Remove stale statements about the pre-brain Argus implementation. |

**Dependency order:** Task 1 can land independently.
Task 2 must precede Task 3.
Task 4 depends on Tasks 1 through 3.

---

### Task 1: Correct Codex and OpenCode headless argument contracts

**Files:**

- Modify: `src/sessions/harness.ts`
- Modify: `test/unit/harness.test.ts`

**Interfaces:**

- Consumes: `HarnessAdapter.headlessArgs(prompt, opts)` and `HarnessAdapter.sessionArgs(prompt, opts)`.
- Produces: valid current CLI argument arrays for Codex and OpenCode.

- [ ] **Step 1: Write exact failing adapter tests**

Add these cases to `test/unit/harness.test.ts`:

```typescript
it('starts an autonomous OpenCode worker with the supported auto flag', () => {
  expect(getAdapter('opencode').sessionArgs('implement task', { autonomy: true })).toEqual([
    'run',
    '--format',
    'json',
    '--print-logs',
    '--auto',
    '--',
    'implement task',
  ]);
});

it('places Codex options before the prompt and grants workspace writes only in autonomy mode', () => {
  expect(getAdapter('codex').sessionArgs('plan work', { model: 'gpt-5.6-sol' })).toEqual([
    'exec',
    '--json',
    '--model',
    'gpt-5.6-sol',
    '--',
    'plan work',
  ]);

  expect(getAdapter('codex').sessionArgs('implement task', { autonomy: true })).toEqual([
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--approve-for-me',
    '--',
    'implement task',
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify the current implementation fails**

Run:

```bash
npm run build
npx vitest run test/unit/harness.test.ts
```

Expected: the OpenCode assertion fails because the current implementation emits `--permission allow`, and the Codex autonomy assertion fails because autonomy is ignored.

- [ ] **Step 3: Implement the minimal argument corrections**

Change only the Codex and OpenCode adapter argument builders.
Use `--` before the prompt so a prompt beginning with a hyphen cannot be parsed as a CLI option.

```typescript
sessionArgs: (prompt, opts) => {
  const args = ['exec', '--json'];
  if (opts.autonomy) {
    args.push('--sandbox', 'workspace-write', '--approve-for-me');
  }
  if (opts.model) args.push('--model', opts.model);
  args.push('--', prompt);
  return args;
},
```

```typescript
sessionArgs: (prompt, opts) => {
  const args = ['run', '--format', 'json', '--print-logs'];
  if (opts.autonomy) args.push('--auto');
  if (opts.model) args.push('--model', opts.model);
  args.push('--', prompt);
  return args;
},
```

Apply the same option ordering and supported autonomy flags to `headlessArgs` so playbook LLM steps do not retain a second, broken contract.

- [ ] **Step 4: Verify adapter tests and current local help**

Run:

```bash
npm run build
npx vitest run test/unit/harness.test.ts
opencode run --help
codex exec --help
```

Expected: tests pass, OpenCode help lists `--auto`, and Codex help lists `--sandbox`, `--approve-for-me`, and `--model`.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/harness.ts test/unit/harness.test.ts
git commit -m "fix(harness): start autonomous Codex and OpenCode sessions"
```

---

### Task 2: Make the complete Argus runtime configuration typed and persistent

**Files:**

- Modify: `src/core/types.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/unit/schema.test.ts`

**Interfaces:**

- Consumes: existing columns on the `argus` table.
- Produces: `BrainHarness`, `WorkerHarness`, the complete `Argus` shape, and validated `StartArgusOptions` fields.

- [ ] **Step 1: Add failing persistence and validation tests**

Add tests that start an Argus manager without running its loop:

```typescript
it('persists and returns the selected brain, workers, models, and limits', () => {
  const manager = new ArgusManager(fixture.root);
  const argus = manager.start({
    name: 'codex-opencode',
    brainHarness: 'codex',
    brainPlanModel: 'gpt-5.6-sol',
    brainReviewModel: 'gpt-5.6-terra',
    workerHarnesses: ['opencode'],
    budgetWindowSec: 7200,
    budgetMaxTokens: 250000,
    maxAttemptsPerTask: 4,
    maxTasks: 24,
    questionTimeoutSec: 45,
  });

  expect(argus).toMatchObject({
    brainHarness: 'codex',
    brainPlanModel: 'gpt-5.6-sol',
    brainReviewModel: 'gpt-5.6-terra',
    workerHarnesses: ['opencode'],
    budgetWindowSec: 7200,
    budgetMaxTokens: 250000,
    maxAttemptsPerTask: 4,
    maxTasks: 24,
    questionTimeoutSec: 45,
  });
});

it('rejects invalid roles before creating rows', () => {
  const manager = new ArgusManager(fixture.root);
  expect(() => manager.start({ brainHarness: 'opencode' as never })).toThrow(/brain harness/);
  expect(() => manager.start({ workerHarnesses: [] })).toThrow(/worker harness/);
  expect(manager.list()).toHaveLength(0);
  expect(new SessionManager(fixture.root).list()).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts
```

Expected: TypeScript or assertions fail because the fields are not in `StartArgusOptions` or `Argus`.

- [ ] **Step 3: Add role types and expose every stored field**

Add these public types in `src/core/types.ts`:

```typescript
export type BrainHarness = Extract<HarnessKind, 'claude' | 'codex'>;
export type WorkerHarness = Extract<HarnessKind, 'opencode' | 'gemini'>;
```

Extend `Argus` with:

```typescript
brainHarness: BrainHarness;
brainPlanModel: string | null;
brainReviewModel: string | null;
workerHarnesses: WorkerHarness[];
budgetWindowSec: number;
budgetMaxTokens: number;
budgetCountCacheReads: boolean;
maxAttemptsPerTask: number;
maxTasks: number;
questionTimeoutSec: number;
```

Extend `StartArgusOptions` with the matching camel-case fields.

- [ ] **Step 4: Validate before side effects and persist all values**

Create a pure validator near `StartArgusOptions`:

```typescript
function validateStartOptions(opts: StartArgusOptions): void {
  if (opts.brainHarness !== undefined && !['claude', 'codex'].includes(opts.brainHarness)) {
    throw new Error(`brain harness must be claude or codex (got ${opts.brainHarness})`);
  }
  if (opts.workerHarnesses !== undefined) {
    if (opts.workerHarnesses.length === 0) throw new Error('at least one worker harness is required');
    const invalid = opts.workerHarnesses.find((h) => h !== 'opencode' && h !== 'gemini');
    if (invalid) throw new Error(`worker harness must be opencode or gemini (got ${invalid})`);
  }
  for (const [name, value] of [
    ['budget window', opts.budgetWindowSec],
    ['budget maximum', opts.budgetMaxTokens],
    ['maximum attempts', opts.maxAttemptsPerTask],
    ['maximum tasks', opts.maxTasks],
    ['question timeout', opts.questionTimeoutSec],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
}
```

Call it as the first statement in `start()`.
Extend the `INSERT INTO argus` statement to set every configurable column explicitly.
Map every field in `rowToArgus`, parsing `worker_harnesses` from JSON and falling back to `['opencode']` only for a corrupt legacy row.
Return `this.get(id)!` from `start()` after insertion so the caller sees database defaults and persisted values through one mapping path.

Use a defensive parser rather than a direct cast:

```typescript
function parseWorkerHarnesses(raw: unknown): WorkerHarness[] {
  try {
    const parsed = JSON.parse(typeof raw === 'string' ? raw : '[]') as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((value) => value === 'opencode' || value === 'gemini')
    ) {
      return parsed;
    }
  } catch {
    // Legacy or externally corrupted row falls through to the safe default.
  }
  return ['opencode'];
}
```

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts test/unit/brain-invoke.test.ts test/unit/budget.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/argus/manager.ts test/unit/schema.test.ts
git commit -m "feat(argus): persist selectable brain and worker roles"
```

---

### Task 3: Expose role, model, and budget configuration through the CLI

**Files:**

- Modify: `src/cli/commands/argus.ts`
- Modify: `test/e2e/orchestrator-cli.test.ts`

**Interfaces:**

- Consumes: the extended `StartArgusOptions` from Task 2.
- Produces: validated `deck argus start` flags and complete JSON status output.

- [ ] **Step 1: Write failing CLI validation tests**

Add tests for the command help and invalid values:

```typescript
it('documents the Codex brain and OpenCode worker flags', () => {
  const result = runCli(['argus', 'start', '--help'], { cwd: fixture.root });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('--brain-harness <claude|codex>');
  expect(result.stdout).toContain('--worker-harness <opencode|gemini>');
  expect(result.stdout).toContain('--budget-max-tokens <count>');
});

it('rejects an invalid brain before starting the foreground loop', () => {
  const result = runCli([
    'argus',
    'start',
    '--mission-body',
    'test mission',
    '--brain-harness',
    'opencode',
  ], { cwd: fixture.root });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('brain harness must be claude or codex');
});
```

- [ ] **Step 2: Run the CLI tests and verify they fail**

Run:

```bash
npm run build
npx vitest run test/e2e/orchestrator-cli.test.ts
```

Expected: the new flags are absent and the invalid option is rejected by commander or ignored with the wrong message.

- [ ] **Step 3: Register exact CLI options**

Add these options to `argus start`:

```typescript
.option('--brain-harness <claude|codex>', 'reasoning brain harness', 'claude')
.option('--brain-plan-model <model>', 'model for planning and tier 2 review')
.option('--brain-review-model <model>', 'model for tier 1 review and answers')
.option(
  '--worker-harness <opencode|gemini>',
  'worker harness, repeat for round-robin workers',
  (value: string, prior: string[]) => [...prior, value],
  []
)
.option('--budget-window <duration>', 'rolling brain budget window, for example 2h')
.option('--budget-max-tokens <count>', 'maximum brain tokens in the window')
.option('--max-attempts <count>', 'attempt limit per task')
.option('--max-tasks <count>', 'task count ceiling for the mission')
.option('--question-timeout <duration>', 'worker question timeout')
```

Convert duration flags with `parseSeconds` and integer flags with a helper that rejects non-integers.
When no `--worker-harness` is provided, pass `undefined` so the database default stays authoritative.
Do not cast arbitrary strings directly to the role types before validation.

Add these CLI-boundary helpers:

```typescript
function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function brainHarness(value: string): BrainHarness {
  if (value !== 'claude' && value !== 'codex') {
    throw new Error(`brain harness must be claude or codex (got ${value})`);
  }
  return value;
}

function workerHarnesses(values: string[]): WorkerHarness[] | undefined {
  if (values.length === 0) return undefined;
  for (const value of values) {
    if (value !== 'opencode' && value !== 'gemini') {
      throw new Error(`worker harness must be opencode or gemini (got ${value})`);
    }
  }
  return values as WorkerHarness[];
}
```

Call these helpers before `manager.start()`.

- [ ] **Step 4: Add a configured-start process test**

Use `spawnCli` with fake `codex` and `opencode` binaries, wait until the Argus row exists, then inspect `ArgusManager.list()` and terminate the foreground process.
Assert the row contains `brainHarness: 'codex'`, `workerHarnesses: ['opencode']`, the selected models, and budget values.
The fake Codex binary must return a valid plan JSON object so the process reaches dispatch.

- [ ] **Step 5: Verify CLI tests**

Run:

```bash
npm run build
npx vitest run test/e2e/orchestrator-cli.test.ts test/e2e/argus.test.ts
```

Expected: all tests pass and the spawned process exits cleanly on `SIGTERM`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/argus.ts test/e2e/orchestrator-cli.test.ts
git commit -m "feat(cli): configure Argus brain and worker roles"
```

---

### Task 4: Add an opt-in real Codex and OpenCode topology smoke test

**Files:**

- Create: `test/e2e/argus-live.test.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: real `codex` and `opencode` binaries, configured credentials, and the CLI flags from Task 3.
- Produces: an explicitly gated acceptance test that proves the selected topology can plan, edit, call MCP, and report.

- [ ] **Step 1: Add a skip-guarded live test**

Create a test that runs only when `FLIGHTDECK_LIVE_ARGUS_E2E=1` and both harness binaries are detected.
The disposable repository must contain one file and a mission that asks the worker to add one line, run a one-command test gate, and call `report_done`.
Use a budget ceiling small enough for a smoke test and a two-minute test timeout.

The final assertions must be:

```typescript
expect(argus.brainHarness).toBe('codex');
expect(argus.workerHarnesses).toEqual(['opencode']);
expect(board.list(argus.id)).toHaveLength(1);
expect(board.list(argus.id)[0].workerReport).not.toBeNull();
expect(fs.readFileSync(path.join(worker.cwd, 'proof.txt'), 'utf8')).toContain('OpenCode worker completed');
const brainSession = new SessionManager(fixture.root)
  .list()
  .find((session) => session.policy === 'brain' && session.argusParent === argus.id);
expect(brainSession).toBeDefined();
expect(new TelemetryStore(fixture.root).get(brainSession!.id)?.model).not.toBeNull();
```

Do not enable this test in normal CI because it consumes authenticated model capacity.

- [ ] **Step 2: Run the hermetic suite**

Run:

```bash
npm test
```

Expected: the live test is skipped and every hermetic test passes.

- [ ] **Step 3: Run the live test once in an authenticated environment**

Run:

```bash
FLIGHTDECK_LIVE_ARGUS_E2E=1 npx vitest run test/e2e/argus-live.test.ts
```

Expected: one Codex brain session plans one task, one OpenCode worker changes the disposable worktree, and the worker reports through Flightdeck MCP.

- [ ] **Step 4: Correct user-facing documentation**

Add a README example:

```bash
deck argus start \
  --name codex-opencode \
  --mission <note-id> \
  --brain-harness codex \
  --brain-plan-model gpt-5.6-sol \
  --brain-review-model gpt-5.6-terra \
  --worker-harness opencode \
  --budget-window 2h \
  --budget-max-tokens 250000
```

Update `CLAUDE.md` so its Argus section describes the task board, brain calls, objective gates, budget, and worker roles that are now implemented.
Remove the stale statement that telemetry is not built.
Do not rewrite unrelated README sections.

- [ ] **Step 5: Run every gate**

Run:

```bash
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/argus-live.test.ts README.md CLAUDE.md
git commit -m "test(argus): verify Codex brain with OpenCode worker"
```

---

## Acceptance Gate

The plan is complete only when all of the following are true:

- `opencode` autonomy uses `--auto`, not the unsupported `--permission allow` form.
- Codex autonomy receives workspace-write capability without a read-only default blocking edits.
- `deck argus start` can select Codex as the brain and OpenCode as the worker without direct database edits.
- `deck argus status --json` returns the persisted role, model, and budget configuration.
- Invalid roles and non-positive limits fail before any Argus or session row is created.
- The hermetic suite passes.
- The opt-in live topology test has been run successfully once before release.
