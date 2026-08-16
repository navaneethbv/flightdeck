# Orchestrator Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Argus orchestrator a real reasoning brain (Claude or Codex) that plans tasks, reviews completed work, and answers worker questions, while spending as few brain tokens as possible.

**Architecture:** A task board in SQLite holds the unit of work. Cheap workers (OpenCode, Gemini) execute tasks in isolated worktrees and report structurally. Objective test and lint gates reject bad work with zero brain involvement. Only gate-passing work reaches the brain, which reviews summaries rather than diffs and returns validated JSON rather than using MCP. A budget ladder throttles brain spend inside a rolling window.

**Tech Stack:** TypeScript (strict ESM), `node:sqlite`, zod, vitest, commander, MCP SDK.

**Spec:** [docs/superpowers/specs/2026-08-15-orchestrator-brain-design.md](../specs/2026-08-15-orchestrator-brain-design.md)

## Global Constraints

- Node 22.5+ is required. State uses the built-in `node:sqlite`, never a native module. Do not add native dependencies.
- Strict TypeScript ESM. Every relative import carries the `.js` extension, because output is native ESM. `import { TaskBoard } from './board.js'`, never `'./board'`.
- Schema changes go in the `migrate()` function in `src/core/state.ts`. There is no migration directory. Adding a column to an existing table uses the `try { db.exec('ALTER TABLE ...') } catch {}` pattern already at the bottom of `migrate()`.
- Run `npm run build` before invoking `npx vitest` directly. Integration and e2e tests spawn `dist/cli/index.js` as a real child process, so a stale `dist/` tests the previous build. `npm test` builds first via `pretest`; direct vitest calls do not.
- Every list and detail CLI command supports `--json`.
- Never display a fabricated or placeholder value. Unknown data renders blank, never zero. Gemini reports no token usage, so its spend must render blank.
- Every MCP tool declares a `risk` of `read`, `additive`, `destructive`, or `external`. Set it deliberately.
- Errors surface as thrown `Error` with a human-readable message.
- Never use an em dash (U+2014) in any code, comment, string, or documentation. Use a comma, colon, semicolon, hyphen, or parentheses.
- Do not add a co-author trailer to commit messages.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/argus/board.ts` | Task board CRUD and every lifecycle state transition. Pure database, no model calls. |
| `src/argus/budget.ts` | Rolling window spend accounting and the degradation ladder. Pure functions. |
| `src/argus/gates.ts` | Runs test and lint commands inside a worktree, records exit codes and failure output. |
| `src/argus/brain.ts` | Prompt assembly, brain invocation, and zod validation of the three JSON contracts. The only module that invokes a model. |
| `src/argus/questions.ts` | Question queue, FAQ cache lookup, and answer writeback. |

**Modified:**

| File | Change |
| --- | --- |
| `src/core/types.ts` | `SessionPolicy` gains `'brain'`. New `Task`, `TaskStatus`, `WorkerReport`, `GateResult`, `Question` types. |
| `src/core/state.ts` | New `tasks` and `questions` tables, new `argus` columns. |
| `src/core/config.ts` | `ArgusConfig` gains `gateTestCommand` and `gateLintCommand`. |
| `src/sessions/manager.ts` | `StartOptions` gains `model` and `onStdout`. Skips MCP config for `policy: 'brain'`. |
| `src/sessions/harness.ts` | `sessionArgs` options gain `model`. All four adapters pass it through. |
| `src/mcp/tools.ts` | Three new worker tools: `task_get`, `report_done`, `ask_manager`. |
| `src/argus/manager.ts` | `parseTasks` deleted. `pulse()` becomes dispatch-only. |
| `src/cli/commands/argus.ts` | New subcommands for board, budget, and task inspection. |

**Dependency order:** Task 1 must be first. Tasks 2, 3, 4, 5, 7 are independent of each other and depend only on Task 1. Task 6 depends on 5. Task 8 depends on 2 and 7. Task 9 depends on 2, 3, 4, 6, 7. Task 10 depends on 9.

---

### Task 1: Schema and type foundation

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/state.ts:35-150` (the `migrate()` function)
- Modify: `src/core/config.ts:6-10` (the `ArgusConfig` interface) and `:33-38` (the `DEFAULTS` value)
- Test: `test/unit/schema.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `SessionPolicy` including `'brain'`; the `TaskStatus`, `Task`, `WorkerReport`, `GateResult`, `Question` interfaces; `tasks` and `questions` tables; new `argus` columns; `ArgusConfig.gateTestCommand` and `ArgusConfig.gateLintCommand`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDb } from '../../src/core/state.js';
import { loadConfig } from '../../src/core/config.js';
import { makeRepo } from '../helpers.js';

function columns(db: ReturnType<typeof getDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  return rows.map((r) => String(r.name));
}

describe('orchestrator schema', () => {
  it('creates the tasks table with every lifecycle column', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      const cols = columns(db, 'tasks');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'argus_id', 'title', 'spec', 'status', 'assignee_session',
          'depends_on', 'attempts', 'worker_report', 'gate_result',
          'diffstat', 'verdict', 'verdict_reason', 'created_at', 'updated_at',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('creates the questions table', () => {
    const fixture = makeRepo();
    try {
      const cols = columns(getDb(fixture.root), 'questions');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'argus_id', 'session_id', 'question', 'answer',
          'faq_key', 'created_at', 'answered_at',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('adds brain and budget columns to argus', () => {
    const fixture = makeRepo();
    try {
      const cols = columns(getDb(fixture.root), 'argus');
      expect(cols).toEqual(
        expect.arrayContaining([
          'brain_harness', 'brain_plan_model', 'brain_review_model',
          'worker_harnesses', 'budget_window_sec', 'budget_max_tokens',
          'budget_count_cache_reads', 'max_attempts_per_task', 'max_tasks',
          'question_timeout_sec',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('defaults the gate commands', () => {
    const config = loadConfig();
    expect(config.argus.gateTestCommand).toBe('npm test');
    expect(config.argus.gateLintCommand).toBe('npm run lint');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/schema.test.ts`
Expected: FAIL. The `tasks` and `questions` PRAGMA calls return empty arrays, so `expect.arrayContaining` fails, and `config.argus.gateTestCommand` is `undefined`.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, change the `SessionPolicy` union on line 11 and append the new types:

```typescript
export type SessionPolicy = 'default' | 'child' | 'manager' | 'brain';

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'reported'
  | 'gating'
  | 'revising'
  | 'in_review'
  | 'done'
  | 'blocked';

/** What a worker reports through the `report_done` MCP tool. */
export interface WorkerReport {
  summary: string;
  filesChanged: string[];
  testsRun: string;
  uncertainties: string;
}

/**
 * Objective gate output. A null exit code means the gate was skipped because
 * its command was configured empty.
 */
export interface GateResult {
  testExitCode: number | null;
  lintExitCode: number | null;
  failureTail: string;
}

export interface Task {
  id: string;
  argusId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  assigneeSession: string | null;
  dependsOn: string[];
  attempts: number;
  workerReport: WorkerReport | null;
  gateResult: GateResult | null;
  diffstat: string | null;
  verdict: string | null;
  verdictReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Question {
  id: number;
  argusId: string;
  sessionId: string;
  question: string;
  answer: string | null;
  faqKey: string | null;
  createdAt: number;
  answeredAt: number | null;
}
```

- [ ] **Step 4: Add the tables**

In `src/core/state.ts`, inside the single `db.exec(\`...\`)` template in `migrate()`, add these two tables immediately before the `CREATE INDEX` lines:

```sql
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      argus_id TEXT NOT NULL,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee_session TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_report TEXT,
      gate_result TEXT,
      diffstat TEXT,
      verdict TEXT,
      verdict_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      argus_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      faq_key TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );
```

Then add these two index lines alongside the existing `CREATE INDEX` statements:

```sql
    CREATE INDEX IF NOT EXISTS idx_tasks_argus ON tasks(argus_id, status);
    CREATE INDEX IF NOT EXISTS idx_questions_argus ON questions(argus_id, answered_at);
```

- [ ] **Step 5: Add the argus columns**

At the bottom of `migrate()` in `src/core/state.ts`, next to the existing `ALTER TABLE sessions ADD COLUMN task TEXT;` block, add:

```typescript
  const argusColumns = [
    "brain_harness TEXT NOT NULL DEFAULT 'claude'",
    'brain_plan_model TEXT',
    'brain_review_model TEXT',
    `worker_harnesses TEXT NOT NULL DEFAULT '["opencode"]'`,
    'budget_window_sec INTEGER NOT NULL DEFAULT 18000',
    'budget_max_tokens INTEGER NOT NULL DEFAULT 1000000',
    'budget_count_cache_reads INTEGER NOT NULL DEFAULT 1',
    'max_attempts_per_task INTEGER NOT NULL DEFAULT 3',
    'max_tasks INTEGER NOT NULL DEFAULT 100',
    'question_timeout_sec INTEGER NOT NULL DEFAULT 120',
  ];
  for (const col of argusColumns) {
    try {
      db.exec(`ALTER TABLE argus ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
```

The 18000 second default is a five hour rolling window.

- [ ] **Step 6: Add the gate command config**

In `src/core/config.ts`, extend the `ArgusConfig` interface:

```typescript
export interface ArgusConfig {
  defaultPulseSec: number;
  defaultChildLimit: number;
  allowedLimits: number[];
  /** Shell command run as the tier 0 test gate. Empty string skips the gate. */
  gateTestCommand: string;
  /** Shell command run as the tier 0 lint gate. Empty string skips the gate. */
  gateLintCommand: string;
}
```

And extend the `argus` block inside `DEFAULTS`:

```typescript
  argus: {
    defaultPulseSec: 60,
    defaultChildLimit: 8,
    allowedLimits: [2, 4, 8, 16],
    gateTestCommand: 'npm test',
    gateLintCommand: 'npm run lint',
  },
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/unit/schema.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Verify nothing else broke**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. If `typecheck` reports a non-exhaustive switch over `SessionPolicy`, add a `case 'brain':` arm that behaves like `'default'`.

