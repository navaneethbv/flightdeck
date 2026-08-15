import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { TablesStore } from '../tables/store.js';
import type { NotesStore } from '../notes/store.js';
import type { MessagingStore } from '../messaging/store.js';
import type { Step, Playbook, StepResult } from './types.js';
import { resolveTemplate, resolveTemplateLoose, type TemplateContext } from './templating.js';
import { evaluateExpression } from './expression.js';
import { resolveSecret } from '../secrets/keychain.js';

export const MAX_PLAYBOOK_DEPTH = 10;

function toSafeString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return '';
}

export interface EngineServices {
  projectRoot: string;
  tables: TablesStore;
  notes: NotesStore;
  messaging: MessagingStore;
  callMcpTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
  runHeadlessPrompt(prompt: string): Promise<{ stdout: string; exitCode: number }>;
  readPlaybook(name: string): Playbook | null;
  confirm(prompt: string): Promise<boolean>;
  fromSession?: string | null;
}

export interface RunOptions {
  inputs?: Record<string, unknown>;
  depth?: number;
  onProgress?: (stepId: string, result: StepResult) => void;
}

export interface RunResult {
  ok: boolean;
  results: Record<string, StepResult>;
  error?: string;
}

export class PlaybookEngine {
  private onProgress: ((stepId: string, result: StepResult) => void) | undefined;

  constructor(private readonly services: EngineServices) {}

  async run(playbook: Playbook, opts: RunOptions = {}): Promise<RunResult> {
    const depth = opts.depth ?? 0;
    if (depth > MAX_PLAYBOOK_DEPTH) {
      throw new Error(`playbook nesting exceeds maximum depth of ${MAX_PLAYBOOK_DEPTH}`);
    }
    this.onProgress = opts.onProgress;
    const inputs = this.resolveInputs(playbook, opts.inputs ?? {});
    const vars = this.resolveVars(playbook.vars ?? {}, { inputs, secrets: {} });
    const ctx: TemplateContext = {
      inputs,
      vars,
      secrets: this.secretProxy(),
      steps: {},
    };
    const results: Record<string, StepResult> = {};
    let ok = true;

    for (const step of playbook.steps) {
      const result = await this.runStep(step, ctx, results, depth);
      results[step.id] = result;
      recordStepContext(ctx, step.id, result);
      this.onProgress?.(step.id, result);
      if (result.status === 'failed') {
        ok = false;
        const mode = step.onError === 'continue' ? 'continue' : playbook.onError ?? 'abort';
        if (mode === 'abort') {
          return { ok: false, results, error: result.error };
        }
      }
    }
    return { ok, results };
  }

