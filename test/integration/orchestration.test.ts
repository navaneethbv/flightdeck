import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { NotesStore } from '../../src/notes/store.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

/** A brain that returns canned JSON, so no model is ever invoked. */
function fakeBrain(responses: Record<string, string>) {
  const calls: string[] = [];
  const fn = async (_root: string, _argusId: string, opts: { label: string }): Promise<string> => {
    calls.push(opts.label);
    return responses[opts.label] ?? '{}';
  };
  return { fn, calls };
}

describe('orchestration', () => {
  it('turns a plan into board rows', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({
        plan: '{"tasks":[{"title":"a","spec":"do a","depends_on":[]},{"title":"b","spec":"do b","depends_on":[0]}]}',
      });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', childLimit: 2, missionNoteId: mission.id });

      await manager.plan(argus.id);

      const tasks = new TaskBoard(fixture.root).list(argus.id);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].dependsOn).toEqual([tasks[0].id]);
      expect(brain.calls).toEqual(['plan']);
    } finally {
      fixture.cleanup();
    }
  });

  it('bounces a gate failure back to the worker without invoking the brain', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({});
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');
      board.report(task.id, {
        summary: 'done', filesChanged: [], testsRun: '', uncertainties: '',
      });

      await manager.runGatesForReported(argus.id, { test: 'exit 1', lint: '' });

      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(brain.calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks a task that exhausts its attempt budget', async () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({ name: 'fleet' });
      getDb(fixture.root)
        .prepare('UPDATE argus SET max_attempts_per_task = 2 WHERE id = ?')
        .run(argus.id);

      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 'worker-1');

      for (let i = 0; i < 2; i++) {
        board.report(task.id, {
          summary: 'done', filesChanged: [], testsRun: '', uncertainties: '',
        });
        await manager.runGatesForReported(argus.id, { test: 'exit 1', lint: '' });
      }

      expect(board.get(task.id)?.status).toBe('blocked');
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a reviewed task and applies the verdict', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        const tasks = board.list(argusId, 'in_review');
        return opts.label === 'review'
          ? `{"verdicts":[{"task_id":"${tasks[0].id}","verdict":"accept"}]}`
          : '{}';
      });
      const argus = manager.start({ name: 'fleet' });
      const argusId = argus.id;
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('does not drain reviews when the budget is paused', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({ review: '{"verdicts":[]}' });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      // Ceiling of zero forces fraction >= 0.95, the paused tier.
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 0 WHERE id = ?')
        .run(argus.id);

      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argus.id);

      expect(board.get(task.id)?.status).toBe('in_review');
      expect(brain.calls).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('answers a pending question and caches it', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({ answer: '{"answer":"Run npm test","faq_key":"test-command"}' });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const argus = manager.start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'What is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');

      await manager.answerQuestions(argus.id);

      expect(queue.get(asked.id)?.answer).toBe('Run npm test');
      expect(queue.pending(argus.id)).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('retries malformed brain output exactly once', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const manager = new ArgusManager(fixture.root, async () => {
        calls += 1;
        return calls === 1 ? 'Sorry, I cannot do that.' : '{"tasks":[{"title":"a","spec":"do a"}]}';
      });
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', missionNoteId: mission.id });

      await manager.plan(argus.id);

      expect(calls).toBe(2);
      expect(new TaskBoard(fixture.root).list(argus.id)).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('gives up after one failed retry rather than looping against a rate limit', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const manager = new ArgusManager(fixture.root, async () => {
        calls += 1;
        return 'still not JSON';
      });
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', missionNoteId: mission.id });

      await expect(manager.plan(argus.id)).rejects.toThrow(/no JSON object/);
      expect(calls).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });
});
