import { getDb, now } from '../core/state.js';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type ColumnType = 'text' | 'number' | 'boolean' | 'date';

export interface ColumnDef {
  name: string;
  type: ColumnType;
  relation?: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnDef[];
  idempotencyKey: string | null;
  createdAt: number;
}

const VALID_IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

function checkIdent(name: string, what: string): void {
  if (!VALID_IDENT.test(name)) {
    throw new Error(`invalid ${what} "${name}"`);
  }
}

function sqlType(type: ColumnType): string {
  switch (type) {
    case 'number':
      return 'REAL';
    case 'boolean':
      return 'INTEGER';
    case 'date':
      return 'TEXT';
    default:
      return 'TEXT';
  }
}

function tableSqlName(name: string): string {
  return `t_${name}`;
}

function coerce(value: unknown, type: ColumnType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) throw new Error(`value ${JSON.stringify(value)} is not a number`);
      return n;
    }
    case 'boolean':
      return value === true || value === 1 || value === 'true' || value === '1' ? 1 : 0;
    case 'date': {
      if (value instanceof Date) return value.toISOString();
      return String(value);
    }
    default:
      return String(value);
  }
}

export class TablesStore {
  private db: DatabaseSync;

  constructor(private readonly projectRoot: string) {
    this.db = getDb(projectRoot);
  }

  createTable(name: string, columns: ColumnDef[], idempotencyKey?: string): TableInfo {
    checkIdent(name, 'table name');
    const names = new Set<string>();
    for (const col of columns) {
      checkIdent(col.name, 'column name');
      if (names.has(col.name)) throw new Error(`duplicate column "${col.name}"`);
      names.add(col.name);
      if (col.relation) checkIdent(col.relation, 'relation');
    }
    if (idempotencyKey) {
      checkIdent(idempotencyKey, 'idempotency key');
      if (!names.has(idempotencyKey)) throw new Error(`idempotency key "${idempotencyKey}" is not a column`);
    }
    const existing = this.db.prepare('SELECT name FROM flightdeck_tables WHERE name = ?').get(name);
    if (existing) throw new Error(`table "${name}" already exists`);

    const cols = columns
      .map((c) => `"${c.name}" ${sqlType(c.type)}`)
      .concat('created_at INTEGER NOT NULL', 'updated_at INTEGER NOT NULL');
    this.db.exec(`CREATE TABLE "${tableSqlName(name)}" (rowid INTEGER PRIMARY KEY AUTOINCREMENT, ${cols.join(', ')})`);
    this.db.prepare('INSERT INTO flightdeck_tables (name, schema_json, idempotency_key, created_at) VALUES (?, ?, ?, ?)').run(
      name,
      JSON.stringify(columns),
      idempotencyKey ?? null,
      now()
    );
    if (idempotencyKey) {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${name}_idem ON "${tableSqlName(name)}" ("${idempotencyKey}")`);
    }
    return { name, columns, idempotencyKey: idempotencyKey ?? null, createdAt: now() };
  }

  listTables(): TableInfo[] {
    const rows = this.db.prepare('SELECT * FROM flightdeck_tables ORDER BY created_at').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      name: String(r.name),
      columns: JSON.parse(String(r.schema_json)) as ColumnDef[],
      idempotencyKey: r.idempotency_key === null ? null : String(r.idempotency_key),
      createdAt: Number(r.created_at),
    }));
  }

  getTable(name: string): TableInfo | null {
    return this.listTables().find((t) => t.name === name) ?? null;
  }

  private assertTable(name: string): TableInfo {
    const table = this.getTable(name);
    if (!table) throw new Error(`table "${name}" not found`);
    return table;
  }

  insertRow(name: string, data: Record<string, unknown>): { rowid: number; existing: boolean } {
    const table = this.assertTable(name);
    const sqlName = tableSqlName(name);
    if (table.idempotencyKey && data[table.idempotencyKey] !== undefined) {
      const existing = this.db
        .prepare(`SELECT rowid FROM "${sqlName}" WHERE "${table.idempotencyKey}" = ?`)
        .get(coerce(data[table.idempotencyKey], table.columns.find((c) => c.name === table.idempotencyKey)?.type ?? 'text') as SQLInputValue);
      if (existing) {
        return { rowid: Number((existing as { rowid: number }).rowid), existing: true };
      }
    }
    const values: Record<string, unknown> = {};
    for (const col of table.columns) {
      if (col.name in data) values[col.name] = coerce(data[col.name], col.type);
    }
    const ts = now();
    const allCols = [...table.columns.map((c) => c.name), 'created_at', 'updated_at'];
    const colList = allCols.map((c) => `"${c}"`).join(', ');
    const placeholders = allCols.map(() => '?').join(', ');
    const rowValues: SQLInputValue[] = [...table.columns.map((c) => (values[c.name] ?? null) as SQLInputValue), ts, ts];
    const result = this.db
      .prepare(`INSERT INTO "${sqlName}" (${colList}) VALUES (${placeholders})`)
      .run(...rowValues);
    return { rowid: Number(result.lastInsertRowid), existing: false };
  }

  query(
    name: string,
    opts: { where?: Record<string, unknown>; limit?: number; orderBy?: { col: string; dir?: 'asc' | 'desc' } } = {}
  ): Record<string, unknown>[] {
    const table = this.assertTable(name);
    const sqlName = tableSqlName(name);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.where) {
      for (const [key, value] of Object.entries(opts.where)) {
        if (!table.columns.some((c) => c.name === key)) throw new Error(`unknown column "${key}"`);
        clauses.push(`"${key}" = ?`);
        params.push(value);
      }
    }
    let sql = `SELECT rowid, * FROM "${sqlName}"`;
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    if (opts.orderBy) {
      checkIdent(opts.orderBy.col, 'column');
      sql += ` ORDER BY "${opts.orderBy.col}" ${opts.orderBy.dir === 'asc' ? 'ASC' : 'DESC'}`;
    }
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${Math.max(1, Math.floor(opts.limit))}`;
    }
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as Record<string, unknown>[];
  }

