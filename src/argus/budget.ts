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
  /** Number of tasks sitting in the review queue right now. */
  reviewQueueDepth: number;
  /** Age in seconds of the oldest queued task, or null when the queue is empty. */
  oldestReviewAgeSec: number | null;
  /**
   * Wall-clock time when the oldest in-window brain session rolls out of the
   * window, or null when no in-window usage exists. A rolling window never
   * resets all at once, so this is a projection, not a full-budget reset.
   */
  nextResetAt: number | null;
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

/**
 * Decides how many queued tasks one brain review call should cover.
 *
 * A forced review may ignore the batching and the 95 percent pause but never
 * the ceiling, so the budget that protects the rate limit cannot be silently
 * exceeded by a human override.
 */
export function reviewBatchSize(
  budget: BudgetState,
  queuedCount: number,
  oldestAgeMs: number,
  force: boolean
): number {
  if (force) {
    if (budget.spent >= budget.ceiling) throw new Error('brain budget exhausted for this window');
    return queuedCount;
  }
  if (!budget.policy.reviewsAllowed) return 0;
  if (budget.tier === 'normal') return Math.min(1, queuedCount);
  if (budget.tier === 'conserve') return Math.min(4, queuedCount);
  if (queuedCount >= 4 || oldestAgeMs >= 30 * 60_000) return queuedCount;
  return 0;
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

  const oldest = db
    .prepare(
      'SELECT MIN(started_at) AS started FROM sessions WHERE policy = ? AND argus_parent = ? AND started_at > ?'
    )
    .get(...(['brain', argusId, windowStart] as SQLInputValue[])) as { started: number | null };

  const queued = db
    .prepare(
      'SELECT COUNT(*) AS n, MIN(COALESCE(review_queued_at, created_at)) AS oldest FROM tasks WHERE argus_id = ? AND status = ?'
    )
    .get(...([argusId, 'in_review'] as SQLInputValue[])) as { n: number; oldest: number | null };

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
    reviewQueueDepth: Number(queued.n),
    oldestReviewAgeSec: queued.oldest === null ? null : Math.max(0, (now() - queued.oldest) / 1000),
    nextResetAt: oldest.started === null ? null : oldest.started + Number(argus.budget_window_sec) * 1000,
  };
}
