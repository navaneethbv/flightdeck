# Argus Quota and Mission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Argus missions share one real subscription's token budget across projects, back off together on a real provider throttle, and give an operator a working stop, a pause/resume, and a scriptable alert hook for a mission's lifecycle.

**Architecture:** A new global SQLite store (`~/.flightdeck/quotas.db`, or `$FLIGHTDECK_HOME/quotas.db`) holds named quota pools and a token usage ledger, mirroring the existing per-project `state.db` pattern (`DatabaseSync`, WAL, `busy_timeout`). `budgetState()` gains one branch that sources spend from a quota when a mission is attached to one, and every other consumer of `BudgetState` is unchanged. The `runForever` scheduler loop, already ticking on a cheap local read every ≤250ms, gains a fresh `status` read each tick so `stop` (fixed) and the new `paused` status take effect regardless of which process wrote them, and a `throttled_until` check that gates every brain call the same way. A second hook directory (`.flightdeck/hooks/on-event/`) reuses the existing `post-create` hook mechanism, fired from the single `writeProgress()` call every state transition already goes through.

**Tech Stack:** TypeScript ESM, `node:sqlite`, zod, vitest, existing harness adapters.

**Spec:** [docs/superpowers/specs/2026-08-16-argus-shared-quota-design.md](../specs/2026-08-16-argus-shared-quota-design.md) and [docs/superpowers/specs/2026-08-16-argus-mission-control-design.md](../specs/2026-08-16-argus-mission-control-design.md)

## Global Constraints

- **No task, test, or fixture in this plan may spawn a real `claude`, `codex`, `opencode`, or `gemini` CLI.** Every test that needs a harness process puts a fake executable (a `#!/bin/bash` script under a temp `binDir`, prepended to `PATH`) on disk and points the session at that. This repo already forbids real harness spawns in tests via `process.env.FLIGHTDECK_FORBID_REAL_HARNESS = '1'`, set globally in `test/setup.ts`; never unset it, never work around it, and never add a test that omits a fake binary on `PATH` before invoking anything that spawns a harness (`ArgusManager.plan`/`drainReviews`/`answerQuestions` with the real `invokeBrain`, `SessionManager.startSession`, or a spawned `deck argus start`). If a step in this plan needs a brain response, either inject a fake `BrainFn` (`fakeBrain(...)` in `test/integration/orchestration.test.ts`) so no process is spawned at all, or write a fake harness script (`makeFakeHarness` / the inline pattern in `makeWakingBrain`, both in `test/helpers.ts` and `test/integration/orchestration.test.ts`) that echoes canned output and exits immediately. Never install or shell out to a real coding-agent CLI, never hit a real model API, and never remove or bypass `FLIGHTDECK_FORBID_REAL_HARNESS`.
- Tier 1 review never receives file contents (unchanged from the parent spec; nothing in this plan touches that).
- Never attach generated MCP configuration, `.flightdeck` state, Git internals, or environment files to a brain prompt (unchanged).
- Keep unknown usage, unknown reset time, and unknown throttle state nullable. Never render or fabricate a zero or a guessed value where the true value is unknown.
- A quota's ceiling and window are self-imposed, observed-consumption estimates, exactly like the parent per-mission budget. Do not invent a way to read a provider's real remaining allowance; none exists.
- `deck argus start --quota <id>` and `--budget-window`/`--budget-max-tokens` are mutually exclusive. Reject the combination with a clear error rather than silently picking one.
- A hook script failure (post-create or on-event) must never crash the scheduler loop except for post-create, whose failure legitimately blocks worktree creation as it already does today. An on-event hook failure is caught, logged as a warning, and otherwise ignored.
- Run `npm run build` before direct Vitest commands.
- Do not add native dependencies.
- Do not add co-author trailers to commits.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/argus/quota.ts` | Global quota store: CRUD, the `quota_usage` ledger, throttle read/write. |
| `src/argus/hooks.ts` | Discover and run `.flightdeck/hooks/on-event/*.sh`, non-throwing. |
| `src/cli/commands/quota.ts` | `deck quota create/list/show`. |
| `test/unit/quota.test.ts` | Quota CRUD, ledger windowing, throttle read/write. |
| `test/unit/hooks.test.ts` | On-event hook discovery, env contents, non-throwing failure. |
| `test/unit/rate-limit.test.ts` | `detectRateLimit` parsers for claude and codex. |

**Modified:**

| File | Responsibility |
| --- | --- |
| `src/core/paths.ts` | `quotasDbPath()`. |
| `src/core/state.ts` | `argus` table gains `quota_id`, `throttled_until`. |
| `src/core/types.ts` | `Argus.status` gains `'paused'`; `Argus` gains `quotaId`, `throttledUntil`. |
| `src/sessions/harness.ts` | Optional `detectRateLimit` on `HarnessAdapter`, implemented for claude and codex. |
| `src/argus/budget.ts` | `BudgetState` gains `throttledUntil`; `budgetState()` sources spend from a quota when attached. |
| `src/argus/brain.ts` | `BrainThrottledError`; `invokeBrain` records quota usage after a quota-attached brain session. |
| `src/argus/manager.ts` | Scheduler loop status handling (stop fix, pause/resume), throttle gating before every brain call, on-event hook dispatch from `writeProgress`, `quotaId` wiring into `start()`. |
| `src/cli/commands/argus.ts` | `--quota` flag, `deck argus pause`/`resume`, budget/status rendering for quota id and throttle. |
| `src/cli/commands/fleet.tsx` | `ConsoleSnapshot` gains mission status, quota id, and throttle; distinct `paused` rendering. |
| `src/cli/index.ts` | Register `deck quota`. |
| `test/unit/schema.test.ts` | New `argus` columns. |
| `test/unit/budget.test.ts` | Quota-sourced spend and `throttledUntil`. |
| `test/unit/fleet-console-view.test.tsx` | Paused rendering, quota and throttle line. |
| `test/integration/orchestration.test.ts` | Quota validation at `start()`, throttle skip at every brain call site, pause/resume, quota ledger after a real (fake-binary) brain session, cross-process stop. |
| `README.md`, `CLAUDE.md` | Document `--quota`, `deck quota`, pause/resume, and on-event hooks. |

**Dependency order:** Task 1 is independent.
Task 2 depends on Task 1 (the `quota_id`/`throttled_until` columns it validates against).
Task 3 and Task 4 are independent of everything else.
Task 5 depends on Task 1 and Task 2.
Task 6 depends on Tasks 1 through 5.
Task 7 depends on Tasks 2 and 6.
Task 8 depends on Tasks 6 and 7.
Task 9 depends on all earlier tasks.

---

### Task 1: Schema and type extensions for `paused` status, quota id, and throttle

**Files:**

- Modify: `src/core/state.ts`
- Modify: `src/core/types.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/unit/schema.test.ts`

**Interfaces:**

- Consumes: nothing from another task.
- Produces: `argus.quota_id`, `argus.throttled_until` columns; `Argus.status` including `'paused'`; `Argus.quotaId`, `Argus.throttledUntil`; `StartArgusOptions.quotaId`.

- [ ] **Step 1: Write a failing schema test**

Add to `test/unit/schema.test.ts`, inside the existing `describe('orchestrator schema', ...)` block:

```typescript
it('adds quota_id and throttled_until to the argus table', () => {
  const fixture = makeRepo();
  try {
    const cols = columns(getDb(fixture.root), 'argus');
    expect(cols).toEqual(expect.arrayContaining(['quota_id', 'throttled_until']));
  } finally {
    fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts -t "quota_id and throttled_until"
```

Expected: FAIL, the two columns are absent.

- [ ] **Step 3: Add the columns**

In `src/core/state.ts`, extend the `lateColumns` array (it already contains `['sessions', 'claimed_at INTEGER']` and `['tasks', 'priority INTEGER NOT NULL DEFAULT 0']`):

```typescript
const lateColumns: [string, string][] = [
  ['sessions', 'claimed_at INTEGER'],
  ['tasks', 'priority INTEGER NOT NULL DEFAULT 0'],
  ['argus', 'quota_id TEXT'],
  ['argus', 'throttled_until INTEGER'],
];
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run:

```bash
npm run build
npx vitest run test/unit/schema.test.ts -t "quota_id and throttled_until"
```

Expected: PASS.

- [ ] **Step 5: Extend the types**

In `src/core/types.ts`, change:

```typescript
status: 'running' | 'stopped';
```

to:

```typescript
status: 'running' | 'stopped' | 'paused';
```

and add two fields to the `Argus` interface, immediately after `conventionsNoteId: string | null;`:

```typescript
  quotaId: string | null;
  throttledUntil: number | null;
```

- [ ] **Step 6: Wire the fields through `ArgusManager`**

In `src/argus/manager.ts`, add `quotaId?: string` to `StartArgusOptions`, immediately after `conventionsNoteId?: string;`:

```typescript
  conventionsNoteId?: string;
  quotaId?: string;
```

In `rowToArgus`, add two mapped fields immediately after `conventionsNoteId: ...`:

```typescript
    conventionsNoteId: typeof row.conventions_note_id === 'string' ? row.conventions_note_id : null,
    quotaId: typeof row.quota_id === 'string' ? row.quota_id : null,
    throttledUntil: row.throttled_until === null || row.throttled_until === undefined ? null : Number(row.throttled_until),
```

In `start()`, add `quotaId: opts.quotaId ?? null,` to the `argus` object literal immediately after `conventionsNoteId: opts.conventionsNoteId ?? null,`, and add `throttledUntil: null,` right after it (a mission never starts throttled). Then extend the `INSERT INTO argus (...)` column list and placeholder count to include `quota_id`, and pass `argus.quotaId` as the corresponding bound value, immediately after the existing `conventions_note_id` column and `argus.conventionsNoteId` value. `throttled_until` needs no explicit `INSERT` value; the column has no `NOT NULL` constraint, so an omitted column defaults to `NULL`.

The full statement becomes:

```typescript
    this.db
      .prepare(
        `INSERT INTO argus (
          id, name, project_root, mission_note_id, cap, child_limit, pulse_sec, risky_tools,
          status, manager_session_id, created_at, last_pulse_at,
          brain_harness, brain_plan_model, brain_review_model, worker_harnesses,
          budget_window_sec, budget_max_tokens, budget_count_cache_reads,
          max_attempts_per_task, max_tasks, question_timeout_sec, conventions_note_id, quota_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        argus.id,
        argus.name,
        argus.projectRoot,
        argus.missionNoteId,
        argus.cap,
        argus.childLimit,
        argus.pulseSec,
        argus.riskyTools ? 1 : 0,
        argus.status,
        argus.managerSessionId,
        argus.createdAt,
        argus.lastPulseAt,
        argus.brainHarness,
        argus.brainPlanModel,
        argus.brainReviewModel,
        JSON.stringify(argus.workerHarnesses),
        argus.budgetWindowSec,
        argus.budgetMaxTokens,
        argus.budgetCountCacheReads ? 1 : 0,
        argus.maxAttemptsPerTask,
        argus.maxTasks,
        argus.questionTimeoutSec,
        argus.conventionsNoteId,
        argus.quotaId
      );
```

- [ ] **Step 7: Typecheck and run the full unit suite**

Run:

```bash
npm run build
npm run typecheck
npx vitest run test/unit/schema.test.ts
```

Expected: all pass. (Other suites that construct an `Argus` object literal directly, if any exist, will fail to typecheck until they add the two new fields; `npm run typecheck` is the authoritative check here.)

- [ ] **Step 8: Commit**

```bash
git add src/core/state.ts src/core/types.ts src/argus/manager.ts test/unit/schema.test.ts
git commit -m "feat(argus): add quota id, throttle, and paused status to the schema"
```

---

### Task 2: Global quota store and validation at `start()`

**Files:**

- Modify: `src/core/paths.ts`
- Create: `src/argus/quota.ts`
- Modify: `src/argus/manager.ts`
- Create: `test/unit/quota.test.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: `argus.quota_id` from Task 1; `FLIGHTDECK_HOME` / `globalDir` from `src/core/paths.ts`.
- Produces: `createQuota`, `getQuota`, `listQuotas`, `recordQuotaUsage`, `quotaSpent`, `quotaOldestUsage`, `setQuotaThrottle`, all exported from `src/argus/quota.ts`; `ArgusManager.start()` validates `opts.quotaId`.

- [ ] **Step 1: Write failing quota store tests**

Create `test/unit/quota.test.ts`:

```typescript
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  createQuota,
  getQuota,
  listQuotas,
  recordQuotaUsage,
  quotaSpent,
  quotaOldestUsage,
  setQuotaThrottle,
} from '../../src/argus/quota.js';

function freshId(): string {
  return `quota-${crypto.randomUUID().slice(0, 8)}`;
}

describe('quota store', () => {
  it('creates and reads back a quota', () => {
    const id = freshId();
    const created = createQuota(id, { maxTokens: 1_000_000, windowSec: 7200 });
    expect(created).toMatchObject({ id, maxTokens: 1_000_000, windowSec: 7200, countCacheReads: true, throttledUntil: null });
    expect(getQuota(id)).toMatchObject({ id, maxTokens: 1_000_000 });
  });

  it('rejects creating the same quota id twice', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 60 });
    expect(() => createQuota(id, { maxTokens: 2000, windowSec: 60 })).toThrow(/already exists/);
  });

  it('returns null for an unknown quota', () => {
    expect(getQuota(freshId())).toBeNull();
  });

  it('lists every created quota', () => {
    const a = freshId();
    const b = freshId();
    createQuota(a, { maxTokens: 1000, windowSec: 60 });
    createQuota(b, { maxTokens: 2000, windowSec: 60 });
    const ids = listQuotas().map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
  });

  it('sums usage inside the window and ignores usage outside it', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    recordQuotaUsage(id, 100);
    recordQuotaUsage(id, 50);
    expect(quotaSpent(id, 3600)).toBe(150);
    // A window of zero seconds excludes usage recorded just now.
    expect(quotaSpent(id, 0)).toBe(0);
  });

  it('reports the oldest in-window usage timestamp, or null when empty', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    expect(quotaOldestUsage(id, 3600)).toBeNull();
    const before = Date.now();
    recordQuotaUsage(id, 10);
    const oldest = quotaOldestUsage(id, 3600);
    expect(oldest).not.toBeNull();
    expect(oldest as number).toBeGreaterThanOrEqual(before);
  });

  it('sets and reads a throttle timestamp', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    const until = Date.now() + 60_000;
    setQuotaThrottle(id, until);
    expect(getQuota(id)?.throttledUntil).toBe(until);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails to import**

Run:

```bash
npm run build
npx vitest run test/unit/quota.test.ts
```

Expected: FAIL, `src/argus/quota.ts` does not exist.

- [ ] **Step 3: Add `quotasDbPath()`**

In `src/core/paths.ts`, add:

```typescript
export function quotasDbPath(): string {
  return path.join(globalDir, 'quotas.db');
}
```

- [ ] **Step 4: Implement the quota store**

Create `src/argus/quota.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quotasDbPath } from '../core/paths.js';
import { now } from '../core/state.js';

let quotaDb: DatabaseSync | null = null;

/**
 * Opens (or returns the cached handle to) the global quota store, shared by
 * every project and every process on the machine that points at the same
 * FLIGHTDECK_HOME. WAL mode is what already makes concurrent multi-process
 * access to one SQLite file safe elsewhere in this codebase; two `deck argus
 * start` processes in two different projects opening this same file is
 * exactly that case.
 */
