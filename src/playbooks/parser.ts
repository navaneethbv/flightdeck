import YAML from 'yaml';
import fs from 'node:fs';
import type { Playbook, Step, StepResult } from './types.js';

export function parsePlaybookYaml(raw: string, sourceName = 'playbook'): Playbook {
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${sourceName}: ${(err as Error).message}`);
  }
  return parsePlaybook(data, sourceName);
}

export function parsePlaybook(data: unknown, sourceName = 'playbook'): Playbook {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`invalid playbook "${sourceName}": expected a mapping`);
  }
  const doc = data as Record<string, unknown>;
  if (typeof doc.name !== 'string' || doc.name.trim() === '') {
    throw new Error(`invalid playbook "${sourceName}": missing "name"`);
  }
  if (!Array.isArray(doc.steps)) {
    throw new Error(`invalid playbook "${doc.name}": missing "steps" array`);
  }
  const steps = doc.steps.map((s) => parseStep(s, `${doc.name}#step`));
  assertUniqueIds(steps, doc.name);
  return {
    name: doc.name,
    description: typeof doc.description === 'string' ? doc.description : undefined,
    inputs: parseInputs(doc.inputs),
    vars: doc.vars !== undefined && typeof doc.vars === 'object' ? (doc.vars as Record<string, unknown>) : undefined,
    steps,
    onError: doc.on_error === 'continue' ? 'continue' : 'abort',
  };
}

function parseInputs(value: unknown): Playbook['inputs'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('invalid "inputs": expected an array');
  return value.map((v) => {
    const def = v as Record<string, unknown>;
    return {
      name: String(def.name),
      required: def.required === true,
      default: def.default,
    };
  });
}

function parseStep(raw: unknown, label: string): Step {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`invalid step in "${label}": expected a mapping`);
  }
  const s = raw as Record<string, unknown>;
  const id = typeof s.id === 'string' ? s.id : null;
  if (!id) throw new Error(`invalid step in "${label}": missing "id"`);
  const type = typeof s.type === 'string' ? s.type : '';
  const base = {
    id,
    retries: numOrUndef(s.retries),
    timeout: numOrUndef(s.timeout),
    onError: s.on_error === 'continue' ? ('continue' as const) : ('abort' as const),
  };
  switch (type) {
    case 'bash':
      requireString(s, 'command', id);
      return { ...base, type, command: String(s.command), cwd: optString(s.cwd) };
    case 'llm':
      requireString(s, 'prompt', id);
      return { ...base, type, prompt: String(s.prompt) };
    case 'http':
      requireString(s, 'url', id);
      return {
        ...base,
        type,
        method: (String(s.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'),
        url: String(s.url),
        headers: optMap(s.headers) as Record<string, string> | undefined,
        body: s.body,
      };
    case 'mcp':
      requireString(s, 'tool', id);
      return { ...base, type, tool: String(s.tool), arguments: optMap(s.arguments) ?? optMap(s.args) };
    case 'data':
      requireString(s, 'table', id);
      requireString(s, 'operation', id);
      return {
        ...base,
        type,
        table: String(s.table),
        operation: String(s.operation) as StepDataOperation,
        columns: Array.isArray(s.columns) ? (s.columns as { name: string; type: string }[]) : undefined,
        data: optMap(s.data),
        where: optMap(s.where),
        rowid: numOrUndef(s.rowid),
        fn: optString(s.fn) as StepDataOperationAggregate | undefined,
        column: optString(s.column),
        groupBy: optString(s.group_by),
        limit: numOrUndef(s.limit),
      };
    case 'message':
      requireString(s, 'body', id);
      return { ...base, type, to: optString(s.to), body: String(s.body) };
    case 'note':
      requireString(s, 'operation', id);
      return {
        ...base,
        type,
        operation: String(s.operation) as StepNoteOperation,
        title: optString(s.title),
        body: optString(s.body),
        noteId: optString(s.note_id),
        query: optString(s.query),
      };
    case 'playbook':
      requireString(s, 'name', id);
      return { ...base, type, name: String(s.name), args: optMap(s.args) };
    case 'wait':
      return { ...base, type, seconds: numOrUndef(s.seconds) ?? 1 };
    case 'condition':
      requireString(s, 'if', id);
      if (!Array.isArray(s.then)) throw new Error(`step "${id}": "then" must be an array`);
      return {
        ...base,
        type,
        if: String(s.if),
        then: (s.then as unknown[]).map((t) => parseStep(t, `${label}.${id}.then`)),
        else: Array.isArray(s.else) ? (s.else as unknown[]).map((t) => parseStep(t, `${label}.${id}.else`)) : undefined,
      };
    case 'manual':
      requireString(s, 'prompt', id);
      return { ...base, type, prompt: String(s.prompt) };
    case 'parallel':
      if (!Array.isArray(s.branches)) throw new Error(`step "${id}": "branches" must be an array`);
      return {
        ...base,
        type,
        branches: (s.branches as unknown[][]).map((branch, i) =>
          branch.map((t) => parseStep(t, `${label}.${id}.branch${i}`))
        ),
      };
    default:
      throw new Error(`step "${id}": unknown type "${type}"`);
  }
}

function assertUniqueIds(steps: Step[], name: string): void {
  const seen = new Set<string>();
  const visit = (list: Step[]): void => {
    for (const step of list) {
      if (seen.has(step.id)) throw new Error(`playbook "${name}": duplicate step id "${step.id}"`);
      seen.add(step.id);
      if (step.type === 'condition') {
        visit(step.then);
        if (step.else) visit(step.else);
      } else if (step.type === 'parallel') {
        for (const branch of step.branches) visit(branch);
      }
    }
  };
  visit(steps);
}

function requireString(s: Record<string, unknown>, key: string, id: string): void {
  if (typeof s[key] !== 'string' || (s[key] as string).trim() === '') {
    throw new Error(`step "${id}": missing string field "${key}"`);
  }
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optMap(v: unknown): Record<string, unknown> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, unknown>;
}

export type StepDataOperation = 'create' | 'insert' | 'query' | 'update' | 'aggregate';
export type StepDataOperationAggregate = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type StepNoteOperation = 'create' | 'read' | 'update' | 'search' | 'list';

export function parsePlaybookFile(filePath: string): Playbook {
  return parsePlaybookYaml(fs.readFileSync(filePath, 'utf8'), filePath);
}

export { StepResult };