  private async runStep(
    step: Step,
    ctx: TemplateContext,
    results: Record<string, StepResult>,
    depth: number
  ): Promise<StepResult> {
    const attempt = async (): Promise<StepResult> => {
      const timeoutSec = step.timeout;
      const withTimeout = (promise: Promise<StepResult>): Promise<StepResult> => {
        if (timeoutSec === undefined) return promise;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`step "${step.id}" timed out after ${timeoutSec}s`)), timeoutSec * 1000);
          promise.then(
            (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            (e) => {
              clearTimeout(timer);
              reject(e);
            }
          );
        });
      };
      return withTimeout(this.exec(step, ctx, results, depth));
    };

    const retries = step.retries ?? 0;
    let lastError: string | undefined;
    for (let i = 0; i <= retries; i++) {
      try {
        const result = await attempt();
        if (result.status === 'failed') {
          lastError = result.error;
          if (i >= retries) return result;
          continue;
        }
        return result;
      } catch (err) {
        lastError = (err as Error).message;
        if (i >= retries) {
          return { status: 'failed', output: null, error: lastError };
        }
      }
    }
    return { status: 'failed', output: null, error: lastError };
  }

  private validateBashCommand(command: string): string | null {
    // Disallow shell control operators and command-substitution constructs that enable injection chaining.
    // Keep behavior simple and predictable for single-command execution.
    const unsafePattern = /[;&|`<>]|\$\(|\n|\r/;
    if (unsafePattern.test(command)) {
      return 'bash command contains disallowed shell control characters';
    }
    return null;
  }

  private execBash(step: Extract<Step, { type: 'bash' }>, t: (v: unknown) => unknown): StepResult {
    const command = String(t(step.command));
    const validationError = this.validateBashCommand(command);
    if (validationError) {
      return { status: 'failed', output: null, error: validationError };
    }
    const cwd = step.cwd ? path.resolve(this.services.projectRoot, String(t(step.cwd))) : this.services.projectRoot;
    const out = spawnSync('/bin/bash', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: step.timeout !== undefined ? step.timeout * 1000 : undefined,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.status };
    return out.status === 0
      ? { status: 'ok', output }
      : { status: 'failed', output, error: `bash exited ${out.status}: ${(out.stderr ?? '').trim()}` };
  }

  private async execLlm(step: Extract<Step, { type: 'llm' }>, t: (v: unknown) => unknown): Promise<StepResult> {
    const prompt = String(t(step.prompt));
    const { stdout, exitCode } = await this.services.runHeadlessPrompt(prompt);
    return exitCode === 0
      ? { status: 'ok', output: { stdout } }
      : { status: 'failed', output: { stdout }, error: `llm exited ${exitCode}` };
  }

  private async execHttp(
    step: Extract<Step, { type: 'http' }>,
    t: (v: unknown) => unknown,
    tl: (v: unknown) => unknown
  ): Promise<StepResult> {
    const url = String(t(step.url));
    const headers = (tl(step.headers) as Record<string, string> | undefined) ?? undefined;
    const body = step.body === undefined ? undefined : tl(step.body);
    let reqBody: string | undefined;
    if (typeof body === 'string') {
      reqBody = body;
    } else if (body !== undefined) {
      reqBody = JSON.stringify(body);
    }
    const res = await fetch(url, {
      method: step.method,
      headers,
      body: reqBody,
    });
    const text = await res.text();
    const output = { status: res.status, body: text, headers: Object.fromEntries(res.headers) };
    return res.ok
      ? { status: 'ok', output }
      : { status: 'failed', output, error: `http ${res.status} from ${url}` };
  }

  private async execMcp(
    step: Extract<Step, { type: 'mcp' }>,
    t: (v: unknown) => unknown,
    tl: (v: unknown) => unknown
  ): Promise<StepResult> {
    const tool = String(t(step.tool));
    const args = (tl(step.arguments) as Record<string, unknown> | undefined) ?? {};
    try {
      const output = await this.services.callMcpTool(tool, args);
      return { status: 'ok', output };
    } catch (err) {
      return { status: 'failed', output: null, error: (err as Error).message };
    }
  }

  private execMessage(step: Extract<Step, { type: 'message' }>, t: (v: unknown) => unknown): StepResult {
    const to = step.to ? String(t(step.to)) : null;
    const body = String(t(step.body));
    const output = this.services.messaging.send(this.services.fromSession ?? 'playbook', to, body);
    return { status: 'ok', output };
  }

  private async execPlaybookStep(
    step: Extract<Step, { type: 'playbook' }>,
    t: (v: unknown) => unknown,
    tl: (v: unknown) => unknown,
    depth: number
  ): Promise<StepResult> {
    const name = String(t(step.name));
    const nested = this.services.readPlaybook(name);
    if (!nested) return { status: 'failed', output: null, error: `playbook "${name}" not found` };
    const nestedInputs = (tl(step.args) as Record<string, unknown> | undefined) ?? {};
    const nestedResult = await this.run(nested, { inputs: nestedInputs, depth: depth + 1 });
    return nestedResult.ok
      ? { status: 'ok', output: { ok: true, results: nestedResult.results } }
      : { status: 'failed', output: { ok: false, results: nestedResult.results }, error: nestedResult.error };
  }

  private async execCondition(
    step: Extract<Step, { type: 'condition' }>,
    t: (v: unknown) => unknown,
    ctx: TemplateContext,
    results: Record<string, StepResult>,
    depth: number
  ): Promise<StepResult> {
    const raw = String(step.if);
    const resolved = String(t(raw));
    const value = evaluateExpression(resolved);
    const branch = value ? step.then : step.else ?? [];
    let failed = false;
    let error: string | undefined;
    for (const nested of branch) {
      const result = await this.runStep(nested, ctx, results, depth);
      results[nested.id] = result;
      recordStepContext(ctx, nested.id, result);
      this.onProgress?.(nested.id, result);
      if (result.status === 'failed') {
        failed = true;
        error = result.error;
        break;
      }
    }
    return failed
      ? { status: 'failed', output: { branch: value ? 'then' : 'else', condition: value }, error }
      : { status: 'ok', output: { branch: value ? 'then' : 'else', condition: value } };
  }

  private async exec(
    step: Step,
    ctx: TemplateContext,
    results: Record<string, StepResult>,
    depth: number
  ): Promise<StepResult> {
    const t = (v: unknown): unknown => resolveTemplate(v, ctx);
    const tl = (v: unknown): unknown => resolveTemplateLoose(v, ctx);
    switch (step.type) {
      case 'bash':
        return this.execBash(step, t);
      case 'llm':
        return this.execLlm(step, t);
      case 'http':
        return this.execHttp(step, t, tl);
      case 'mcp':
        return this.execMcp(step, t, tl);
      case 'data':
        return this.execData(step, tl);
      case 'message':
        return this.execMessage(step, t);
      case 'note':
        return this.execNote(step, tl);
      case 'playbook':
        return this.execPlaybookStep(step, t, tl, depth);
      case 'wait': {
        const seconds = Number(tl(step.seconds));
        await sleep(seconds * 1000);
        return { status: 'ok', output: { waited: seconds } };
      }
      case 'condition':
        return this.execCondition(step, t, ctx, results, depth);
      case 'manual': {
        const prompt = String(t(step.prompt));
        const confirmed = await this.services.confirm(prompt);
        return { status: 'ok', output: { confirmed, prompt } };
      }
      case 'parallel': {
        const branchResults = await Promise.all(
          step.branches.map(async (branch) => {
            const branchOut: StepResult[] = [];
            for (const nested of branch) {
              const result = await this.runStep(nested, ctx, results, depth);
              results[nested.id] = result;
              recordStepContext(ctx, nested.id, result);
              this.onProgress?.(nested.id, result);
              branchOut.push(result);
              if (result.status === 'failed') break;
            }
            return branchOut;
          })
        );
        const failed = branchResults.some((b) => b.some((r) => r.status === 'failed'));
        return failed
          ? { status: 'failed', output: { branches: branchResults }, error: 'one or more parallel branches failed' }
          : { status: 'ok', output: { branches: branchResults } };
      }
    }
  }

  private execData(step: Extract<Step, { type: 'data' }>, tl: (v: unknown) => unknown): StepResult {
    const table = String(tl(step.table));
    const data = (tl(step.data) as Record<string, unknown> | undefined) ?? {};
    const where = (tl(step.where) as Record<string, unknown> | undefined) ?? {};
    try {
      switch (step.operation) {
        case 'create':
          this.services.tables.createTable(
            table,
            (tl(step.columns) as { name: string; type: string }[] | undefined)?.map((c) => ({ name: c.name, type: c.type as never })) ?? []
          );
          return { status: 'ok', output: { created: true } };
        case 'insert':
          return { status: 'ok', output: this.services.tables.insertRow(table, data) };
        case 'query':
          return { status: 'ok', output: this.services.tables.query(table, { where, limit: step.limit }) };
        case 'update':
          if (step.rowid === undefined) throw new Error('update requires rowid');
          this.services.tables.updateRow(table, step.rowid, data);
          return { status: 'ok', output: { updated: true } };
        case 'aggregate':
          return { status: 'ok', output: this.services.tables.aggregate(table, step.fn ?? 'count', step.column, step.groupBy) };
        default:
          throw new Error(`unknown data operation "${String(step.operation)}"`);
      }
    } catch (err) {
      return { status: 'failed', output: null, error: (err as Error).message };
    }
  }

  private execNote(step: Extract<Step, { type: 'note' }>, tl: (v: unknown) => unknown): StepResult {
    try {
      switch (step.operation) {
        case 'create': {
          const note = this.services.notes.createNote(toSafeString(tl(step.title)), toSafeString(tl(step.body)));
          return { status: 'ok', output: note };
        }
        case 'read': {
          const noteId = toSafeString(tl(step.noteId));
          const note = this.services.notes.readNote(noteId);
          if (!note) throw new Error(`note "${noteId}" not found`);
          return { status: 'ok', output: note };
        }
        case 'update': {
          const noteId = toSafeString(tl(step.noteId));
          const note = this.services.notes.updateNote(noteId, {
            title: step.title !== undefined ? toSafeString(tl(step.title)) : undefined,
            body: step.body !== undefined ? toSafeString(tl(step.body)) : undefined,
          });
          return { status: 'ok', output: note };
        }
        case 'search':
          return { status: 'ok', output: this.services.notes.searchNotes(toSafeString(tl(step.query))) };
        case 'list':
          return { status: 'ok', output: this.services.notes.listNotes() };
        default:
          throw new Error(`unknown note operation "${String(step.operation)}"`);
      }
    } catch (err) {
      return { status: 'failed', output: null, error: (err as Error).message };
    }
  }

  private resolveInputs(playbook: Playbook, provided: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const input of playbook.inputs ?? []) {
      const value = provided[input.name] ?? input.default;
      if (input.required && (value === undefined || value === null)) {
        throw new Error(`playbook "${playbook.name}" requires input "${input.name}"`);
      }
      out[input.name] = value;
    }
    return out;
  }

  private resolveVars(vars: Record<string, unknown>, seed: Pick<TemplateContext, 'inputs' | 'secrets'>): Record<string, unknown> {
    const ctx: TemplateContext = { inputs: seed.inputs, secrets: seed.secrets, vars: {}, steps: {} };
    return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, resolveTemplateLoose(v, ctx)]));
  }

  private secretProxy(): Record<string, string> {
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          return resolveSecret(prop);
        },
        has() {
          return true;
        },
      }
    );
  }
}

function recordStepContext(ctx: TemplateContext, stepId: string, result: StepResult): void {
  ctx.steps[stepId] = {
    status: result.status,
    output: result.output,
    ...(typeof result.output === 'object' && result.output !== null && !Array.isArray(result.output)
      ? (result.output as Record<string, unknown>)
      : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
