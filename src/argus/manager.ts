import crypto from 'node:crypto';
import { getDb, now, randomToken } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { Argus, HarnessKind, Task } from '../core/types.js';
import { SessionManager } from '../sessions/manager.js';
import { NotesStore } from '../notes/store.js';
import { TablesStore } from '../tables/store.js';
import { createWorktree } from '../worktrees/manager.js';
import { log } from '../core/logger.js';
import type { DatabaseSync } from 'node:sqlite';
import { TaskBoard } from './board.js';
import { budgetState } from './budget.js';
import { runGates, computeDiffstat, gateCommandsFromConfig, type GateCommands } from './gates.js';
import { QuestionQueue } from './questions.js';
import { invokeBrain, parsePlan, parseReview, parseAnswer, type BrainInvocation } from './brain.js';

export interface StartArgusOptions {
  name?: string;
  missionNoteId?: string;
  pulseSec?: number;
  childLimit?: number;
  riskyTools?: boolean;
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
    };
    if (![2, 4, 8, 16].includes(argus.childLimit)) {
      throw new Error(`child limit must be one of 2, 4, 8, 16 (got ${argus.childLimit})`);
    }
    this.db
      .prepare(
        'INSERT INTO argus (id, name, project_root, mission_note_id, cap, child_limit, pulse_sec, risky_tools, status, manager_session_id, created_at, last_pulse_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        argus.lastPulseAt
      );
    this.writeProgress(argus.id, null, 'argus_created', `child_limit=${argus.childLimit} pulse=${argus.pulseSec}s`);
    return argus;
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

    const stop = (): void => {
      this.db.prepare("UPDATE argus SET status = 'stopped', last_pulse_at = ? WHERE id = ?").run(now(), id);
      if (argus.managerSessionId) {
        this.db
          .prepare("UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?")
          .run(now(), now(), argus.managerSessionId);
      }
      this.writeProgress(id, null, 'argus_stopped', '');
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    log.info(`argus ${id} running with pulse=${argus.pulseSec}s childLimit=${argus.childLimit}`);
    while (true) {
      await this.pulse(id);
      await sleep(argus.pulseSec * 1000);
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
      return parse(retried);
    }
  }

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

    const existingList = existing.map((t) => `- ${t.title} [${t.status}]`).join('\n');
    const prompt = [
      'You are the orchestrator of a fleet of coding agents.',
      'Break the mission below into independent tasks that separate agents can work on in isolated git worktrees.',
      '',
      'Mission:',
      mission.body,
      '',
      existing.length > 0 ? `Tasks already on the board (do not repeat them):\n${existingList}` : '',
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
        // Tier 2 file attachment is not built yet. Leaving the task in
        // `in_review` would make the next pulse re-review it, draw the same
        // verdict, and repeat forever, which is exactly the runaway brain
        // spend this subsystem exists to prevent. Send it back to the worker
        // instead: that costs cheap tokens, usually fixes the real problem (a
        // thin summary), and terminates through `max_attempts_per_task`.
        const paths = verdict.paths.join(', ');
        this.writeProgress(id, null, 'review_need_files', paths);
        this.board.recordVerdict(
          verdict.taskId,
          'revise',
          `The reviewer could not judge this from your summary and asked to see: ${paths || '(unspecified files)'}. Expand your report: describe what changed in those files and how you verified it, then report again.`
        );
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

  private children(argus: Argus): ArgusChild[] {
    const sessions = this.sessions.list().filter((s) => s.argusParent === argus.id);
    return sessions.map((session) => ({
      session,
      worktreeName: session.worktree ?? '',
      task: session.task ?? '',
    }));
  }

  async stop(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) throw new Error(`argus "${id}" not found`);
    const children = this.children(argus);
    for (const child of children) {
      if (child.session?.status === 'running') {
        await this.sessions.stopSession(child.session.id);
      }
    }
    this.db.prepare("UPDATE argus SET status = 'stopped', last_pulse_at = ? WHERE id = ?").run(now(), id);
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
