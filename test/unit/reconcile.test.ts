import { describe, it, expect } from 'vitest';
import { planReconcile, paneTitle, type FleetSession } from '../../src/fleet/reconcile.js';
import type { PaneInfo } from '../../src/fleet/tmux.js';

const NOW = 1_000_000;

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    id: 's1',
    name: 'worker-1',
    harness: 'opencode',
    status: 'running',
    policy: 'child',
    endedAt: null,
    claimedAt: null,
    ...over,
  };
}

const consolePane: PaneInfo = { paneId: '%0', sessionId: null, title: 'console' };

describe('planReconcile', () => {
  it('creates a pane for a running worker that has none', () => {
    const actions = planReconcile([session()], [consolePane], NOW);
    expect(actions).toEqual([{ kind: 'create-pane', sessionId: 's1', title: paneTitle(session()) }]);
  });

  it('never gives a brain session a pane', () => {
    // Brain invocations are their own short-lived sessions. Including them
    // would create and destroy a pane on every brain call.
    const brain = session({ id: 'b1', policy: 'brain', name: 'brain-plan' });
    expect(planReconcile([brain], [consolePane], NOW)).toEqual([]);
  });

  it('leaves the console pane alone', () => {
    expect(planReconcile([], [consolePane], NOW)).toEqual([]);
  });

  it('keeps a just-finished pane during the grace period', () => {
    const finished = session({ status: 'stopped', endedAt: NOW - 10_000 });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: paneTitle(finished) };
    expect(planReconcile([finished], [consolePane, pane], NOW)).toEqual([]);
  });

  it('kills a pane once the grace period has passed', () => {
    const finished = session({ status: 'stopped', endedAt: NOW - 90_000 });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: 'stale' };
    expect(planReconcile([finished], [consolePane, pane], NOW)).toEqual([
      { kind: 'kill-pane', paneId: '%1' },
    ]);
  });

  it('kills a pane whose session no longer exists at all', () => {
    const orphan: PaneInfo = { paneId: '%3', sessionId: 'gone', title: 'gone' };
    expect(planReconcile([], [consolePane, orphan], NOW)).toEqual([
      { kind: 'kill-pane', paneId: '%3' },
    ]);
  });

  it('retitles a pane whose title has drifted', () => {
    const claimed = session({ claimedAt: NOW });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: 'worker-1 · opencode · running' };
    expect(planReconcile([claimed], [consolePane, pane], NOW)).toEqual([
      { kind: 'retitle-pane', paneId: '%1', title: paneTitle(claimed) },
    ]);
  });

  it('does nothing when the fleet already matches', () => {
    const s = session();
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: paneTitle(s) };
    expect(planReconcile([s], [consolePane, pane], NOW)).toEqual([]);
  });
});

describe('paneTitle', () => {
  it('marks a claimed session', () => {
    expect(paneTitle(session({ claimedAt: NOW }))).toContain('CLAIMED');
    expect(paneTitle(session())).not.toContain('CLAIMED');
  });
});
