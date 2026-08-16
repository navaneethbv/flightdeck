import { describe, it, expect } from 'vitest';
import {
  classifyTier,
  tierPolicy,
  budgetState,
  reviewBatchSize,
  type BudgetState,
  type BudgetTier,
} from '../../src/argus/budget.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

function fixtureBudget(tier: BudgetTier, spent: number, ceiling: number): BudgetState {
  return {
    spent,
    ceiling,
    fraction: ceiling > 0 ? spent / ceiling : 1,
    tier,
    policy: tierPolicy(tier),
    questionsAllowed: spent < ceiling,
    windowStart: now() - 3600 * 1000,
    reviewQueueDepth: 0,
    oldestReviewAgeSec: null,
    nextResetAt: null,
  };
}

describe('classifyTier', () => {
  it('maps each ladder boundary to the correct tier', () => {
    expect(classifyTier(0)).toBe('normal');
    expect(classifyTier(0.599)).toBe('normal');
    expect(classifyTier(0.6)).toBe('conserve');
    expect(classifyTier(0.799)).toBe('conserve');
    expect(classifyTier(0.8)).toBe('batch');
    expect(classifyTier(0.949)).toBe('batch');
    expect(classifyTier(0.95)).toBe('paused');
    expect(classifyTier(1.5)).toBe('paused');
  });
});

describe('tierPolicy', () => {
  it('disables tier 2 above the conserve threshold', () => {
    expect(tierPolicy('normal').tier2Allowed).toBe(true);
    expect(tierPolicy('conserve').tier2Allowed).toBe(false);
    expect(tierPolicy('batch').tier2Allowed).toBe(false);
    expect(tierPolicy('paused').tier2Allowed).toBe(false);
  });

  it('widens the review batch as spend climbs', () => {
    expect(tierPolicy('normal').batchSize).toBe(1);
    expect(tierPolicy('conserve').batchSize).toBe(4);
    expect(tierPolicy('batch').batchSize).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('stops reviews only at the paused tier', () => {
    expect(tierPolicy('batch').reviewsAllowed).toBe(true);
    expect(tierPolicy('paused').reviewsAllowed).toBe(false);
  });
});

/** Inserts a finished brain session with the given usage. */
function seedBrainSpend(
  root: string,
  argusId: string,
  opts: { input: number; output: number; cached?: number; startedAt: number }
): void {
  const db = getDb(root);
  const id = `brain-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES (?, ?, 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
  ).run(id, id, root, root, argusId, opts.startedAt, opts.startedAt);
  db.prepare(
    'INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, cached_tokens, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, opts.input, opts.output, opts.cached ?? 0, opts.startedAt);
}

describe('budgetState', () => {
  it('sums only brain sessions inside the window', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      db.prepare(
        "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, budget_window_sec, budget_max_tokens) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 3600, 1000)"
      ).run(fixture.root, now());

      seedBrainSpend(fixture.root, 'a1', { input: 100, output: 100, startedAt: now() });
      // Outside the window, must be excluded.
      seedBrainSpend(fixture.root, 'a1', {
        input: 5000,
        output: 5000,
        startedAt: now() - 7200 * 1000,
      });

      const state = budgetState(fixture.root, 'a1');
      expect(state.spent).toBe(200);
      expect(state.ceiling).toBe(1000);
      expect(state.fraction).toBeCloseTo(0.2);
      expect(state.tier).toBe('normal');
    } finally {
      fixture.cleanup();
    }
  });

  it('counts cache reads at full weight by default', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      db.prepare(
        "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, budget_window_sec, budget_max_tokens, budget_count_cache_reads) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 3600, 1000, 1)"
      ).run(fixture.root, now());
      seedBrainSpend(fixture.root, 'a1', { input: 100, output: 100, cached: 700, startedAt: now() });

      const state = budgetState(fixture.root, 'a1');
      expect(state.spent).toBe(900);
      expect(state.tier).toBe('batch');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('reviewBatchSize', () => {
  it('decides the drain batch from tier, queue age, and force', () => {
    const normal = fixtureBudget('normal', 0, 1_000_000);
    const conserve = fixtureBudget('conserve', 700_000, 1_000_000);
    const batch = fixtureBudget('batch', 850_000, 1_000_000);
    const pausedBelowCeiling = fixtureBudget('paused', 960_000, 1_000_000);
    const atCeiling = fixtureBudget('paused', 1_000_000, 1_000_000);

    expect(reviewBatchSize(normal, 1, 0, false)).toBe(1);
    expect(reviewBatchSize(conserve, 7, 0, false)).toBe(4);
    expect(reviewBatchSize(batch, 3, 31 * 60_000, false)).toBe(3);
    expect(reviewBatchSize(batch, 3, 29 * 60_000, false)).toBe(0);
    expect(reviewBatchSize(batch, 4, 1_000, false)).toBe(4);
    expect(reviewBatchSize(pausedBelowCeiling, 8, 1_000, false)).toBe(0);
    expect(reviewBatchSize(pausedBelowCeiling, 8, 1_000, true)).toBe(8);
    expect(() => reviewBatchSize(atCeiling, 8, 1_000, true)).toThrow(/exhausted/);
  });
});
