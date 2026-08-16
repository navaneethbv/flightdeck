import type { PaneInfo } from './tmux.js';

export interface FleetSession {
  id: string;
  name: string;
  harness: string;
  status: string;
  policy: string;
  endedAt: number | null;
  claimedAt: number | null;
}

export type ReconcileAction =
  | { kind: 'create-pane'; sessionId: string; title: string }
  | { kind: 'kill-pane'; paneId: string }
  | { kind: 'retitle-pane'; paneId: string; title: string };

/**
 * How long a finished worker keeps its pane. Without this the pane vanishes
 * the instant the process exits, taking the last of its output with it.
 */
export const PANE_GRACE_MS = 60_000;

export function paneTitle(session: FleetSession): string {
  const claimed = session.claimedAt !== null ? ' · CLAIMED' : '';
  return `${session.name} · ${session.harness}${claimed} · ${session.status}`;
}

/**
 * A session earns a pane when a human could usefully watch it: worker or
 * plain sessions only, and either running or recently finished.
 *
 * Excluding `brain` and `manager` is required rather than cosmetic. A brain
 * invocation is its own short-lived session, so including them would create
 * and destroy a pane on every brain call.
 */
function deservesPane(session: FleetSession, nowMs: number): boolean {
  if (session.policy !== 'child' && session.policy !== 'default') return false;
  if (session.status === 'running') return true;
  return session.endedAt !== null && nowMs - session.endedAt <= PANE_GRACE_MS;
}

/**
 * Pure. Takes the world as it is and returns what to do about it, so the
 * riskiest logic in the fleet window is directly testable.
 *
 * Idempotent by construction: applying the result and re-running yields no
 * actions, which is what makes a race with the dispatcher harmless.
 */
export function planReconcile(
  sessions: FleetSession[],
  panes: PaneInfo[],
  nowMs: number
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const wanted = sessions.filter((s) => deservesPane(s, nowMs));
  const byId = new Map(wanted.map((s) => [s.id, s]));
  const tracked = panes.filter((p) => p.sessionId !== null);

  for (const pane of tracked) {
    const session = byId.get(pane.sessionId!);
    if (!session) {
      actions.push({ kind: 'kill-pane', paneId: pane.paneId });
      continue;
    }
    const title = paneTitle(session);
    if (pane.title !== title) {
      actions.push({ kind: 'retitle-pane', paneId: pane.paneId, title });
    }
  }

  const paneSessions = new Set(tracked.map((p) => p.sessionId));
  for (const session of wanted) {
    if (!paneSessions.has(session.id)) {
      actions.push({ kind: 'create-pane', sessionId: session.id, title: paneTitle(session) });
    }
  }

  return actions;
}
