import { describe, it, expect } from 'vitest';
import { renderToString } from 'ink';
import type { ReactElement } from 'react';
import {
  FleetConsoleView,
  FleetConsole,
  loadSnapshot,
  sortTasks,
  resolveConsoleEvent,
  resolveArgusId,
  type ConsoleSnapshot,
} from '../../src/cli/commands/fleet.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { TablesStore } from '../../src/tables/store.js';
import type { FleetConsoleState } from '../../src/fleet/console-state.js';
import { makeRepo } from '../helpers.js';

function state(overrides: Partial<FleetConsoleState> = {}): FleetConsoleState {
  return {
    focus: 'workers',
    workerIndex: 0,
    taskIndex: 0,
    pendingAction: null,
    rejectReason: '',
    ...overrides,
  };
}

function snapshot(overrides: Partial<ConsoleSnapshot> = {}): ConsoleSnapshot {
  return {
    sessions: [],
    argusId: null,
    argusStatus: null,
    tasks: [],
    reviewQueueDepth: 0,
    nextBudgetResetAt: null,
    spent: 0,
    ceiling: 0,
    tier: 'normal',
    quotaId: null,
    throttledUntil: null,
    progress: [],
    fleetError: null,
    tick: 1,
    ...overrides,
  };
}

function render(snap: ConsoleSnapshot, st: FleetConsoleState, message = ''): string {
  const el = FleetConsoleView({
    snap,
    state: st,
    message,
  }) as ReactElement;
  return renderToString(el, { columns: 100 });
}