- [ ] **Step 9: Commit**

```bash
git add src/core/types.ts src/core/state.ts src/core/config.ts test/unit/schema.test.ts
git commit -m "feat(argus): add task board schema, brain policy, and gate config"
```

---

### Task 2: Task board

**Files:**
- Create: `src/argus/board.ts`
- Test: `test/unit/board.test.ts` (create)

**Interfaces:**
- Consumes: `Task`, `TaskStatus`, `WorkerReport`, `GateResult` from `src/core/types.js`; `getDb`, `now` from `src/core/state.js`.
- Produces: `class TaskBoard` with `create`, `get`, `list`, `dispatchable`, `assign`, `report`, `recordGates`, `toRevising`, `block`, `recordVerdict`. Task 8 and Task 9 both call these.

- [ ] **Step 1: Write the failing test**

Create `test/unit/board.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TaskBoard } from '../../src/argus/board.js';
import { makeRepo } from '../helpers.js';

describe('TaskBoard', () => {
  it('rewrites depends_on indices into task ids', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const tasks = board.create('argus-1', [
        { title: 'schema', spec: 'add tables', dependsOn: [] },
        { title: 'store', spec: 'add store', dependsOn: [0] },
      ]);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].dependsOn).toEqual([]);
      expect(tasks[1].dependsOn).toEqual([tasks[0].id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an out-of-range dependency index', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      expect(() =>
        board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [5] }])
      ).toThrow(/dependency index 5 is out of range/);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a dependency cycle', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      expect(() =>
        board.create('argus-1', [
          { title: 'a', spec: 'a', dependsOn: [1] },
          { title: 'b', spec: 'b', dependsOn: [0] },
        ])
      ).toThrow(/dependency cycle/);
    } finally {
      fixture.cleanup();
    }
  });

  it('only reports a task as dispatchable once its dependencies are done', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [first, second] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [0] },
      ]);

      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([first.id]);

      board.assign(first.id, 'session-1');
      expect(board.dispatchable('argus-1')).toHaveLength(0);

      board.recordVerdict(first.id, 'accept', null);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([second.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('increments attempts on each revision and round-trips the worker report', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);

      board.assign(task.id, 'session-1');
      const reported = board.report(task.id, {
        summary: 'did the thing',
        filesChanged: ['src/a.ts'],
        testsRun: 'npm test',
        uncertainties: 'none',
      });
      expect(reported.status).toBe('reported');
      expect(reported.workerReport?.filesChanged).toEqual(['src/a.ts']);

      const revised = board.toRevising(task.id, 'tests failed');
      expect(revised.status).toBe('revising');
      expect(revised.attempts).toBe(1);
      expect(board.toRevising(task.id, 'still failing').attempts).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('moves a task to in_review only when gates pass', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [pass, fail] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);

      const passed = board.recordGates(
        pass.id,
        { testExitCode: 0, lintExitCode: 0, failureTail: '' },
        ' src/a.ts | 2 +-'
      );
      expect(passed.status).toBe('in_review');

      const failed = board.recordGates(
        fail.id,
        { testExitCode: 1, lintExitCode: 0, failureTail: '1 test failed' },
        ''
      );
      expect(failed.status).toBe('revising');
      expect(failed.attempts).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/board.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/board.js'".

- [ ] **Step 3: Implement the board**

Create `src/argus/board.ts`:

```typescript
import crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { GateResult, Task, TaskStatus, WorkerReport } from '../core/types.js';

export interface TaskDraft {
  title: string;
  spec: string;
  /** Zero-based indices into the same draft array, not task ids. */
  dependsOn: number[];
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    argusId: String(row.argus_id),
    title: String(row.title),
    spec: String(row.spec),
    status: row.status as TaskStatus,
    assigneeSession: typeof row.assignee_session === 'string' ? row.assignee_session : null,
    dependsOn: parseJson<string[]>(row.depends_on, []),
    attempts: Number(row.attempts),
    workerReport: parseJson<WorkerReport | null>(row.worker_report, null),
    gateResult: parseJson<GateResult | null>(row.gate_result, null),
    diffstat: typeof row.diffstat === 'string' ? row.diffstat : null,
    verdict: typeof row.verdict === 'string' ? row.verdict : null,
    verdictReason: typeof row.verdict_reason === 'string' ? row.verdict_reason : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Rejects any dependency index outside the draft array and any cycle, before
 * a single row is written. The brain emits indices because it cannot
 * reference ids that do not exist yet; a malformed plan must fail whole
 * rather than leave a half-inserted board.
 */
function validateDrafts(drafts: TaskDraft[]): void {
  for (const draft of drafts) {
    for (const dep of draft.dependsOn) {
      if (!Number.isInteger(dep) || dep < 0 || dep >= drafts.length) {
        throw new Error(`dependency index ${dep} is out of range for a plan of ${drafts.length} tasks`);
      }
    }
  }
  const state = new Array<0 | 1 | 2>(drafts.length).fill(0);
  const visit = (i: number): void => {
    if (state[i] === 1) throw new Error(`dependency cycle detected at task index ${i}`);
    if (state[i] === 2) return;
    state[i] = 1;
    for (const dep of drafts[i].dependsOn) visit(dep);
    state[i] = 2;
  };
  for (let i = 0; i < drafts.length; i++) visit(i);
}

export class TaskBoard {
  private readonly db: DatabaseSync;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
  }

  create(argusId: string, drafts: TaskDraft[]): Task[] {
    validateDrafts(drafts);
    const ids = drafts.map(() => crypto.randomUUID());
    const ts = now();
    const insert = this.db.prepare(
      'INSERT INTO tasks (id, argus_id, title, spec, status, depends_on, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)'
    );
    drafts.forEach((draft, i) => {
      insert.run(
        ids[i],
        argusId,
        draft.title,
        draft.spec,
        'pending',
        JSON.stringify(draft.dependsOn.map((d) => ids[d])),
        ts,
        ts
      );
    });
    return ids.map((id) => this.get(id)!);
  }

  get(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTask(row) : null;
  }

  list(argusId: string, status?: TaskStatus): Task[] {
    const sql = status
      ? 'SELECT * FROM tasks WHERE argus_id = ? AND status = ? ORDER BY created_at ASC'
      : 'SELECT * FROM tasks WHERE argus_id = ? ORDER BY created_at ASC';
    const params: SQLInputValue[] = status ? [argusId, status] : [argusId];
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }

  /** Pending tasks whose every dependency has reached `done`. */
  dispatchable(argusId: string): Task[] {
    const all = this.list(argusId);
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
    return all.filter((t) => t.status === 'pending' && t.dependsOn.every((d) => done.has(d)));
  }

  private update(id: string, sets: Record<string, SQLInputValue>): Task {
    const keys = Object.keys(sets);
    const assignments = keys.map((k) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((k) => sets[k]), now(), id);
    const task = this.get(id);
    if (!task) throw new Error(`task "${id}" not found`);
    return task;
  }

  assign(taskId: string, sessionId: string): Task {
    return this.update(taskId, { status: 'assigned', assignee_session: sessionId });
  }

  report(taskId: string, report: WorkerReport): Task {
    return this.update(taskId, { status: 'reported', worker_report: JSON.stringify(report) });
  }

  /**
   * Tier 0. A failing gate returns the task to the worker and costs no brain
   * tokens; only a clean gate run reaches the review queue.
   */
  recordGates(taskId: string, result: GateResult, diffstat: string): Task {
    const failed =
      (result.testExitCode !== null && result.testExitCode !== 0) ||
      (result.lintExitCode !== null && result.lintExitCode !== 0);
    this.update(taskId, { gate_result: JSON.stringify(result), diffstat });
    if (failed) return this.toRevising(taskId, result.failureTail);
    return this.update(taskId, { status: 'in_review' });
  }

  toRevising(taskId: string, reason: string): Task {
    const current = this.get(taskId);
    if (!current) throw new Error(`task "${taskId}" not found`);
    return this.update(taskId, {
      status: 'revising',
      attempts: current.attempts + 1,
      verdict_reason: reason,
    });
  }

  block(taskId: string, reason: string): Task {
    return this.update(taskId, { status: 'blocked', verdict_reason: reason });
  }

