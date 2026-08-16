import { describe, it, expect } from 'vitest';
import { TaskBoard } from '../../src/argus/board.js';
import { makeRepo } from '../helpers.js';

describe('TaskBoard', () => {
  it('rewrites depends_on indices into task ids', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const tasks = board.create('argus-1', [
        { title: 'schema', spec: 'add tables', dependsOn: [] },
        { title: 'store', spec: 'add store', dependsOn: [0] },
      ]);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].dependsOn).toEqual([]);
      expect(tasks[1].dependsOn).toEqual([tasks[0].id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an out-of-range dependency index', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      expect(() =>
        board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [5] }])
      ).toThrow(/dependency index 5 is out of range/);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a dependency cycle', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      expect(() =>
        board.create('argus-1', [
          { title: 'a', spec: 'a', dependsOn: [1] },
          { title: 'b', spec: 'b', dependsOn: [0] },
        ])
      ).toThrow(/dependency cycle/);
    } finally {
      fixture.cleanup();
    }
  });

  it('only reports a task as dispatchable once its dependencies are done', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [first, second] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [0] },
      ]);

      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([first.id]);

      board.assign(first.id, 'session-1');
      expect(board.dispatchable('argus-1')).toHaveLength(0);

      board.recordVerdict(first.id, 'accept', null);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([second.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('increments attempts on each revision and round-trips the worker report', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);

      board.assign(task.id, 'session-1');
      const reported = board.report(task.id, {
        summary: 'did the thing',
        filesChanged: ['src/a.ts'],
        testsRun: 'npm test',
        uncertainties: 'none',
      });
      expect(reported.status).toBe('reported');
      expect(reported.workerReport?.filesChanged).toEqual(['src/a.ts']);

      const revised = board.toRevising(task.id, 'tests failed');
      expect(revised.status).toBe('revising');
      expect(revised.attempts).toBe(1);
      expect(board.toRevising(task.id, 'still failing').attempts).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('moves a task to in_review only when gates pass', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [pass, fail] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);

      const passed = board.recordGates(
        pass.id,
        { testExitCode: 0, lintExitCode: 0, failureTail: '' },
        ' src/a.ts | 2 +-'
      );
      expect(passed.status).toBe('in_review');

      const failed = board.recordGates(
        fail.id,
        { testExitCode: 1, lintExitCode: 0, failureTail: '1 test failed' },
        ''
      );
      expect(failed.status).toBe('revising');
      expect(failed.attempts).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});
