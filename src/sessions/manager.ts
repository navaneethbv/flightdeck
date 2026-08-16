import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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
  /** Overrides the harness default model. Used for brain model tiering. */
  model?: string;
  /** Receives raw stdout chunks. Brain invocations use this to read JSON. */
  onStdout?: (chunk: string) => void;
}

const running = new Map<string, ChildProcess>();

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
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
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
    assertHarnessSpawnAllowed(adapter.binary);
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

    // A brain session returns JSON on stdout and calls no tools, so it must
    // never receive an MCP config or a live session token.
    if (session.policy !== 'brain') {
      adapter.writeMcpConfig(session, cwd, extraMcpEnv);
    }

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
      ? adapter.sessionArgs(opts.prompt ?? '', { autonomy: opts.autonomy, model: opts.model })
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
          const raw = d.toString();
          opts.onStdout?.(raw);
          try {
            const text = collector.feed(raw, 'stdout');
            if (text) logStream?.write(text);
          } catch {
            // ignore
          }
        });
        child.stderr?.on('data', (d) => {
          const raw = d.toString();
          try {
            const text = collector.feed(raw, 'stderr');
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
        log.error(`session ${session.id} collector setup error: ${(err as Error).message}`);
      }
    }

    const finish = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
      running.delete(id);
      try {
        const dbNow = getDb(this.projectRoot);
        // A claimed session is owned by a human in a fleet pane. Its headless
        // child has already been stopped on purpose, so this close event must
        // not overwrite the running/claimed state the claim just recorded.
        // The claimed_at guard makes the update a no-op for either event order.
        dbNow.prepare(
          'UPDATE sessions SET status = ?, ended_at = ?, exit_code = ?, last_activity_at = ? WHERE id = ? AND claimed_at IS NULL'
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
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            if (child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {
                child.kill('SIGKILL');
              }
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
    }
    const db = getDb(this.projectRoot);
    db.prepare(
      "UPDATE sessions SET status = 'stopped', ended_at = ?, last_activity_at = ? WHERE id = ?"
    ).run(now(), now(), id);
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
