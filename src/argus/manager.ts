import crypto from 'node:crypto';
import { getDb, now, randomToken } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { Argus, BrainHarness, HarnessKind, Session, Task, WorkerHarness } from '../core/types.js';
import { SessionManager } from '../sessions/manager.js';
import { NotesStore } from '../notes/store.js';
import { TablesStore } from '../tables/store.js';
import { createWorktree } from '../worktrees/manager.js';
import { log } from '../core/logger.js';
import type { DatabaseSync } from 'node:sqlite';
import { TaskBoard, type TaskDraft } from './board.js';
import { budgetState, reviewBatchSize } from './budget.js';
import { runGates, computeDiffstat, gateCommandsFromConfig, type GateCommands } from './gates.js';
import { QuestionQueue } from './questions.js';
import {
  invokeBrain,
  parsePlan,
  parseReview,
  parseAnswer,
  validateReviewCoverage,
  BrainContractError,
  type BrainInvocation,
  type Verdict,
} from './brain.js';
import { loadReviewFiles } from './review-files.js';

export interface StartArgusOptions {
  name?: string;
  missionNoteId?: string;
  pulseSec?: number;
  childLimit?: number;
  riskyTools?: boolean;
  brainHarness?: BrainHarness;
  brainPlanModel?: string;
  brainReviewModel?: string;
  workerHarnesses?: WorkerHarness[];
  budgetWindowSec?: number;
  budgetMaxTokens?: number;
  budgetCountCacheReads?: boolean;
  maxAttemptsPerTask?: number;
  maxTasks?: number;
  questionTimeoutSec?: number;
  conventionsNoteId?: string;
}

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

export interface ArgusChild {
  session: ReturnType<SessionManager['get']>;
  worktreeName: string;
  task: string;
}

function rowToArgus(row: Record<string, unknown>): Argus {
  return {
    id: String(row.id),
    name: String(row.name),
    projectRoot: String(row.project_root),
    missionNoteId: typeof row.mission_note_id === 'string' ? row.mission_note_id : null,
    cap: String(row.cap),
    childLimit: Number(row.child_limit),
    pulseSec: Number(row.pulse_sec),
    riskyTools: Number(row.risky_tools) === 1,
    status: row.status as Argus['status'],
    managerSessionId: typeof row.manager_session_id === 'string' ? row.manager_session_id : null,
    createdAt: Number(row.created_at),
    lastPulseAt: row.last_pulse_at === null ? null : Number(row.last_pulse_at),
    brainHarness: (row.brain_harness === 'codex' ? 'codex' : 'claude') as BrainHarness,
    brainPlanModel: typeof row.brain_plan_model === 'string' ? row.brain_plan_model : null,
    brainReviewModel: typeof row.brain_review_model === 'string' ? row.brain_review_model : null,
    workerHarnesses: parseWorkerHarnesses(row.worker_harnesses),
    budgetWindowSec: Number(row.budget_window_sec),
    budgetMaxTokens: Number(row.budget_max_tokens),
    budgetCountCacheReads: Number(row.budget_count_cache_reads) === 1,
    maxAttemptsPerTask: Number(row.max_attempts_per_task),
    maxTasks: Number(row.max_tasks),
    questionTimeoutSec: Number(row.question_timeout_sec),
    conventionsNoteId: typeof row.conventions_note_id === 'string' ? row.conventions_note_id : null,
  };
}

function trimHyphens(str: string): string {
  let start = 0;
  let end = str.length;
  while (start < end && str[start] === '-') start++;
  while (end > start && str[end - 1] === '-') end--;
  return str.slice(start, end);
}

function slugify(title: string, maxLen = 40): string {
  const slug = trimHyphens(
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
  ).slice(0, maxLen);
  return slug || 'task';
}

export type BrainFn = (
  projectRoot: string,
  argusId: string,
  opts: BrainInvocation
) => Promise<string>;

