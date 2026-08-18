import { z } from 'zod';
import type { TaskDraft } from './board.js';

export interface Verdict {
  taskId: string;
  verdict: 'accept' | 'revise' | 'need_files';
  reason: string | null;
  paths: string[];
}

export const PlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        spec: z.string().min(1),
        depends_on: z.array(z.number().int().nonnegative()).default([]),
      })
    )
    .min(1),
});

export const ReviewSchema = z.object({
  verdicts: z.array(
    z.object({
      task_id: z.string().min(1),
      verdict: z.enum(['accept', 'revise', 'need_files']),
      reason: z.string().nullish(),
      paths: z.array(z.string()).default([]),
    })
  ),
});

export const AnswerSchema = z.object({
  answer: z.string().min(1),
  faq_key: z.string().min(1),
});

/**
 * Scans for a balanced JSON object starting at `start`, returning the index of
 * the closing brace, or -1 if no balanced object is found.
 */
function balancedObjectEnd(stdout: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let j = start; j < stdout.length; j++) {
    const ch = stdout[j];
    if (ch === '\\') {
      // Skip the escaped character so a \" or \\ inside a string is not
      // mistaken for structure.
      j++;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Collects every balanced JSON object in the stream, outermost first. Scanning
 * resumes just past each found object, so a nested object is never treated as
 * a candidate of its own.
 */
function collectJsonCandidates(stdout: string): string[] {
  const candidates: string[] = [];
  let i = 0;
  while (i < stdout.length) {
    if (stdout[i] !== '{') {
      i++;
      continue;
    }
    const end = balancedObjectEnd(stdout, i);
    if (end === -1) {
      i++;
      continue;
    }
    candidates.push(stdout.slice(i, end + 1));
    i = end + 1;
  }
  return candidates;
}

/**
 * Harnesses wrap their output in prose or code fences even when told not to,
 * so the last balanced JSON object in the stream is taken as the answer. The
 * last one wins because a model that corrects itself puts the correction
 * after the draft.
 */
export function extractJson(stdout: string): unknown {
  const candidates = collectJsonCandidates(stdout);
  for (const candidate of candidates.toReversed()) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('brain output contained no JSON object');
}

export function parsePlan(stdout: string): TaskDraft[] {
  const parsed = PlanSchema.parse(extractJson(stdout));
  return parsed.tasks.map((t) => ({
    title: t.title,
    spec: t.spec,
    dependsOn: t.depends_on,
  }));
}

export function parseReview(stdout: string): Verdict[] {
  const parsed = ReviewSchema.parse(extractJson(stdout));
  return parsed.verdicts.map((v) => ({
    taskId: v.task_id,
    verdict: v.verdict,
    reason: v.reason ?? null,
    paths: v.paths,
  }));
}

export function parseAnswer(stdout: string): { answer: string; faqKey: string } {
  const parsed = AnswerSchema.parse(extractJson(stdout));
  return { answer: parsed.answer, faqKey: parsed.faq_key };
}

/**
 * Thrown after a brain call produced malformed output twice, so callers reach
 * a visible terminal state instead of looping against a broken model.
 */
export class BrainContractError extends Error {
  constructor(
    readonly label: string,
    readonly causeMessage: string
  ) {
    super(`brain ${label} output was malformed twice: ${causeMessage}`);
    this.name = 'BrainContractError';
  }
}

/**
 * Thrown when a brain call's output matches a real provider rate limit,
 * detected by the harness adapter. Distinct from BrainContractError: this is
 * not malformed output, it is a live external throttle, so the caller must
 * leave the affected task or question exactly as it was rather than
 * escalating toward blocked or abandoned.
 */
export class BrainThrottledError extends Error {
  constructor(
    readonly label: string,
    readonly backoffMs: number
  ) {
    super(`brain ${label} call was rate-limited by the provider; backing off ${backoffMs}ms`);
    this.name = 'BrainThrottledError';
  }
}

/**
 * Every requested task in a batch must receive exactly one verdict. Semantic
 * failures like this get the same single correction attempt as invalid JSON,
 * so a hallucinated task id cannot silently skip or duplicate a decision.
 */
export function validateReviewCoverage(tasks: { id: string }[], verdicts: Verdict[]): Verdict[] {
  const expected = new Set(tasks.map((task) => task.id));
  const seen = new Set<string>();
  for (const verdict of verdicts) {
    if (!expected.has(verdict.taskId)) throw new Error(`unexpected task id ${verdict.taskId}`);
    if (seen.has(verdict.taskId)) throw new Error(`duplicate verdict for ${verdict.taskId}`);
    seen.add(verdict.taskId);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`missing verdicts for ${missing.join(', ')}`);
  return verdicts;
}

import crypto from 'node:crypto';
import { getDb } from '../core/state.js';
import { SessionManager } from '../sessions/manager.js';
import type { HarnessKind } from '../core/types.js';
import { getQuota, recordQuotaUsage } from './quota.js';

export interface BrainInvocation {
  prompt: string;
  /** Null means the harness default model. */
  model: string | null;
  /** Short label used in the session name, for example "plan" or "review". */
  label: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs one brain call as its own short-lived `policy: 'brain'` session.
 *
 * Each invocation being a separate session is load-bearing: it makes budget
 * accounting a plain sum over `session_telemetry` inside the window, and it
 * guarantees the brain can never satisfy the `isManager` check, which
 * requires `policy === 'manager'`.
 */
export async function invokeBrain(
  projectRoot: string,
  argusId: string,
  opts: BrainInvocation
): Promise<string> {
  const db = getDb(projectRoot);
  const argus = db
    .prepare('SELECT brain_harness, quota_id, budget_count_cache_reads FROM argus WHERE id = ?')
    .get(argusId) as
    | { brain_harness?: string; quota_id?: string | null; budget_count_cache_reads?: number }
    | undefined;
  if (!argus) throw new Error(`argus "${argusId}" not found`);

  const manager = new SessionManager(projectRoot);
  const session = manager.createSession({
    name: `brain-${opts.label}-${crypto.randomUUID().slice(0, 6)}`,
    harness: (argus.brain_harness ?? 'claude') as HarnessKind,
    cwd: projectRoot,
    policy: 'brain',
    argusParent: argusId,
  });

  let stdout = '';
  await manager.startSession(session.id, {
    headless: true,
    prompt: opts.prompt,
    autonomy: true,
    waitForExit: true,
    model: opts.model ?? undefined,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    env: opts.env,
  });

  if (argus.quota_id) {
    const telemetry = db
      .prepare('SELECT input_tokens, output_tokens, cached_tokens FROM session_telemetry WHERE session_id = ?')
      .get(session.id) as
      | { input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null }
      | undefined;
    if (telemetry) {
      // The attached quota owns its own countCacheReads setting, set via
      // `deck quota create --no-count-cache-reads`; the mission's own
      // budget_count_cache_reads only applies to a private, unquota'd budget.
      const quota = getQuota(argus.quota_id);
      const countCache = quota ? quota.countCacheReads : Number(argus.budget_count_cache_reads) === 1;
      const tokens =
        (telemetry.input_tokens ?? 0) + (telemetry.output_tokens ?? 0) + (countCache ? telemetry.cached_tokens ?? 0 : 0);
      recordQuotaUsage(argus.quota_id, tokens);
    }
  }

  return stdout;
}
