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
      board.assign(pass.id, 'w1');
      board.report(pass.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.assign(fail.id, 'w2');
      board.report(fail.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(pass.id);
      board.beginGating(fail.id);

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

  it('requires a reported task before gating and a gating task before recording gates', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);

      expect(() => board.beginGating(task.id)).toThrow(/expected reported/);

      board.assign(task.id, 'worker-1');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      const gating = board.beginGating(task.id);
      expect(gating.status).toBe('gating');

      const reviewed = board.recordGates(
        task.id,
        { testExitCode: 0, lintExitCode: 0, failureTail: '' },
        ''
      );
      expect(reviewed.status).toBe('in_review');
      expect(() => board.recordGates(task.id, { testExitCode: 1, lintExitCode: 0, failureTail: 'x' }, '')).toThrow(
        /expected gating/
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('returns a revision to assigned without clearing feedback or attempts', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');
      const revised = board.toRevising(task.id, 'tests failed');
      const resumed = board.resumeRevision(task.id);
      expect(resumed.status).toBe('assigned');
      expect(resumed.assigneeSession).toBe('worker-1');
      expect(resumed.attempts).toBe(revised.attempts);
      expect(resumed.verdictReason).toBe('tests failed');
    } finally {
      fixture.cleanup();
    }
  });

  it('requeues an orphaned revision while preserving attempts and feedback', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');
      const revised = board.toRevising(task.id, 'tests failed');
      const requeued = board.clearAssigneeAndRequeue(task.id);
      expect(requeued.status).toBe('pending');
      expect(requeued.assigneeSession).toBeNull();
      expect(requeued.attempts).toBe(revised.attempts);
      expect(requeued.verdictReason).toBe('tests failed');
    } finally {
      fixture.cleanup();
    }
  });

  it('stamps the review queue entry time and clears it on revision', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('argus-1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.assign(task.id, 'w1');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);

      const queued = board.recordGates(
        task.id,
        { testExitCode: 0, lintExitCode: 0, failureTail: '' },
        ' src/a.ts | 2 +-'
      );
      expect(queued.status).toBe('in_review');
      expect(queued.reviewQueuedAt).not.toBeNull();
      expect(queued.reviewQueuedAt!).toBeGreaterThanOrEqual(queued.createdAt);

      const revising = board.toRevising(task.id, 'needs work');
      expect(revising.reviewQueuedAt).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
