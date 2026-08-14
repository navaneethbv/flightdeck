import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateDbPath, normalizeProjectRoot } from './paths.js';

const dbCache = new Map<string, DatabaseSync>();

export function randomToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function getDb(projectRoot: string): DatabaseSync {
  const real = normalizeProjectRoot(projectRoot);
  const cached = dbCache.get(real);
  if (cached) return cached;
  const dbPath = stateDbPath(real);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  dbCache.set(real, db);
  return db;
}

export function closeDb(projectRoot: string): void {
  const db = dbCache.get(normalizeProjectRoot(projectRoot));
  if (db) {
    db.close();
    dbCache.delete(normalizeProjectRoot(projectRoot));
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      harness TEXT NOT NULL,
      project_root TEXT NOT NULL,
      worktree TEXT,
      cwd TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'stopped',
      token TEXT NOT NULL,
      policy TEXT NOT NULL DEFAULT 'default',
      argus_parent TEXT,
      task TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      last_activity_at INTEGER NOT NULL,
      exit_code INTEGER
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(note_id, version)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(note_id UNINDEXED, title, body);

    CREATE TABLE IF NOT EXISTS flightdeck_tables (
      name TEXT PRIMARY KEY,
      schema_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_session TEXT NOT NULL,
      to_session TEXT,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS argus (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_root TEXT NOT NULL,
      mission_note_id TEXT,
      cap TEXT NOT NULL,
      child_limit INTEGER NOT NULL,
      pulse_sec INTEGER NOT NULL,
      risky_tools INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'stopped',
      manager_session_id TEXT,
      created_at INTEGER NOT NULL,
      last_pulse_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS integration_cache (
      cache_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_hosts (
      name TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      port INTEGER,
      user TEXT,
      auth TEXT NOT NULL DEFAULT 'agent',
      key_file TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_root);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_session);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session);
    CREATE INDEX IF NOT EXISTS idx_argus_project ON argus(project_root);
    CREATE INDEX IF NOT EXISTS idx_cache_kind ON integration_cache(kind);
  `);
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN task TEXT;');
  } catch {
    // column already exists
  }
}

export function now(): number {
  return Date.now();
}
