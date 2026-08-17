import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  createQuota,
  getQuota,
  listQuotas,
  recordQuotaUsage,
  quotaSpent,
  quotaOldestUsage,
  setQuotaThrottle,
} from '../../src/argus/quota.js';

function freshId(): string {
  return `quota-${crypto.randomUUID().slice(0, 8)}`;
}

describe('quota store', () => {
  it('creates and reads back a quota', () => {
    const id = freshId();
    const created = createQuota(id, { maxTokens: 1_000_000, windowSec: 7200 });
    expect(created).toMatchObject({ id, maxTokens: 1_000_000, windowSec: 7200, countCacheReads: true, throttledUntil: null });
    expect(getQuota(id)).toMatchObject({ id, maxTokens: 1_000_000 });
  });

  it('rejects creating the same quota id twice', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 60 });
    expect(() => createQuota(id, { maxTokens: 2000, windowSec: 60 })).toThrow(/already exists/);
  });

  it('returns null for an unknown quota', () => {
    expect(getQuota(freshId())).toBeNull();
  });

  it('lists every created quota', () => {
    const a = freshId();
    const b = freshId();
    createQuota(a, { maxTokens: 1000, windowSec: 60 });
    createQuota(b, { maxTokens: 2000, windowSec: 60 });
    const ids = listQuotas().map((q) => q.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
  });

  it('sums usage inside the window and ignores usage outside it', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    recordQuotaUsage(id, 100);
    recordQuotaUsage(id, 50);
    expect(quotaSpent(id, 3600)).toBe(150);
    // A window of zero seconds excludes usage recorded just now.
    expect(quotaSpent(id, 0)).toBe(0);
  });

  it('reports the oldest in-window usage timestamp, or null when empty', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    expect(quotaOldestUsage(id, 3600)).toBeNull();
    const before = Date.now();
    recordQuotaUsage(id, 10);
    const oldest = quotaOldestUsage(id, 3600);
    expect(oldest).not.toBeNull();
    expect(oldest as number).toBeGreaterThanOrEqual(before);
  });

  it('sets and reads a throttle timestamp', () => {
    const id = freshId();
    createQuota(id, { maxTokens: 1000, windowSec: 3600 });
    const until = Date.now() + 60_000;
    setQuotaThrottle(id, until);
    expect(getQuota(id)?.throttledUntil).toBe(until);
  });
});
