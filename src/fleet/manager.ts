import crypto from 'node:crypto';
import { normalizeProjectRoot } from '../core/paths.js';
import { cliEntryPath } from '../core/cliEntry.js';
import { SessionManager } from '../sessions/manager.js';
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
}
