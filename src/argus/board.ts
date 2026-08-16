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

  listByAssignee(sessionId: string): Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE assignee_session = ? ORDER BY created_at ASC')
      .all(sessionId) as Record<string, unknown>[];
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
