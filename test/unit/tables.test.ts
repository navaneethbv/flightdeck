import { describe, it, expect } from 'vitest';
import { TablesStore } from '../../src/tables/store.js';
import { makeRepo } from '../helpers.js';

describe('TablesStore', () => {
  it('creates a table and enforces typed inserts', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('tasks', [
        { name: 'title', type: 'text' },
        { name: 'priority', type: 'number' },
        { name: 'done', type: 'boolean' },
      ]);
      store.insertRow('tasks', { title: 'fix bug', priority: 1, done: false });
      store.insertRow('tasks', { title: 'ship feature', priority: 2, done: true });
      const rows = store.query('tasks');
      expect(rows).toHaveLength(2);
      expect(rows[0].priority).toBe(1);
      expect(rows[1].done).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('queries with equality filters and ordering', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('tasks', [{ name: 'status', type: 'text' }, { name: 'rank', type: 'number' }]);
      store.insertRow('tasks', { status: 'open', rank: 1 });
      store.insertRow('tasks', { status: 'closed', rank: 2 });
      store.insertRow('tasks', { status: 'open', rank: 3 });

      const open = store.query('tasks', { where: { status: 'open' }, orderBy: { col: 'rank', dir: 'desc' } });
      expect(open.map((r) => r.rank)).toEqual([3, 1]);

      const limited = store.query('tasks', { where: { status: 'open' }, limit: 1 });
      expect(limited).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('idempotency key prevents duplicate inserts', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('events', [{ name: 'key', type: 'text' }], 'key');
      store.insertRow('events', { key: 'abc' });
      store.insertRow('events', { key: 'abc' });
      expect(store.query('events')).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('aggregates', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('sales', [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }]);
      store.insertRow('sales', { region: 'west', amount: 10 });
      store.insertRow('sales', { region: 'west', amount: 20 });
      store.insertRow('sales', { region: 'east', amount: 5 });
      const grouped = store.aggregate('sales', 'sum', 'amount', 'region');
      expect(grouped).toHaveLength(2);
      const west = grouped.find((r) => r.group_value === 'west');
      expect(west?.value).toBe(30);
      const total = store.aggregate('sales', 'avg', 'amount');
      expect(total[0].value).toBeCloseTo(11.6667, 3);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects duplicate table names and bad identifiers', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('t1', [{ name: 'a', type: 'text' }]);
      expect(() => store.createTable('t1', [{ name: 'b', type: 'text' }])).toThrow(/already exists/);
      expect(() => store.createTable('bad-name', [{ name: 'a', type: 'text' }])).toThrow(/invalid table name/);
      expect(() => store.createTable('t2', [{ name: 'bad-col', type: 'text' }])).toThrow(/invalid column name/);
    } finally {
      fixture.cleanup();
    }
  });

  it('lists and drops tables', () => {
    const fixture = makeRepo();
    try {
      const store = new TablesStore(fixture.root);
      store.createTable('tbl1', [{ name: 'x', type: 'text' }]);
      store.createTable('tbl2', [{ name: 'y', type: 'number' }]);
      const list = store.listTables();
      expect(list.map((t) => t.name)).toContain('tbl1');
      expect(list.map((t) => t.name)).toContain('tbl2');

      store.dropTable('tbl1');
      expect(store.listTables().map((t) => t.name)).not.toContain('tbl1');
      expect(() => store.query('tbl1')).toThrow(/not found/);
    } finally {
      fixture.cleanup();
    }
  });
});
