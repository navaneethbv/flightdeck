import crypto from 'node:crypto';
import { normalizeProjectRoot } from '../core/paths.js';
import { getDb, now } from '../core/state.js';
import { cliEntryPath } from '../core/cliEntry.js';
import { SessionManager } from '../sessions/manager.js';
import { getAdapter } from '../sessions/harness.js';
import { Tmux } from './tmux.js';
import { planReconcile, paneTitle, type FleetSession } from './reconcile.js';

export class FleetManager {
  private readonly projectRoot: string;
  private readonly sessions: SessionManager;

  constructor(projectRoot: string, private readonly tmux: Tmux = new Tmux()) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.sessions = new SessionManager(this.projectRoot);
  }

  /**
   * Hashed rather than derived from the path directly: it avoids collisions
   * between projects and sidesteps tmux name escaping for paths with spaces
   * or colons.
   */
  tmuxSessionName(): string {
    const hash = crypto.createHash('sha256').update(this.projectRoot).digest('hex');
    return `flightdeck-${hash.slice(0, 8)}`;
  }

  private deckCommand(args: string[]): string[] {
    return [process.execPath, cliEntryPath(), ...args, '--project', this.projectRoot];
  }

  fleetSessions(): FleetSession[] {
    return this.sessions
      .list()
      .filter((s) => s.policy === 'child' || s.policy === 'default')
      .map((s) => ({
        id: s.id,
        name: s.name,
        harness: s.harness,
        status: s.status,
        policy: s.policy,
        endedAt: s.endedAt,
        claimedAt: s.claimedAt,
      }));
  }

  ensureSession(): void {
    const name = this.tmuxSessionName();
    if (this.tmux.sessionExists(name)) return;
    this.tmux.newSession(name, this.projectRoot, this.deckCommand(['fleet', 'console']));
  }

  /**
   * Idempotent. A session that finishes between listing and acting simply
   * yields a no-op on the next pass, which is what makes racing the
   * dispatcher harmless.
   */
  reconcile(): void {
    const name = this.tmuxSessionName();
    const panes = this.tmux.listPanes(name);
    const actions = planReconcile(this.fleetSessions(), panes, Date.now());
    if (actions.length === 0) return;

    for (const action of actions) {
      if (action.kind === 'kill-pane') {
        this.tmux.killPane(action.paneId);
        continue;
      }
      if (action.kind === 'retitle-pane') {
        this.tmux.setPaneTitle(action.paneId, action.title);
        continue;
      }
      const session = this.sessions.get(action.sessionId);
      if (!session) continue;
      const paneId = this.tmux.splitWindow(
        name,
        session.cwd,
        this.deckCommand(['session', 'follow', session.id])
      );
      if (!paneId) continue;
      this.tmux.setPaneSession(paneId, session.id);
      this.tmux.setPaneTitle(paneId, action.title);
    }
    this.tmux.selectLayout(name);
  }

  /**
   * `insideTmux` must be true when the caller is already in a tmux client,
   * because `attach-session` refuses to nest and would error instead of
   * moving the client.
   */
  attachArgs(insideTmux: boolean): string[] {
    const name = this.tmuxSessionName();
    return insideTmux ? this.tmux.switchClientArgs(name) : this.tmux.attachArgs(name);
  }

  paneFor(sessionId: string): string | null {
    const pane = this.tmux
      .listPanes(this.tmuxSessionName())
      .find((p) => p.sessionId === sessionId);
    return pane?.paneId ?? null;
  }

  titleFor(session: FleetSession): string {
    return paneTitle(session);
  }

  /**
   * Hands one worker to the human.
   *
   * The headless process stops, then the same pane is respawned running the
   * harness interactively in the same worktree. The session row, worktree,
   * generated MCP config, and token all survive, so `task_get`,
   * `report_done`, and `ask_manager` keep working while a human drives it.
   *
   * tmux owns the pane's pseudo-terminal, which is why flightdeck never has
   * to emulate one.
   */
  async claim(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);
    if (session.policy === 'brain' || session.policy === 'manager') {
      throw new Error(`session "${sessionId}" is not a worker and cannot be claimed`);
    }
    const paneId = this.paneFor(sessionId);
    if (!paneId) throw new Error(`session "${sessionId}" has no fleet pane to claim`);

    if (session.status === 'running') {
      await this.sessions.stopSession(sessionId);
    }

    const adapter = getAdapter(session.harness);
    // Deliberately no FLIGHTDECK_SESSION_TOKEN. Every tmux argument is visible
    // to `ps`, including a -e value, so there is no safe way to pass a secret
    // here. There is also no need: nothing reads that variable from the
    // environment, and the session's generated MCP config already hands the
    // token to the MCP server through its --token argument.
    const env: Record<string, string> = {
      ...(adapter.profileEnv(session) as Record<string, string>),
      FLIGHTDECK_SESSION_ID: session.id,
    };
    this.tmux.respawnPane(
      paneId,
      session.cwd,
      [adapter.binary, ...adapter.interactiveArgs()],
      env
    );

    getDb(this.projectRoot)
      .prepare("UPDATE sessions SET claimed_at = ?, status = 'running' WHERE id = ?")
      .run(now(), sessionId);
    this.tmux.setPaneTitle(paneId, paneTitle(this.fleetSessionOf(sessionId)));
  }

  /**
   * Stops one worker's process only. It never mutates tasks or removes the
   * worktree, so the human caller (not this method) decides what happens to
   * the task and the worktree.
   */
  async stopWorker(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);
    if (session.policy === 'brain' || session.policy === 'manager') {
      throw new Error(`session "${sessionId}" is not a worker`);
    }
    await this.sessions.stopSession(sessionId);
  }

  /** Ends a claim. Returns the pane to tailing, or restarts the worker headless. */
  async release(sessionId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);

    // Atomically clear the claim and record the headless process as stopped
    // before the pane is respawned, so no stale close callback or polling pass
    // can resurrect a released session as running.
    getDb(this.projectRoot)
      .prepare(
        "UPDATE sessions SET claimed_at = NULL, status = 'stopped', pid = NULL, ended_at = ?, last_activity_at = ? WHERE id = ?"
      )
      .run(now(), now(), sessionId);

    const paneId = this.paneFor(sessionId);
    if (paneId) {
      this.tmux.respawnPane(
        paneId,
        session.cwd,
        this.deckCommand(['session', 'follow', sessionId])
      );
      this.tmux.setPaneTitle(paneId, paneTitle(this.fleetSessionOf(sessionId)));
    }

    if (opts.resume) {
      // restartSession performs the later transition back to running.
      await this.sessions.restartSession(sessionId, { headless: true, waitForExit: false });
    }
  }

  private fleetSessionOf(sessionId: string): FleetSession {
    const found = this.fleetSessions().find((s) => s.id === sessionId);
    if (!found) throw new Error(`session "${sessionId}" not found`);
    return found;
  }
}
