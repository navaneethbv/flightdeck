import type { SQLInputValue } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';

export type BudgetTier = 'normal' | 'conserve' | 'batch' | 'paused';

export interface TierPolicy {
  /** Whether the brain may pull actual file contents during review. */
  tier2Allowed: boolean;
  /** How many tasks to review in one brain invocation. */
  batchSize: number;
  /** Whether the review queue may drain at all. */
  reviewsAllowed: boolean;
}

export interface BudgetState {
  spent: number;
  ceiling: number;
  fraction: number;
  tier: BudgetTier;
  policy: TierPolicy;
  /**
   * Questions stay answerable in the band between the review pause and the
   * ceiling, so a heavy review batch cannot starve `ask_manager`.
   */
  questionsAllowed: boolean;
  windowStart: number;
}

export function classifyTier(fraction: number): BudgetTier {
  if (fraction < 0.6) return 'normal';
  if (fraction < 0.8) return 'conserve';
  if (fraction < 0.95) return 'batch';
  return 'paused';
}

export function tierPolicy(tier: BudgetTier): TierPolicy {
  switch (tier) {
    case 'normal':
      return { tier2Allowed: true, batchSize: 1, reviewsAllowed: true };
    case 'conserve':
      return { tier2Allowed: false, batchSize: 4, reviewsAllowed: true };
    case 'batch':
      return { tier2Allowed: false, batchSize: Number.MAX_SAFE_INTEGER, reviewsAllowed: true };
    case 'paused':
      return { tier2Allowed: false, batchSize: 0, reviewsAllowed: false };
  }
}

export function budgetState(projectRoot: string, argusId: string): BudgetState {
  const root = normalizeProjectRoot(projectRoot);
  const db = getDb(root);
  const argus = db
    .prepare(
      'SELECT budget_window_sec, budget_max_tokens, budget_count_cache_reads FROM argus WHERE id = ?'
    )
    .get(argusId) as Record<string, unknown> | undefined;
  if (!argus) throw new Error(`argus "${argusId}" not found`);

  const ceiling = Number(argus.budget_max_tokens);
  const windowStart = now() - Number(argus.budget_window_sec) * 1000;
  const countCache = Number(argus.budget_count_cache_reads) === 1;

  const cacheTerm = countCache ? ' + COALESCE(t.cached_tokens, 0)' : '';
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0)${cacheTerm}), 0) AS spent
       FROM session_telemetry t
       JOIN sessions s ON s.id = t.session_id
       WHERE s.policy = 'brain' AND s.argus_parent = ? AND s.started_at > ?`
    )
    .get(...([argusId, windowStart] as SQLInputValue[])) as { spent: number };

  const spent = Number(row.spent);
  const fraction = ceiling > 0 ? spent / ceiling : 1;
  const tier = classifyTier(fraction);
  return {
    spent,
    ceiling,
    fraction,
    tier,
    policy: tierPolicy(tier),
    questionsAllowed: spent < ceiling,
    windowStart,
  };
}