export function getQuotaDb(): DatabaseSync {
  if (quotaDb) return quotaDb;
  const dbPath = quotasDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota (
      id TEXT PRIMARY KEY,
      max_tokens INTEGER NOT NULL,
      window_sec INTEGER NOT NULL,
      count_cache_reads INTEGER NOT NULL DEFAULT 1,
      throttled_until INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_usage (
      quota_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_usage_quota ON quota_usage(quota_id, recorded_at);
  `);
  quotaDb = db;
  return db;
}

/** Test-only: drop the cached handle so a later `getQuotaDb()` reopens the file. */
export function closeQuotaDb(): void {
  if (quotaDb) {
    quotaDb.close();
    quotaDb = null;
  }
}

export interface Quota {
  id: string;
  maxTokens: number;
  windowSec: number;
  countCacheReads: boolean;
  throttledUntil: number | null;
  createdAt: number;
}

function rowToQuota(row: Record<string, unknown>): Quota {
  return {
    id: String(row.id),
    maxTokens: Number(row.max_tokens),
    windowSec: Number(row.window_sec),
    countCacheReads: Number(row.count_cache_reads) === 1,
    throttledUntil: row.throttled_until === null || row.throttled_until === undefined ? null : Number(row.throttled_until),
    createdAt: Number(row.created_at),
  };
}

export interface CreateQuotaOptions {
  maxTokens: number;
  windowSec: number;
  countCacheReads?: boolean;
}

export function createQuota(id: string, opts: CreateQuotaOptions): Quota {
  const db = getQuotaDb();
  const existing = db.prepare('SELECT 1 FROM quota WHERE id = ?').get(id);
  if (existing) throw new Error(`quota "${id}" already exists`);
  db.prepare(
    'INSERT INTO quota (id, max_tokens, window_sec, count_cache_reads, throttled_until, created_at) VALUES (?, ?, ?, ?, NULL, ?)'
  ).run(id, opts.maxTokens, opts.windowSec, opts.countCacheReads === false ? 0 : 1, now());
  return getQuota(id)!;
}

export function getQuota(id: string): Quota | null {
  const row = getQuotaDb().prepare('SELECT * FROM quota WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToQuota(row) : null;
}

export function listQuotas(): Quota[] {
  const rows = getQuotaDb().prepare('SELECT * FROM quota ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToQuota);
}

/** Appends one usage row. Called once per finished brain session attached to this quota. */
export function recordQuotaUsage(quotaId: string, tokens: number): void {
  getQuotaDb()
    .prepare('INSERT INTO quota_usage (quota_id, tokens, recorded_at) VALUES (?, ?, ?)')
    .run(quotaId, tokens, now());
}

export function quotaSpent(quotaId: string, windowSec: number): number {
  const windowStart = now() - windowSec * 1000;
  const row = getQuotaDb()
    .prepare('SELECT COALESCE(SUM(tokens), 0) AS spent FROM quota_usage WHERE quota_id = ? AND recorded_at > ?')
    .get(quotaId, windowStart) as { spent: number };
  return Number(row.spent);
}

/** Oldest in-window usage timestamp, or null when the quota has no usage inside the window. */
export function quotaOldestUsage(quotaId: string, windowSec: number): number | null {
  const windowStart = now() - windowSec * 1000;
  const row = getQuotaDb()
    .prepare('SELECT MIN(recorded_at) AS oldest FROM quota_usage WHERE quota_id = ? AND recorded_at > ?')
    .get(quotaId, windowStart) as { oldest: number | null };
  return row.oldest === null ? null : Number(row.oldest);
}

export function setQuotaThrottle(quotaId: string, throttledUntil: number): void {
  getQuotaDb().prepare('UPDATE quota SET throttled_until = ? WHERE id = ?').run(throttledUntil, quotaId);
}
```

- [ ] **Step 5: Run the quota store tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/unit/quota.test.ts
```

Expected: PASS.

- [ ] **Step 6: Validate `opts.quotaId` at `start()`**

In `src/argus/manager.ts`, add an import:

```typescript
import { getQuota } from './quota.js';
```

In `validateStartOptions`, add, after the existing `workerHarnesses` block:

```typescript
  if (opts.quotaId !== undefined && (opts.budgetWindowSec !== undefined || opts.budgetMaxTokens !== undefined)) {
    throw new Error('cannot combine --quota with --budget-window or --budget-max-tokens; the quota owns those numbers');
  }
```

In `start()`, add a resolution check immediately after the existing conventions-note check:

```typescript
    if (opts.conventionsNoteId && !this.notes.readNote(opts.conventionsNoteId)) {
      throw new Error(`conventions note "${opts.conventionsNoteId}" not found`);
    }
    if (opts.quotaId && !getQuota(opts.quotaId)) {
      throw new Error(`quota "${opts.quotaId}" not found`);
    }
```

- [ ] **Step 7: Write failing integration tests for the new validation**

Add to `test/integration/orchestration.test.ts`, near the existing `'rejects a conventions note id that does not exist'` test:

```typescript
  it('rejects a quota id that does not exist', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      expect(() => manager.start({ quotaId: 'nope' })).toThrow(/quota "nope" not found/);
      expect(manager.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects --quota combined with --budget-window or --budget-max-tokens', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      expect(() => manager.start({ quotaId: 'q1', budgetWindowSec: 3600 })).toThrow(/cannot combine --quota/);
      expect(() => manager.start({ quotaId: 'q1', budgetMaxTokens: 1000 })).toThrow(/cannot combine --quota/);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a mission attached to an existing quota', () => {
    const fixture = makeRepo();
    try {
      createQuota('shared-account', { maxTokens: 500_000, windowSec: 7200 });
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({ quotaId: 'shared-account' });
      expect(argus.quotaId).toBe('shared-account');
    } finally {
      fixture.cleanup();
    }
  });
```

Add the import at the top of the file:

```typescript
import { createQuota } from '../../src/argus/quota.js';
```

Note: `createQuota('shared-account', ...)` uses a fixed id deliberately, to prove the id round-trips through `start()`; if this test is ever run more than once against the same `FLIGHTDECK_HOME` without a fresh temp home per file (as `test/setup.ts` already guarantees per file), give it a `crypto.randomUUID()`-suffixed id instead.

- [ ] **Step 8: Run the full suite and confirm it passes**

Run:

```bash
npm run build
npx vitest run test/unit/quota.test.ts test/integration/orchestration.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/paths.ts src/argus/quota.ts src/argus/manager.ts test/unit/quota.test.ts test/integration/orchestration.test.ts
git commit -m "feat(argus): add a global quota store and validate --quota at start"
```

---

### Task 3: On-event hooks

**Files:**

- Create: `src/argus/hooks.ts`
- Modify: `src/argus/manager.ts`
- Create: `test/unit/hooks.test.ts`

**Interfaces:**

- Consumes: nothing from another task.
- Produces: `runOnEventHooks(projectRoot, event, argusId, sessionId, detail)`, called from inside `ArgusManager.writeProgress()`.

- [ ] **Step 1: Write failing hook discovery tests**

Create `test/unit/hooks.test.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { runOnEventHooks } from '../../src/argus/hooks.js';
import { makeRepo } from '../helpers.js';

function hooksDir(projectRoot: string): string {
  return path.join(projectRoot, '.flightdeck', 'hooks', 'on-event');
}

function writeHook(projectRoot: string, filename: string, script: string): void {
  const dir = hooksDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), script, { mode: 0o755 });
}

describe('runOnEventHooks', () => {
  it('does nothing when no hook directory exists', () => {
    const fixture = makeRepo();
    try {
      expect(() =>
        runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', 'session-1', 'task X blocked')
      ).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('runs every *.sh hook with the event env vars set', () => {
    const fixture = makeRepo();
    const envFile = path.join(fixture.root, 'env-seen.txt');
    try {
      writeHook(
        fixture.root,
        '01-record.sh',
        `#!/bin/bash\necho "$FLIGHTDECK_EVENT|$FLIGHTDECK_ARGUS_ID|$FLIGHTDECK_SESSION|$FLIGHTDECK_MESSAGE" > "${envFile}"\n`
      );
      runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', 'session-1', 'task X blocked');
      const seen = fs.readFileSync(envFile, 'utf8').trim();
      expect(seen).toBe('task_blocked|argus-1|session-1|task X blocked');
    } finally {
      fixture.cleanup();
    }
  });

  it('omits FLIGHTDECK_SESSION when no session is related to the event', () => {
    const fixture = makeRepo();
    const envFile = path.join(fixture.root, 'env-seen.txt');
    try {
      writeHook(
        fixture.root,
        '01-record.sh',
        `#!/bin/bash\necho "session=[$FLIGHTDECK_SESSION]" > "${envFile}"\n`
      );
      runOnEventHooks(fixture.root, 'argus_paused', 'argus-1', null, '');
      expect(fs.readFileSync(envFile, 'utf8').trim()).toBe('session=[]');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not throw when a hook script fails', () => {
    const fixture = makeRepo();
    try {
      writeHook(fixture.root, '01-fail.sh', '#!/bin/bash\nexit 1\n');
      expect(() => runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', null, '')).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });

  it('ignores non-.sh files in the hook directory', () => {
    const fixture = makeRepo();
    const dir = hooksDir(fixture.root);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'README.md'), 'not a hook');
      expect(() => runOnEventHooks(fixture.root, 'task_blocked', 'argus-1', null, '')).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails to import**

Run:

```bash
npm run build
npx vitest run test/unit/hooks.test.ts
```

Expected: FAIL, `src/argus/hooks.ts` does not exist.

- [ ] **Step 3: Implement the hook runner**

Create `src/argus/hooks.ts`:

```typescript
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../core/logger.js';

function onEventHooksDir(projectRoot: string): string {
  return path.join(projectRoot, '.flightdeck', 'hooks', 'on-event');
}

/**
 * Runs every `.flightdeck/hooks/on-event/*.sh` script for one Argus progress
 * event, in sorted order, mirroring the existing post-create hook mechanism
 * in `src/worktrees/manager.ts`. Unlike a post-create hook, whose failure
 * legitimately blocks worktree creation, a broken alert script must never
 * take the scheduler down with it: every failure is caught and logged as a
 * warning, never thrown.
 */
export function runOnEventHooks(
  projectRoot: string,
  event: string,
  argusId: string,
  sessionId: string | null,
  detail: string
): void {
  const dir = onEventHooksDir(projectRoot);
  if (!fs.existsSync(dir)) return;
  let scripts: string[];
  try {
    scripts = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sh'))
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    log.warn(`failed to list on-event hooks: ${(err as Error).message}`);
    return;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FLIGHTDECK_EVENT: event,
    FLIGHTDECK_ARGUS_ID: argusId,
    FLIGHTDECK_MESSAGE: detail,
  };
  if (sessionId) env.FLIGHTDECK_SESSION = sessionId;
  for (const script of scripts) {
    const scriptPath = path.join(dir, script);
    try {
      const result = spawnSync('/bin/bash', [scriptPath], { cwd: projectRoot, env, encoding: 'utf8' });
      if (result.status !== 0) {
        log.warn(
          `on-event hook "${script}" failed (exit ${result.status}): ${result.stderr?.trim() || result.stdout?.trim()}`
        );
      }
    } catch (err) {
      log.warn(`on-event hook "${script}" threw: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run the hook tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/unit/hooks.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire it into `writeProgress`**

In `src/argus/manager.ts`, add an import:

```typescript
import { runOnEventHooks } from './hooks.js';
```

Change `writeProgress` to:

```typescript
  private writeProgress(argusId: string, sessionId: string | null, event: string, detail: string): void {
    try {
      this.tables.insertRow('argus_progress', {
        argus_id: argusId,
        session_id: sessionId,
        event,
        detail,
      });
    } catch (err) {
      log.error(`failed to write argus progress: ${(err as Error).message}`);
    }
    runOnEventHooks(this.projectRoot, event, argusId, sessionId, detail);
  }
```

`runOnEventHooks` is called even when the table insert failed, since a hook script may want to know about an event flightdeck itself could not durably record, and `runOnEventHooks` never throws, so this cannot mask the original table-insert failure.

- [ ] **Step 6: Add an integration test proving a real progress event fires a hook**

Add to `test/integration/orchestration.test.ts`:

```typescript
  it('fires an on-event hook when a task is blocked', async () => {
    const fixture = makeRepo();
    const hookDir = path.join(fixture.root, '.flightdeck', 'hooks', 'on-event');
    const eventFile = path.join(fixture.root, 'events.txt');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(
      path.join(hookDir, '01-record.sh'),
      `#!/bin/bash\necho "$FLIGHTDECK_EVENT" >> "${eventFile}"\n`,
      { mode: 0o755 }
    );
    try {
      const brain = fakeBrain({
        plan: '{"tasks":[{"title":"a","spec":"do a","depends_on":[]}]}',
      });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', maxAttemptsPerTask: 1, missionNoteId: mission.id });
      await manager.plan(argus.id);
      const board = new TaskBoard(fixture.root);
      const task = board.list(argus.id)[0];
      board.toRevising(task.id, 'forced for test');
      await manager.resumeRevisions(argus.id);
      const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8').trim().split('\n') : [];
      expect(events).toContain('task_blocked');
    } finally {
      fixture.cleanup();
    }
  });
```

This exercises the real attempt-limit path (`maxAttemptsPerTask: 1`, one forced revision), so `resumeRevisions` blocks the task and `writeProgress` fires the hook for real, with no brain call needed for gating (`resumeRevisions` blocks before ever restarting a worker session when the attempt limit is already met).

- [ ] **Step 7: Run the full suite and confirm it passes**

Run:

```bash
npm run build
npx vitest run test/unit/hooks.test.ts test/integration/orchestration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/argus/hooks.ts src/argus/manager.ts test/unit/hooks.test.ts test/integration/orchestration.test.ts
git commit -m "feat(argus): run on-event hooks from every progress write"
```

---

### Task 4: Rate-limit detection on the brain-eligible harness adapters

**Files:**

- Modify: `src/sessions/harness.ts`
- Create: `test/unit/rate-limit.test.ts`

**Interfaces:**

- Consumes: nothing from another task.
- Produces: `HarnessAdapter.detectRateLimit?(output: string): number | null`, implemented for `claude` and `codex`.

- [ ] **Step 1: Write failing detection tests**

Create `test/unit/rate-limit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/sessions/harness.js';

describe('detectRateLimit', () => {
  it('detects a Claude rate-limit message and suggests a backoff', () => {
    const output = 'Error: Claude AI usage limit reached. Please try again later. (429)';
    const backoff = adapters.claude.detectRateLimit?.(output);
    expect(backoff).not.toBeNull();
    expect(backoff as number).toBeGreaterThan(0);
  });

  it('does not flag normal Claude stream-json output', () => {
    const output = '{"type":"result","usage":{"input_tokens":100,"output_tokens":50}}\n';
    expect(adapters.claude.detectRateLimit?.(output)).toBeNull();
  });

  it('detects a Codex rate-limit message and suggests a backoff', () => {
    const output = '{"type":"error","message":"Rate limit exceeded, please retry later"}';
    const backoff = adapters.codex.detectRateLimit?.(output);
    expect(backoff).not.toBeNull();
    expect(backoff as number).toBeGreaterThan(0);
  });

  it('does not flag normal Codex turn.completed output', () => {
    const output = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}';
    expect(adapters.codex.detectRateLimit?.(output)).toBeNull();
  });

  it('is undefined on worker-only harnesses, which never need it', () => {
    expect(adapters.opencode.detectRateLimit).toBeUndefined();
    expect(adapters.gemini.detectRateLimit).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
npm run build
npx vitest run test/unit/rate-limit.test.ts
```

Expected: FAIL, `detectRateLimit` does not exist.

- [ ] **Step 3: Add the optional adapter field and a shared heuristic**

In `src/sessions/harness.ts`, add to the `HarnessAdapter` interface, after `authFiles`:

```typescript
  /**
   * Best-effort detection of a real provider rate limit in one invocation's
   * combined output, returning a suggested backoff in milliseconds, or null
   * when nothing matches. No API exposes a structured retry-after in headless
   * mode for either harness today, so this is a keyword heuristic with a
   * fixed backoff, the same kind of self-imposed, observed-behavior estimate
   * the token budget itself already is. Revisit once real throttle output has
   * been captured from each harness. Only implemented for brain-eligible
   * harnesses (claude, codex); a worker harness never triggers a brain-budget
   * concern.
   */
  detectRateLimit?(output: string): number | null;
```

Add a shared helper, above the `claude` adapter definition:

```typescript
const RATE_LIMIT_PATTERNS = [/rate limit/i, /usage limit reached/i, /too many requests/i, /\b429\b/];
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000;

function detectRateLimitByKeyword(output: string): number | null {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(output)) ? DEFAULT_RATE_LIMIT_BACKOFF_MS : null;
}
```

- [ ] **Step 4: Implement it for `claude` and `codex`**

In the `claude` adapter object, add, after `authFiles(env) { ... },`:

```typescript
  detectRateLimit: detectRateLimitByKeyword,
```

In the `codex` adapter object, add the same line after its `authFiles(env) { ... },`.

Leave `opencode` and `gemini` without the field; `HarnessAdapter.detectRateLimit` is optional, so omitting it is the correct "not applicable" representation, not a placeholder.

- [ ] **Step 5: Run the tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/unit/rate-limit.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/harness.ts test/unit/rate-limit.test.ts
git commit -m "feat(sessions): detect a provider rate limit in brain harness output"
```

---

### Task 5: Quota-sourced budget spend and `throttledUntil`

**Files:**

- Modify: `src/argus/budget.ts`
- Modify: `test/unit/budget.test.ts`

**Interfaces:**

- Consumes: `getQuota`, `quotaSpent`, `quotaOldestUsage` from `src/argus/quota.ts` (Task 2); `argus.quota_id`, `argus.throttled_until` (Task 1).
- Produces: `BudgetState.throttledUntil`; `budgetState()` sources `spent`, `windowStart`, and `nextResetAt` from the quota ledger when the mission is attached to one.

- [ ] **Step 1: Write failing budget tests**

Add to `test/unit/budget.test.ts`. First update the shared `fixtureBudget` helper to include the new field:

```typescript
function fixtureBudget(tier: BudgetTier, spent: number, ceiling: number): BudgetState {
  return {
    spent,
    ceiling,
    fraction: ceiling > 0 ? spent / ceiling : 1,
    tier,
    policy: tierPolicy(tier),
    questionsAllowed: spent < ceiling,
    windowStart: now() - 3600 * 1000,
    reviewQueueDepth: 0,
    oldestReviewAgeSec: null,
    nextResetAt: null,
    throttledUntil: null,
  };
}
```

Then add a new `describe` block:

```typescript
describe('budgetState with a quota', () => {
  it('sources spend from the quota ledger instead of local session telemetry', () => {
    const fixture = makeRepo();
    try {
      const quotaId = `quota-${crypto.randomUUID().slice(0, 8)}`;
      createQuota(quotaId, { maxTokens: 1000, windowSec: 3600 });
      recordQuotaUsage(quotaId, 400);
      recordQuotaUsage(quotaId, 100);
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ quotaId });
      const state = budgetState(fixture.root, argus.id);
      expect(state.spent).toBe(500);
      expect(state.ceiling).toBe(1000);
      expect(state.tier).toBe('conserve');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports the quota throttle on BudgetState', () => {
    const fixture = makeRepo();
    try {
      const quotaId = `quota-${crypto.randomUUID().slice(0, 8)}`;
      createQuota(quotaId, { maxTokens: 1000, windowSec: 3600 });
      const until = Date.now() + 60_000;
      setQuotaThrottle(quotaId, until);
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ quotaId });
      expect(budgetState(fixture.root, argus.id).throttledUntil).toBe(until);
    } finally {
      fixture.cleanup();
    }
  });

  it('leaves a private mission (no quota) with a null throttle by default', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({});
      expect(budgetState(fixture.root, argus.id).throttledUntil).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
```

Add the needed imports at the top of the file:

```typescript
import crypto from 'node:crypto';
import { ArgusManager } from '../../src/argus/manager.js';
import { createQuota, recordQuotaUsage, setQuotaThrottle } from '../../src/argus/quota.js';
import { makeRepo } from '../helpers.js';
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
npm run build
npx vitest run test/unit/budget.test.ts
```

Expected: FAIL, `throttledUntil` is missing from `BudgetState` and quota-sourced spend is not implemented.

- [ ] **Step 3: Extend `BudgetState`**

In `src/argus/budget.ts`, add to the `BudgetState` interface, after `nextResetAt: number | null;`:

```typescript
  /**
   * A real provider rate limit observed on a previous brain call, or null.
   * Set on the mission's quota when attached to one, or on the mission's own
   * row otherwise, and checked before every brain call regardless of source.
   */
  throttledUntil: number | null;
```

- [ ] **Step 4: Branch `budgetState()` on `quota_id`**

Add an import:

```typescript
import { getQuota, quotaSpent, quotaOldestUsage } from './quota.js';
```

Replace the body of `budgetState` with:

```typescript
export function budgetState(projectRoot: string, argusId: string): BudgetState {
  const root = normalizeProjectRoot(projectRoot);
  const db = getDb(root);
  const argus = db
    .prepare(
      'SELECT budget_window_sec, budget_max_tokens, budget_count_cache_reads, quota_id, throttled_until FROM argus WHERE id = ?'
    )
    .get(argusId) as Record<string, unknown> | undefined;
  if (!argus) throw new Error(`argus "${argusId}" not found`);

  const quotaId = typeof argus.quota_id === 'string' ? argus.quota_id : null;

  let ceiling: number;
  let windowSec: number;
  let spent: number;
  let throttledUntil: number | null;
  let nextResetAt: number | null;

  if (quotaId) {
    const quota = getQuota(quotaId);
    if (!quota) throw new Error(`quota "${quotaId}" not found`);
    ceiling = quota.maxTokens;
    windowSec = quota.windowSec;
    spent = quotaSpent(quotaId, windowSec);
    throttledUntil = quota.throttledUntil;
    const oldest = quotaOldestUsage(quotaId, windowSec);
    nextResetAt = oldest === null ? null : oldest + windowSec * 1000;
  } else {
    ceiling = Number(argus.budget_max_tokens);
    windowSec = Number(argus.budget_window_sec);
    const countCache = Number(argus.budget_count_cache_reads) === 1;
    const windowStart = now() - windowSec * 1000;
    const cacheTerm = countCache ? ' + COALESCE(t.cached_tokens, 0)' : '';
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0)${cacheTerm}), 0) AS spent
         FROM session_telemetry t
         JOIN sessions s ON s.id = t.session_id
         WHERE s.policy = 'brain' AND s.argus_parent = ? AND s.started_at > ?`
      )
      .get(...([argusId, windowStart] as SQLInputValue[])) as { spent: number };
    spent = Number(row.spent);
    const oldest = db
      .prepare('SELECT MIN(started_at) AS started FROM sessions WHERE policy = ? AND argus_parent = ? AND started_at > ?')
      .get(...(['brain', argusId, windowStart] as SQLInputValue[])) as { started: number | null };
    nextResetAt = oldest.started === null ? null : oldest.started + windowSec * 1000;
    throttledUntil =
      argus.throttled_until === null || argus.throttled_until === undefined ? null : Number(argus.throttled_until);
  }

  const windowStart = now() - windowSec * 1000;
  const queued = db
    .prepare(
      'SELECT COUNT(*) AS n, MIN(COALESCE(review_queued_at, created_at)) AS oldest FROM tasks WHERE argus_id = ? AND status = ?'
    )
    .get(...([argusId, 'in_review'] as SQLInputValue[])) as { n: number; oldest: number | null };

  const fraction = ceiling > 0 ? spent / ceiling : 1;
  const tier = classifyTier(fraction);
  return {
    spent,
    ceiling,
    fraction,
    tier,
    policy: tierPolicy(tier),
    questionsAllowed: spent < ceiling,
    windowStart,
    reviewQueueDepth: Number(queued.n),
    oldestReviewAgeSec: queued.oldest === null ? null : Math.max(0, (now() - queued.oldest) / 1000),
    nextResetAt,
    throttledUntil,
  };
}
```

`reviewQueueDepth` and `oldestReviewAgeSec` stay sourced from the local `tasks` table in both branches: tasks are per-mission-per-project and never shared across a quota, only token spend is.

- [ ] **Step 5: Run the tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/unit/budget.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the full unit and integration suites to catch any other `BudgetState` literal**

Run:

```bash
npm run typecheck
npx vitest run test/unit test/integration
```

Expected: PASS. `npm run typecheck` will fail on any other file constructing a `BudgetState` object literal without `throttledUntil`; fix those by adding `throttledUntil: null,` alongside their other fields.

- [ ] **Step 7: Commit**

```bash
git add src/argus/budget.ts test/unit/budget.test.ts
git commit -m "feat(argus): source budget spend from a quota when a mission is attached to one"
```

---

### Task 6: Scheduler loop status handling, throttle gating, and quota ledger writes

**Files:**

- Modify: `src/argus/brain.ts`
- Modify: `src/argus/manager.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: `BudgetState.throttledUntil` (Task 5), `HarnessAdapter.detectRateLimit` (Task 4), `setQuotaThrottle`/`recordQuotaUsage` (Task 2), `Argus.status` including `'paused'` (Task 1).
- Produces: a scheduler loop that exits on `stopped` from any process, skips all work while `paused`, skips every brain call while throttled, and records quota usage after a quota-attached brain session; `ArgusManager.pause(id)`, `ArgusManager.resume(id)`; `BrainThrottledError`.

- [ ] **Step 1: Write a failing cross-process stop test**

Add to `test/integration/orchestration.test.ts`, near the other `spawnCli`-based tests:

```typescript
  it('actually stops the manager loop when stop is issued from a separate process', async () => {
    const fixture = makeRepo();
    const fake = makeWakingBrain(path.join(fixture.root, 'answer-log.txt'));
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- wake the brain');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'stopme', '--mission', mission.id, '--children', '2', '--pulse', '1h'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      const manager = new ArgusManager(fixture.root);
      await waitFor(() => manager.list().find((a) => a.name === 'stopme') ?? null);
      const argusId = manager.list().find((a) => a.name === 'stopme')!.id;

      // Issued from a brand new ArgusManager instance, standing in for a
      // separate `deck argus stop` process, exactly like the CLI does.
      await new ArgusManager(fixture.root).stop(argusId);

      const code = await new Promise<number | null>((resolve) => {
        const timeout = setTimeout(() => resolve(null), 3000);
        child.on('close', (c) => {
          clearTimeout(timeout);
          resolve(c);
        });
      });
      expect(code, 'the runForever process should exit on its own once status is stopped').not.toBeNull();
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
```

- [ ] **Step 2: Run it and confirm it fails**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "actually stops the manager loop"
```

Expected: FAIL (timeout), `code` is `null` because the child process never exits.

- [ ] **Step 3: Write failing pause/resume tests**

Add to `test/integration/orchestration.test.ts`:

```typescript
  it('pauses and resumes a mission, and rejects an invalid transition', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({});
      // start() always creates the row with status 'stopped'; only
      // runForever transitions it to 'running'. Simulate that directly so
      // pause()/resume() can be tested without a spawned loop.
      getDb(fixture.root).prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(argus.id);

      manager.pause(argus.id);
      expect(manager.get(argus.id)?.status).toBe('paused');
      expect(() => manager.pause(argus.id)).toThrow(/expected running/);

      manager.resume(argus.id);
      expect(manager.get(argus.id)?.status).toBe('running');
      expect(() => manager.resume(argus.id)).toThrow(/expected paused/);
    } finally {
      fixture.cleanup();
    }
  });

  it('skips pulsing and processing pending events while paused, in a real spawned loop', async () => {
    const fixture = makeRepo();
    const answerLog = path.join(fixture.root, 'answer-log.txt');
    const fake = makeWakingBrain(answerLog);
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- wake the brain');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'pauseme', '--mission', mission.id, '--children', '2', '--pulse', '1h'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      const manager = new ArgusManager(fixture.root);
      await waitFor(() => manager.list().find((a) => a.name === 'pauseme') ?? null);
      const argusId = manager.list().find((a) => a.name === 'pauseme')!.id;
      await waitFor(() => (new TaskBoard(fixture.root).list(argusId).length > 0 ? argusId : null));

      manager.pause(argusId);
      await sleep(500);

      const worker = new SessionManager(fixture.root).createSession({
        name: 'pauseme-worker',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: argusId,
      });
      new QuestionQueue(fixture.root).ask(argusId, worker.id, 'What is the test command?');
      await sleep(1000);
      const answered = new QuestionQueue(fixture.root).pending(argusId);
      expect(answered, 'a paused mission must not answer a question').toHaveLength(1);

      manager.resume(argusId);
      await waitFor(() => (new QuestionQueue(fixture.root).pending(argusId).length === 0 ? argusId : null));

      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
```

Add the import:

```typescript
import { getDb } from '../../src/core/state.js';
```

(`getDb` may already be imported; if so, do not duplicate the import line.)

- [ ] **Step 4: Run these and confirm they fail**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "pauses"
```

Expected: FAIL, `pause`/`resume` do not exist on `ArgusManager`.

- [ ] **Step 5: Write failing throttle-gating tests**

Add to `test/integration/orchestration.test.ts`:

```typescript
  it('skips planning without a brain call while throttled', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({ plan: '{"tasks":[{"title":"a","spec":"do a","depends_on":[]}]}' });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ missionNoteId: mission.id });
      getDb(fixture.root)
        .prepare('UPDATE argus SET throttled_until = ? WHERE id = ?')
        .run(Date.now() + 60_000, argus.id);

      await manager.plan(argus.id);

      expect(brain.calls).toHaveLength(0);
      expect(new TaskBoard(fixture.root).list(argus.id)).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('records a real provider throttle and stops calling the brain for the rest of the window', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const brain = async (_root: string, _argusId: string, opts: { label: string }): Promise<string> => {
        calls += 1;
        return 'Error: Claude AI usage limit reached. Please try again later. (429)';
      };
      const manager = new ArgusManager(fixture.root, brain);
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ missionNoteId: mission.id, brainHarness: 'claude' });

      await expect(manager.plan(argus.id)).rejects.toThrow(/rate-limited/);
      expect(calls).toBe(1);
      const throttledAt = manager.get(argus.id)?.throttledUntil;
      expect(throttledAt).not.toBeNull();
      expect(throttledAt as number).toBeGreaterThan(Date.now());

      await manager.plan(argus.id);
      expect(calls, 'a second plan() call must not invoke the brain again while throttled').toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
```

- [ ] **Step 6: Run these and confirm they fail**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "throttled"
```

Expected: FAIL. `throttledUntil` is never set, the plan call is never skipped, and `manager.plan` never rejects.

- [ ] **Step 7: Add `BrainThrottledError` and the quota ledger write to `brain.ts`**

In `src/argus/brain.ts`, add after `BrainContractError`:

```typescript
/**
 * Thrown when a brain call's output matches a real provider rate limit,
 * detected by the harness adapter. Distinct from BrainContractError: this is
 * not malformed output, it is a live external throttle, so the caller must
 * leave the affected task or question exactly as it was rather than
 * escalating toward blocked or abandoned.
 */
export class BrainThrottledError extends Error {
  constructor(
    readonly label: string,
    readonly backoffMs: number
  ) {
    super(`brain ${label} call was rate-limited by the provider; backing off ${backoffMs}ms`);
    this.name = 'BrainThrottledError';
  }
}
```

Add an import at the top of the `invokeBrain` section (below the existing `import type { HarnessKind } from '../core/types.js';`):

```typescript
import { recordQuotaUsage } from './quota.js';
```

Replace `invokeBrain` with:

```typescript
export async function invokeBrain(
  projectRoot: string,
  argusId: string,
  opts: BrainInvocation
): Promise<string> {
  const db = getDb(projectRoot);
  const argus = db
    .prepare('SELECT brain_harness, quota_id, budget_count_cache_reads FROM argus WHERE id = ?')
    .get(argusId) as
    | { brain_harness?: string; quota_id?: string | null; budget_count_cache_reads?: number }
    | undefined;
  if (!argus) throw new Error(`argus "${argusId}" not found`);

  const manager = new SessionManager(projectRoot);
  const session = manager.createSession({
    name: `brain-${opts.label}-${crypto.randomUUID().slice(0, 6)}`,
    harness: (argus.brain_harness ?? 'claude') as HarnessKind,
    cwd: projectRoot,
    policy: 'brain',
    argusParent: argusId,
  });

  let stdout = '';
  await manager.startSession(session.id, {
    headless: true,
    prompt: opts.prompt,
    waitForExit: true,
    model: opts.model ?? undefined,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    env: opts.env,
  });

  if (argus.quota_id) {
    const telemetry = db
      .prepare('SELECT input_tokens, output_tokens, cached_tokens FROM session_telemetry WHERE session_id = ?')
      .get(session.id) as
      | { input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null }
      | undefined;
    if (telemetry) {
      const countCache = Number(argus.budget_count_cache_reads) === 1;
      const tokens =
        (telemetry.input_tokens ?? 0) + (telemetry.output_tokens ?? 0) + (countCache ? telemetry.cached_tokens ?? 0 : 0);
      recordQuotaUsage(argus.quota_id, tokens);
    }
  }

  return stdout;
}
```

- [ ] **Step 8: Add throttle detection to `brainJson` and pre-call guards to every call site, in `manager.ts`**

Add imports:

```typescript
import { getAdapter } from '../sessions/harness.js';
import {
  invokeBrain,
  parsePlan,
  parseReview,
  parseAnswer,
  validateReviewCoverage,
  BrainContractError,
  BrainThrottledError,
  type BrainInvocation,
  type Verdict,
} from './brain.js';
```

This replaces the existing `brain.js` import block, which already lists most of these names; add `BrainThrottledError` to it rather than importing it twice.

Also change the existing `import { getQuota } from './quota.js';` added in Task 2 to:

```typescript
import { getQuota, setQuotaThrottle } from './quota.js';
```

(one import line, `getQuota` already present from Task 2; do not add a second `from './quota.js'` import statement).

Add a private helper, immediately above `brainJson`:

```typescript
  /**
   * Detects a real provider throttle in one call's raw output and, if found,
   * records it on the mission's quota (or its own row, if private) and throws
   * BrainThrottledError so the caller leaves the affected task or question
   * untouched instead of escalating it.
   */
  private checkThrottle(id: string, stdout: string, label: string): void {
    const argus = this.get(id);
    if (!argus) return;
    const backoffMs = getAdapter(argus.brainHarness).detectRateLimit?.(stdout) ?? null;
    if (backoffMs === null) return;
    const until = now() + backoffMs;
    if (argus.quotaId) {
      setQuotaThrottle(argus.quotaId, until);
    } else {
      this.db.prepare('UPDATE argus SET throttled_until = ? WHERE id = ?').run(until, id);
    }
    this.writeProgress(id, null, 'brain_throttled', `${label} backoff=${backoffMs}ms`);
    throw new BrainThrottledError(label, backoffMs);
  }
```

Replace `brainJson` with:

```typescript
  private async brainJson<T>(
    id: string,
    opts: BrainInvocation,
    parse: (stdout: string) => T
  ): Promise<T> {
    const stdout = await this.brain(this.projectRoot, id, opts);
    this.checkThrottle(id, stdout, opts.label);
    try {
      return parse(stdout);
    } catch (err) {
      const reason = (err as Error).message;
      this.writeProgress(id, null, 'brain_malformed', reason);
      const retryPrompt = [
        opts.prompt,
        '',
        `Your previous reply could not be parsed: ${reason}`,
        'Reply again with a single valid JSON object and no other text.',
      ].join('\n');
      const retried = await this.brain(this.projectRoot, id, { ...opts, prompt: retryPrompt });
      this.checkThrottle(id, retried, opts.label);
      try {
        return parse(retried);
      } catch (error_) {
        this.writeProgress(id, null, 'brain_abandoned', (error_ as Error).message);
        throw new BrainContractError(opts.label, (error_ as Error).message);
      }
    }
  }
```

Add a pre-call guard at the top of `plan()`, immediately after the `if (!mission) throw ...` line:

```typescript
    const budgetBeforePlan = budgetState(this.projectRoot, id);
    if (budgetBeforePlan.throttledUntil !== null && budgetBeforePlan.throttledUntil > now()) {
      this.writeProgress(id, null, 'brain_throttled_skip', 'plan');
      return;
    }
```

Wrap the `brainJson` call inside `plan()` to also catch `BrainThrottledError` and return quietly (the mission is left exactly as it was, to be retried on the next pulse):

```typescript
    let drafts: TaskDraft[];
    try {
      drafts = await this.brainJson(
        id,
        { prompt, model: row.brain_plan_model ?? null, label: 'plan' },
        parsePlan
      );
    } catch (err) {
      if (err instanceof BrainThrottledError) return;
      if (err instanceof BrainContractError) {
        this.db.prepare("UPDATE argus SET status = 'stopped' WHERE id = ?").run(id);
        if (argus.managerSessionId) {
          this.db
            .prepare("UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?")
            .run(now(), now(), argus.managerSessionId);
        }
        throw err;
      }
      throw err;
    }
```

In `drainReviews`, add the guard immediately after `const budget = budgetState(this.projectRoot, id);` and before the `if (queued.length === 0) return;` line:

```typescript
    if (budget.throttledUntil !== null && budget.throttledUntil > now()) {
      this.writeProgress(id, null, 'brain_throttled_skip', 'review');
      return;
    }
```

In the `try`/`catch` around the tier 1 `brainJson` call inside `drainReviews`, add a `BrainThrottledError` branch before the existing `BrainContractError` branch:

```typescript
    let verdicts: Verdict[];
    try {
      verdicts = await this.brainJson(
        id,
        { prompt, model: row.brain_review_model ?? null, label: 'review' },
        (stdout) => validateReviewCoverage(batch, parseReview(stdout))
      );
    } catch (err) {
      if (err instanceof BrainThrottledError) return;
      if (err instanceof BrainContractError) {
        for (const task of batch) {
          this.board.block(task.id, `brain review was malformed twice: ${err.causeMessage}`);
        }
        this.writeProgress(id, null, 'review_failed', batch.map((t) => t.id).join(', '));
        return;
      }
      throw err;
    }
```

In `tierTwoReview`, add the guard immediately after `const budgetAfterTier1 = budgetState(this.projectRoot, id);` and before the existing `if (!budgetAfterTier1.policy.tier2Allowed)` check:

```typescript
    if (budgetAfterTier1.throttledUntil !== null && budgetAfterTier1.throttledUntil > now()) {
      this.writeProgress(id, null, 'brain_throttled_skip', 'review-files');
      return;
    }
```

And in its `try`/`catch`, add the same `BrainThrottledError` branch before the `BrainContractError` branch:

```typescript
    let tier2: Verdict[];
    try {
      tier2 = await this.brainJson(
        id,
        { prompt, model: row.brain_plan_model ?? null, label: 'review-files' },
        (stdout) => validateReviewCoverage([task], parseReview(stdout))
      );
    } catch (err) {
      if (err instanceof BrainThrottledError) return;
      if (err instanceof BrainContractError) {
        this.board.block(task.id, `tier 2 file review was malformed twice: ${err.causeMessage}`);
        this.writeProgress(id, task.assigneeSession, 'review_files_failed', task.id);
        return;
      }
      throw err;
    }
```

In `answerQuestions`, add the guard immediately after `const budget = budgetState(this.projectRoot, id);` and before the existing `if (!budget.questionsAllowed) return;` line:

```typescript
    if (budget.throttledUntil !== null && budget.throttledUntil > now()) {
      this.writeProgress(id, null, 'brain_throttled_skip', 'answer');
      return;
    }
```

And in its per-question `try`/`catch`, add the throttle branch and stop the loop entirely (a throttle affecting one question affects every later one in the same pass, so continuing would waste calls right up to the point each one also throttles):

```typescript
      try {
        const parsed = await this.brainJson(
          id,
          { prompt, model: row.brain_review_model ?? null, label: 'answer' },
          parseAnswer
        );
        this.questions.answer(question.id, parsed.answer, parsed.faqKey);
        this.writeProgress(id, question.sessionId, 'question_answered', parsed.faqKey);
      } catch (err) {
        if (err instanceof BrainThrottledError) return;
        if (err instanceof BrainContractError) {
          this.questions.markFailed(question.id, err.causeMessage);
          this.writeProgress(id, question.sessionId, 'question_failed', err.causeMessage);
          continue;
        }
        throw err;
      }
```

- [ ] **Step 9: Add `pause()` and `resume()`**

Add two methods to `ArgusManager`, immediately after `stop()`:

```typescript
  pause(id: string): void {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    if (argus.status !== 'running') {
      throw new Error(`argus "${id}" is ${argus.status}, expected running`);
    }
    this.db.prepare("UPDATE argus SET status = 'paused' WHERE id = ?").run(id);
    this.writeProgress(id, null, 'argus_paused', '');
  }

  resume(id: string): void {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    if (argus.status !== 'paused') {
      throw new Error(`argus "${id}" is ${argus.status}, expected paused`);
    }
    this.db.prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(id);
    this.writeProgress(id, null, 'argus_resumed', '');
  }
```

- [ ] **Step 10: Fix the scheduler loop's status handling**

Replace the shutdown closure and the `while (true)` loop inside `runForever` with:

```typescript
    this.stopping = false;
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return; // a second signal, or a second detected 'stopped' status, must not race the first shutdown
      stopping = true;
      this.stopping = true;
      void (async () => {
        try {
          // Stops every child session this fleet spawned. Without it, SIGTERM to
          // the manager leaves autonomous agents running with no supervisor.
          // Idempotent when a separate process already stopped them: children
          // already stopped tolerate a second stop.
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
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    log.info(`argus ${id} running with pulse=${argus.pulseSec}s childLimit=${argus.childLimit}`);
    let nextPulseAt = 0;
    let wasPaused = false;
    while (true) {
      // A fresh read every tick, not the row captured at the top of this
      // function, because `stop` and `pause` are ordinary DB writes that may
      // come from a completely different process: the CLI's `deck argus
      // stop`/`pause`/`resume` commands each construct their own
      // ArgusManager. This is the only way this loop learns about them.
      const row = this.db.prepare('SELECT status FROM argus WHERE id = ?').get(id) as { status?: string } | undefined;
      if (row?.status === 'stopped') {
        shutdown();
        return;
      }
      if (row?.status === 'paused') {
        wasPaused = true;
        await sleep(250);
        continue;
      }
      if (wasPaused) {
        wasPaused = false;
        nextPulseAt = 0; // don't wait out the rest of a stale pre-pause interval
      }
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

- [ ] **Step 11: Run the full targeted suite and confirm everything passes**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts
```

Expected: PASS, including the cross-process stop test, both pause/resume tests, and both throttle tests.

- [ ] **Step 12: Run the complete test suite**

Run:

```bash
npm test
```

Expected: every test passes. This is the first point where a regression in an unrelated existing Argus test (gate failures, revisions, malformed-brain containment) would surface, since `brainJson` and every brain call site changed.

- [ ] **Step 13: Commit**

```bash
git add src/argus/brain.ts src/argus/manager.ts test/integration/orchestration.test.ts
git commit -m "fix(argus): stop the loop on a cross-process stop, add pause/resume, gate on a real throttle"
```

---

### Task 7: CLI surface

**Files:**

- Create: `src/cli/commands/quota.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/argus.ts`
- Modify: `test/integration/orchestration.test.ts`

**Interfaces:**

- Consumes: `createQuota`, `getQuota`, `listQuotas` (Task 2); `ArgusManager.pause`/`resume` (Task 6); `budgetState().throttledUntil` (Task 5).
- Produces: `deck quota create/list/show`, `deck argus start --quota`, `deck argus pause/resume`, updated `deck argus budget`/`status` output.

- [ ] **Step 1: Write failing CLI tests**

Add to `test/integration/orchestration.test.ts`:

```typescript
  it('creates, lists, and shows a quota through the CLI', () => {
    const fixture = makeRepo();
    try {
      const created = runCli(['quota', 'create', 'cli-quota', '--max-tokens', '500000', '--window', '2h', '--json'], {
        cwd: fixture.root,
      });
      expect(created.code, created.stderr).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ id: 'cli-quota', maxTokens: 500000, windowSec: 7200 });

      const listed = runCli(['quota', 'list', '--json'], { cwd: fixture.root });
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).map((q: { id: string }) => q.id)).toContain('cli-quota');

      const shown = runCli(['quota', 'show', 'cli-quota', '--json'], { cwd: fixture.root });
      expect(shown.code, shown.stderr).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({ id: 'cli-quota' });
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects deck argus start --quota combined with --budget-window', () => {
    const fixture = makeRepo();
    try {
      runCli(['quota', 'create', 'combo-quota', '--max-tokens', '1000', '--window', '1h'], { cwd: fixture.root });
      const mission = new NotesStore(fixture.root).createNote('mission', '- do it');
      const result = runCli(
        ['argus', 'start', '--mission', mission.id, '--quota', 'combo-quota', '--budget-window', '1h', '--json'],
        { cwd: fixture.root, env: { FLIGHTDECK_FORBID_REAL_HARNESS: '1' } }
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/cannot combine --quota/);
    } finally {
      fixture.cleanup();
    }
  });

  it('pauses and resumes a mission through the CLI', async () => {
    const fixture = makeRepo();
    const fake = makeWakingBrain(path.join(fixture.root, 'answer-log.txt'));
    const mission = new NotesStore(fixture.root).createNote('mission', '- wake the brain');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'cli-pause', '--mission', mission.id, '--pulse', '1h'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      const manager = new ArgusManager(fixture.root);
      await waitFor(() => manager.list().find((a) => a.name === 'cli-pause') ?? null);
      const argusId = manager.list().find((a) => a.name === 'cli-pause')!.id;

      const paused = runCli(['argus', 'pause', argusId], { cwd: fixture.root });
      expect(paused.code, paused.stderr).toBe(0);
      await waitFor(() => (manager.get(argusId)?.status === 'paused' ? argusId : null));

      const resumed = runCli(['argus', 'resume', argusId], { cwd: fixture.root });
      expect(resumed.code, resumed.stderr).toBe(0);
      await waitFor(() => (manager.get(argusId)?.status === 'running' ? argusId : null));

      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child.on('close', () => resolve()));
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
```

Add `runCli` to the existing import from `'../helpers.js'` if it is not already imported (`makeRepo, spawnCli, sleep` are already imported; add `runCli` alongside them).

- [ ] **Step 2: Run these and confirm they fail**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "quota"
npx vitest run test/integration/orchestration.test.ts -t "pauses and resumes a mission through the CLI"
```

Expected: FAIL, `deck quota` and `deck argus pause`/`resume` do not exist yet.

- [ ] **Step 3: Implement `deck quota`**

Create `src/cli/commands/quota.ts`:

```typescript
import { Command } from 'commander';
import { createQuota, getQuota, listQuotas } from '../../argus/quota.js';
import { printJson, handleError, parseSeconds } from '../util.js';

type Opts = Record<string, string | boolean | undefined>;

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function registerQuota(program: Command): void {
  const quota = program.command('quota').description('Named token budget pools shared across missions and projects');

  quota
    .command('create <id>')
    .description('Create a quota that one or more Argus missions can attach to with --quota')
    .requiredOption('--max-tokens <count>', 'token ceiling for the rolling window')
    .requiredOption('--window <duration>', 'rolling window length, for example 2h')
    .option('--count-cache-reads', 'count cache reads at full weight (default true)', true)
    .option('--no-count-cache-reads', 'do not count cache reads')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const created = createQuota(id, {
          maxTokens: positiveInteger(String(opts.maxTokens), 'max tokens'),
          windowSec: parseSeconds(String(opts.window)),
          countCacheReads: opts.countCacheReads !== false,
        });
        if (opts.json) printJson(created);
        else process.stdout.write(`created quota "${created.id}" (${created.maxTokens} tokens / ${created.windowSec}s)\n`);
      } catch (err) {
        handleError(err);
      }
    });

  quota
    .command('list')
    .description('List every quota')
    .option('--json', 'emit machine-readable output')
    .action((opts: Opts) => {
      try {
        const quotas = listQuotas();
        if (opts.json) {
          printJson(quotas);
          return;
        }
        for (const q of quotas) {
          process.stdout.write(`${q.id.padEnd(24)} ${q.maxTokens} tokens / ${q.windowSec}s\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  quota
    .command('show <id>')
    .description('Show one quota')
    .option('--json', 'emit machine-readable output')
    .action((id: string, opts: Opts) => {
      try {
        const found = getQuota(id);
        if (!found) throw new Error(`quota "${id}" not found`);
        if (opts.json) {
          printJson(found);
          return;
        }
        process.stdout.write(`${found.id}\n`);
        process.stdout.write(`  max tokens   ${found.maxTokens}\n`);
        process.stdout.write(`  window       ${found.windowSec}s\n`);
        if (found.throttledUntil !== null) {
          process.stdout.write(`  throttled until ${new Date(found.throttledUntil).toISOString()}\n`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
```

- [ ] **Step 4: Register it**

In `src/cli/index.ts`, find the existing `registerArgus(program)` call (or similar `register*` calls) and add, alongside the existing imports and registrations:

```typescript
import { registerQuota } from './commands/quota.js';
```

```typescript
registerQuota(program);
```

Place both immediately next to the existing `registerArgus` import and call, matching that file's existing ordering convention for command registration.

- [ ] **Step 5: Add `--quota` to `deck argus start`, and `deck argus pause`/`resume`**

In `src/cli/commands/argus.ts`, add to `buildArgusStartParams`, after `conventionsNoteId: ...`:

```typescript
    quotaId: opts.quota !== undefined ? String(opts.quota) : undefined,
```

Add the CLI option to the `start` command, after `.option('--conventions <note-id>', ...)`:

```typescript
    .option('--quota <id>', 'attach to a shared quota created with deck quota create')
```

Add two new commands, after the existing `stop` command:

```typescript
  argus
    .command('pause <id>')
    .description('Pause a running mission without ending it')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Opts) => {
      try {
        new ArgusManager(projectRootOf(opts.project as string | undefined)).pause(id);
        process.stdout.write(`paused argus ${id}\n`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('resume <id>')
    .description('Resume a paused mission')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Opts) => {
      try {
        new ArgusManager(projectRootOf(opts.project as string | undefined)).resume(id);
        process.stdout.write(`resumed argus ${id}\n`);
      } catch (err) {
        handleError(err);
      }
    });
```

- [ ] **Step 6: Render quota and throttle state in `budget` and `status`**

In the `budget <id>` command's non-JSON branch, add after the existing `if (state.nextResetAt !== null) { ... }` block:

```typescript
        if (state.throttledUntil !== null) {
          console.log(`throttled until ${new Date(state.throttledUntil).toISOString()}`);
        }
```

In `printArgusFleet`, add the quota id when present, immediately after the existing `mission: ...` line:

```typescript
function printArgusFleet(fleet: ReturnType<ArgusManager['fleet']>): void {
  process.stdout.write(`argus ${fleet.argus.name} (${fleet.argus.id}) ${fleet.argus.status}\n`);
  process.stdout.write(`  mission: ${fleet.argus.missionNoteId}  children: ${fleet.children.length}/${fleet.argus.childLimit}  pulse: ${fleet.argus.pulseSec}s\n`);
  if (fleet.argus.quotaId !== null) {
    process.stdout.write(`  quota: ${fleet.argus.quotaId}\n`);
  }
  for (const child of fleet.children) {
    const s = child.session;
    const childDesc = s ? `${s.name} ${s.status} ${s.harness}` : 'unknown';
    process.stdout.write(`  child ${childDesc}\n`);
  }
  for (const p of fleet.recentProgress.slice(-5)) {
    const detail = typeof p.detail === 'string' ? p.detail : '';
    process.stdout.write(`  progress: ${String(p.event)} ${detail}\n`);
  }
}
```

`printArgusList` already renders `a.status`, which now naturally includes `paused` with no further change, since it prints whatever string is stored.

- [ ] **Step 7: Run the tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/quota.ts src/cli/index.ts src/cli/commands/argus.ts test/integration/orchestration.test.ts
git commit -m "feat(cli): add deck quota, --quota, and deck argus pause/resume"
```

---

### Task 8: Fleet console rendering

**Files:**

- Modify: `src/cli/commands/fleet.tsx`
- Modify: `test/unit/fleet-console-view.test.tsx`

**Interfaces:**

- Consumes: `Argus.status` including `'paused'`, `Argus.quotaId`, `BudgetState.throttledUntil` (Tasks 1, 5, 6).
- Produces: `ConsoleSnapshot.argusStatus`, `ConsoleSnapshot.quotaId`, `ConsoleSnapshot.throttledUntil`, rendered distinctly in `FleetConsoleView`.

- [ ] **Step 1: Write failing view tests**

Add to `test/unit/fleet-console-view.test.tsx`, first extending the local `snapshot()` helper's default object with the three new fields:

```typescript
function snapshot(overrides: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    sessions: [],
    argusId: null,
    argusStatus: null,
    tasks: [],
    reviewQueueDepth: 0,
    nextBudgetResetAt: null,
    spent: 0,
    ceiling: 0,
    tier: 'normal',
    quotaId: null,
    throttledUntil: null,
    progress: [],
    fleetError: null,
    tick: 1,
    ...overrides,
  };
}
```

Then add:

```typescript
  it('renders a paused mission distinctly from running or stopped', () => {
    const output = render(snapshot({ argusStatus: 'paused' }), state());
    expect(output).toContain('paused');
  });

  it('renders the attached quota id when present', () => {
    const output = render(snapshot({ quotaId: 'shared-account' }), state());
    expect(output).toContain('shared-account');
  });

  it('renders a throttle time when set', () => {
    const until = Date.parse('2026-08-16T12:00:00.000Z');
    const output = render(snapshot({ throttledUntil: until }), state());
    expect(output.toLowerCase()).toContain('throttled');
  });

  it('does not render a quota or throttle line when neither is set', () => {
    const output = render(snapshot(), state());
    expect(output.toLowerCase()).not.toContain('throttled');
  });
```

- [ ] **Step 2: Run these and confirm they fail**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-console-view.test.tsx
```

Expected: FAIL, `argusStatus`/`quotaId`/`throttledUntil` do not exist on `ConsoleSnapshot`, and typecheck itself fails on the new fields.

- [ ] **Step 3: Extend `ConsoleSnapshot` and both snapshot builders**

In `src/cli/commands/fleet.tsx`, add three fields to the `ConsoleSnapshot` interface, after `tier: string;`:

```typescript
  quotaId: string | null;
  throttledUntil: number | null;
```

and one field after `argusId: string | null;`:

```typescript
  argusStatus: string | null;
```

In `loadSnapshot`, add the matching keys to `empty` (after `tier: 'normal',`):

```typescript
    quotaId: null,
    throttledUntil: null,
```

and after `argusId: null,`:

```typescript
    argusStatus: null,
```

Then, in the populated return at the bottom of `loadSnapshot` (after `const argus = fleets[0];` and `const budget = budgetState(projectRoot, argus.id);`), add to the returned object, after `tier: budget.tier,`:

```typescript
    quotaId: argus.quotaId,
    throttledUntil: budget.throttledUntil,
```

and after `argusId: argus.id,`:

```typescript
    argusStatus: argus.status,
```

In `emptySnapshot`, add the same three fields with the same null/`'normal'`-free defaults as `empty` above (`argusStatus: null,`, `quotaId: null,`, `throttledUntil: null,`), in the equivalent positions.

- [ ] **Step 4: Render the new fields in `FleetConsoleView`**

In `FleetConsoleView`, change the header `Box` (currently just the `flightdeck fleet` title and the `select with Tab/arrows` hint) to show a paused badge:

```typescript
      <Box marginBottom={1}>
        <Text bold color="cyan">{'flightdeck fleet  '}</Text>
        <Text dimColor>{'select with Tab/arrows  '}</Text>
        {snap.argusStatus === 'paused' && <Text color="yellow">{'paused'}</Text>}
      </Box>
```

Extend the "Brain budget" block to show the quota id and throttle when present:

```typescript
      <Text bold underline>Brain budget</Text>
      <Box marginBottom={1}>
        <Text>{`  ${spendLabel}  `}</Text>
        <Text color={snap.tier === 'paused' ? 'red' : 'green'}>{snap.tier}</Text>
        <Text>{`  queued=${snap.reviewQueueDepth}`}</Text>
        {snap.nextBudgetResetAt !== null && (
          <Text>{`  next reset ${new Date(snap.nextBudgetResetAt).toLocaleTimeString()}`}</Text>
        )}
      </Box>
      {snap.quotaId !== null && (
        <Box marginBottom={1}>
          <Text dimColor>{`  quota: ${snap.quotaId}`}</Text>
          {snap.throttledUntil !== null && (
            <Text color="red">{`  throttled until ${new Date(snap.throttledUntil).toLocaleTimeString()}`}</Text>
          )}
        </Box>
      )}
      {snap.quotaId === null && snap.throttledUntil !== null && (
        <Box marginBottom={1}>
          <Text color="red">{`  throttled until ${new Date(snap.throttledUntil).toLocaleTimeString()}`}</Text>
        </Box>
      )}
```

- [ ] **Step 5: Run the view tests and confirm they pass**

Run:

```bash
npm run build
npx vitest run test/unit/fleet-console-view.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Run the full unit suite for regressions**

Run:

```bash
npm run typecheck
npx vitest run test/unit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/fleet.tsx test/unit/fleet-console-view.test.tsx
git commit -m "feat(fleet): render paused missions and quota throttle state"
```

---

### Task 9: Full lifecycle proof and documentation

**Files:**

- Modify: `test/integration/orchestration.test.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: Tasks 1 through 8.
- Produces: one integration test proving two missions in two different projects share one quota's budget and throttle, and accurate operator documentation.

- [ ] **Step 1: Write the cross-project quota-sharing test**

At the top of `test/integration/orchestration.test.ts`, add `import crypto from 'node:crypto';` alongside the other `node:*` imports, and change the existing `import { createQuota } from '../../src/argus/quota.js';` (added in Task 2) to:

```typescript
import { createQuota, recordQuotaUsage, setQuotaThrottle } from '../../src/argus/quota.js';
```

Add to `test/integration/orchestration.test.ts`:

```typescript
  it('shares one quota across two missions in two different projects', async () => {
    const projectA = makeRepo();
    const projectB = makeRepo();
    try {
      const quotaId = `shared-${crypto.randomUUID().slice(0, 8)}`;
      createQuota(quotaId, { maxTokens: 1000, windowSec: 3600 });

      const managerA = new ArgusManager(projectA.root, fakeBrain({}).fn);
      const managerB = new ArgusManager(projectB.root, fakeBrain({}).fn);
      const argusA = managerA.start({ quotaId, name: 'mission-a' });
      const argusB = managerB.start({ quotaId, name: 'mission-b' });

      // Mission A's own brain session spends against the shared pool.
      recordQuotaUsage(quotaId, 700);

      // Mission B, in a completely different project's state.db, observes the
      // combined spend on its very next read, with no cross-process signal
      // beyond the shared quotas.db file.
      const stateB = budgetState(projectB.root, argusB.id);
      expect(stateB.spent).toBe(700);
      expect(stateB.tier).toBe('batch');

      // A real throttle recorded by mission A immediately gates mission B's
      // next brain call too.
      const until = Date.now() + 60_000;
      setQuotaThrottle(quotaId, until);
      const stateA = budgetState(projectA.root, argusA.id);
      expect(stateA.throttledUntil).toBe(until);
      expect(budgetState(projectB.root, argusB.id).throttledUntil).toBe(until);
    } finally {
      projectA.cleanup();
      projectB.cleanup();
    }
  });
```

- [ ] **Step 2: Run it and confirm it fails, then implement any gap it reveals**

Run:

```bash
npm run build
npx vitest run test/integration/orchestration.test.ts -t "shares one quota across two missions"
```

Expected: PASS immediately, since Tasks 2 through 6 already implement every piece this test exercises. If it fails, the gap is in whichever earlier task's step was skipped; do not patch around it here, go back and fix that task.

- [ ] **Step 3: Update README.md**

In the `deck argus start [options]` row of the commands table, add `--quota <id>` to the listed flags, immediately after `--conventions <note-id>`.

Add two new rows to the commands table, near the existing `deck argus stop <id>` row:

```markdown
| `deck argus pause <id>` | Pause a running mission without ending it |
| `deck argus resume <id>` | Resume a paused mission |
| `deck quota create <id> --max-tokens <count> --window <duration>` | Create a named token budget pool that multiple missions, in this project or others, can attach to with `--quota` |
| `deck quota list` / `deck quota show <id>` | List or inspect quotas |
```

Extend the existing prose describing `--conventions`, tier 1/tier 2 review, and independent question wake-up (the block added by the prior orchestrator-contract-completion plan) with:

```markdown
- `--quota <id>` attaches a mission to a named, shared token budget pool created with `deck quota create`, instead of the mission owning its own `--budget-window`/`--budget-max-tokens`; the two are mutually exclusive. Every mission attached to the same quota, in this project or a different one, shares one ceiling and one rolling window.
- A real rate-limit response from the brain harness sets a throttle on the mission's quota (or the mission itself, if unattached) that every attached mission observes immediately, skipping brain calls until it clears, distinct from and in addition to the self-imposed token ceiling.
- `deck argus pause`/`resume` suspends and resumes a mission without ending it; workers already dispatched keep running, but no new dispatch, gate draining, review, or brain call happens while paused.
- A `.flightdeck/hooks/on-event/*.sh` script, run the same way as an existing post-create hook, fires on every mission progress event (`task_blocked`, `brain_abandoned`, `argus_paused`, a quota entering `throttled`, and others) with `FLIGHTDECK_EVENT`, `FLIGHTDECK_ARGUS_ID`, `FLIGHTDECK_SESSION`, and `FLIGHTDECK_MESSAGE` set.
```

- [ ] **Step 4: Update CLAUDE.md**

In the `### Argus` section, extend the existing paragraph describing the budget and review loop with two sentences:

```markdown
A mission may instead attach to a named quota (`deck quota create`, `deck argus start --quota <id>`) so several missions, including ones in a different project, share one ceiling and rolling window through a small global store at `$FLIGHTDECK_HOME/quotas.db`; see [src/argus/quota.ts](src/argus/quota.ts). A real provider rate-limit response, detected heuristically per harness ([src/sessions/harness.ts](src/sessions/harness.ts)), sets a throttle that every mission on the same quota observes before its next brain call, independent of the self-imposed token ceiling.
```

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
git add test/integration/orchestration.test.ts README.md CLAUDE.md
git commit -m "test(argus): prove cross-project quota sharing and document quota, pause, and hooks"
```

---

## Acceptance Gate

The plan is complete only when all of the following are true:

- A mission attached to a quota sources its budget spend, tier, and next-reset projection from that quota's shared ledger, not from its own project's local telemetry.
- Two missions in two different projects, attached to the same quota, observe each other's spend and each other's throttle with no signal beyond the shared `quotas.db` file.
- `deck argus start --quota <id>` rejects `--budget-window`/`--budget-max-tokens` and an unknown quota id.
- A real provider rate-limit response detected in brain output records a throttle and aborts that call; a subsequent call within the throttle window is skipped entirely, with zero brain calls, until it clears.
- `deck argus stop <id>`, issued from a process other than the one running `deck argus start`, causes that other process's loop to exit on its own within one scheduler tick.
- `deck argus pause <id>` stops all dispatch, gate draining, review, and brain calls without ending the mission or its already-dispatched workers; `deck argus resume <id>` picks the mission back up within one scheduler tick.
- Every `writeProgress` call fires any `.flightdeck/hooks/on-event/*.sh` script present, with the event, mission id, related session id (when there is one), and detail set as environment variables; a failing hook script never stops the scheduler.
- The Fleet console and `deck argus status`/`budget` render `paused`, a quota id, and a throttle time distinctly, never fabricating a value the code cannot compute.
- No test, fixture, or CLI invocation anywhere in this plan spawns a real `claude`, `codex`, `opencode`, or `gemini` binary.
- The full hermetic lifecycle and every repository gate (`typecheck`, `lint`, `test`) pass.