  updateRow(name: string, rowid: number, data: Record<string, unknown>): void {
    const table = this.assertTable(name);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const col of table.columns) {
      if (col.name in data) {
        sets.push(`"${col.name}" = ?`);
        params.push(coerce(data[col.name], col.type));
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(now(), rowid);
    this.db
      .prepare(`UPDATE "${tableSqlName(name)}" SET ${sets.join(', ')} WHERE rowid = ?`)
      .run(...(params as SQLInputValue[]));
  }

  aggregate(
    name: string,
    fn: 'count' | 'sum' | 'avg' | 'min' | 'max',
    column?: string,
    groupBy?: string
  ): Record<string, unknown>[] {
    const table = this.assertTable(name);
    if (fn !== 'count' && !column) throw new Error(`aggregate "${fn}" requires a column`);
    if (column) {
      checkIdent(column, 'column');
      if (!table.columns.some((c) => c.name === column)) throw new Error(`unknown column "${column}"`);
    }
    if (groupBy) {
      checkIdent(groupBy, 'column');
      if (!table.columns.some((c) => c.name === groupBy)) throw new Error(`unknown column "${groupBy}"`);
    }
    const target = column ? `"${column}"` : '*';
    const sql = groupBy
      ? `SELECT "${groupBy}" AS group_value, ${fn}(${target}) AS value FROM "${tableSqlName(name)}" GROUP BY "${groupBy}"`
      : `SELECT ${fn}(${target}) AS value FROM "${tableSqlName(name)}"`;
    return this.db.prepare(sql).all() as Record<string, unknown>[];
  }

  dropTable(name: string): void {
    const table = this.assertTable(name);
    this.db.exec(`DROP TABLE IF EXISTS "${tableSqlName(name)}"`);
    this.db.prepare('DELETE FROM flightdeck_tables WHERE name = ?').run(name);
    void table;
  }
}
