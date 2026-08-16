export type HarnessKind = 'claude' | 'codex' | 'opencode' | 'gemini';

export type BrainHarness = Extract<HarnessKind, 'claude' | 'codex'>;
export type WorkerHarness = Extract<HarnessKind, 'opencode' | 'gemini'>;

export const HARNESSES: HarnessKind[] = ['claude', 'codex', 'opencode', 'gemini'];

export function isHarnessKind(value: string): value is HarnessKind {
  return (HARNESSES as string[]).includes(value);
}

export type SessionStatus = 'running' | 'stopped' | 'failed';

export type SessionPolicy = 'default' | 'child' | 'manager' | 'brain';

export type TaskStatus =
  | 'pending'
  | 'assigned'
  | 'reported'
  | 'gating'
  | 'revising'
  | 'in_review'
  | 'done'
  | 'blocked';

/** What a worker reports through the `report_done` MCP tool. */
export interface WorkerReport {
  summary: string;
  filesChanged: string[];
  testsRun: string;
  uncertainties: string;
}

/**
 * Objective gate output. A null exit code means the gate was skipped because
 * its command was configured empty.
 */
export interface GateResult {
  testExitCode: number | null;
  lintExitCode: number | null;
  failureTail: string;
}

export interface Task {
  id: string;
  argusId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  assigneeSession: string | null;
  dependsOn: string[];
  attempts: number;
  workerReport: WorkerReport | null;
  gateResult: GateResult | null;
  diffstat: string | null;
  verdict: string | null;
  verdictReason: string | null;
  createdAt: number;
  updatedAt: number;
  /** Higher dispatches first. Set by the human override surface. */
  priority: number;
  reviewQueuedAt: number | null;
}

export interface Question {
  id: number;
  argusId: string;
  sessionId: string;
  question: string;
  answer: string | null;
  faqKey: string | null;
  createdAt: number;
  answeredAt: number | null;
  failedAt: number | null;
}

export interface Session {
  id: string;
  name: string;
  harness: HarnessKind;
  projectRoot: string;
  worktree: string | null;
  cwd: string;
  pid: number | null;
  status: SessionStatus;
  token: string;
  policy: SessionPolicy;
  argusParent: string | null;
  task: string | null;
  startedAt: number;
  endedAt: number | null;
  lastActivityAt: number;
  exitCode: number | null;
  /** Set while a human has taken this session over in a fleet pane. */
  claimedAt: number | null;
}

export interface Argus {
  id: string;
  name: string;
  projectRoot: string;
  missionNoteId: string | null;
  cap: string;
  childLimit: number;
  pulseSec: number;
  riskyTools: boolean;
  status: 'running' | 'stopped';
  managerSessionId: string | null;
  createdAt: number;
  lastPulseAt: number | null;
  brainHarness: BrainHarness;
  brainPlanModel: string | null;
  brainReviewModel: string | null;
  workerHarnesses: WorkerHarness[];
  budgetWindowSec: number;
  budgetMaxTokens: number;
  budgetCountCacheReads: boolean;
  maxAttemptsPerTask: number;
  maxTasks: number;
  questionTimeoutSec: number;
  conventionsNoteId: string | null;
}

export type IntegrationKind = 'jira' | 'github' | 'slack';

