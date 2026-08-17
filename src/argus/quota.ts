import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { quotasDbPath } from '../core/paths.js';
import { now } from '../core/state.js';

let quotaDb: DatabaseSync | null = null;

/**
 * Opens (or returns the cached handle to) the global quota store, shared by
 * every project and every process on the machine that points at the same
 * FLIGHTDECK_HOME. WAL mode is what already makes concurrent multi-process
 * access to one SQLite file safe elsewhere in this codebase; two `deck argus
 * start` processes in two different projects opening this same file is
 * exactly that case.
 */
export function getQuotaDb(): DatabaseSync {
  if (quotaDb) return quotaDb;
  const dbPath = quotasDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota (
      id TEXT PRIMARY KEY,
      max_tokens INTEGER NOT NULL,
      window_sec INTEGER NOT NULL,
      count_cache_reads INTEGER NOT NULL DEFAULT 1,
      throttled_until INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_usage (
      quota_id TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quota_usage_quota ON quota_usage(quota_id, recorded_at);
  `);
  quotaDb = db;
  return db;
}

/** Test-only: drop the cached handle so a later `getQuotaDb()` reopens the file. */
export function closeQuotaDb(): void {
  if (quotaDb) {
    quotaDb.close();
    quotaDb = null;
  }
}

export interface Quota {
  id: string;
  maxTokens: number;
  windowSec: number;
  countCacheReads: boolean;
  throttledUntil: number | null;
  createdAt: number;
}

function rowToQuota(row: Record<string, unknown>): Quota {
  return {
    id: String(row.id),
    maxTokens: Number(row.max_tokens),
    windowSec: Number(row.window_sec),
    countCacheReads: Number(row.count_cache_reads) === 1,
    throttledUntil: row.throttled_until === null || row.throttled_until === undefined ? null : Number(row.throttled_until),
    createdAt: Number(row.created_at),
  };
}

export interface CreateQuotaOptions {
  maxTokens: number;
  windowSec: number;
  countCacheReads?: boolean;
}

export function createQuota(id: string, opts: CreateQuotaOptions): Quota {
  const db = getQuotaDb();
  const existing = db.prepare('SELECT 1 FROM quota WHERE id = ?').get(id);
  if (existing) throw new Error(`quota "${id}" already exists`);
  db.prepare(
    'INSERT INTO quota (id, max_tokens, window_sec, count_cache_reads, throttled_until, created_at) VALUES (?, ?, ?, ?, NULL, ?)'
  ).run(id, opts.maxTokens, opts.windowSec, opts.countCacheReads === false ? 0 : 1, now());
  return getQuota(id)!;
}

export function getQuota(id: string): Quota | null {
  const row = getQuotaDb().prepare('SELECT * FROM quota WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToQuota(row) : null;
}

export function listQuotas(): Quota[] {
  const rows = getQuotaDb().prepare('SELECT * FROM quota ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(rowToQuota);
}

/** Appends one usage row. Called once per finished brain session attached to this quota. */
export function recordQuotaUsage(quotaId: string, tokens: number): void {
  getQuotaDb()
    .prepare('INSERT INTO quota_usage (quota_id, tokens, recorded_at) VALUES (?, ?, ?)')
    .run(quotaId, tokens, now());
}

export function quotaSpent(quotaId: string, windowSec: number): number {
  const windowStart = now() - windowSec * 1000;
  const row = getQuotaDb()
    .prepare('SELECT COALESCE(SUM(tokens), 0) AS spent FROM quota_usage WHERE quota_id = ? AND recorded_at > ?')
    .get(quotaId, windowStart) as { spent: number };
  return Number(row.spent);
}

/** Oldest in-window usage timestamp, or null when the quota has no usage inside the window. */
export function quotaOldestUsage(quotaId: string, windowSec: number): number | null {
  const windowStart = now() - windowSec * 1000;
  const row = getQuotaDb()
    .prepare('SELECT MIN(recorded_at) AS oldest FROM quota_usage WHERE quota_id = ? AND recorded_at > ?')
    .get(quotaId, windowStart) as { oldest: number | null };
  return row.oldest === null ? null : Number(row.oldest);
}

export function setQuotaThrottle(quotaId: string, throttledUntil: number): void {
  getQuotaDb().prepare('UPDATE quota SET throttled_until = ? WHERE id = ?').run(throttledUntil, quotaId);
}
