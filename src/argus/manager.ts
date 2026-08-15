import crypto from 'node:crypto';
import { getDb, now, randomToken } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { Argus } from '../core/types.js';
import { SessionManager } from '../sessions/manager.js';
import { NotesStore } from '../notes/store.js';
import { TablesStore } from '../tables/store.js';
import { createWorktree } from '../worktrees/manager.js';
import { log } from '../core/logger.js';
import type { DatabaseSync } from 'node:sqlite';

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

export function parseTasks(missionBody: string): string[] {
  const bullets = missionBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''));
  if (bullets.length > 0) return bullets;
  const trimmed = missionBody.trim();
  return trimmed ? [trimmed] : [];
}

export class ArgusManager {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionManager;
  private readonly notes: NotesStore;
  private readonly tables: TablesStore;
  private readonly projectRoot: string;
  private readonly completedLogged = new Set<string>();

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.sessions = new SessionManager(this.projectRoot);
    this.notes = new NotesStore(this.projectRoot);
    this.tables = new TablesStore(this.projectRoot);
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

  async pulse(id: string): Promise<void> {
    const argus = this.get(id);
    if (!argus) return;
    const mission = argus.missionNoteId ? this.notes.readNote(argus.missionNoteId) : null;
    if (!mission) {
      this.writeProgress(id, null, 'pulse_skipped', 'mission note missing');
      return;
    }
    const tasks = parseTasks(mission.body);
    const children = this.children(argus);
    const runningChildren = children.filter((c) => c.session?.status === 'running');
    this.writeProgress(
      id,
      null,
      'pulse',
      `tasks=${tasks.length} children=${children.length} running=${runningChildren.length}`
    );

    if (children.length < argus.childLimit && tasks.length > children.length) {
      const nextTask = tasks[children.length];
      try {
        await this.spawnChild(argus, nextTask, children.length + 1);
      } catch (err) {
        this.writeProgress(id, null, 'child_failed', (err as Error).message);
      }
    }

    for (const child of children) {
      if (child.session && child.session.status !== 'running' && child.session.endedAt) {
        if (!this.completedLogged.has(child.session.id)) {
          this.completedLogged.add(child.session.id);
          this.writeProgress(
            id,
            child.session.id,
            'child_completed',
            `exit=${child.session.exitCode ?? '?'} task=${child.task.slice(0, 80)}`
          );
        }
      }
    }

    this.db.prepare('UPDATE argus SET last_pulse_at = ? WHERE id = ?').run(now(), id);
  }

  private async spawnChild(argus: Argus, task: string, n: number): Promise<void> {
    const worktreeName = `${slugify(argus.name)}-${n}-${slugify(task, 24)}`;
    const info = createWorktree(this.projectRoot, worktreeName, argus.managerSessionId ?? undefined);
    const session = this.sessions.createSession({
      name: `${argus.name}-child-${n}`,
      harness: 'claude',
      worktree: worktreeName,
      cwd: info.path,
      policy: 'child',
      argusParent: argus.id,
      task,
    });
    const prompt = [
      `You are a coding agent working autonomously in an isolated worktree.`,
      `Worktree: ${info.path}`,
      `Mission:`,
      this.notes.readNote(argus.missionNoteId!)?.body ?? '',
      ``,
      `Your assigned task:`,
      task,
      ``,
      `Work until the task is complete: edit code, run tests, and prepare commits or pull requests as appropriate.`,
    ].join('\n');
    await this.sessions.startSession(session.id, {
      headless: true,
      prompt,
      autonomy: true,
      waitForExit: false,
      env: { FLIGHTDECK_ARGUS_ID: argus.id },
    });
    this.writeProgress(argus.id, session.id, 'child_spawned', `task=${task.slice(0, 80)}`);
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
