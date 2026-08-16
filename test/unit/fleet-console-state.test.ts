import { describe, it, expect } from 'vitest';
import {
  reduceConsoleState,
  type ConsoleBounds,
  type FleetConsoleState,
  type ConsoleEvent,
} from '../../src/fleet/console-state.js';

function initial(overrides: Partial<FleetConsoleState> = {}): FleetConsoleState {
  return {
    focus: 'workers',
    workerIndex: 0,
    taskIndex: 0,
    pendingAction: null,
    rejectReason: '',
    ...overrides,
  };
}

function bounds(overrides: Partial<ConsoleBounds> = {}): ConsoleBounds {
  return {
    argusId: 'a1',
    workerIds: ['w1', 'w2'],
    taskIds: ['t1', 't2', 't3'],
    ...overrides,
  };
}

function reduce(state: FleetConsoleState, event: ConsoleEvent, b: ConsoleBounds = bounds()) {
  return reduceConsoleState(state, event, b);
}

describe('reduceConsoleState', () => {
  it('switches focus on tab', () => {
    const a = reduce(initial(), { type: 'tab' });
    expect(a.state.focus).toBe('tasks');
    const b = reduce(a.state, { type: 'tab' });
    expect(b.state.focus).toBe('workers');
  });

  it('clamps up and down selection to the current list bounds', () => {
    const s = reduce(initial({ workerIndex: 1 }), { type: 'down' });
    expect(s.state.workerIndex).toBe(1);
    const s2 = reduce(initial({ taskIndex: 2 }), { type: 'down' });
    expect(s2.state.taskIndex).toBe(2);
    const s3 = reduce(initial({ workerIndex: 0 }), { type: 'up' });
    expect(s3.state.workerIndex).toBe(0);
  });

  it('clamps a previously valid selection when a list shrinks', () => {
    const b = bounds({ workerIds: ['w1'], taskIds: ['t1'] });
    const s = reduce(initial({ workerIndex: 5, taskIndex: 9 }), { type: 'down' }, b);
    expect(s.state.workerIndex).toBe(0);
    expect(s.state.taskIndex).toBe(0);
  });

  it('enters kill confirmation only with a selected worker', () => {
    const s = reduce(initial(), { type: 'action', key: 'k' });
    expect(s.state.pendingAction).toEqual({ kind: 'kill', sessionId: 'w1' });
    expect(s.effect).toBeNull();

    const empty = reduce(initial(), { type: 'action', key: 'k' }, bounds({ workerIds: [] }));
    expect(empty.state.pendingAction).toBeNull();
  });

  it('confirms a kill with y and cancels with n or Escape', () => {
    const armed = initial({ pendingAction: { kind: 'kill', sessionId: 'w1' } });
    const yes = reduce(armed, { type: 'action', key: 'y' });
    expect(yes.effect).toEqual({ kind: 'kill', sessionId: 'w1' });
    expect(yes.state.pendingAction).toBeNull();

    const no = reduce(armed, { type: 'action', key: 'n' });
    expect(no.effect).toBeNull();
    expect(no.state.pendingAction).toBeNull();

    const esc = reduce(armed, { type: 'cancel' });
    expect(esc.effect).toBeNull();
    expect(esc.state.pendingAction).toBeNull();
  });

  it('enters reject-reason mode only with a selected task', () => {
    const s = reduce(initial(), { type: 'action', key: 'x' });
    expect(s.state.pendingAction).toEqual({ kind: 'reject', taskId: 't1' });

    const empty = reduce(initial(), { type: 'action', key: 'x' }, bounds({ taskIds: [] }));
    expect(empty.state.pendingAction).toBeNull();
  });

  it('edits the reject reason with text and backspace', () => {
    const s = reduce(initial({ pendingAction: { kind: 'reject', taskId: 't1' } }), { type: 'text', value: 'a' });
    expect(s.state.rejectReason).toBe('a');
    const s2 = reduce(s.state, { type: 'text', value: 'b' });
    expect(s2.state.rejectReason).toBe('ab');
    const s3 = reduce(s2.state, { type: 'backspace' });
    expect(s3.state.rejectReason).toBe('a');
  });

  it('confirms a reject only when the trimmed reason is non-empty', () => {
    const armed = initial({ pendingAction: { kind: 'reject', taskId: 't1' }, rejectReason: '  ' });
    const empty = reduce(armed, { type: 'confirm' });
    expect(empty.effect).toBeNull();
    expect(empty.state.pendingAction).not.toBeNull();

    const ready = initial({ pendingAction: { kind: 'reject', taskId: 't1' }, rejectReason: 'missing tests' });
    const confirmed = reduce(ready, { type: 'confirm' });
    expect(confirmed.effect).toEqual({ kind: 'reject', taskId: 't1', argusId: 'a1', reason: 'missing tests' });
    expect(confirmed.state.pendingAction).toBeNull();
    expect(confirmed.state.rejectReason).toBe('');
  });

  it('emits exactly one effect for claim, release, spawn, and prioritize', () => {
    const claim = reduce(initial(), { type: 'action', key: 'c' });
    expect(claim.effect).toEqual({ kind: 'claim', sessionId: 'w1' });

    const release = reduce(initial(), { type: 'action', key: 'r' });
    expect(release.effect).toEqual({ kind: 'release', sessionId: 'w1', resume: false });

    const resume = reduce(initial(), { type: 'action', key: 'R' });
    expect(resume.effect).toEqual({ kind: 'release', sessionId: 'w1', resume: true });

    const spawn = reduce(initial(), { type: 'action', key: 'n' });
    expect(spawn.effect).toEqual({ kind: 'spawn', argusId: 'a1' });

    const unblock = reduce(initial(), { type: 'action', key: 'u' });
    expect(unblock.effect).toEqual({ kind: 'unblock', taskId: 't1', argusId: 'a1' });

    const prioritize = reduce(initial(), { type: 'action', key: 'p' });
    expect(prioritize.effect).toEqual({ kind: 'prioritize', taskId: 't1', argusId: 'a1' });

    const force = reduce(initial(), { type: 'action', key: 'f' });
    expect(force.effect).toEqual({ kind: 'force-review', argusId: 'a1' });
  });

  it('accepts the selected task with a', () => {
    const s = reduce(initial(), { type: 'action', key: 'a' });
    expect(s.effect).toEqual({ kind: 'accept', taskId: 't1', argusId: 'a1' });
  });

  it('leaves state unchanged for unknown keys', () => {
    const s = reduce(initial(), { type: 'action', key: 'z' as never });
    expect(s.state).toEqual(initial());
    expect(s.effect).toBeNull();
  });
});