describe('FleetConsoleView', () => {
  it('renders empty workers and tasks without a crash', () => {
    const output = render(snapshot(), state());
    expect(output).toContain('Workers');
    expect(output).toContain('Tasks');
    expect(output).toContain('(none)');
  });

  it('marks the selected worker row and shows the claim badge', () => {
    const snap = snapshot({
      sessions: [
        {
          id: 'w1', name: 'worker-a', harness: 'opencode', status: 'running', policy: 'child', endedAt: null, claimedAt: 123,
        },
        {
          id: 'w2', name: 'worker-b', harness: 'claude', status: 'stopped', policy: 'child', endedAt: null, claimedAt: null,
        },
      ],
    });
    const output = render(snap, state({ focus: 'workers', workerIndex: 1 }));
    expect(output).toContain('worker-a');
    expect(output).toContain('CLAIMED');
    // The selected row is the second worker, so its status line is marked.
    expect(output).toContain('> stopped');
  });

  it('marks the selected task row and renders blocked tasks with reasons', () => {
    const snap = snapshot({
      argusId: 'a1',
      tasks: [
        {
          id: 't-aaaaaaaa-0000', argusId: 'a1', title: 'fix parser', spec: 's', status: 'blocked',
          assigneeSession: null, dependsOn: [], attempts: 2, workerReport: null, gateResult: null,
          diffstat: null, verdict: null, verdictReason: 'exhausted 3 attempts: tests fail', createdAt: 1, updatedAt: 2, priority: 0,
        },
        {
          id: 't-bbbbbbbb-0000', argusId: 'a1', title: 'add schema', spec: 's', status: 'pending',
          assigneeSession: null, dependsOn: [], attempts: 0, workerReport: null, gateResult: null,
          diffstat: null, verdict: null, verdictReason: null, createdAt: 2, updatedAt: 2, priority: 0,
        },
      ],
    });
    const output = render(snap, state({ focus: 'tasks', taskIndex: 1 }));
    expect(output).toContain('fix parser');
    expect(output).toContain('exhausted 3 attempts: tests fail');
    expect(output).toContain('> pending');
  });

  it('shows review queue depth and next reset only when known', () => {
    const snap = snapshot({
      argusId: 'a1',
      reviewQueueDepth: 3,
      nextBudgetResetAt: 1755400000000,
      spent: 500,
      ceiling: 1000,
      tier: 'batch',
    });
    const output = render(snap, state());
    expect(output).toContain('queued=3');
    expect(output).toContain('next reset');
    expect(output).toContain('batch');

    const empty = render(snapshot({ argusId: 'a1', nextBudgetResetAt: null }), state());
    expect(empty).not.toContain('next reset');
  });

  it('shows the kill confirmation prompt and renders a service failure', () => {
    const snap = snapshot({ sessions: [{ id: 'w1', name: 'w', harness: 'opencode', status: 'running', policy: 'child', endedAt: null, claimedAt: null }] });
    const armed = render(snap, state({ pendingAction: { kind: 'kill', sessionId: 'w1' } }));
    expect(armed).toContain('Kill w1 and block its task?');

    const failed = render(snap, state(), 'session w1 not found');
    expect(failed).toContain('session w1 not found');
  });

  it('renders reject-reason entry and hides spend on unknown values', () => {
    const snap = snapshot({
      argusId: 'a1',
      tasks: [
        {
          id: 't1', argusId: 'a1', title: 'a', spec: 's', status: 'pending', assigneeSession: null,
          dependsOn: [], attempts: 0, workerReport: null, gateResult: null, diffstat: null,
          verdict: null, verdictReason: null, createdAt: 1, updatedAt: 1, priority: 0,
        },
      ],
    });
    const rejecting = render(snap, state({ focus: 'tasks', pendingAction: { kind: 'reject', taskId: 't1' }, rejectReason: 'bad' }));
    expect(rejecting).toContain('bad');

    // Unknown spend must not render as 0.
    const unknown = render(snapshot({ argusId: 'a1', spent: 0, ceiling: 0 }), state());
    expect(unknown).not.toMatch(/0 \/ 0/);
  });

  it('renders fleetError when multiple fleets exist and draws no task rows', () => {
    const snap = snapshot({
      argusId: null,
      fleetError: 'multiple fleets exist; drive them from the CLI with --argus <id> until a fleet selector exists',
      tasks: [],
    });
    const output = render(snap, state());
    expect(output).toContain('multiple fleets exist');
    expect(output).toContain('Tasks');
    expect(output).toContain('(none)');
  });

  it('renders a paused mission distinctly from running or stopped', () => {
    const output = render(snapshot({ argusStatus: 'paused' }), state());
    expect(output).toContain('paused');
  });

  it('renders the attached quota id when present', () => {
    const output = render(snapshot({ quotaId: 'shared-account' }), state());
    expect(output).toContain('shared-account');
  });

  it('renders a throttle time that is still in the future', () => {
    const until = Date.now() + 60_000;
    const output = render(snapshot({ throttledUntil: until }), state());
    expect(output.toLowerCase()).toContain('throttled');
  });

  it('does not render a throttle time that has already passed', () => {
    const until = Date.now() - 60_000;
    const output = render(snapshot({ throttledUntil: until }), state());
    expect(output.toLowerCase()).not.toContain('throttled');
  });

  it('does not render a quota or throttle line when neither is set', () => {
    const output = render(snapshot(), state());
    expect(output.toLowerCase()).not.toContain('throttled');
  });

  it('renders FleetConsole component cleanly', () => {
    const fixture = makeRepo();
    try {
      const output = renderToString(<FleetConsole projectRoot={fixture.root} />, { columns: 100 });
      expect(output).toContain('Workers');
      expect(output).toContain('Tasks');
    } finally {
      fixture.cleanup();
    }
  });

  it('tests loadSnapshot and sortTasks variations', () => {
    const fixture = makeRepo();
    try {
      // 0 fleets
      const snap0 = loadSnapshot(fixture.root);
      expect(snap0.fleetError).toContain('no argus fleet exists');

      // 1 fleet with tasks and progress
      const am = new ArgusManager(fixture.root);
      const fleet1 = am.start({ name: 'fl-snap-1' });
      const board = new TaskBoard(fixture.root);
      const [t1, t2] = board.create(fleet1.id, [
        { title: 'Task Done', spec: 'Done spec', dependsOn: [] },
        { title: 'Task Blocked', spec: 'Blocked spec', dependsOn: [] },
      ]);
      board.recordVerdict(t1.id, 'accept', 'done reason');
      board.block(t2.id, 'failed reason');

      const tbl = new TablesStore(fixture.root);
      tbl.insertRow('argus_progress', { argus_id: fleet1.id, event: 'test_event', detail: 'test_detail' });

      const snap1 = loadSnapshot(fixture.root);
      expect(snap1.argusId).toBe(fleet1.id);
      expect(snap1.tasks).toHaveLength(2);
      expect(snap1.progress).toHaveLength(2);

      // >1 fleets
      am.start({ name: 'fl-snap-2' });
      const snap2 = loadSnapshot(fixture.root);
      expect(snap2.fleetError).toContain('multiple fleets exist');

      // sortTasks
      const sorted = sortTasks(snap1.tasks);
      expect(sorted[0].status).toBe('done');

      // resolveArgusId
      expect(resolveArgusId(fixture.root, 'explicit-id')).toBe('explicit-id');
      expect(() => resolveArgusId(fixture.root, undefined)).toThrow('multiple fleets exist');
    } finally {
      fixture.cleanup();
    }
  });

  it('tests resolveConsoleEvent key mappings and actions', () => {
    expect(resolveConsoleEvent('', { tab: true }, null)).toEqual({ type: 'tab' });
    expect(resolveConsoleEvent('', { upArrow: true }, null)).toEqual({ type: 'up' });
    expect(resolveConsoleEvent('', { downArrow: true }, null)).toEqual({ type: 'down' });
    expect(resolveConsoleEvent('', { escape: true }, null)).toEqual({ type: 'cancel' });
    expect(resolveConsoleEvent('', { return: true }, null)).toEqual({ type: 'confirm' });
    expect(resolveConsoleEvent('', { backspace: true }, null)).toEqual({ type: 'backspace' });
    expect(resolveConsoleEvent('q', {}, null)).toBe('quit');
    expect(resolveConsoleEvent('q', {}, { kind: 'kill', sessionId: 's1' })).toEqual({ type: 'cancel' });
    expect(resolveConsoleEvent('c', {}, null)).toEqual({ type: 'action', key: 'c' });
    expect(resolveConsoleEvent('r', {}, null)).toEqual({ type: 'action', key: 'r' });
    expect(resolveConsoleEvent('R', {}, null)).toEqual({ type: 'action', key: 'R' });
    expect(resolveConsoleEvent('k', {}, null)).toEqual({ type: 'action', key: 'k' });
    expect(resolveConsoleEvent('n', {}, null)).toEqual({ type: 'action', key: 'n' });
    expect(resolveConsoleEvent('a', {}, null)).toEqual({ type: 'action', key: 'a' });
    expect(resolveConsoleEvent('x', {}, null)).toEqual({ type: 'action', key: 'x' });
    expect(resolveConsoleEvent('u', {}, null)).toEqual({ type: 'action', key: 'u' });
    expect(resolveConsoleEvent('p', {}, null)).toEqual({ type: 'action', key: 'p' });
    expect(resolveConsoleEvent('f', {}, null)).toEqual({ type: 'action', key: 'f' });
    expect(resolveConsoleEvent('hello', {}, { kind: 'reject', taskId: 't1' })).toEqual({ type: 'text', value: 'hello' });
    expect(resolveConsoleEvent('z', {}, null)).toBeNull();
  });
});
