import { describe, it, expect } from 'vitest';
import { renderToString } from 'ink';
import type { ReactElement } from 'react';
import { FleetConsoleView, type ConsoleSnapshot } from '../../src/cli/commands/fleet.js';
import type { FleetConsoleState } from '../../src/fleet/console-state.js';

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

  it('renders a throttle time when set', () => {
    const until = Date.parse('2026-08-16T12:00:00.000Z');
    const output = render(snapshot({ throttledUntil: until }), state());
    expect(output.toLowerCase()).toContain('throttled');
  });

  it('does not render a quota or throttle line when neither is set', () => {
    const output = render(snapshot(), state());
    expect(output.toLowerCase()).not.toContain('throttled');
  });
});
