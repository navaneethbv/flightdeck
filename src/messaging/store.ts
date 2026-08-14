import { getDb, now } from '../core/state.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface Message {
  id: number;
  fromSession: string;
  toSession: string | null;
  body: string;
  createdAt: number;
  readAt: number | null;
}

export class MessagingStore {
  private db: DatabaseSync;

  constructor(private readonly projectRoot: string) {
    this.db = getDb(projectRoot);
  }

  send(fromSession: string, toSession: string | null, body: string): Message {
    const result = this.db
      .prepare('INSERT INTO messages (from_session, to_session, body, created_at) VALUES (?, ?, ?, ?)')
      .run(fromSession, toSession, body, now());
    return {
      id: Number(result.lastInsertRowid),
      fromSession,
      toSession,
      body,
      createdAt: now(),
      readAt: null,
    };
  }

  list(opts: { from?: string; to?: string; limit?: number } = {}): Message[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      clauses.push('from_session = ?');
      params.push(opts.from);
    }
    if (opts.to) {
      clauses.push('to_session = ?');
      params.push(opts.to);
    }
    let sql = 'SELECT * FROM messages';
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY id DESC';
    const limit = opts.limit ?? 100;
    sql += ` LIMIT ${Math.max(1, Math.floor(limit))}`;
    const rows = this.db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
    return rows.reverse().map(rowToMessage);
  }

  poll(to: string, sinceId: number): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE to_session = ? AND id > ? AND read_at IS NULL ORDER BY id ASC')
      .all(...([to, sinceId] as SQLInputValue[])) as Record<string, unknown>[];
    const nowTs = now();
    for (const row of rows) {
      if (row.read_at === null) {
        this.db.prepare('UPDATE messages SET read_at = ? WHERE id = ?').run(nowTs, row.id as SQLInputValue);
      }
    }
    return rows.map(rowToMessage);
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: Number(row.id),
    fromSession: String(row.from_session),
    toSession: row.to_session === null ? null : String(row.to_session),
    body: String(row.body),
    createdAt: Number(row.created_at),
    readAt: row.read_at === null ? null : Number(row.read_at),
  };
}
