export interface PlaybookInput {
  name: string;
  required?: boolean;
  default?: unknown;
}

export interface BaseStep {
  id: string;
  retries?: number;
  timeout?: number;
  onError?: 'abort' | 'continue';
}

export interface BashStep extends BaseStep {
  type: 'bash';
  command: string;
  cwd?: string;
}

export interface LlmStep extends BaseStep {
  type: 'llm';
  prompt: string;
}

export interface HttpStep extends BaseStep {
  type: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface McpStep extends BaseStep {
  type: 'mcp';
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface DataStep extends BaseStep {
  type: 'data';
  operation: 'create' | 'insert' | 'query' | 'update' | 'aggregate';
  table: string;
  columns?: { name: string; type: string }[];
  data?: Record<string, unknown>;
  where?: Record<string, unknown>;
  rowid?: number;
  fn?: 'count' | 'sum' | 'avg' | 'min' | 'max';
  column?: string;
  groupBy?: string;
  limit?: number;
}

export interface MessageStep extends BaseStep {
  type: 'message';
  to?: string;
  body: string;
}

export interface NoteStep extends BaseStep {
  type: 'note';
  operation: 'create' | 'read' | 'update' | 'search' | 'list';
  title?: string;
  body?: string;
  noteId?: string;
  query?: string;
}

export interface PlaybookStep extends BaseStep {
  type: 'playbook';
  name: string;
  args?: Record<string, unknown>;
}

export interface WaitStep extends BaseStep {
  type: 'wait';
  seconds: number;
}

export interface ConditionStep extends BaseStep {
  type: 'condition';
  if: string;
  then: Step[];
  else?: Step[];
}

export interface ManualStep extends BaseStep {
  type: 'manual';
  prompt: string;
}

export interface ParallelStep extends BaseStep {
  type: 'parallel';
  branches: Step[][];
}

export type Step =
  | BashStep
  | LlmStep
  | HttpStep
  | McpStep
  | DataStep
  | MessageStep
  | NoteStep
  | PlaybookStep
  | WaitStep
  | ConditionStep
  | ManualStep
  | ParallelStep;

export interface Playbook {
  name: string;
  description?: string;
  inputs?: PlaybookInput[];
  vars?: Record<string, unknown>;
  steps: Step[];
  onError?: 'abort' | 'continue';
}

export interface StepResult {
  status: 'ok' | 'failed' | 'skipped';
  output: unknown;
  error?: string;
}
