import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now, randomToken } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import type { HarnessKind, Session, SessionPolicy } from '../core/types.js';
import { adapters } from './harness.js';
import { TelemetryCollector } from './telemetry.js';
import { log } from '../core/logger.js';

export interface CreateSessionOptions {
  name: string;
  harness: HarnessKind;
  worktree?: string | null;
  cwd: string;
  policy?: SessionPolicy;
  argusParent?: string | null;
  task?: string | null;
}

export interface StartOptions {
  headless?: boolean;
  prompt?: string;
  autonomy?: boolean;
  waitForExit?: boolean;
  env?: NodeJS.ProcessEnv;
}

const running = new Map<string, ChildProcess>();

export function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: String(row.id),
    name: String(row.name),
    harness: row.harness as HarnessKind,
    projectRoot: String(row.project_root),
    worktree: typeof row.worktree === 'string' ? row.worktree : null,
    cwd: String(row.cwd),
    pid: row.pid === null ? null : Number(row.pid),
    status: row.status as Session['status'],
    token: String(row.token),
    policy: row.policy as SessionPolicy,
    argusParent: typeof row.argus_parent === 'string' ? row.argus_parent : null,
    task: typeof row.task === 'string' ? row.task : null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    lastActivityAt: Number(row.last_activity_at),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
  };
}

