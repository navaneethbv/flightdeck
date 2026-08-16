import { describe, it, expect } from 'vitest';
import { Override } from '../../src/argus/override.js';
import { TaskBoard } from '../../src/argus/board.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TablesStore } from '../../src/tables/store.js';
import { makeRepo } from '../helpers.js';

describe('Override', () => {
  it('forces a task to done regardless of the brain', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      new Override(fixture.root).acceptTask(task.id);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('forces a task back to revising with a human reason', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      new Override(fixture.root).rejectTask(task.id, 'missing migration');
      const updated = board.get(task.id);
      expect(updated?.status).toBe('revising');
      expect(updated?.verdictReason).toContain('missing migration');
    } finally {
      fixture.cleanup();
    }
  });

  it('unblocks a task and resets its attempts', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.toRevising(task.id, 'failed');
      board.toRevising(task.id, 'failed again');
      board.block(task.id, 'exhausted');

      new Override(fixture.root).unblockTask(task.id);
      const updated = board.get(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.attempts).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('prioritizes a task above its peers', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [a, b] = board.create('a1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);
      new Override(fixture.root).prioritizeTask(b.id);
      expect(board.dispatchable('a1').map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('records every override in the decision log as a human action', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);

      new Override(fixture.root).acceptTask(task.id, argus.id);

      const rows = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argus.id },
        limit: 20,
      });
      const events = rows.map((r) => String(r.event));
      expect(events).toContain('human_accept');
    } finally {
      fixture.cleanup();
    }
  });
});
