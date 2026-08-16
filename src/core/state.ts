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
      exit_code INTEGER,
      claimed_at INTEGER
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
      last_pulse_at INTEGER,
      conventions_note_id TEXT
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

    CREATE TABLE IF NOT EXISTS session_telemetry (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_tokens INTEGER,
      cost_usd REAL,
      turns INTEGER,
      progress INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      argus_id TEXT NOT NULL,
      title TEXT NOT NULL,
      spec TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee_session TEXT,
      depends_on TEXT NOT NULL DEFAULT '[]',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_report TEXT,
      gate_result TEXT,
      diffstat TEXT,
      verdict TEXT,
      verdict_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      argus_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      faq_key TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_root);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_session);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_session);
    CREATE INDEX IF NOT EXISTS idx_argus_project ON argus(project_root);
    CREATE INDEX IF NOT EXISTS idx_cache_kind ON integration_cache(kind);
    CREATE INDEX IF NOT EXISTS idx_tasks_argus ON tasks(argus_id, status);
    CREATE INDEX IF NOT EXISTS idx_questions_argus ON questions(argus_id, answered_at);
  `);
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN task TEXT;');
  } catch {
    // column already exists
  }
  const argusColumns = [
    "brain_harness TEXT NOT NULL DEFAULT 'claude'",
    'brain_plan_model TEXT',
    'brain_review_model TEXT',
    `worker_harnesses TEXT NOT NULL DEFAULT '["opencode"]'`,
    'budget_window_sec INTEGER NOT NULL DEFAULT 18000',
    'budget_max_tokens INTEGER NOT NULL DEFAULT 1000000',
    'budget_count_cache_reads INTEGER NOT NULL DEFAULT 1',
    'max_attempts_per_task INTEGER NOT NULL DEFAULT 3',
    'max_tasks INTEGER NOT NULL DEFAULT 100',
    'question_timeout_sec INTEGER NOT NULL DEFAULT 120',
    'conventions_note_id TEXT',
  ];
  for (const col of argusColumns) {
    try {
      db.exec(`ALTER TABLE argus ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
  const lateColumns: [string, string][] = [
    ['sessions', 'claimed_at INTEGER'],
    ['tasks', 'priority INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, col] of lateColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
}

export function now(): number {
  return Date.now();
}
