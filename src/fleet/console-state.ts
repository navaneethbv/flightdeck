export type ConsoleFocus = 'workers' | 'tasks';

export type PendingAction =
  | { kind: 'kill'; sessionId: string }
  | { kind: 'reject'; taskId: string }
  | null;

export interface FleetConsoleState {
  focus: ConsoleFocus;
  workerIndex: number;
  taskIndex: number;
  pendingAction: PendingAction;
  rejectReason: string;
}

export interface ConsoleBounds {
  argusId: string | null;
  workerIds: string[];
  taskIds: string[];
}

export type ConsoleEffect =
  | { kind: 'claim'; sessionId: string }
  | { kind: 'release'; sessionId: string; resume: boolean }
  | { kind: 'kill'; sessionId: string }
  | { kind: 'spawn'; argusId: string }
  | { kind: 'accept' | 'unblock' | 'prioritize'; taskId: string; argusId: string }
  | { kind: 'reject'; taskId: string; argusId: string; reason: string }
  | { kind: 'force-review'; argusId: string };

export interface ConsoleTransition {
  state: FleetConsoleState;
  effect: ConsoleEffect | null;
}

export type ConsoleEvent =
  | { type: 'tab' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'action'; key: 'c' | 'r' | 'k' | 'n' | 'a' | 'x' | 'u' | 'p' | 'f' | 'R' | 'y' }
  | { type: 'text'; value: string }
  | { type: 'backspace' }
  | { type: 'confirm' }
  | { type: 'cancel' };

function clamp(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(value, max - 1));
}

function focusIndex(state: FleetConsoleState): number {
  return state.focus === 'workers' ? state.workerIndex : state.taskIndex;
}

function setFocusIndex(state: FleetConsoleState, index: number): FleetConsoleState {
  return state.focus === 'workers'
    ? { ...state, workerIndex: index }
    : { ...state, taskIndex: index };
}

function handleConfirm(clamped: FleetConsoleState, bounds: ConsoleBounds): ConsoleTransition {
  const pending = clamped.pendingAction;
  if (pending?.kind === 'kill') {
    return { state: { ...clamped, pendingAction: null }, effect: { kind: 'kill', sessionId: pending.sessionId } };
  }
  if (pending?.kind === 'reject' && clamped.rejectReason.trim() !== '' && bounds.argusId) {
    return {
      state: { ...clamped, pendingAction: null, rejectReason: '' },
      effect: { kind: 'reject', taskId: pending.taskId, argusId: bounds.argusId, reason: clamped.rejectReason.trim() },
    };
  }
  return { state: clamped, effect: null };
}

/**
 * Pure selection, focus, and confirmation reducer for the Fleet console. It
 * never calls services, exits the process, or reads SQLite: it only maps
 * keyboard events plus current list bounds to a new state and, at most, one
 * service effect that the Ink layer should run.
 */
export function reduceConsoleState(
  state: FleetConsoleState,
  event: ConsoleEvent,
  bounds: ConsoleBounds
): ConsoleTransition {
  // A list that shrank between polls must never leave either selection out of
  // range, regardless of which section currently has focus.
  const clamped: FleetConsoleState = {
    ...state,
    workerIndex: clamp(state.workerIndex, bounds.workerIds.length),
    taskIndex: clamp(state.taskIndex, bounds.taskIds.length),
  };

  switch (event.type) {
    case 'tab':
      return { state: { ...clamped, focus: clamped.focus === 'workers' ? 'tasks' : 'workers' }, effect: null };
    case 'up':
    case 'down': {
      const max = clamped.focus === 'workers' ? bounds.workerIds.length : bounds.taskIds.length;
      const delta = event.type === 'up' ? -1 : 1;
      const next = clamp(focusIndex(clamped) + delta, max);
      return { state: setFocusIndex(clamped, next), effect: null };
    }
    case 'backspace':
      if (clamped.pendingAction?.kind !== 'reject') return { state: clamped, effect: null };
      return { state: { ...clamped, rejectReason: clamped.rejectReason.slice(0, -1) }, effect: null };
    case 'text':
      if (clamped.pendingAction?.kind !== 'reject') return { state: clamped, effect: null };
      return { state: { ...clamped, rejectReason: clamped.rejectReason + event.value }, effect: null };
    case 'confirm':
      return handleConfirm(clamped, bounds);
    case 'cancel':
      if (clamped.pendingAction) return { state: { ...clamped, pendingAction: null, rejectReason: '' }, effect: null };
      return { state: clamped, effect: null };
    case 'action':
      return reduceKey(clamped, event.key, bounds);
  }
}

function reduceWorkerKey(
  state: FleetConsoleState,
  key: 'c' | 'r' | 'R' | 'k',
  workerId: string | null
): ConsoleTransition {
  if (!workerId) return { state, effect: null };
  switch (key) {
    case 'c':
      return { state, effect: { kind: 'claim', sessionId: workerId } };
    case 'r':
      return { state, effect: { kind: 'release', sessionId: workerId, resume: false } };
    case 'R':
      return { state, effect: { kind: 'release', sessionId: workerId, resume: true } };
    case 'k':
      return { state: { ...state, pendingAction: { kind: 'kill', sessionId: workerId } }, effect: null };
  }
}

function reduceTaskKey(
  state: FleetConsoleState,
  key: 'a' | 'x' | 'u' | 'p',
  taskId: string | null,
  argusId: string | null
): ConsoleTransition {
  if (!taskId) return { state, effect: null };
  if (key === 'x') {
    return { state: { ...state, pendingAction: { kind: 'reject', taskId } }, effect: null };
  }
  if (!argusId) return { state, effect: null };
  switch (key) {
    case 'a':
      return { state, effect: { kind: 'accept', taskId, argusId } };
    case 'u':
      return { state, effect: { kind: 'unblock', taskId, argusId } };
    case 'p':
      return { state, effect: { kind: 'prioritize', taskId, argusId } };
  }
}

function reduceKey(
  state: FleetConsoleState,
  key: 'c' | 'r' | 'k' | 'n' | 'a' | 'x' | 'u' | 'p' | 'f' | 'R' | 'y',
  bounds: ConsoleBounds
): ConsoleTransition {
  const workerId = bounds.workerIds[state.workerIndex] ?? null;
  const taskId = bounds.taskIds[state.taskIndex] ?? null;

  if (key === 'c' || key === 'r' || key === 'R' || key === 'k') {
    return reduceWorkerKey(state, key, workerId);
  }
  if (key === 'a' || key === 'x' || key === 'u' || key === 'p') {
    return reduceTaskKey(state, key, taskId, bounds.argusId);
  }
  if (key === 'y') {
    if (state.pendingAction?.kind === 'kill') {
      return {
        state: { ...state, pendingAction: null },
        effect: { kind: 'kill', sessionId: state.pendingAction.sessionId },
      };
    }
    return { state, effect: null };
  }
  if (key === 'n') {
    if (state.pendingAction) {
      return { state: { ...state, pendingAction: null, rejectReason: '' }, effect: null };
    }
    return bounds.argusId
      ? { state, effect: { kind: 'spawn', argusId: bounds.argusId } }
      : { state, effect: null };
  }
  if (key === 'f') {
    return bounds.argusId
      ? { state, effect: { kind: 'force-review', argusId: bounds.argusId } }
      : { state, effect: null };
  }
  return { state, effect: null };
}
