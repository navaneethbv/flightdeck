import { describe, it, expect } from 'vitest';
import { getDb } from '../../src/core/state.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo } from '../helpers.js';

function columns(root: string, table: string): string[] {
  const rows = getDb(root).prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  return rows.map((r) => String(r.name));
}

describe('fleet schema', () => {
  it('adds claimed_at to sessions and priority to tasks', () => {
    const fixture = makeRepo();
    try {
      expect(columns(fixture.root, 'sessions')).toContain('claimed_at');
      expect(columns(fixture.root, 'tasks')).toContain('priority');
    } finally {
      fixture.cleanup();
    }
  });

  it('exposes claimedAt as null on a fresh session', () => {
    const fixture = makeRepo();
    try {
      const session = new SessionManager(fixture.root).createSession({
        name: 'w1',
        harness: 'opencode',
        cwd: fixture.root,
      });
      expect(session.claimedAt).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('dispatches higher priority tasks first, then oldest first', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [a, b, c] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
        { title: 'c', spec: 'c', dependsOn: [] },
      ]);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([a.id, b.id, c.id]);

      getDb(fixture.root).prepare('UPDATE tasks SET priority = 5 WHERE id = ?').run(c.id);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([c.id, a.id, b.id]);
      expect(board.get(c.id)?.priority).toBe(5);
    } finally {
      fixture.cleanup();
    }
  });
});