  recordVerdict(taskId: string, verdict: string, reason: string | null): Task {
    if (verdict === 'accept') {
      return this.update(taskId, { status: 'done', verdict, verdict_reason: reason });
    }
    this.update(taskId, { verdict });
    return this.toRevising(taskId, reason ?? 'revision requested');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/board.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/board.ts test/unit/board.test.ts
git commit -m "feat(argus): add task board with dependency and gate transitions"
```

---

### Task 3: Budget accounting and ladder

**Files:**
- Create: `src/argus/budget.ts`
- Test: `test/unit/budget.test.ts` (create)

**Interfaces:**
- Consumes: `getDb`, `now` from `src/core/state.js`.
- Produces: `type BudgetTier = 'normal' | 'conserve' | 'batch' | 'paused'`; `interface BudgetState`; `classifyTier(fraction: number): BudgetTier`; `tierPolicy(tier: BudgetTier): { tier2Allowed: boolean; batchSize: number; reviewsAllowed: boolean }`; `budgetState(projectRoot: string, argusId: string): BudgetState`. Task 9 calls `budgetState`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/budget.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyTier, tierPolicy, budgetState } from '../../src/argus/budget.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

describe('classifyTier', () => {
  it('maps each ladder boundary to the correct tier', () => {
    expect(classifyTier(0)).toBe('normal');
    expect(classifyTier(0.599)).toBe('normal');
    expect(classifyTier(0.6)).toBe('conserve');
    expect(classifyTier(0.799)).toBe('conserve');
    expect(classifyTier(0.8)).toBe('batch');
    expect(classifyTier(0.949)).toBe('batch');
    expect(classifyTier(0.95)).toBe('paused');
    expect(classifyTier(1.5)).toBe('paused');
  });
});

describe('tierPolicy', () => {
  it('disables tier 2 above the conserve threshold', () => {
    expect(tierPolicy('normal').tier2Allowed).toBe(true);
    expect(tierPolicy('conserve').tier2Allowed).toBe(false);
    expect(tierPolicy('batch').tier2Allowed).toBe(false);
    expect(tierPolicy('paused').tier2Allowed).toBe(false);
  });

  it('widens the review batch as spend climbs', () => {
    expect(tierPolicy('normal').batchSize).toBe(1);
    expect(tierPolicy('conserve').batchSize).toBe(4);
    expect(tierPolicy('batch').batchSize).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stops reviews only at the paused tier', () => {
    expect(tierPolicy('batch').reviewsAllowed).toBe(true);
    expect(tierPolicy('paused').reviewsAllowed).toBe(false);
  });
});

/** Inserts a finished brain session with the given usage. */
function seedBrainSpend(
  root: string,
  argusId: string,
  opts: { input: number; output: number; cached?: number; startedAt: number }
): void {
  const db = getDb(root);
  const id = `brain-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES (?, ?, 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
  ).run(id, id, root, root, argusId, opts.startedAt, opts.startedAt);
  db.prepare(
    'INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, cached_tokens, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, opts.input, opts.output, opts.cached ?? 0, opts.startedAt);
}

describe('budgetState', () => {
  it('sums only brain sessions inside the window', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      db.prepare(
        "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, budget_window_sec, budget_max_tokens) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 3600, 1000)"
      ).run(fixture.root, now());

      seedBrainSpend(fixture.root, 'a1', { input: 100, output: 100, startedAt: now() });
      // Outside the window, must be excluded.
      seedBrainSpend(fixture.root, 'a1', {
        input: 5000,
        output: 5000,
        startedAt: now() - 7200 * 1000,
      });

      const state = budgetState(fixture.root, 'a1');
      expect(state.spent).toBe(200);
      expect(state.ceiling).toBe(1000);
      expect(state.fraction).toBeCloseTo(0.2);
      expect(state.tier).toBe('normal');
    } finally {
      fixture.cleanup();
    }
  });

  it('counts cache reads at full weight by default', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      db.prepare(
        "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, budget_window_sec, budget_max_tokens, budget_count_cache_reads) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 3600, 1000, 1)"
      ).run(fixture.root, now());
      seedBrainSpend(fixture.root, 'a1', { input: 100, output: 100, cached: 700, startedAt: now() });

      const state = budgetState(fixture.root, 'a1');
      expect(state.spent).toBe(900);
      expect(state.tier).toBe('batch');
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/budget.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/budget.js'".

- [ ] **Step 3: Implement the budget module**

Create `src/argus/budget.ts`:

```typescript
import type { SQLInputValue } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';

export type BudgetTier = 'normal' | 'conserve' | 'batch' | 'paused';

export interface TierPolicy {
  /** Whether the brain may pull actual file contents during review. */
  tier2Allowed: boolean;
  /** How many tasks to review in one brain invocation. */
  batchSize: number;
  /** Whether the review queue may drain at all. */
  reviewsAllowed: boolean;
}

export interface BudgetState {
  spent: number;
  ceiling: number;
  fraction: number;
  tier: BudgetTier;
  policy: TierPolicy;
  /**
   * Questions stay answerable in the band between the review pause and the
   * ceiling, so a heavy review batch cannot starve `ask_manager`.
   */
  questionsAllowed: boolean;
  windowStart: number;
}

export function classifyTier(fraction: number): BudgetTier {
  if (fraction < 0.6) return 'normal';
  if (fraction < 0.8) return 'conserve';
  if (fraction < 0.95) return 'batch';
  return 'paused';
}

export function tierPolicy(tier: BudgetTier): TierPolicy {
  switch (tier) {
    case 'normal':
      return { tier2Allowed: true, batchSize: 1, reviewsAllowed: true };
    case 'conserve':
      return { tier2Allowed: false, batchSize: 4, reviewsAllowed: true };
    case 'batch':
      return { tier2Allowed: false, batchSize: Number.MAX_SAFE_INTEGER, reviewsAllowed: true };
    case 'paused':
      return { tier2Allowed: false, batchSize: 0, reviewsAllowed: false };
  }
}

export function budgetState(projectRoot: string, argusId: string): BudgetState {
  const root = normalizeProjectRoot(projectRoot);
  const db = getDb(root);
  const argus = db
    .prepare(
      'SELECT budget_window_sec, budget_max_tokens, budget_count_cache_reads FROM argus WHERE id = ?'
    )
    .get(argusId) as Record<string, unknown> | undefined;
  if (!argus) throw new Error(`argus "${argusId}" not found`);

  const ceiling = Number(argus.budget_max_tokens);
  const windowStart = now() - Number(argus.budget_window_sec) * 1000;
  const countCache = Number(argus.budget_count_cache_reads) === 1;

  const cacheTerm = countCache ? ' + COALESCE(t.cached_tokens, 0)' : '';
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0)${cacheTerm}), 0) AS spent
       FROM session_telemetry t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.policy = 'brain' AND s.argus_parent = ? AND s.started_at > ?`
    )
    .get(...([argusId, windowStart] as SQLInputValue[])) as { spent: number };

  const spent = Number(row.spent);
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
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/budget.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/budget.ts test/unit/budget.test.ts
git commit -m "feat(argus): add rolling-window budget accounting and degradation ladder"
```

---

### Task 4: Objective gates

**Files:**
- Create: `src/argus/gates.ts`
- Test: `test/unit/gates.test.ts` (create)

**Interfaces:**
- Consumes: `GateResult` from `src/core/types.js`; `loadConfig` from `src/core/config.js`.
- Produces: `interface GateCommands { test: string; lint: string }`; `runGates(worktreePath: string, cmds: GateCommands): GateResult`; `computeDiffstat(worktreePath: string): string`; `gateCommandsFromConfig(): GateCommands`. Task 9 calls `runGates` and `computeDiffstat`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/gates.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runGates, computeDiffstat } from '../../src/argus/gates.js';
import { makeRepo } from '../helpers.js';

describe('runGates', () => {
  it('reports success when both commands exit zero', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, { test: 'exit 0', lint: 'exit 0' });
      expect(result.testExitCode).toBe(0);
      expect(result.lintExitCode).toBe(0);
      expect(result.failureTail).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('captures the failing command output in the tail', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, {
        test: 'echo "3 tests failed" && exit 1',
        lint: 'exit 0',
      });
      expect(result.testExitCode).toBe(1);
      expect(result.failureTail).toContain('3 tests failed');
    } finally {
      fixture.cleanup();
    }
  });

  it('skips a gate whose command is empty', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, { test: '', lint: 'exit 0' });
      expect(result.testExitCode).toBeNull();
      expect(result.lintExitCode).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('truncates a very long failure tail', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, {
        test: 'for i in $(seq 1 200); do echo "line $i"; done && exit 1',
        lint: '',
      });
      expect(result.failureTail.split('\n').length).toBeLessThanOrEqual(40);
      expect(result.failureTail).toContain('line 200');
      expect(result.failureTail).not.toContain('line 1\n');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('computeDiffstat', () => {
  it('summarises uncommitted changes', () => {
    const fixture = makeRepo();
    try {
      fs.writeFileSync(path.join(fixture.root, 'README.md'), '# fixture\nchanged\n');
      const stat = computeDiffstat(fixture.root);
      expect(stat).toContain('README.md');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns an empty string in a clean worktree', () => {
    const fixture = makeRepo();
    try {
      expect(computeDiffstat(fixture.root).trim()).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/gates.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/gates.js'".

- [ ] **Step 3: Implement the gates**

Create `src/argus/gates.ts`:

```typescript
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../core/config.js';
import type { GateResult } from '../core/types.js';

export interface GateCommands {
  test: string;
  lint: string;
}

const TAIL_LINES = 40;
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

export function gateCommandsFromConfig(): GateCommands {
  const { argus } = loadConfig();
  return { test: argus.gateTestCommand, lint: argus.gateLintCommand };
}

function tail(text: string): string {
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.slice(-TAIL_LINES).join('\n');
}

/** Runs one gate command. An empty command is a skipped gate, reported as null. */
function runOne(cwd: string, command: string): { code: number | null; output: string } {
  if (command.trim() === '') return { code: null, output: '' };
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS,
    env: { ...process.env, CI: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  // A timeout or spawn failure yields a null status; treat it as a gate failure
  // rather than a pass, so unverifiable work never reaches the brain.
  const code = result.status === null ? 1 : result.status;
  return { code, output };
}

/**
 * Tier 0 of review. Runs entirely in TypeScript and costs no brain tokens,
 * which is the point: objectively broken work must never reach a
 * rate-limited reviewer.
 */
export function runGates(worktreePath: string, cmds: GateCommands): GateResult {
  const testRun = runOne(worktreePath, cmds.test);
  const lintRun = runOne(worktreePath, cmds.lint);

  const failures: string[] = [];
  if (testRun.code !== null && testRun.code !== 0) failures.push(testRun.output);
  if (lintRun.code !== null && lintRun.code !== 0) failures.push(lintRun.output);

  return {
    testExitCode: testRun.code,
    lintExitCode: lintRun.code,
    failureTail: failures.length > 0 ? tail(failures.join('\n')) : '',
  };
}

/**
 * `git diff --stat` against HEAD, including untracked files. This is what the
 * brain sees instead of the diff itself at tier 1.
 */
export function computeDiffstat(worktreePath: string): string {
  const result = spawnSync('git', ['diff', '--stat', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  if (result.status !== 0) return '';
  return result.stdout ?? '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/gates.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/gates.ts test/unit/gates.test.ts
git commit -m "feat(argus): add tier 0 test and lint gates"
```

---

### Task 5: Brain JSON contract

**Files:**
- Create: `src/argus/brain.ts`
- Test: `test/unit/brain-contract.test.ts` (create)

**Interfaces:**
- Consumes: `zod` (already a dependency); `TaskDraft` from `src/argus/board.js`.
- Produces: `extractJson(stdout: string): unknown`; `PlanSchema`, `ReviewSchema`, `AnswerSchema`; `parsePlan(stdout: string): TaskDraft[]`; `parseReview(stdout: string): Verdict[]`; `parseAnswer(stdout: string): { answer: string; faqKey: string }`; `interface Verdict`. Task 6 and Task 9 call the parsers.

- [ ] **Step 1: Write the failing test**

Create `test/unit/brain-contract.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractJson, parsePlan, parseReview, parseAnswer } from '../../src/argus/brain.js';

describe('extractJson', () => {
  it('finds the JSON object inside conversational output', () => {
    const stdout = 'Here is the plan you asked for:\n{"tasks": []}\nLet me know.';
    expect(extractJson(stdout)).toEqual({ tasks: [] });
  });

  it('finds JSON inside a fenced code block', () => {
    const stdout = 'Result:\n```json\n{"answer": "yes", "faq_key": "k"}\n```\n';
    expect(extractJson(stdout)).toEqual({ answer: 'yes', faq_key: 'k' });
  });

  it('prefers the last JSON object when several appear', () => {
    const stdout = '{"tasks": [{"title": "draft", "spec": "s"}]}\nActually:\n{"tasks": []}';
    expect(extractJson(stdout)).toEqual({ tasks: [] });
  });

  it('throws when no JSON object is present', () => {
    expect(() => extractJson('I could not complete that.')).toThrow(/no JSON object/);
  });
});

describe('parsePlan', () => {
  it('parses tasks and defaults a missing depends_on', () => {
    const drafts = parsePlan('{"tasks":[{"title":"a","spec":"do a"}]}');
    expect(drafts).toEqual([{ title: 'a', spec: 'do a', dependsOn: [] }]);
  });

  it('maps depends_on indices through unchanged', () => {
    const drafts = parsePlan(
      '{"tasks":[{"title":"a","spec":"x","depends_on":[]},{"title":"b","spec":"y","depends_on":[0]}]}'
    );
    expect(drafts[1].dependsOn).toEqual([0]);
  });

  it('rejects an empty task list', () => {
    expect(() => parsePlan('{"tasks":[]}')).toThrow();
  });

  it('rejects a task missing a spec', () => {
    expect(() => parsePlan('{"tasks":[{"title":"a"}]}')).toThrow();
  });
});

describe('parseReview', () => {
  it('parses a batch of verdicts', () => {
    const verdicts = parseReview(
      '{"verdicts":[{"task_id":"t1","verdict":"accept"},{"task_id":"t2","verdict":"revise","reason":"no tests"}]}'
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({ taskId: 't1', verdict: 'accept', reason: null, paths: [] });
    expect(verdicts[1].reason).toBe('no tests');
  });

  it('parses a need_files verdict with paths', () => {
    const verdicts = parseReview(
      '{"verdicts":[{"task_id":"t1","verdict":"need_files","paths":["src/a.ts"]}]}'
    );
    expect(verdicts[0].verdict).toBe('need_files');
    expect(verdicts[0].paths).toEqual(['src/a.ts']);
  });

  it('rejects an unknown verdict value', () => {
    expect(() => parseReview('{"verdicts":[{"task_id":"t1","verdict":"maybe"}]}')).toThrow();
  });
});

describe('parseAnswer', () => {
  it('parses an answer and its faq key', () => {
    expect(parseAnswer('{"answer":"use vitest","faq_key":"test-command"}')).toEqual({
      answer: 'use vitest',
      faqKey: 'test-command',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/brain-contract.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/brain.js'".

- [ ] **Step 3: Implement the contract**

Create `src/argus/brain.ts`:

```typescript
import { z } from 'zod';
import type { TaskDraft } from './board.js';

export interface Verdict {
  taskId: string;
  verdict: 'accept' | 'revise' | 'need_files';
  reason: string | null;
  paths: string[];
}

export const PlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        spec: z.string().min(1),
        depends_on: z.array(z.number().int().nonnegative()).default([]),
      })
    )
    .min(1),
});

export const ReviewSchema = z.object({
  verdicts: z.array(
    z.object({
      task_id: z.string().min(1),
      verdict: z.enum(['accept', 'revise', 'need_files']),
      reason: z.string().nullish(),
      paths: z.array(z.string()).default([]),
    })
  ),
});

export const AnswerSchema = z.object({
  answer: z.string().min(1),
  faq_key: z.string().min(1),
});

/**
 * Harnesses wrap their output in prose or code fences even when told not to,
 * so the last balanced JSON object in the stream is taken as the answer. The
 * last one wins because a model that corrects itself puts the correction
 * after the draft.
 */
export function extractJson(stdout: string): unknown {
  const candidates: string[] = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(stdout.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('brain output contained no JSON object');
}

export function parsePlan(stdout: string): TaskDraft[] {
  const parsed = PlanSchema.parse(extractJson(stdout));
  return parsed.tasks.map((t) => ({
    title: t.title,
    spec: t.spec,
    dependsOn: t.depends_on,
  }));
}

export function parseReview(stdout: string): Verdict[] {
  const parsed = ReviewSchema.parse(extractJson(stdout));
  return parsed.verdicts.map((v) => ({
    taskId: v.task_id,
    verdict: v.verdict,
    reason: v.reason ?? null,
    paths: v.paths,
  }));
}

export function parseAnswer(stdout: string): { answer: string; faqKey: string } {
  const parsed = AnswerSchema.parse(extractJson(stdout));
  return { answer: parsed.answer, faqKey: parsed.faq_key };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/brain-contract.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/brain.ts test/unit/brain-contract.test.ts
git commit -m "feat(argus): add validated JSON contract for brain responses"
```

---

### Task 6: Brain invocation

**Files:**
- Modify: `src/sessions/harness.ts:26-33` (the `HarnessAdapter` interface) and each adapter's `sessionArgs`
- Modify: `src/sessions/manager.ts:22-28` (`StartOptions`), `:121` (the `writeMcpConfig` call), `:136-138` (the args branch), `:167-174` (the stdout handler)
- Modify: `src/argus/brain.ts` (append)
- Test: `test/unit/brain-invoke.test.ts` (create)

**Interfaces:**
- Consumes: `SessionManager`, `StartOptions` from `src/sessions/manager.js`; parsers from Task 5.
- Produces: `StartOptions.model?: string`; `StartOptions.onStdout?: (chunk: string) => void`; `invokeBrain(projectRoot: string, argusId: string, opts: BrainInvocation): Promise<string>` returning raw stdout; `interface BrainInvocation { prompt: string; model: string | null; label: string }`. Task 9 calls `invokeBrain`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/brain-invoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDb, now } from '../../src/core/state.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { invokeBrain } from '../../src/argus/brain.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

function seedArgus(root: string): void {
  getDb(root)
    .prepare(
      "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, brain_harness) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 'claude')"
    )
    .run(root, now());
}

describe('brain sessions', () => {
  it('never writes an MCP config, so a brain can never hold a session token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({
        name: 'brain-1',
        harness: 'claude',
        cwd: fixture.root,
        policy: 'brain',
      });
      await manager.startSession(session.id, {
        headless: true,
        prompt: 'hi',
        waitForExit: true,
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      const fs = await import('node:fs');
      expect(fs.existsSync(`${fixture.root}/.mcp.json`)).toBe(false);
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('returns the brain stdout and records a brain-policy session', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      seedArgus(fixture.root);
      const stdout = await invokeBrain(fixture.root, 'a1', {
        prompt: 'plan this',
        model: null,
        label: 'plan',
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      expect(stdout).toContain('fake claude ran with');

      const sessions = new SessionManager(fixture.root)
        .list()
        .filter((s) => s.policy === 'brain');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].argusParent).toBe('a1');
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/unit/brain-invoke.test.ts`
Expected: FAIL. `invokeBrain` is not exported, and the first test fails because `.mcp.json` is written for every session regardless of policy.

- [ ] **Step 3: Add the model option to the harness adapters**

In `src/sessions/harness.ts`, change the `HarnessAdapter` interface members on lines 26 and 33 to accept a model:

```typescript
  headlessArgs(prompt: string, opts: { autonomy?: boolean; model?: string }): string[];
  sessionArgs(prompt: string, opts: { autonomy?: boolean; model?: string }): string[];
```

In each of the four adapters, thread `opts.model` into the argv. For the Claude and Codex adapters, push `'--model', opts.model` when `opts.model` is set. For OpenCode use `'--model', opts.model`. Gemini uses `'-m', opts.model`. Concretely, in each `sessionArgs` body, immediately before the return, build the array then append:

```typescript
    if (opts.model) args.push('--model', opts.model);
```

using `'-m'` instead of `'--model'` for the Gemini adapter. If an adapter currently returns an array literal directly, refactor it into a `const args = [...]` followed by the conditional push and `return args;`.

**Verify these flags before trusting them.** The flag names above are unverified. For each of the four harnesses, run its `--help` (for example `claude --help`, `codex --help`, `opencode run --help`, `gemini --help`) and use the flag that binary actually documents. If a harness has no model flag, leave its `sessionArgs` ignoring `opts.model` and add a one-line comment saying so. Do not invent a flag: passing an unrecognised argument makes the harness exit non-zero, which would break every session for that harness, not just brain calls. Only Claude and Codex can be the brain, so those two matter most.

- [ ] **Step 4: Extend StartOptions and honour it**

In `src/sessions/manager.ts`, extend `StartOptions`:

```typescript
export interface StartOptions {
  headless?: boolean;
  prompt?: string;
  autonomy?: boolean;
  waitForExit?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Overrides the harness default model. Used for brain model tiering. */
  model?: string;
  /** Receives raw stdout chunks. Brain invocations use this to read JSON. */
  onStdout?: (chunk: string) => void;
}
```

Guard the MCP config write on line 121 so a brain session never gets one:

```typescript
    // A brain session returns JSON on stdout and calls no tools, so it must
    // never receive an MCP config or a live session token.
    if (session.policy !== 'brain') {
      adapter.writeMcpConfig(session, cwd, extraMcpEnv);
    }
```

Pass the model through when building args (currently lines 136 to 138):

```typescript
    const args = opts.headless
      ? adapter.sessionArgs(opts.prompt ?? '', { autonomy: opts.autonomy, model: opts.model })
      : adapter.interactiveArgs();
```

And forward raw stdout inside the existing `child.stdout?.on('data', ...)` handler, as the first statement in the callback body:

```typescript
        child.stdout?.on('data', (d) => {
          const raw = d.toString();
          opts.onStdout?.(raw);
          try {
            const text = collector.feed(raw, 'stdout');
            if (text) logStream?.write(text);
          } catch {
            // ignore
          }
        });
```

- [ ] **Step 5: Implement invokeBrain**

Append to `src/argus/brain.ts`:

```typescript
import crypto from 'node:crypto';
import { getDb } from '../core/state.js';
import { SessionManager } from '../sessions/manager.js';
import type { HarnessKind } from '../core/types.js';

export interface BrainInvocation {
  prompt: string;
  /** Null means the harness default model. */
  model: string | null;
  /** Short label used in the session name, for example "plan" or "review". */
  label: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one brain call as its own short-lived `policy: 'brain'` session.
 *
 * Each invocation being a separate session is load-bearing: it makes budget
 * accounting a plain sum over `session_telemetry` inside the window, and it
 * guarantees the brain can never satisfy the `isManager` check, which
 * requires `policy === 'manager'`.
 */
export async function invokeBrain(
  projectRoot: string,
  argusId: string,
  opts: BrainInvocation
): Promise<string> {
  const argus = getDb(projectRoot)
    .prepare('SELECT brain_harness FROM argus WHERE id = ?')
    .get(argusId) as { brain_harness?: string } | undefined;
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
  return stdout;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/unit/brain-invoke.test.ts test/unit/harness.test.ts`
Expected: PASS. If `test/unit/harness.test.ts` fails on adapter argv assertions, update those assertions to match the new array construction, but do not change the argv when `model` is absent.

- [ ] **Step 7: Commit**

```bash
git add src/sessions/harness.ts src/sessions/manager.ts src/argus/brain.ts test/unit/brain-invoke.test.ts
git commit -m "feat(argus): invoke the brain as a budget-tracked headless session"
```

---

### Task 7: Question queue and FAQ cache

**Files:**
- Create: `src/argus/questions.ts`
- Test: `test/unit/questions.test.ts` (create)

**Interfaces:**
- Consumes: `NotesStore` from `src/notes/store.js`; `Question` from `src/core/types.js`; `getDb`, `now` from `src/core/state.js`.
- Produces: `class QuestionQueue` with `ask`, `pending`, `answer`, `waitForAnswer`, `faqLookup`; `type AskResult = { hit: true; answer: string } | { hit: false; id: number }`. Tasks 8 and 9 call these.

- [ ] **Step 1: Write the failing test**

Create `test/unit/questions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { QuestionQueue } from '../../src/argus/questions.js';
import { makeRepo } from '../helpers.js';

describe('QuestionQueue', () => {
  it('misses on a cold cache and queues the question', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const result = queue.ask('a1', 's1', 'What is the test command?');
      expect(result.hit).toBe(false);
      expect(queue.pending('a1')).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('serves a repeat question from the FAQ without queueing it', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const first = queue.ask('a1', 's1', 'What is the test command?');
      if (first.hit) throw new Error('expected a cache miss');
      queue.answer(first.id, 'Run npm test', 'test-command');

      const second = queue.ask('a1', 's2', 'What is the test command?');
      expect(second).toEqual({ hit: true, answer: 'Run npm test' });
      expect(queue.pending('a1')).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('matches on keyword overlap despite punctuation and case', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const first = queue.ask('a1', 's1', 'What is the test command?');
      if (first.hit) throw new Error('expected a cache miss');
      queue.answer(first.id, 'Run npm test', 'test-command');

      const second = queue.ask('a1', 's2', 'what is the TEST command');
      expect(second.hit).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('resolves waitForAnswer once the answer lands', async () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's1', 'Which auth pattern?');
      if (asked.hit) throw new Error('expected a cache miss');

      setTimeout(() => queue.answer(asked.id, 'Use the session token', 'auth'), 60);
      const answer = await queue.waitForAnswer(asked.id, 2000);
      expect(answer).toBe('Use the session token');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns null when the brain does not answer in time, so the worker is never stalled', async () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's1', 'Anything?');
      if (asked.hit) throw new Error('expected a cache miss');
      expect(await queue.waitForAnswer(asked.id, 250)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/questions.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/questions.js'".

- [ ] **Step 3: Implement the queue**

Create `src/argus/questions.ts`:

```typescript
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import { NotesStore } from '../notes/store.js';
import type { Question } from '../core/types.js';

export type AskResult = { hit: true; answer: string } | { hit: false; id: number };

const FAQ_TITLE = 'flightdeck-faq';
const MATCH_THRESHOLD = 0.6;
const POLL_INTERVAL_MS = 50;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'what', 'which', 'how', 'why', 'when', 'where', 'to', 'of', 'in',
  'on', 'for', 'i', 'we', 'should', 'can', 'this', 'that', 'it',
]);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
  );
}

/**
 * Jaccard overlap of significant words. Deliberately naive: a miss costs one
 * brain call, whereas embeddings would add a dependency and an index to
 * maintain. Revisit if the observed miss rate is high.
 */
export function similarity(a: string, b: string): number {
  const setA = keywords(a);
  const setB = keywords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  const union = new Set([...setA, ...setB]).size;
  return shared / union;
}

function rowToQuestion(row: Record<string, unknown>): Question {
  return {
    id: Number(row.id),
    argusId: String(row.argus_id),
    sessionId: String(row.session_id),
    question: String(row.question),
    answer: typeof row.answer === 'string' ? row.answer : null,
    faqKey: typeof row.faq_key === 'string' ? row.faq_key : null,
    createdAt: Number(row.created_at),
    answeredAt: row.answered_at === null ? null : Number(row.answered_at),
  };
}

export class QuestionQueue {
  private readonly db: DatabaseSync;
  private readonly notes: NotesStore;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.notes = new NotesStore(this.projectRoot);
  }

  /** Every previously answered question in this project, newest first. */
  private answered(argusId: string): Question[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM questions WHERE argus_id = ? AND answer IS NOT NULL ORDER BY id DESC'
      )
      .all(argusId) as Record<string, unknown>[];
    return rows.map(rowToQuestion);
  }

  faqLookup(argusId: string, question: string): string | null {
    for (const prior of this.answered(argusId)) {
      if (similarity(prior.question, question) >= MATCH_THRESHOLD) {
        return prior.answer;
      }
    }
    return null;
  }

  ask(argusId: string, sessionId: string, question: string): AskResult {
    const cached = this.faqLookup(argusId, question);
    if (cached !== null) return { hit: true, answer: cached };

    const result = this.db
      .prepare(
        'INSERT INTO questions (argus_id, session_id, question, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(...([argusId, sessionId, question, now()] as SQLInputValue[]));
    return { hit: false, id: Number(result.lastInsertRowid) };
  }

  pending(argusId: string): Question[] {
    const rows = this.db
      .prepare('SELECT * FROM questions WHERE argus_id = ? AND answer IS NULL ORDER BY id ASC')
      .all(argusId) as Record<string, unknown>[];
    return rows.map(rowToQuestion);
  }

  get(id: number): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToQuestion(row) : null;
  }

  /** Records the answer and appends it to the human-readable FAQ note. */
  answer(id: number, answer: string, faqKey: string): void {
    this.db
      .prepare('UPDATE questions SET answer = ?, faq_key = ?, answered_at = ? WHERE id = ?')
      .run(...([answer, faqKey, now(), id] as SQLInputValue[]));
    this.appendToFaqNote(faqKey, answer);
  }

  private appendToFaqNote(faqKey: string, answer: string): void {
    const existing = this.notes.list().find((n) => n.title === FAQ_TITLE);
    const entry = `\n## ${faqKey}\n\n${answer}\n`;
    if (existing) {
      const full = this.notes.readNote(existing.id);
      this.notes.updateNote(existing.id, { body: `${full?.body ?? ''}${entry}` });
      return;
    }
    this.notes.createNote(FAQ_TITLE, `# Fleet FAQ\n${entry}`);
  }

  /**
   * Resolves with the answer, or null on timeout. Null is not an error: a
   * throttled brain must slow review throughput without ever stalling a
   * worker, so the caller proceeds on best judgment instead.
   */
  async waitForAnswer(id: number, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const question = this.get(id);
      if (question?.answer) return question.answer;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/questions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/questions.ts test/unit/questions.test.ts
git commit -m "feat(argus): add FAQ-cached question queue that never stalls workers"
```

---

### Task 8: Worker MCP tools

**Files:**
- Modify: `src/mcp/tools.ts` (imports at the top, and inside `registerAll()`)
- Test: `test/unit/worker-tools.test.ts` (create)

**Interfaces:**
- Consumes: `TaskBoard` (Task 2), `QuestionQueue` (Task 7).
- Produces: three registered tools, `task_get` (risk `read`), `report_done` (risk `additive`), `ask_manager` (risk `additive`).

- [ ] **Step 1: Write the failing test**

Create `test/unit/worker-tools.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/mcp/tools.js';
import { TaskBoard } from '../../src/argus/board.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

function childContext(root: string, sessionId: string) {
  return {
    projectRoot: root,
    sessionId,
    policy: 'child' as const,
    isManager: false,
    riskyTools: false,
    confirm: async () => false,
  };
}

function seedArgus(root: string): void {
  getDb(root)
    .prepare(
      "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, question_timeout_sec) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 1)"
    )
    .run(root, now());
}

describe('worker tools', () => {
  it('all three are callable by a child session with risky tools disabled', () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      for (const name of ['task_get', 'report_done', 'ask_manager']) {
        const def = registry.tools.get(name);
        expect(def, `${name} must be registered`).toBeDefined();
        expect(['read', 'additive']).toContain(def!.risk);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('task_get returns the assigned task for the calling session', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 's1');

      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      const result = (await registry.call('task_get', {})) as Record<string, unknown>;
      expect(result.id).toBe(task.id);
      expect(result.spec).toBe('do a');
    } finally {
      fixture.cleanup();
    }
  });

  it('report_done moves the task to reported and stores the report', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 's1');

      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      await registry.call('report_done', {
        summary: 'added the module',
        files_changed: ['src/a.ts'],
        tests_run: 'npm test',
        uncertainties: 'none',
      });

      const updated = board.get(task.id);
      expect(updated?.status).toBe('reported');
      expect(updated?.workerReport?.summary).toBe('added the module');
    } finally {
      fixture.cleanup();
    }
  });

  it('ask_manager returns a cached answer immediately without queueing', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      // ask_manager resolves the fleet from the caller's session row, so the
      // worker must actually exist and be parented to the argus.
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'a1',
      });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's0', 'What is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');
      queue.answer(asked.id, 'Run npm test', 'test-command');

      const registry = new ToolRegistry(childContext(fixture.root, worker.id));
      const result = (await registry.call('ask_manager', {
        question: 'What is the test command?',
      })) as Record<string, unknown>;
      expect(result.answer).toBe('Run npm test');
      expect(result.cached).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('ask_manager tells the worker to proceed when the brain does not answer', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'a1',
      });
      const registry = new ToolRegistry(childContext(fixture.root, worker.id));
      // seedArgus sets question_timeout_sec to 1, so this resolves in ~1s.
      const result = (await registry.call('ask_manager', {
        question: 'Something nobody has asked before?',
      })) as Record<string, unknown>;
      expect(result.answer).toBeNull();
      expect(String(result.directive)).toContain('best judgment');
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/worker-tools.test.ts`
Expected: FAIL. `registry.tools.get('task_get')` is `undefined`.

- [ ] **Step 3: Register the tools**

In `src/mcp/tools.ts`, add these imports next to the existing ones at the top:

```typescript
import { TaskBoard } from '../argus/board.js';
import { QuestionQueue } from '../argus/questions.js';
```

Add two private fields to `ToolRegistry` alongside `messaging`, and initialise them in the constructor before `this.registerAll()`:

```typescript
  private readonly board: TaskBoard;
  private readonly questions: QuestionQueue;
```

```typescript
    this.board = new TaskBoard(ctx.projectRoot);
    this.questions = new QuestionQueue(ctx.projectRoot);
```

Then inside `registerAll()`, add these three registrations. Place them immediately after the existing `message_send` registration.

```typescript
    const board = this.board;
    const questions = this.questions;

    // Worker-facing. All three are read or additive so a `policy: 'child'`
    // session can call them without a risky-tools grant.
    this.register({
      name: 'task_get',
      description: 'Get the task currently assigned to this session, with its full spec.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => {
        if (!s.sessionId) throw new Error('task_get requires a session');
        const mine = board
          .listByAssignee(s.sessionId)
          .find((t) => t.status === 'assigned' || t.status === 'revising');
        if (!mine) throw new Error('no task is currently assigned to this session');
        return {
          id: mine.id,
          title: mine.title,
          spec: mine.spec,
          status: mine.status,
          attempts: mine.attempts,
          previousFeedback: mine.verdictReason,
        };
      },
    });

    this.register({
      name: 'report_done',
      description:
        'Report the assigned task complete. Provide an honest summary; automated test and lint gates run immediately afterwards and will return the task to you if they fail.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tests_run: { type: 'string' },
          uncertainties: { type: 'string' },
        },
        required: ['summary'],
      },
      risk: 'additive',
      handler: async (args) => {
        if (!s.sessionId) throw new Error('report_done requires a session');
        const mine = board
          .listByAssignee(s.sessionId)
          .find((t) => t.status === 'assigned' || t.status === 'revising');
        if (!mine) throw new Error('no task is currently assigned to this session');
        const files = Array.isArray(args.files_changed)
          ? (args.files_changed as unknown[]).map((f) => asStr(f))
          : [];
        board.report(mine.id, {
          summary: asStr(args.summary),
          filesChanged: files,
          testsRun: asStr(args.tests_run),
          uncertainties: asStr(args.uncertainties),
        });
        return { ok: true, taskId: mine.id, next: 'gates' };
      },
    });

    this.register({
      name: 'ask_manager',
      description:
        'Ask the orchestrator a question. Answers are cached, so repeated questions are free. If no answer arrives in time, proceed on your best judgment and record the assumption in your report.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
      risk: 'additive',
      handler: async (args) => {
        if (!s.sessionId) throw new Error('ask_manager requires a session');
        const session = sessions.get(s.sessionId);
        const argusId = session?.argusParent;
        if (!argusId) throw new Error('ask_manager is only available to fleet workers');

        const question = asStr(args.question);
        const asked = questions.ask(argusId, s.sessionId, question);
        if (asked.hit) return { answer: asked.answer, cached: true };

        const row = getDb(s.projectRoot)
          .prepare('SELECT question_timeout_sec FROM argus WHERE id = ?')
          .get(argusId) as { question_timeout_sec?: number } | undefined;
        const timeoutMs = Number(row?.question_timeout_sec ?? 120) * 1000;

        const answer = await questions.waitForAnswer(asked.id, timeoutMs);
        if (answer !== null) return { answer, cached: false };
        return {
          answer: null,
          cached: false,
          directive:
            'No answer available in time. Proceed on your best judgment and record the assumption in the uncertainties field of your report.',
        };
      },
    });
```

Add the `getDb` import at the top of the file if it is not already present:

```typescript
import { getDb } from '../core/state.js';
```

- [ ] **Step 4: Add the board lookup the tools need**

`task_get` and `report_done` both call `board.listByAssignee`, which does not exist yet. Add it to `src/argus/board.ts` as a method on `TaskBoard`, directly after `list`:

```typescript
  listByAssignee(sessionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE assignee_session = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(rowToTask);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/worker-tools.test.ts test/unit/permissions.test.ts`
Expected: PASS. `permissions.test.ts` must still pass unchanged, confirming the permission gate was not weakened.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/argus/board.ts test/unit/worker-tools.test.ts
git commit -m "feat(mcp): add task_get, report_done, and ask_manager worker tools"
```

---

### Task 9: Dispatcher and the orchestration loop

**Files:**
- Modify: `src/argus/manager.ts:60-69` (delete `parseTasks`), `:185-227` (replace `pulse`), `:229-260` (rewrite `spawnChild`)
- Test: `test/integration/orchestration.test.ts` (create)

**Interfaces:**
- Consumes: `TaskBoard`, `budgetState`, `runGates`, `computeDiffstat`, `invokeBrain`, `parsePlan`, `parseReview`, `parseAnswer`, `QuestionQueue`.
- Produces: `ArgusManager.pulse(id)` performing plan, dispatch, gate, review, and answer phases; `ArgusManager.plan(id)`; `ArgusManager.drainReviews(id)`; `ArgusManager.answerQuestions(id)`. Task 10 calls these from the CLI.

**Note on testing:** the brain is invoked through `invokeBrain`. To test without a model, this task adds an injectable seam: `ArgusManager` takes an optional second constructor argument `brainFn` defaulting to the real `invokeBrain`. Tests pass a fake returning canned JSON.

- [ ] **Step 1: Write the failing test**

Create `test/integration/orchestration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { NotesStore } from '../../src/notes/store.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

/** A brain that returns canned JSON, so no model is ever invoked. */
function fakeBrain(responses: Record<string, string>) {
  const calls: string[] = [];
  const fn = async (_root: string, _argusId: string, opts: { label: string }): Promise<string> => {
    calls.push(opts.label);
    return responses[opts.label] ?? '{}';
  };
  return { fn, calls };
}

describe('orchestration', () => {
  it('turns a plan into board rows', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({
        plan: '{"tasks":[{"title":"a","spec":"do a","depends_on":[]},{"title":"b","spec":"do b","depends_on":[0]}]}',
      });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', childLimit: 2, missionNoteId: mission.id });

      await manager.plan(argus.id);

      const tasks = new TaskBoard(fixture.root).list(argus.id);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].dependsOn).toEqual([tasks[0].id]);
      expect(brain.calls).toEqual(['plan']);
    } finally {
      fixture.cleanup();
    }
  });

  it('bounces a gate failure back to the worker without invoking the brain', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({});
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');
      board.report(task.id, {
        summary: 'done', filesChanged: [], testsRun: '', uncertainties: '',
      });

      await manager.runGatesForReported(argus.id, { test: 'exit 1', lint: '' });

      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(brain.calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks a task that exhausts its attempt budget', async () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({ name: 'fleet' });
      getDb(fixture.root)
        .prepare('UPDATE argus SET max_attempts_per_task = 2 WHERE id = ?')
        .run(argus.id);

      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');

      for (let i = 0; i < 2; i++) {
        board.report(task.id, {
          summary: 'done', filesChanged: [], testsRun: '', uncertainties: '',
        });
        await manager.runGatesForReported(argus.id, { test: 'exit 1', lint: '' });
      }

      expect(board.get(task.id)?.status).toBe('blocked');
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a reviewed task and applies the verdict', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        const tasks = board.list(argusId, 'in_review');
        return opts.label === 'review'
          ? `{"verdicts":[{"task_id":"${tasks[0].id}","verdict":"accept"}]}`
          : '{}';
      });
      const argus = manager.start({ name: 'fleet' });
      const argusId = argus.id;
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not drain reviews when the budget is paused', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({ review: '{"verdicts":[]}' });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      // Ceiling of zero forces fraction >= 0.95, the paused tier.
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 0 WHERE id = ?')
        .run(argus.id);

      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argus.id);

      expect(board.get(task.id)?.status).toBe('in_review');
      expect(brain.calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('answers a pending question and caches it', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({ answer: '{"answer":"Run npm test","faq_key":"test-command"}' });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'What is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');

      await manager.answerQuestions(argus.id);

      expect(queue.get(asked.id)?.answer).toBe('Run npm test');
      expect(queue.pending(argus.id)).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('retries malformed brain output exactly once', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const manager = new ArgusManager(fixture.root, async () => {
        calls += 1;
        return calls === 1 ? 'Sorry, I cannot do that.' : '{"tasks":[{"title":"a","spec":"do a"}]}';
      });
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', missionNoteId: mission.id });

      await manager.plan(argus.id);

      expect(calls).toBe(2);
      expect(new TaskBoard(fixture.root).list(argus.id)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('gives up after one failed retry rather than looping against a rate limit', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const manager = new ArgusManager(fixture.root, async () => {
        calls += 1;
        return 'still not JSON';
      });
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', missionNoteId: mission.id });

      await expect(manager.plan(argus.id)).rejects.toThrow(/no JSON object/);
      expect(calls).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/integration/orchestration.test.ts`
Expected: FAIL. `ArgusManager` takes one constructor argument and has no `plan`, `runGatesForReported`, `drainReviews`, or `answerQuestions` methods.

- [ ] **Step 3: Delete parseTasks**

Remove the `parseTasks` function from `src/argus/manager.ts` (lines 60 to 69) entirely, along with its export. Then run `grep -rn "parseTasks" src test` and delete or update every reference found, including any assertion in `test/e2e/argus.test.ts`.

- [ ] **Step 4: Rewrite the manager**

In `src/argus/manager.ts`, add the imports:

```typescript
import { TaskBoard } from './board.js';
import { budgetState } from './budget.js';
import { runGates, computeDiffstat, gateCommandsFromConfig, type GateCommands } from './gates.js';
import { QuestionQueue } from './questions.js';
import { invokeBrain, parsePlan, parseReview, parseAnswer, type BrainInvocation } from './brain.js';
```

Add the injectable brain seam and the new fields to the class. Replace the existing constructor with:

```typescript
export type BrainFn = (
  projectRoot: string,
  argusId: string,
  opts: BrainInvocation
) => Promise<string>;

// ... inside the class:
  private readonly board: TaskBoard;
  private readonly questions: QuestionQueue;
  private readonly brain: BrainFn;

  constructor(projectRoot: string, brain: BrainFn = invokeBrain) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.sessions = new SessionManager(this.projectRoot);
    this.notes = new NotesStore(this.projectRoot);
    this.tables = new TablesStore(this.projectRoot);
    this.board = new TaskBoard(this.projectRoot);
    this.questions = new QuestionQueue(this.projectRoot);
    this.brain = brain;
  }
```

Add the retry wrapper. Every brain call goes through it, so no phase method parses raw stdout itself:

```typescript
  /**
   * One brain call, with exactly one retry on malformed output.
   *
   * A retry loop against a rate-limited brain is worse than a visible
   * failure, so the second parse error is thrown rather than retried.
   */
  private async brainJson<T>(
    id: string,
    opts: BrainInvocation,
    parse: (stdout: string) => T
  ): Promise<T> {
    const stdout = await this.brain(this.projectRoot, id, opts);
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
      return parse(retried);
    }
  }
```

Add the four phase methods:

```typescript
  /** Turns the mission note into task board rows. One brain call. */
  async plan(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const mission = argus.missionNoteId ? this.notes.readNote(argus.missionNoteId) : null;
    if (!mission) throw new Error(`argus "${id}" has no readable mission note`);

    const existing = this.board.list(id);
    const row = this.db
      .prepare('SELECT brain_plan_model, max_tasks FROM argus WHERE id = ?')
      .get(id) as { brain_plan_model?: string; max_tasks?: number };

    const prompt = [
      'You are the orchestrator of a fleet of coding agents.',
      'Break the mission below into independent tasks that separate agents can work on in isolated git worktrees.',
      '',
      'Mission:',
      mission.body,
      '',
      existing.length > 0
        ? `Tasks already on the board (do not repeat them):\n${existing.map((t) => `- ${t.title} [${t.status}]`).join('\n')}`
        : '',
      '',
      'Reply with JSON only, in exactly this shape:',
      '{"tasks":[{"title":"short name","spec":"what to do and how to verify it","depends_on":[]}]}',
      '"depends_on" holds zero-based indices into this same tasks array.',
      'Do not write any prose outside the JSON object.',
    ].join('\n');

    const drafts = await this.brainJson(
      id,
      { prompt, model: row.brain_plan_model ?? null, label: 'plan' },
      parsePlan
    );
    const room = Math.max(0, Number(row.max_tasks ?? 100) - existing.length);
    const created = this.board.create(id, drafts.slice(0, room));
    this.writeProgress(id, null, 'planned', `tasks=${created.length}`);
  }

  /**
   * Tier 0. Runs the objective gates for every reported task. No brain call,
   * which is the point: objectively broken work must never reach a
   * rate-limited reviewer.
   */
  async runGatesForReported(id: string, cmds: GateCommands = gateCommandsFromConfig()): Promise<void> {
    const argus = this.get(id);
    if (!argus) return;
    const maxAttempts = Number(
      (this.db.prepare('SELECT max_attempts_per_task FROM argus WHERE id = ?').get(id) as
        { max_attempts_per_task?: number }).max_attempts_per_task ?? 3
    );

    for (const task of this.board.list(id, 'reported')) {
      const session = task.assigneeSession ? this.sessions.get(task.assigneeSession) : undefined;
      const cwd = session?.cwd ?? this.projectRoot;
      const result = runGates(cwd, cmds);
      const updated = this.board.recordGates(task.id, result, computeDiffstat(cwd));
      this.writeProgress(
        id,
        task.assigneeSession,
        updated.status === 'in_review' ? 'gates_passed' : 'gates_failed',
        task.title
      );
      if (updated.status === 'revising' && updated.attempts >= maxAttempts) {
        this.board.block(task.id, `exhausted ${maxAttempts} attempts: ${result.failureTail}`);
        this.writeProgress(id, task.assigneeSession, 'task_blocked', task.title);
      }
    }
  }

  /** Drains the review queue in batches sized by the budget ladder. */
  async drainReviews(id: string): Promise<void> {
    const budget = budgetState(this.projectRoot, id);
    if (!budget.policy.reviewsAllowed) {
      this.writeProgress(id, null, 'review_paused', `spend=${budget.spent}/${budget.ceiling}`);
      return;
    }
    const queued = this.board.list(id, 'in_review');
    if (queued.length === 0) return;

    const batch = queued.slice(0, Math.min(queued.length, budget.policy.batchSize));
    const row = this.db
      .prepare('SELECT brain_review_model FROM argus WHERE id = ?')
      .get(id) as { brain_review_model?: string };

    const body = batch
      .map((t) =>
        [
          `Task ${t.id}: ${t.title}`,
          `Spec: ${t.spec}`,
          `Worker summary: ${t.workerReport?.summary ?? '(none)'}`,
          `Files changed: ${(t.workerReport?.filesChanged ?? []).join(', ') || '(none)'}`,
          `Worker uncertainties: ${t.workerReport?.uncertainties ?? '(none)'}`,
          `Diffstat:\n${t.diffstat ?? '(none)'}`,
          `Gates: test=${t.gateResult?.testExitCode ?? 'skipped'} lint=${t.gateResult?.lintExitCode ?? 'skipped'}`,
        ].join('\n')
      )
      .join('\n\n---\n\n');

    const prompt = [
      'Review the completed tasks below. Automated test and lint gates have already passed for all of them.',
      'Judge whether the work satisfies its spec.',
      '',
      body,
      '',
      'Reply with JSON only:',
      '{"verdicts":[{"task_id":"...","verdict":"accept|revise|need_files","reason":"...","paths":[]}]}',
      budget.policy.tier2Allowed
        ? 'Use "need_files" with specific paths only if you genuinely cannot decide from the summary.'
        : 'The token budget is constrained. Do not use "need_files"; decide from the summary, or return "revise" with a concrete reason.',
    ].join('\n');

    const verdicts = await this.brainJson(
      id,
      { prompt, model: row.brain_review_model ?? null, label: 'review' },
      parseReview
    );

    for (const verdict of verdicts) {
      if (verdict.verdict === 'need_files') {
        // Tier 2 re-queue is a follow-up call; leave the task queued and
        // record what the brain asked for.
        this.writeProgress(id, null, 'review_need_files', verdict.paths.join(', '));
        continue;
      }
      this.board.recordVerdict(verdict.taskId, verdict.verdict, verdict.reason);
      this.writeProgress(id, null, `review_${verdict.verdict}`, verdict.taskId);
    }
  }

  /** Answers queued worker questions, one brain call each. */
  async answerQuestions(id: string): Promise<void> {
    const budget = budgetState(this.projectRoot, id);
    if (!budget.questionsAllowed) return;
    const mission = this.get(id)?.missionNoteId;
    const missionBody = mission ? this.notes.readNote(mission)?.body ?? '' : '';
    const row = this.db
      .prepare('SELECT brain_review_model FROM argus WHERE id = ?')
      .get(id) as { brain_review_model?: string };

    for (const question of this.questions.pending(id)) {
      const prompt = [
        'A coding agent in your fleet has a question. Answer it concisely and concretely.',
        '',
        missionBody ? `Mission context:\n${missionBody}\n` : '',
        `Question: ${question.question}`,
        '',
        'Reply with JSON only:',
        '{"answer":"...","faq_key":"short-kebab-case-topic"}',
      ].join('\n');
      const parsed = await this.brainJson(
        id,
        { prompt, model: row.brain_review_model ?? null, label: 'answer' },
        parseAnswer
      );
      this.questions.answer(question.id, parsed.answer, parsed.faqKey);
      this.writeProgress(id, question.sessionId, 'question_answered', parsed.faqKey);
    }
  }
```

- [ ] **Step 5: Replace pulse with dispatch-only scheduling**

Replace the whole body of `pulse` in `src/argus/manager.ts` with:

```typescript
  /**
   * Free scheduling. The brain is event-driven, never polled: this loop only
   * dispatches work and runs gates, then wakes the brain if and only if there
   * is something for it to decide.
   */
  async pulse(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) return;

    if (this.board.list(id).length === 0) {
      await this.plan(id);
    }

    await this.dispatch(id);
    await this.runGatesForReported(id);

    if (this.questions.pending(id).length > 0) {
      await this.answerQuestions(id);
    }
    if (this.board.list(id, 'in_review').length > 0) {
      await this.drainReviews(id);
    }

    this.db.prepare('UPDATE argus SET last_pulse_at = ? WHERE id = ?').run(now(), id);
  }

  /** Assigns dispatchable tasks to fresh worker sessions, up to the child limit. */
  private async dispatch(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) return;
    const row = this.db
      .prepare('SELECT worker_harnesses FROM argus WHERE id = ?')
      .get(id) as { worker_harnesses?: string };
    const harnesses = JSON.parse(row.worker_harnesses ?? '["opencode"]') as HarnessKind[];

    const active = this.children(argus).filter((c) => c.session?.status === 'running');
    let slots = argus.childLimit - active.length;
    let n = this.children(argus).length;

    for (const task of this.board.dispatchable(id)) {
      if (slots <= 0) break;
      try {
        n += 1;
        await this.spawnWorker(argus, task, harnesses[n % harnesses.length], n);
        slots -= 1;
      } catch (err) {
        this.writeProgress(id, null, 'child_failed', (err as Error).message);
      }
    }
  }
```

Rename `spawnChild` to `spawnWorker` and change its signature and prompt so the worker uses the MCP tools rather than a one-shot instruction:

```typescript
  private async spawnWorker(
    argus: Argus,
    task: Task,
    harness: HarnessKind,
    n: number
  ): Promise<void> {
    const worktreeName = `${slugify(argus.name)}-${n}-${slugify(task.title, 24)}`;
    const info = createWorktree(this.projectRoot, worktreeName, argus.managerSessionId ?? undefined);
    const session = this.sessions.createSession({
      name: `${argus.name}-worker-${n}`,
      harness,
      worktree: worktreeName,
      cwd: info.path,
      policy: 'child',
      argusParent: argus.id,
      task: task.title,
    });
    this.board.assign(task.id, session.id);

    const prompt = [
      'You are a coding agent working autonomously in an isolated git worktree.',
      `Worktree: ${info.path}`,
      '',
      'Your assigned task:',
      task.spec,
      '',
      'Rules:',
      '- If you are unsure about a project convention, call the `ask_manager` tool. Answers are cached, so asking is cheap.',
      '- When finished, call the `report_done` tool with an honest summary.',
      '- Automated test and lint gates run immediately after you report. If they fail, the task comes back to you with the output.',
    ].join('\n');

    await this.sessions.startSession(session.id, {
      headless: true,
      prompt,
      autonomy: true,
      waitForExit: false,
      env: { FLIGHTDECK_ARGUS_ID: argus.id },
    });
    this.writeProgress(argus.id, session.id, 'worker_spawned', task.title);
  }
```

Add `import type { HarnessKind, Task } from '../core/types.js';` to the existing type import at the top.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/integration/orchestration.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS. `test/e2e/argus.test.ts` may need updating where it asserted bullet-derived children; update it to assert board rows instead, and do not weaken it to a trivial assertion.

- [ ] **Step 8: Commit**

```bash
git add src/argus/manager.ts test/integration/orchestration.test.ts test/e2e/argus.test.ts
git commit -m "feat(argus): replace bullet scheduling with brain-driven orchestration"
```

---

### Task 10: CLI surface

**Files:**
- Modify: `src/cli/commands/argus.ts`
- Test: `test/e2e/orchestrator-cli.test.ts` (create)

**Interfaces:**
- Consumes: `ArgusManager` phase methods (Task 9), `TaskBoard` (Task 2), `budgetState` (Task 3).
- Produces: `deck argus board <id> [--json]`, `deck argus budget <id> [--json]`, `deck argus task <task-id> [--json]`, `deck argus plan <id>`.

- [ ] **Step 1: Write the failing test**

Create `test/e2e/orchestrator-cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { runCli, makeRepo } from '../helpers.js';

describe('orchestrator CLI', () => {
  it('prints the board as JSON', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      new TaskBoard(fixture.root).create(argus.id, [
        { title: 'first task', spec: 'do it', dependsOn: [] },
      ]);

      const result = runCli(['argus', 'board', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { title: string; status: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe('first task');
      expect(parsed[0].status).toBe('pending');
    } finally {
      fixture.cleanup();
    }
  });

  it('prints the budget with its tier', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });

      const result = runCli(['argus', 'budget', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { spent: number; tier: string };
      expect(parsed.spent).toBe(0);
      expect(parsed.tier).toBe('normal');
    } finally {
      fixture.cleanup();
    }
  });

  it('exits non-zero for an unknown argus id', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['argus', 'budget', 'nope', '--json'], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/e2e/orchestrator-cli.test.ts`
Expected: FAIL. `deck argus board` is an unknown command, so the CLI exits non-zero and stdout is not JSON.

- [ ] **Step 3: Register the commands**

In `src/cli/commands/argus.ts`, add these imports:

```typescript
import { TaskBoard } from '../../argus/board.js';
import { budgetState } from '../../argus/budget.js';
```

Then register four subcommands on the existing `argus` command object. Follow the file's established pattern for `--json` and for `handleError`:

```typescript
  argus
    .command('board <id>')
    .description('Show the task board for a fleet')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const tasks = new TaskBoard(projectRoot).list(id);
        if (opts.json) {
          console.log(JSON.stringify(tasks, null, 2));
          return;
        }
        if (tasks.length === 0) {
          console.log('(no tasks)');
          return;
        }
        for (const task of tasks) {
          const attempts = task.attempts > 0 ? ` attempts=${task.attempts}` : '';
          console.log(`${task.status.padEnd(10)} ${task.id.slice(0, 8)}  ${task.title}${attempts}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('budget <id>')
    .description('Show brain token spend for the current window')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const state = budgetState(projectRoot, id);
        if (opts.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }
        const pct = (state.fraction * 100).toFixed(1);
        console.log(`spent   ${state.spent} / ${state.ceiling} tokens (${pct}%)`);
        console.log(`tier    ${state.tier}`);
        console.log(`reviews ${state.policy.reviewsAllowed ? 'draining' : 'paused'}`);
        console.log(`tier 2  ${state.policy.tier2Allowed ? 'allowed' : 'disabled'}`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('task <taskId>')
    .description('Show one task in full, including the worker report and gate output')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((taskId: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const task = new TaskBoard(projectRoot).get(taskId);
        if (!task) throw new Error(`task "${taskId}" not found`);
        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }
        console.log(`${task.title}  [${task.status}]`);
        console.log(`\nSpec:\n${task.spec}`);
        if (task.workerReport) {
          console.log(`\nWorker summary:\n${task.workerReport.summary}`);
          console.log(`Uncertainties: ${task.workerReport.uncertainties || '(none)'}`);
        }
        if (task.gateResult) {
          console.log(
            `\nGates: test=${task.gateResult.testExitCode ?? 'skipped'} lint=${task.gateResult.lintExitCode ?? 'skipped'}`
          );
          if (task.gateResult.failureTail) console.log(task.gateResult.failureTail);
        }
        if (task.verdictReason) console.log(`\nFeedback:\n${task.verdictReason}`);
      } catch (err) {
        handleError(err);
      }
    });

  argus
    .command('plan <id>')
    .description('Ask the brain to plan the mission into board tasks (costs brain tokens)')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (id: string, opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new ArgusManager(projectRoot).plan(id);
        const tasks = new TaskBoard(projectRoot).list(id);
        console.log(`planned ${tasks.length} tasks`);
      } catch (err) {
        handleError(err);
      }
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/e2e/orchestrator-cli.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full suite and every check**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: all four exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/argus.ts test/e2e/orchestrator-cli.test.ts
git commit -m "feat(cli): add argus board, budget, task, and plan commands"
```

---

## Deferred to a follow-up

These are named in the spec but are deliberately not in this plan. Do not implement them.

- **Tier 2 file attachment.** `drainReviews` records a `need_files` verdict and leaves the task queued; it does not yet re-invoke the brain with file contents attached. The budget ladder already disables tier 2 above 60 percent, so the common path is unaffected.
- **The tmux fleet window.** Phase 2, separate spec.
- **A human override command** for changing a verdict or re-prioritising the board mid-mission.
