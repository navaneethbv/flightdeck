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
 * Harnesses wrap their output in prose or code fences even when told not to,
 * so the last balanced JSON object in the stream is taken as the answer. The
 * last one wins because a model that corrects itself puts the correction
 * after the draft.
 */
export function extractJson(stdout: string): unknown {
  const candidates: string[] = [];
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < stdout.length; j++) {
      const ch = stdout[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          candidates.push(stdout.slice(i, j + 1));
          i = j;
          break;
        }
      }
    }
  }
  for (const candidate of candidates.reverse()) {
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

import crypto from 'node:crypto';
import { getDb } from '../core/state.js';
import { SessionManager } from '../sessions/manager.js';
import type { HarnessKind } from '../core/types.js';

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
  const argus = getDb(projectRoot)
    .prepare('SELECT brain_harness FROM argus WHERE id = ?')
    .get(argusId) as { brain_harness?: string } | undefined;
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
    waitForExit: true,
    model: opts.model ?? undefined,
    onStdout: (chunk) => {
      stdout += chunk;
    },
    env: opts.env,
  });
  return stdout;
}
