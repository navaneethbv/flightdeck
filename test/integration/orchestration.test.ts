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
  const prompts: Record<string, string> = {};
  const fn = async (_root: string, _argusId: string, opts: { label: string; prompt?: string }): Promise<string> => {
    calls.push(opts.label);
    if (opts.prompt !== undefined) prompts[opts.label] = opts.prompt;
    return responses[opts.label] ?? '{}';
  };
  return { fn, calls, prompts };
}

describe('orchestration', () => {
  it('includes the project conventions note in plan and answer prompts', async () => {
    const fixture = makeRepo();
    try {
      const brain = fakeBrain({
        plan: '{"tasks":[{"title":"a","spec":"do a","depends_on":[]}]}',
        answer: '{"answer":"Run npm test","faq_key":"test-command"}',
      });
      const manager = new ArgusManager(fixture.root, brain.fn);
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('mission', '- build the thing');
      const conventions = notes.createNote('conventions', 'Use strict ESM and run npm test.');
      const argus = manager.start({
        name: 'fleet',
        missionNoteId: mission.id,
        conventionsNoteId: conventions.id,
      });

      await manager.plan(argus.id);
      const queue = new QuestionQueue(fixture.root);
      queue.ask(argus.id, 'worker-1', 'How do I verify?');
      await manager.answerQuestions(argus.id);

      expect(brain.prompts.plan).toContain('Project conventions:\nUse strict ESM and run npm test.');
      expect(brain.prompts.answer).toContain('Project conventions:\nUse strict ESM and run npm test.');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a conventions note id that does not exist', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      expect(() => manager.start({ conventionsNoteId: 'nope' })).toThrow(/conventions note "nope" not found/);
      expect(manager.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

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

  it('does not re-review a need_files task forever', async () => {
    const fixture = makeRepo();
    try {
      let reviewCalls = 0;
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        if (opts.label !== 'review') return '{}';
        reviewCalls += 1;
        const queued = board.list(argusId, 'in_review');
        return `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"need_files","paths":["src/a.ts"]}]}`;
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;

      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      // The task must leave the review queue, or every later pulse re-reviews
      // it and burns brain tokens on an identical verdict.
      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(board.list(argusId, 'in_review')).toHaveLength(0);
      expect(String(board.get(task.id)?.verdictReason)).toContain('src/a.ts');

      // A second drain has nothing queued, so the brain is not called again.
      await manager.drainReviews(argusId);
      expect(reviewCalls).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});
