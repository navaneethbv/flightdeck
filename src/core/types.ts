export type HarnessKind = 'claude' | 'codex' | 'opencode' | 'gemini';

export const HARNESSES: HarnessKind[] = ['claude', 'codex', 'opencode', 'gemini'];

export function isHarnessKind(value: string): value is HarnessKind {
  return (HARNESSES as string[]).includes(value);
}

export type SessionStatus = 'running' | 'stopped' | 'failed';

export type SessionPolicy = 'default' | 'child' | 'manager';

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
}

export type IntegrationKind = 'jira' | 'github' | 'slack';