export class SessionManager {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
  }

  createSession(opts: CreateSessionOptions): Session {
    const db = getDb(this.projectRoot);
    const id = crypto.randomUUID();
    const token = randomToken();
    const policy = opts.policy ?? 'default';
    const ts = now();
    db.prepare(
      `INSERT INTO sessions (id, name, harness, project_root, worktree, cwd, pid, status, token, policy, argus_parent, task, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 'stopped', ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      opts.name,
      opts.harness,
      this.projectRoot,
      opts.worktree ?? null,
      opts.cwd,
      token,
      policy,
      opts.argusParent ?? null,
      opts.task ?? null,
      ts,
      ts
    );
    return this.get(id)!;
  }

  list(): Session[] {
    const db = getDb(this.projectRoot);
    const rows = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  get(id: string): Session | undefined {
    const db = getDb(this.projectRoot);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : undefined;
  }

  touch(id: string): void {
    const db = getDb(this.projectRoot);
    db.prepare('UPDATE sessions SET last_activity_at = ? WHERE id = ?').run(now(), id);
  }

  async startSession(id: string, opts: StartOptions = {}): Promise<Session> {
    const session = this.get(id);
    if (!session) throw new Error(`session "${id}" not found`);
    const adapter = adapters[session.harness];
    const cwd = session.cwd;
    fs.mkdirSync(cwd, { recursive: true });

    const extraMcpEnv: Record<string, string> = {};
    if (session.policy === 'manager') {
      const db = getDb(this.projectRoot);
      const argus = db
        .prepare('SELECT cap FROM argus WHERE manager_session_id = ?')
        .get(session.id) as { cap?: string } | undefined;
      if (argus?.cap) {
        extraMcpEnv.FLIGHTDECK_ARGUS_CAP = argus.cap;
      }
    }

    adapter.writeMcpConfig(session, cwd, extraMcpEnv);

    const profileEnv = adapter.profileEnv(session);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...profileEnv,
      ...extraMcpEnv,
      ...opts.env,
      FLIGHTDECK_SESSION_ID: session.id,
      FLIGHTDECK_SESSION_TOKEN: session.token,
    };
    const outputDir = path.join(this.projectRoot, '.flightdeck', 'logs', 'sessions');
    fs.mkdirSync(outputDir, { recursive: true });
    let logStream: fs.WriteStream | null = null;

    const args = opts.headless
      ? adapter.sessionArgs(opts.prompt ?? '', { autonomy: opts.autonomy })
      : adapter.interactiveArgs();

    log.info(`starting session ${session.id} harness=${session.harness} headless=${opts.headless ?? false} cwd=${cwd}`);

    const child = spawn(adapter.binary, args, {
      cwd,
      env,
      stdio: opts.headless ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      detached: Boolean(opts.headless),
    });

    running.set(id, child);

    const startTs = now();
    const db = getDb(this.projectRoot);
    db.prepare(
      "UPDATE sessions SET status = 'running', pid = ?, started_at = ?, ended_at = NULL, exit_code = NULL, last_activity_at = ? WHERE id = ?"
    ).run(child.pid ?? null, startTs, startTs, id);

    if (opts.headless) {
      try {
        logStream = fs.createWriteStream(path.join(outputDir, `${session.id}.log`), { flags: 'a' });
        logStream.on('error', (err) => {
          log.error(`session ${session.id} log stream error: ${err.message}`);
        });
        const collector = new TelemetryCollector(this.projectRoot, session.id, {
          parseLine: adapter.telemetry,
          renderLine: adapter.renderLine,
        });
        child.stdout?.on('data', (d) => {
          try {
            const text = collector.feed(d.toString(), 'stdout');
            if (text) logStream?.write(text);
          } catch {
            // ignore
          }
        });
        child.stderr?.on('data', (d) => {
          try {
            const text = collector.feed(d.toString(), 'stderr');
            if (text) logStream?.write(text);
          } catch {
            // ignore
          }
        });
        child.on('close', () => {
          try {
            const text = collector.flush();
            if (text) logStream?.write(text);
          } catch {
            // ignore
          }
        });
      } catch (err) {
        log.error(`session ${session.id} log open error: ${(err as Error).message}`);
      }
    }

    const finish = async (code: number | null, signal: string | null): Promise<void> => {
      running.delete(id);
      try {
        const dbNow = getDb(this.projectRoot);
        dbNow.prepare(
          'UPDATE sessions SET status = ?, ended_at = ?, exit_code = ?, last_activity_at = ? WHERE id = ?'
        ).run(code === 0 ? 'stopped' : 'failed', now(), code, now(), id);
      } catch {
        // db might be cleaned up in tests
      }
      if (logStream) {
        try {
          await new Promise<void>((resolve) => {
            logStream!.end(() => resolve());
          });
        } catch {
          // ignore
        }
        logStream = null;
      }
      log.info(`session ${session.id} exited code=${code} signal=${signal}`);
    };

    if (opts.headless) {
      if (opts.waitForExit) {
        const exitCode = await new Promise<number | null>((resolve) => {
          child.on('close', (code) => resolve(code));
          child.on('error', (err) => {
            log.error(`session ${session.id} spawn error: ${err.message}`);
            resolve(null);
          });
        });
        await finish(exitCode, null);
      } else {
        child.on('close', (code, signal) => void finish(code, signal));
        child.on('error', (err) => {
          log.error(`session ${session.id} spawn error: ${err.message}`);
          void finish(null, null);
        });
      }
    } else {
      child.on('close', (code, signal) => void finish(code, signal));
      child.on('error', (err) => {
        log.error(`session ${session.id} spawn error: ${err.message}`);
        void finish(null, null);
      });
    }

    return this.get(id)!;
  }

  async stopSession(id: string, timeoutMs = 8000): Promise<void> {
    const session = this.get(id);
    if (!session) throw new Error(`session "${id}" not found`);
    const child = running.get(id);
    if (child?.pid) {
      if (child.stdout === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      } else {
        child.kill('SIGTERM');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            if (child.pid) {
              if (child.stdout === null) process.kill(-child.pid, 'SIGKILL');
              else child.kill('SIGKILL');
            }
          } catch {
            // already gone
          }
          resolve();
        }, timeoutMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      const db = getDb(this.projectRoot);
      db.prepare(
        "UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?"
      ).run(now(), now(), id);
    }
  }

  async restartSession(id: string, opts: StartOptions = {}): Promise<Session> {
    const session = this.get(id);
    if (!session) throw new Error(`session "${id}" not found`);
    return this.startSession(id, opts);
  }

  getLogs(id: string, tailLines = 100): string {
    const logDir = path.resolve(this.projectRoot, '.flightdeck', 'logs', 'sessions');
    const logPath = path.resolve(logDir, `${id}.log`);
    // Fail closed if the id ever resolves outside the session log directory;
    // path traversal must never turn this into an arbitrary file read.
    if (!logPath.startsWith(`${logDir}${path.sep}`)) {
      return '';
    }
    if (!fs.existsSync(logPath)) {
      return '';
    }
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n');
    return lines.slice(-tailLines).join('\n');
  }
}
