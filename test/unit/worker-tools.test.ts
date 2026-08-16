import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../src/mcp/tools.js';
import { TaskBoard } from '../../src/argus/board.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

function childContext(root: string, sessionId: string) {
  return {
    projectRoot: root,
    sessionId,
    policy: 'child' as const,
    isManager: false,
    riskyTools: false,
    confirm: async () => false,
  };
}

function seedArgus(root: string): void {
  getDb(root)
    .prepare(
      "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, question_timeout_sec) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 1)"
    )
    .run(root, now());
}

describe('worker tools', () => {
  it('all three are callable by a child session with risky tools disabled', () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      for (const name of ['task_get', 'report_done', 'ask_manager']) {
        const def = registry.tools.get(name);
        expect(def, `${name} must be registered`).toBeDefined();
        expect(['read', 'additive']).toContain(def!.risk);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('task_get returns the assigned task for the calling session', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 's1');

      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      const result = (await registry.call('task_get', {})) as Record<string, unknown>;
      expect(result.id).toBe(task.id);
      expect(result.spec).toBe('do a');
    } finally {
      fixture.cleanup();
    }
  });

  it('task_get returns the project conventions note bound to the fleet', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'a1',
      });
      const notes = new NotesStore(fixture.root);
      const conventions = notes.createNote('conventions', 'Use strict ESM and run npm test.');
      getDb(fixture.root)
        .prepare('UPDATE argus SET conventions_note_id = ? WHERE id = ?')
        .run(conventions.id, 'a1');
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);

      const registry = new ToolRegistry(childContext(fixture.root, worker.id));
      const result = await registry.call('task_get', {});
      expect(result).toMatchObject({
        id: task.id,
        projectConventions: 'Use strict ESM and run npm test.',
      });
    } finally {
      fixture.cleanup();
    }
  });

  it('report_done moves the task to reported and stores the report', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, 's1');

      const registry = new ToolRegistry(childContext(fixture.root, 's1'));
      await registry.call('report_done', {
        summary: 'added the module',
        files_changed: ['src/a.ts'],
        tests_run: 'npm test',
        uncertainties: 'none',
      });

      const updated = board.get(task.id);
      expect(updated?.status).toBe('reported');
      expect(updated?.workerReport?.summary).toBe('added the module');
    } finally {
      fixture.cleanup();
    }
  });

  it('ask_manager returns a cached answer immediately without queueing', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      // ask_manager resolves the fleet from the caller's session row, so the
      // worker must actually exist and be parented to the argus.
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'a1',
      });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's0', 'What is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');
      queue.answer(asked.id, 'Run npm test', 'test-command');

      const registry = new ToolRegistry(childContext(fixture.root, worker.id));
      const result = (await registry.call('ask_manager', {
        question: 'What is the test command?',
      })) as Record<string, unknown>;
      expect(result.answer).toBe('Run npm test');
      expect(result.cached).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('ask_manager tells the worker to proceed when the brain does not answer', async () => {
    const fixture = makeRepo();
    try {
      seedArgus(fixture.root);
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'a1',
      });
      const registry = new ToolRegistry(childContext(fixture.root, worker.id));
      // seedArgus sets question_timeout_sec to 1, so this resolves in ~1s.
      const result = (await registry.call('ask_manager', {
        question: 'Something nobody has asked before?',
      })) as Record<string, unknown>;
      expect(result.answer).toBeNull();
      expect(String(result.directive)).toContain('best judgment');
    } finally {
      fixture.cleanup();
    }
  });
});