export class ArgusManager {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionManager;
  private readonly notes: NotesStore;
  private readonly tables: TablesStore;
  private readonly projectRoot: string;
  private readonly board: TaskBoard;
  private readonly questions: QuestionQueue;
  private readonly brain: BrainFn;
  private stopping = false;

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

  list(): Argus[] {
    const rows = this.db
      .prepare('SELECT * FROM argus WHERE project_root = ? ORDER BY created_at DESC')
      .all(this.projectRoot) as Record<string, unknown>[];
    return rows.map(rowToArgus);
  }

  get(id: string): Argus | null {
    const row = this.db.prepare('SELECT * FROM argus WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToArgus(row) : null;
  }

  start(opts: StartArgusOptions = {}): Argus {
    validateStartOptions(opts);
    if (opts.conventionsNoteId && !this.notes.readNote(opts.conventionsNoteId)) {
      throw new Error(`conventions note "${opts.conventionsNoteId}" not found`);
    }
    this.ensureProgressTable();
    const id = crypto.randomUUID();
    const cap = randomToken();
    const managerSession = this.sessions.createSession({
      name: opts.name ?? `argus-${id.slice(0, 6)}`,
      harness: 'claude',
      worktree: null,
      cwd: this.projectRoot,
      policy: 'manager',
      argusParent: null,
    });
    const argus: Argus = {
      id,
      name: opts.name ?? `argus-${id.slice(0, 6)}`,
      projectRoot: this.projectRoot,
      missionNoteId: opts.missionNoteId ?? null,
      cap,
      childLimit: opts.childLimit ?? 8,
      pulseSec: opts.pulseSec ?? 60,
      riskyTools: opts.riskyTools ?? false,
      status: 'stopped',
      managerSessionId: managerSession.id,
      createdAt: now(),
      lastPulseAt: null,
      brainHarness: opts.brainHarness ?? 'claude',
      brainPlanModel: opts.brainPlanModel ?? null,
      brainReviewModel: opts.brainReviewModel ?? null,
      workerHarnesses: opts.workerHarnesses ?? ['opencode'],
      budgetWindowSec: opts.budgetWindowSec ?? 18000,
      budgetMaxTokens: opts.budgetMaxTokens ?? 1000000,
      budgetCountCacheReads: opts.budgetCountCacheReads ?? true,
      maxAttemptsPerTask: opts.maxAttemptsPerTask ?? 3,
      maxTasks: opts.maxTasks ?? 100,
      questionTimeoutSec: opts.questionTimeoutSec ?? 120,
      conventionsNoteId: opts.conventionsNoteId ?? null,
    };
    if (![2, 4, 8, 16].includes(argus.childLimit)) {
      throw new Error(`child limit must be one of 2, 4, 8, 16 (got ${argus.childLimit})`);
    }
    this.db
      .prepare(
        `INSERT INTO argus (
          id, name, project_root, mission_note_id, cap, child_limit, pulse_sec, risky_tools,
          status, manager_session_id, created_at, last_pulse_at,
          brain_harness, brain_plan_model, brain_review_model, worker_harnesses,
          budget_window_sec, budget_max_tokens, budget_count_cache_reads,
          max_attempts_per_task, max_tasks, question_timeout_sec, conventions_note_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        argus.conventionsNoteId
      );
    this.writeProgress(argus.id, null, 'argus_created', `child_limit=${argus.childLimit} pulse=${argus.pulseSec}s`);
    return this.get(id)!;
  }

  async runForever(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const mission = argus.missionNoteId ? this.notes.readNote(argus.missionNoteId) : null;
    if (!mission) {
      throw new Error(`argus "${id}" has no readable mission note`);
    }
    this.db.prepare("UPDATE argus SET status = 'running', last_pulse_at = ? WHERE id = ?").run(now(), id);
    if (argus.managerSessionId) {
      const dbNow = now();
      this.db
        .prepare("UPDATE sessions SET status = 'running', pid = ?, started_at = ?, ended_at = NULL, last_activity_at = ? WHERE id = ?")
        .run(process.pid, dbNow, dbNow, argus.managerSessionId);
    }

    this.recoverGatingTasks(id);

    const cmds = gateCommandsFromConfig();
    if (cmds.test.trim() === '' && cmds.lint.trim() === '') {
      this.writeProgress(id, null, 'gates_disabled', 'no test or lint gate commands configured');
      log.warn(`argus ${id}: no objective gates configured; work will go directly to brain review`);
    }

    this.stopping = false;
    let stopping = false;
    const stop = (): void => {
      if (stopping) return; // a second signal must not race the first shutdown
      stopping = true;
      this.stopping = true;
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

    log.info(`argus ${id} running with pulse=${argus.pulseSec}s childLimit=${argus.childLimit}`);
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
  }

  /**
   * Cheap read-only check for work that must not wait for the next mission
   * pulse: an unanswered question or a worker that reported a task. An
   * intentionally batched `in_review` queue is deliberately excluded so the
   * 250 ms scheduler does not repeatedly reconsider a queue that is waiting
   * for four tasks or a 30-minute-old task.
   */
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

  /** Handles worker events between mission pulses, without any model polling. */
  private async processPendingEvents(id: string): Promise<void> {
    await this.answerQuestions(id);
    const promoted = await this.runGatesForReported(id);
    await this.resumeRevisions(id);
    if (promoted > 0) {
      await this.drainReviews(id);
      await this.resumeRevisions(id);
    }
  }

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
      try {
        return parse(retried);
      } catch (second) {
        this.writeProgress(id, null, 'brain_abandoned', (second as Error).message);
        throw new BrainContractError(opts.label, (second as Error).message);
      }
    }
  }

  /** Turns the mission note into task board rows. One brain call. */
  async plan(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const { mission, conventions } = this.contextFor(argus);
    if (!mission) throw new Error(`argus "${id}" has no readable mission note`);

    const existing = this.board.list(id);
    const row = this.db
      .prepare('SELECT brain_plan_model, max_tasks FROM argus WHERE id = ?')
      .get(id) as { brain_plan_model?: string; max_tasks?: number };

    const existingList = existing.map((t) => `- ${t.title} [${t.status}]`).join('\n');
    const prompt = [
      'You are the orchestrator of a fleet of coding agents.',
      'Break the mission below into independent tasks that separate agents can work on in isolated git worktrees.',
      '',
      'Mission:',
      mission,
      '',
      conventions ? `Project conventions:\n${conventions}\n` : '',
      existing.length > 0 ? `Tasks already on the board (do not repeat them):\n${existingList}` : '',
      '',
      'Reply with JSON only, in exactly this shape:',
      '{"tasks":[{"title":"short name","spec":"what to do and how to verify it","depends_on":[]}]}',
      '"depends_on" holds zero-based indices into this same tasks array.',
      'Do not write any prose outside the JSON object.',
    ].join('\n');

    let drafts: TaskDraft[];
    try {
      drafts = await this.brainJson(
        id,
        { prompt, model: row.brain_plan_model ?? null, label: 'plan' },
        parsePlan
      );
    } catch (err) {
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
    const room = Math.max(0, Number(row.max_tasks ?? 100) - existing.length);
    const created = this.board.create(id, drafts.slice(0, room));
    this.writeProgress(id, null, 'planned', `tasks=${created.length}`);
  }

  /**
   * Tier 0. Runs the objective gates for every reported task. No brain call,
   * which is the point: objectively broken work must never reach a
   * rate-limited reviewer.
   */
  async runGatesForReported(id: string, cmds: GateCommands = gateCommandsFromConfig()): Promise<number> {
    const argus = this.get(id);
    if (!argus) return 0;
    const maxAttempts = this.maxAttemptsFor(id);
    let promoted = 0;

    for (const task of this.board.list(id, 'reported')) {
      this.board.beginGating(task.id);
      const session = task.assigneeSession ? this.sessions.get(task.assigneeSession) : undefined;
      const cwd = session?.cwd ?? this.projectRoot;
      const result = runGates(cwd, cmds);
      const updated = this.board.recordGates(task.id, result, computeDiffstat(cwd));
      if (updated.status === 'in_review') promoted += 1;
      this.writeProgress(
        id,
        task.assigneeSession,
        updated.status === 'in_review' ? 'gates_passed' : 'gates_failed',
        task.title
      );
      if (updated.status === 'revising' && this.atAttemptLimit(updated, maxAttempts)) {
        this.board.block(task.id, `exhausted ${maxAttempts} attempts: ${result.failureTail}`);
        this.writeProgress(id, task.assigneeSession, 'task_blocked', task.title);
      }
    }
    return promoted;
  }

  private maxAttemptsFor(id: string): number {
    return Number(
      (this.db.prepare('SELECT max_attempts_per_task FROM argus WHERE id = ?').get(id) as {
        max_attempts_per_task?: number;
      }).max_attempts_per_task ?? 3
    );
  }

  private atAttemptLimit(task: Task, maxAttempts: number): boolean {
    return task.attempts >= maxAttempts;
  }

  /**
   * Recovers a worker that exited without calling `report_done`. Each such
   * task is moved to `revising` once so `resumeRevisions()` restarts the same
   * worktree, and the attempt counter advances so a loop cannot spin forever.
   */
  private recoverOrphans(id: string): void {
    const maxAttempts = this.maxAttemptsFor(id);
    for (const task of this.board.list(id, 'assigned')) {
      const session = task.assigneeSession ? this.sessions.get(task.assigneeSession) : undefined;
      if (!session || session.startedAt === null || (session.status !== 'stopped' && session.status !== 'failed')) {
        continue;
      }
      this.board.toRevising(task.id, 'worker exited before report_done');
      this.writeProgress(id, task.assigneeSession, 'worker_orphaned', task.title);
      if (this.atAttemptLimit(this.board.get(task.id)!, maxAttempts)) {
        this.board.block(task.id, `exhausted ${maxAttempts} attempts: worker exited before report_done`);
        this.writeProgress(id, task.assigneeSession, 'task_blocked', task.title);
      }
    }
  }

  /** Moves tasks left in `gating` by an interrupted process back to `reported`. */
  private recoverGatingTasks(id: string): void {
    for (const task of this.board.list(id, 'gating')) {
      this.db
        .prepare("UPDATE tasks SET status = 'reported', updated_at = ? WHERE id = ?")
        .run(now(), task.id);
      this.writeProgress(id, task.assigneeSession, 'gates_recovered', task.title);
    }
  }

  /**
   * Restarts every task awaiting a revision in its existing worktree, with the
   * original spec, the failure feedback, and autonomy. A task is blocked at
   * the attempt limit, requeued when its session row vanished, or left alone
   * when a human has claimed the session.
   */
  async resumeRevisions(id: string): Promise<void> {
    const maxAttempts = this.maxAttemptsFor(id);
    for (const task of this.board.list(id, 'revising')) {
      if (this.atAttemptLimit(task, maxAttempts)) {
        this.board.block(task.id, `exhausted ${maxAttempts} attempts: ${task.verdictReason ?? 'revision requested'}`);
        this.writeProgress(id, task.assigneeSession, 'task_blocked', task.title);
        continue;
      }
      const session = task.assigneeSession ? this.sessions.get(task.assigneeSession) : undefined;
      if (!session) {
        this.board.clearAssigneeAndRequeue(task.id);
        this.writeProgress(id, task.assigneeSession, 'worker_requeued', task.title);
        continue;
      }
      if (session.claimedAt !== null) {
        this.writeProgress(id, session.id, 'revision_waiting_for_human', task.title);
        continue;
      }
      if (session.status === 'running') {
        await this.sessions.stopSession(session.id);
      }
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
      const restarted = await this.sessions.startSession(session.id, {
        headless: true,
        prompt,
        autonomy: true,
        waitForExit: false,
        env: { FLIGHTDECK_ARGUS_ID: id },
      });
      this.board.resumeRevision(task.id);
      this.writeProgress(id, restarted.id, 'worker_reprompted', task.title);
    }
  }

  /** Drains the review queue in batches sized by the budget ladder. */
  async drainReviews(id: string, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true;
    const budget = budgetState(this.projectRoot, id);
    const queued = this.board.list(id, 'in_review');
    if (queued.length === 0) return;
    if (!budget.policy.reviewsAllowed && !force) {
      this.writeProgress(id, null, 'review_paused', `spend=${budget.spent}/${budget.ceiling}`);
      return;
    }

    const oldest = Math.min(...queued.map((t) => t.createdAt));
    const batchSize = reviewBatchSize(budget, queued.length, now() - oldest, force);
    if (batchSize === 0) {
      this.writeProgress(id, null, 'review_batched', `queued=${queued.length} oldest=${Math.round((now() - oldest) / 1000)}s`);
      return;
    }

    const batch = queued.slice(0, batchSize);
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

    let verdicts: Verdict[];
    try {
      verdicts = await this.brainJson(
        id,
        { prompt, model: row.brain_review_model ?? null, label: 'review' },
        (stdout) => validateReviewCoverage(batch, parseReview(stdout))
      );
    } catch (err) {
      if (err instanceof BrainContractError) {
        for (const task of batch) {
          this.board.block(task.id, `brain review was malformed twice: ${err.causeMessage}`);
        }
        this.writeProgress(id, null, 'review_failed', batch.map((t) => t.id).join(', '));
        return;
      }
      throw err;
    }

    for (const verdict of verdicts) {
      if (verdict.verdict === 'need_files') {
        await this.tierTwoReview(id, verdict);
        continue;
      }
      this.board.recordVerdict(verdict.taskId, verdict.verdict, verdict.reason);
      this.writeProgress(id, null, `review_${verdict.verdict}`, verdict.taskId);
    }
  }

  /**
   * Tier 2. One bounded brain call that may read specific files from the
   * assigned worker's worktree. Runs only under the plan model budget band and
   * never mixes worktrees into one prompt. A repeated `need_files` becomes one
   * concrete revision so a model cannot loop forever.
   */
  private async tierTwoReview(id: string, verdict: Verdict): Promise<void> {
    const paths = verdict.paths;
    const budgetAfterTier1 = budgetState(this.projectRoot, id);
    if (!budgetAfterTier1.policy.tier2Allowed) {
      const detail = `requested file review was unavailable under the current budget (tier ${budgetAfterTier1.tier})`;
      this.writeProgress(id, null, 'review_files_disabled', detail);
      this.board.recordVerdict(
        verdict.taskId,
        'revise',
        `The reviewer asked to see ${paths.join(', ') || '(unspecified files)'}, but ${detail}. Expand your report and report again.`
      );
      return;
    }
    const task = this.board.get(verdict.taskId);
    if (!task) return;
    const session = task.assigneeSession ? this.sessions.get(task.assigneeSession) : undefined;
    if (!session) {
      this.board.recordVerdict(
        verdict.taskId,
        'revise',
        'The reviewer asked to see files, but the worker session no longer exists. Expand your report and report again.'
      );
      return;
    }
    const files = loadReviewFiles(session.cwd, paths);
    const row = this.db
      .prepare('SELECT brain_plan_model FROM argus WHERE id = ?')
      .get(id) as { brain_plan_model?: string };

    const entries = files
      .map((file) => {
        const head = [`File: ${file.path}`];
        if (file.error) head.push(`Error: ${file.error}`);
        else if (file.content !== null) {
          head.push(file.truncated ? 'Content (truncated):' : 'Content:');
          head.push(file.content);
        }
        return head.join('\n');
      })
      .join('\n\n---\n\n');

    const prompt = [
      `Review task ${task.id}: ${task.title}`,
      `Spec: ${task.spec}`,
      `Worker summary: ${task.workerReport?.summary ?? '(none)'}`,
      '',
      'You asked to see specific files. They are attached below, bounded to 32 KiB each and 128 KiB total.',
      '',
      entries,
      '',
      'Decide now. Reply with JSON only:',
      '{"verdicts":[{"task_id":"...","verdict":"accept|revise","reason":"..."}]}',
    ].join('\n');

    let tier2: Verdict[];
    try {
      tier2 = await this.brainJson(
        id,
        { prompt, model: row.brain_plan_model ?? null, label: 'review-files' },
        (stdout) => validateReviewCoverage([task], parseReview(stdout))
      );
    } catch (err) {
      if (err instanceof BrainContractError) {
        this.board.block(task.id, `tier 2 file review was malformed twice: ${err.causeMessage}`);
        this.writeProgress(id, task.assigneeSession, 'review_files_failed', task.id);
        return;
      }
      throw err;
    }
    const second = tier2[0];
    if (second.verdict === 'accept') {
      this.board.recordVerdict(task.id, 'accept', second.reason);
      this.writeProgress(id, task.assigneeSession, 'review_accept', task.id);
      return;
    }
    // A second need_files (or any revise) becomes one concrete revision so the
    // model cannot loop on file requests forever.
    this.board.recordVerdict(
      task.id,
      'revise',
      second.verdict === 'need_files'
        ? 'The reviewer again requested files it was already given. Expand the report with a precise description of the changes and verification, then report again.'
        : second.reason ?? 'Revision requested after file review.'
    );
    this.writeProgress(id, task.assigneeSession, 'review_revise', task.id);
  }

  /** Answers queued worker questions, one brain call each. */
  async answerQuestions(id: string): Promise<void> {
    const budget = budgetState(this.projectRoot, id);
    if (!budget.questionsAllowed) return;
    const argus = this.get(id);
    const { mission, conventions } = argus ? this.contextFor(argus) : { mission: '', conventions: '' };
    const row = this.db
      .prepare('SELECT brain_review_model FROM argus WHERE id = ?')
      .get(id) as { brain_review_model?: string };

    for (const question of this.questions.pending(id)) {
      const prompt = [
        'A coding agent in your fleet has a question. Answer it concisely and concretely.',
        '',
        mission ? `Mission context:\n${mission}\n` : '',
        conventions ? `Project conventions:\n${conventions}\n` : '',
        `Question: ${question.question}`,
        '',
        'Reply with JSON only:',
        '{"answer":"...","faq_key":"short-kebab-case-topic"}',
      ].join('\n');
      try {
        const parsed = await this.brainJson(
          id,
          { prompt, model: row.brain_review_model ?? null, label: 'answer' },
          parseAnswer
        );
        this.questions.answer(question.id, parsed.answer, parsed.faqKey);
        this.writeProgress(id, question.sessionId, 'question_answered', parsed.faqKey);
      } catch (err) {
        if (err instanceof BrainContractError) {
          this.questions.markFailed(question.id, err.causeMessage);
          // The question stays unanswered so the waiting worker receives its
          // normal timeout directive, and the manager keeps serving later work.
          this.writeProgress(id, question.sessionId, 'question_failed', err.causeMessage);
          continue;
        }
        throw err;
      }
    }
  }

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

    await this.recoverOrphans(id);
    await this.resumeRevisions(id);
    await this.dispatch(id);
    await this.runGatesForReported(id);
    await this.resumeRevisions(id);

    if (this.questions.pending(id).length > 0) {
      await this.answerQuestions(id);
    }
    if (this.board.list(id, 'in_review').length > 0) {
      await this.drainReviews(id);
      await this.resumeRevisions(id);
    }

    this.db.prepare('UPDATE argus SET last_pulse_at = ? WHERE id = ?').run(now(), id);
  }

  private contextFor(argus: Argus): { mission: string; conventions: string } {
    const mission = argus.missionNoteId ? this.notes.readNote(argus.missionNoteId)?.body ?? '' : '';
    const conventions = argus.conventionsNoteId
      ? this.notes.readNote(argus.conventionsNoteId)?.body ?? ''
      : '';
    return { mission, conventions };
  }

  private isActiveChild(child: ArgusChild): boolean {
    return (
      child.session?.status === 'running' ||
      (child.session?.status === 'stopped' && child.session?.endedAt === null)
    );
  }

  /**
   * Spawns exactly one worker for the highest-priority dispatchable task,
   * through the same rules as the automatic dispatcher. This is the shared
   * operation behind both the fleet pulse and the manual "new worker" action,
   * so a manual spawn can never create an untracked agent with no task.
   */
  async spawnNextWorker(id: string): Promise<{ task: Task; session: Session }> {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const active = this.children(argus).filter((child) => this.isActiveChild(child));
    if (active.length >= argus.childLimit) throw new Error('fleet is already at its child limit');
    const task = this.board.dispatchable(id)[0];
    if (!task) throw new Error('no dispatchable task is available');
    const harnesses = this.workerHarnessesFor(id);
    const sequence = this.children(argus).length + 1;
    const session = await this.spawnWorker(argus, task, harnesses[(sequence - 1) % harnesses.length], sequence);
    return { task, session };
  }

  private workerHarnessesFor(id: string): WorkerHarness[] {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    return argus.workerHarnesses;
  }

  /** Assigns dispatchable tasks to fresh worker sessions, up to the child limit. */
  private async dispatch(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) return;
    const active = this.children(argus).filter((c) => this.isActiveChild(c));
    let slots = argus.childLimit - active.length;
    const tasks = this.board.dispatchable(id);
    let i = 0;
    while (slots > 0 && i < tasks.length) {
      if (this.stopping) break;
      try {
        await this.spawnNextWorker(id);
        slots -= 1;
        i += 1;
      } catch (err) {
        this.writeProgress(id, null, 'child_failed', (err as Error).message);
        i += 1;
      }
    }
  }

  private async spawnWorker(
    argus: Argus,
    task: Task,
    harness: HarnessKind,
    n: number
  ): Promise<Session> {
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

    if (this.stopping) {
      throw new Error(`argus "${argus.id}" is stopped`);
    }

    await this.sessions.startSession(session.id, {
      headless: true,
      prompt,
      autonomy: true,
      waitForExit: false,
      env: { FLIGHTDECK_ARGUS_ID: argus.id },
    });
    this.writeProgress(argus.id, session.id, 'worker_spawned', task.title);
    return session;
  }

  private children(argus: Argus): ArgusChild[] {
    const sessions = this.sessions.list().filter((s) => s.argusParent === argus.id);
    return sessions.map((session) => ({
      session,
      worktreeName: session.worktree ?? '',
      task: session.task ?? '',
    }));
  }

  async stop(id: string): Promise<void> {
    this.stopping = true;
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    this.db.prepare("UPDATE argus SET status = 'stopped', last_pulse_at = ? WHERE id = ?").run(now(), id);
    const children = this.children(argus);
    for (const child of children) {
      if (child.session) {
        await this.sessions.stopSession(child.session.id);
      }
    }
    this.writeProgress(id, null, 'argus_stopped', `stopped ${children.length} children`);
  }

  fleet(id: string): { argus: Argus; children: ArgusChild[]; recentProgress: Record<string, unknown>[] } {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const progress = this.tables.query('argus_progress', { where: { argus_id: id }, limit: 20 });
    return { argus, children: this.children(argus), recentProgress: progress };
  }

  private ensureProgressTable(): void {
    try {
      this.tables.createTable(
        'argus_progress',
        [
          { name: 'argus_id', type: 'text' },
          { name: 'session_id', type: 'text' },
          { name: 'event', type: 'text' },
          { name: 'detail', type: 'text' },
        ]
      );
    } catch {
      // already exists
    }
  }

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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
