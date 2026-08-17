import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArgusManager } from '../../src/argus/manager.js';
import { Override } from '../../src/argus/override.js';
import { TaskBoard } from '../../src/argus/board.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { budgetState } from '../../src/argus/budget.js';
import { NotesStore } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ToolRegistry } from '../../src/mcp/tools.js';
import { saveConfig, loadConfig } from '../../src/core/config.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo, spawnCli, sleep } from '../helpers.js';
import { createQuota } from '../../src/argus/quota.js';

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

function waitFor<T>(probe: () => T | null, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const poll = (): void => {
      const value = probe();
      if (value !== null && value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${probe.toString().slice(0, 80)}`));
        return;
      }
      setTimeout(poll, 100);
    };
    poll();
  });
}

/**
 * A binDir with a claude that plans one task, answers questions, and accepts
 * review, plus an inert opencode. The answer counter file proves the child
 * process answers an uncached question promptly.
 */
function makeWakingBrain(answerLog: string): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  const claude = [
    '#!/bin/bash',
    'ARGS="$*"',
    'if echo "$ARGS" | grep -q "Review the completed tasks below"; then',
    '  TASK_ID=$(echo "$ARGS" | grep -oE "Task [0-9a-f-]+:" | head -1 | sed "s/Task //;s/://")',
    `  echo "{\\"verdicts\\":[{\\"task_id\\":\\"$TASK_ID\\",\\"verdict\\":\\"accept\\"}]}"`,
    '  exit 0',
    'fi',
    'if echo "$ARGS" | grep -q "has a question"; then',
    `  echo "answer" >> "${answerLog}"`,
    '  echo \'{"answer":"Run npm test","faq_key":"test-command"}\'',
    '  exit 0',
    'fi',
    'echo \'{"tasks":[{"title":"wake task","spec":"do the wake task","depends_on":[]}]}\'',
    'exit 0',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'claude'), claude, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'opencode'), '#!/bin/bash\necho "fake opencode ran with: $@"\nexit 0\n', { mode: 0o755 });
  return { binDir, cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }) };
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

  it('rejects a quota id that does not exist', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      expect(() => manager.start({ quotaId: 'nope' })).toThrow(/quota "nope" not found/);
      expect(manager.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects --quota combined with --budget-window or --budget-max-tokens', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      expect(() => manager.start({ quotaId: 'q1', budgetWindowSec: 3600 })).toThrow(/cannot combine --quota/);
      expect(() => manager.start({ quotaId: 'q1', budgetMaxTokens: 1000 })).toThrow(/cannot combine --quota/);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a mission attached to an existing quota', () => {
    const fixture = makeRepo();
    try {
      createQuota('shared-account', { maxTokens: 500_000, windowSec: 7200 });
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({ quotaId: 'shared-account' });
      expect(argus.quotaId).toBe('shared-account');
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

  it('re-prompts the same worker session in the same worktree after a gate failure', async () => {
    const fixture = makeRepo();
    const promptLog = path.join(fixture.root, 'worker-prompts.txt');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    const opencode = `#!/bin/bash\nprintf '%s\\n' "$*" >> "${promptLog}"\nexit 0\n`;
    fs.writeFileSync(path.join(binDir, 'opencode'), opencode, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      const manager = new ArgusManager(fixture.root, fakeBrain({}).fn);
      const argus = manager.start({ name: 'fleet' });
      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: worktree,
        policy: 'child',
        argusParent: argus.id,
      });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, {
        summary: 'done', filesChanged: [], testsRun: '', uncertainties: '',
      });

      await manager.runGatesForReported(argus.id, { test: 'echo "tests failed" && exit 1', lint: '' });
      await manager.resumeRevisions(argus.id);
      await waitFor(() => (fs.existsSync(promptLog) ? promptLog : null), 5000);

      const resumed = board.get(task.id);
      expect(resumed?.status).toBe('assigned');
      expect(resumed?.assigneeSession).toBe(worker.id);
      expect(resumed?.verdictReason).toContain('tests failed');
      expect(resumed?.attempts).toBe(1);
      const prompt = fs.readFileSync(promptLog, 'utf8');
      expect(prompt).toContain('do a');
      expect(prompt).toContain('tests failed');
      expect(prompt).toContain('report_done');
    } finally {
      process.env.PATH = oldPath ?? '';
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('blocks a revision at the configured attempt limit', async () => {
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
      board.toRevising(task.id, 'first failure');
      board.toRevising(task.id, 'second failure');

      await manager.resumeRevisions(argus.id);

      expect(board.get(task.id)?.status).toBe('blocked');
      expect(String(board.get(task.id)?.verdictReason)).toContain('exhausted 2 attempts');
    } finally {
      fixture.cleanup();
    }
  });

  it('batches all eight queued tasks in one forced review call below the ceiling', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const ids: string[] = [];
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        if (opts.label !== 'review') return '{}';
        const body = opts.prompt ?? '';
        for (const id of ids) {
          expect(body).toContain(id);
        }
        return `{"verdicts":[${ids.map((id) => `{"task_id":"${id}","verdict":"accept"}`).join(',')}]}`;
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 1000 WHERE id = ?')
        .run(argusId);
      for (let i = 0; i < 8; i++) {
        const [t] = board.create(argusId, [{ title: `t${i}`, spec: 's', dependsOn: [] }]);
        ids.push(t.id);
        board.assign(t.id, `w${i}`);
        board.report(t.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
        board.beginGating(t.id);
        board.recordGates(t.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');
      }
      // 96 percent of the ceiling: normal drain must pause, force must drain.
      const db = getDb(fixture.root);
      for (const id of ids) {
        db.prepare(
          "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES (?, ?, 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
        ).run(`b-${id}`, `b-${id}`, fixture.root, fixture.root, argusId, now(), now());
        db.prepare(
          'INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)'
        ).run(`b-${id}`, 60, 60, now());
      }

      await manager.drainReviews(argusId);
      expect(board.list(argusId, 'done')).toHaveLength(0);

      const override = new Override(fixture.root);
      await override.forceReview(argusId, manager);
      expect(board.list(argusId, 'done')).toHaveLength(8);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses a forced review at 100 percent of the ceiling', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) =>
        opts.label === 'review' ? '{"verdicts":[]}' : '{}'
      );
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 1000 WHERE id = ?')
        .run(argusId);
      const [t] = board.create(argusId, [{ title: 't', spec: 's', dependsOn: [] }]);
      board.assign(t.id, 'w0');
      board.report(t.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(t.id);
      board.recordGates(t.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');
      getDb(fixture.root)
        .prepare(
          "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES ('b1', 'b1', 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
        )
        .run(fixture.root, fixture.root, argusId, now(), now());
      getDb(fixture.root)
        .prepare(
          'INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)'
        )
        .run('b1', 600, 400, now());

      await expect(new Override(fixture.root).forceReview(argusId, manager)).rejects.toThrow(/exhausted/);
      expect(board.get(t.id)?.status).toBe('in_review');
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

  it('stops the argus after a malformed plan twice without a third call', async () => {
    const fixture = makeRepo();
    try {
      let calls = 0;
      const manager = new ArgusManager(fixture.root, async () => {
        calls += 1;
        return 'still not JSON';
      });
      const mission = new NotesStore(fixture.root).createNote('mission', '- build the thing');
      const argus = manager.start({ name: 'fleet', missionNoteId: mission.id });

      await expect(manager.plan(argus.id)).rejects.toThrow(/malformed twice/);
      expect(calls).toBe(2);
      expect(manager.get(argus.id)?.status).toBe('stopped');
      const progress = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argus.id }, limit: 20,
      });
      expect(progress.map((r) => String(r.event))).toContain('brain_abandoned');
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks every task in a batch whose review is malformed twice', async () => {
    const fixture = makeRepo();
    try {
      let reviewCalls = 0;
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        if (opts.label !== 'review') return '{}';
        reviewCalls += 1;
        return 'this is not json';
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      // Conserve tier (70 percent spend) batches up to four tasks together.
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 1000 WHERE id = ?')
        .run(argusId);
      getDb(fixture.root)
        .prepare(
          "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES ('bs1', 'bs1', 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
        )
        .run(fixture.root, fixture.root, argusId, now(), now());
      getDb(fixture.root)
        .prepare('INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)')
        .run('bs1', 600, 100, now());
      const [t1, t2] = board.create(argusId, [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);
      for (const t of [t1, t2]) {
        board.assign(t.id, `w-${t.id}`);
        board.report(t.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
        board.beginGating(t.id);
        board.recordGates(t.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');
      }

      await manager.drainReviews(argusId);

      expect(reviewCalls).toBe(2);
      for (const t of [t1, t2]) {
        expect(board.get(t.id)?.status).toBe('blocked');
        expect(String(board.get(t.id)?.verdictReason)).toContain('malformed');
      }
      const progress = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argusId }, limit: 20,
      });
      expect(progress.map((r) => String(r.event))).toContain('review_failed');

      // Later scheduler checks must not re-review the blocked tasks.
      await manager.drainReviews(argusId);
      expect(reviewCalls).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('blocks only the affected task when tier 2 review is malformed twice', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      let tier2Calls = 0;
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        const queued = board.list(argusId, 'in_review');
        const id = queued[0]?.id ?? '';
        if (opts.label === 'review') {
          return `{"verdicts":[{"task_id":"${id}","verdict":"need_files","paths":["src/a.ts"]}]}`;
        }
        if (opts.label === 'review-files') {
          tier2Calls += 1;
          return 'still not json';
        }
        return '{}';
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1', harness: 'opencode', cwd: worktree, policy: 'child', argusParent: argusId,
      });
      const [task] = board.create(argusId, [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      expect(tier2Calls).toBe(2);
      expect(board.get(task.id)?.status).toBe('blocked');
      const progress = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argusId }, limit: 20,
      });
      expect(progress.map((r) => String(r.event))).toContain('review_files_failed');
      await manager.drainReviews(argusId);
      expect(tier2Calls).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('abandons a question after exactly two calls even under the scheduler loop', async () => {
    const fixture = makeRepo();
    try {
      let answerCalls = 0;
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        if (opts.label === 'answer') answerCalls += 1;
        return 'not json';
      });
      const argus = manager.start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'help?');
      if (asked.hit) throw new Error('expected a cache miss');

      // Ten scheduler passes stand in for the 250 ms loop running for seconds.
      for (let i = 0; i < 10; i++) {
        await manager.answerQuestions(argus.id);
      }

      expect(answerCalls).toBe(2);
      expect(queue.get(asked.id)?.answer).toBeNull();
      expect(queue.pending(argus.id)).toHaveLength(0);
      const progress = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argus.id }, limit: 50,
      });
      expect(progress.filter((r) => String(r.event) === 'question_failed')).toHaveLength(1);
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
      board.assign(task.id, 'w1');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
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
      board.assign(task.id, 'w1');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
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

  it('loads requested files only in a second bounded brain review call', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const sourceContents = 'export const a = 1;\n';
      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
      fs.writeFileSync(path.join(worktree, 'src', 'a.ts'), sourceContents);
      const calls: { label: string; model: string | null; prompt: string }[] = [];
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        calls.push({ label: opts.label, model: opts.model ?? null, prompt: opts.prompt ?? '' });
        const queued = board.list(argusId, 'in_review');
        if (opts.label === 'review') {
          return `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"need_files","paths":["src/a.ts"]}]}`;
        }
        if (opts.label === 'review-files') {
          return `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"accept"}]}`;
        }
        return '{}';
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      getDb(fixture.root)
        .prepare("UPDATE argus SET brain_review_model = 'review-model', brain_plan_model = 'plan-model' WHERE id = ?")
        .run(argusId);
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1', harness: 'opencode', cwd: worktree, policy: 'child', argusParent: argusId,
      });
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      expect(calls).toHaveLength(2);
      expect(calls[0].model).toBe('review-model');
      expect(calls[0].prompt).not.toContain(sourceContents);
      expect(calls[1].model).toBe('plan-model');
      expect(calls[1].prompt).toContain('File: src/a.ts');
      expect(calls[1].prompt).toContain(sourceContents);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('converts a repeated tier 2 need_files into a single revision', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      fs.mkdirSync(path.join(fixture.root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(fixture.root, 'src', 'a.ts'), 'export const a = 1;\n');
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        const queued = board.list(argusId, 'in_review');
        const id = queued[0]?.id ?? '';
        return opts.label === 'review'
          ? `{"verdicts":[{"task_id":"${id}","verdict":"need_files","paths":["src/a.ts"]}]}`
          : `{"verdicts":[{"task_id":"${id}","verdict":"need_files","paths":["src/a.ts"]}]}`;
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1', harness: 'opencode', cwd: worktree, policy: 'child', argusParent: argusId,
      });
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(board.list(argusId, 'in_review')).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('records one revision when tier 2 file review is denied by the budget', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        const queued = board.list(argusId, 'in_review');
        return opts.label === 'review'
          ? `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"need_files","paths":["src/a.ts"]}]}`
          : '{}';
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;
      // Conserve tier disables tier 2 while still draining reviews.
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 1000 WHERE id = ?')
        .run(argusId);
      getDb(fixture.root)
        .prepare(
          "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES ('b1', 'b1', 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
        )
        .run(fixture.root, fixture.root, argusId, now(), now());
      getDb(fixture.root)
        .prepare('INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)')
        .run('b1', 600, 100, now());
      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1', harness: 'opencode', cwd: worktree, policy: 'child', argusParent: argusId,
      });
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      expect(board.get(task.id)?.status).toBe('revising');
      expect(String(board.get(task.id)?.verdictReason)).toContain('file review was unavailable');
      expect(board.list(argusId, 'in_review')).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not re-review a need_files task forever', async () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const manager = new ArgusManager(fixture.root, async (_r, _a, _opts) => {
        const queued = board.list(argusId, 'in_review');
        return `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"need_files","paths":["src/a.ts"]}]}`;
      });
      const argus = manager.start({ name: 'fleet' });
      argusId = argus.id;

      const worktree = path.join(fixture.root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'worker-1', harness: 'opencode', cwd: worktree, policy: 'child', argusParent: argusId,
      });
      const [task] = board.create(argusId, [{ title: 'a', spec: 'do a', dependsOn: [] }]);
      board.assign(task.id, worker.id);
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      await manager.drainReviews(argusId);

      // The task must leave the review queue, or every later pulse re-reviews
      // it and burns brain tokens on an identical verdict. Tier 2 runs, keeps
      // requesting the file, and the repeated request becomes one revision.
      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(board.list(argusId, 'in_review')).toHaveLength(0);
      expect(String(board.get(task.id)?.verdictReason)).toContain('files');
    } finally {
      fixture.cleanup();
    }
  });

  it('runs the complete lifecycle: plan, gate retry, tier 1, and tier 2 accept', async () => {
    const fixture = makeRepo();
    const promptLog = path.join(fixture.root, 'worker-prompts.txt');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    const opencode = `#!/bin/bash\nprintf '%s\\n' "$*" >> "${promptLog}"\nexit 0\n`;
    fs.writeFileSync(path.join(binDir, 'opencode'), opencode, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      const calls: string[] = [];
      const worker = new SessionManager(fixture.root);
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        calls.push(opts.label);
        if (opts.label === 'plan') {
          return '{"tasks":[{"title":"write proof","spec":"append the word proof to proof.txt and verify it","depends_on":[]}]}';
        }
        const queued = board.list(argusId, 'in_review');
        const id = queued[0]?.id ?? '';
        if (opts.label === 'review') {
          return `{"verdicts":[{"task_id":"${id}","verdict":"need_files","paths":["proof.txt"]}]}`;
        }
        if (opts.label === 'review-files') {
          return `{"verdicts":[{"task_id":"${id}","verdict":"accept","reason":"proof verified"}]}`;
        }
        return '{}';
      });
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('mission', '- write proof');
      const conventions = notes.createNote('conventions', 'Use strict ESM and run npm test.');
      const argus = manager.start({
        name: 'lifecycle', missionNoteId: mission.id, conventionsNoteId: conventions.id,
        childLimit: 2, pulseSec: 1, workerHarnesses: ['opencode'],
      });
      argusId = argus.id;
      getDb(fixture.root)
        .prepare("UPDATE argus SET brain_review_model = 'review-model', brain_plan_model = 'plan-model', budget_max_tokens = 1000000 WHERE id = ?")
        .run(argusId);

      // Pulse 1: plan and dispatch one worker.
      await manager.pulse(argusId);
      const task = board.list(argusId)[0];
      expect(task.status).toBe('assigned');
      await waitFor(() => (fs.existsSync(promptLog) ? promptLog : null), 5000);
      const firstPrompt = fs.readFileSync(promptLog, 'utf8');
      expect(firstPrompt).toContain('proof.txt');

      // The worker (simulated here) reads its task, sees conventions, and reports.
      const workerId = task.assigneeSession!;
      const registry = new ToolRegistry({
        projectRoot: fixture.root,
        sessionId: workerId,
        policy: 'child',
        isManager: false,
        riskyTools: false,
        confirm: async () => false,
      });
      const got = (await registry.call('task_get', {})) as Record<string, unknown>;
      expect(got.projectConventions).toBe('Use strict ESM and run npm test.');

      // First report: the gate fails once.
      fs.writeFileSync(path.join(worker.get(workerId)!.cwd, 'proof.txt'), 'wrong content');
      await registry.call('report_done', {
        summary: 'first attempt', files_changed: ['proof.txt'], tests_run: '', uncertainties: '',
      });
      await manager.runGatesForReported(argusId, { test: 'grep proof proof.txt || { echo "proof missing"; exit 1; }', lint: '' });
      expect(board.get(task.id)?.status).toBe('revising');
      expect(board.get(task.id)?.attempts).toBe(1);

      // The same session receives a revision prompt in the same worktree.
      await manager.resumeRevisions(argusId);
      expect(board.get(task.id)?.status).toBe('assigned');
      expect(board.get(task.id)?.assigneeSession).toBe(workerId);
      await waitFor(() => {
        const prompts = fs.readFileSync(promptLog, 'utf8');
        return prompts.includes('requires revision') ? prompts : null;
      }, 5000);
      const secondPrompt = fs.readFileSync(promptLog, 'utf8');
      expect(secondPrompt).toContain('requires revision');
      expect(secondPrompt).toContain('proof missing');

      // The worker fixes the gate and reports again.
      fs.writeFileSync(path.join(worker.get(workerId)!.cwd, 'proof.txt'), 'proof confirmed');
      await registry.call('report_done', {
        summary: 'second attempt', files_changed: ['proof.txt'], tests_run: '', uncertainties: '',
      });
      await manager.runGatesForReported(argusId, { test: 'grep proof proof.txt || { echo "proof missing"; exit 1; }', lint: '' });
      expect(board.get(task.id)?.status).toBe('in_review');

      // Tier 1 asks for the file; tier 2 accepts it.
      await manager.drainReviews(argusId);
      expect(board.get(task.id)?.status).toBe('done');
      expect(board.get(task.id)?.attempts).toBe(1);
      expect(calls).toEqual(['plan', 'review', 'review-files']);
    } finally {
      process.env.PATH = oldPath ?? '';
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('pauses review above 95 percent while workers and gates continue, and drains on force-review', async () => {
    const fixture = makeRepo();
    const promptLog = path.join(fixture.root, 'worker-prompts.txt');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    const opencode = `#!/bin/bash\nprintf '%s\\n' "$*" >> "${promptLog}"\nexit 0\n`;
    fs.writeFileSync(path.join(binDir, 'opencode'), opencode, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      const board = new TaskBoard(fixture.root);
      let argusId = '';
      let reviewCalls = 0;
      const manager = new ArgusManager(fixture.root, async (_r, _a, opts) => {
        if (opts.label !== 'review') return '{}';
        reviewCalls += 1;
        const queued = board.list(argusId, 'in_review');
        return `{"verdicts":[{"task_id":"${queued[0].id}","verdict":"accept"}]}`;
      });
      const argus = manager.start({ name: 'paused', childLimit: 2, pulseSec: 1, workerHarnesses: ['opencode'] });
      argusId = argus.id;
      // 96 percent of the ceiling: reviews paused, gates and workers continue.
      getDb(fixture.root)
        .prepare('UPDATE argus SET budget_max_tokens = 1000 WHERE id = ?')
        .run(argusId);
      getDb(fixture.root)
        .prepare(
          "INSERT INTO sessions (id, name, harness, project_root, cwd, status, token, policy, argus_parent, started_at, last_activity_at) VALUES ('bp1', 'bp1', 'claude', ?, ?, 'stopped', 'tok', 'brain', ?, ?, ?)"
        )
        .run(fixture.root, fixture.root, argusId, now(), now());
      getDb(fixture.root)
        .prepare('INSERT INTO session_telemetry (session_id, input_tokens, output_tokens, updated_at) VALUES (?, ?, ?, ?)')
        .run('bp1', 600, 360, now());

      const [task] = board.create(argusId, [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.assign(task.id, 'w0');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');

      const budget = budgetState(fixture.root, argusId);
      expect(budget.fraction).toBeGreaterThan(0.95);
      expect(budget.fraction).toBeLessThan(1);

      await manager.drainReviews(argusId);
      expect(reviewCalls).toBe(0);
      expect(board.get(task.id)?.status).toBe('in_review');

      const override = new Override(fixture.root);
      await override.forceReview(argusId, manager);
      expect(board.get(task.id)?.status).toBe('done');
      expect(reviewCalls).toBe(1);
    } finally {
      process.env.PATH = oldPath ?? '';
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('answers a question before a long mission pulse', async () => {
    const fixture = makeRepo();
    const answerLog = path.join(fixture.root, 'answer-log.txt');
    const fake = makeWakingBrain(answerLog);
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- wake the brain');
    try {
      const child = spawnCli(
        [
          'argus', 'start',
          '--name', 'wake',
          '--mission', mission.id,
          '--children', '2',
          '--pulse', '1h',
          '--question-timeout', '3s',
        ],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));

      const manager = new ArgusManager(fixture.root);
      await waitFor(() => manager.list().find((a) => a.name === 'wake') ?? null);
      const argusId = manager.list().find((a) => a.name === 'wake')!.id;
      await waitFor(() => (new TaskBoard(fixture.root).list(argusId).length > 0 ? argusId : null));

      const worker = new SessionManager(fixture.root).createSession({
        name: 'wake-worker',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: argusId,
      });
      const registry = new ToolRegistry({
        projectRoot: fixture.root,
        sessionId: worker.id,
        policy: 'child',
        isManager: false,
        riskyTools: false,
        confirm: async () => false,
      });

      const started = Date.now();
      const result = (await registry.call('ask_manager', {
        question: 'What is the test command?',
      })) as Record<string, unknown>;
      const elapsed = Date.now() - started;

      expect(elapsed, `stderr: ${stderr}`).toBeLessThan(3000);
      expect(result).toMatchObject({ answer: 'Run npm test', cached: false });

      // The child manager must not poll the brain on idle scheduler ticks.
      await sleep(2000);
      const log = fs.existsSync(answerLog) ? fs.readFileSync(answerLog, 'utf8').trim() : '';
      expect(log.split('\n').filter((l) => l === 'answer')).toHaveLength(1);

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
      expect(code).toBe(0);
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('runs gates and review promptly after report_done on a long pulse', async () => {
    const fixture = makeRepo();
    const answerLog = path.join(fixture.root, 'answer-log.txt');
    const fake = makeWakingBrain(answerLog);
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- wake the brain');
    const previousConfig = loadConfig();
    saveConfig({
      defaultHarness: 'opencode',
      profileDir: {},
      argus: {
        defaultPulseSec: 60,
        defaultChildLimit: 8,
        allowedLimits: [2, 4, 8, 16],
        gateTestCommand: '',
        gateLintCommand: '',
      },
      models: {},
    });
    try {
      const child = spawnCli(
        [
          'argus', 'start',
          '--name', 'wake-review',
          '--mission', mission.id,
          '--children', '2',
          '--pulse', '1h',
        ],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));

      const manager = new ArgusManager(fixture.root);
      await waitFor(() => manager.list().find((a) => a.name === 'wake-review') ?? null);
      const argusId = manager.list().find((a) => a.name === 'wake-review')!.id;
      await waitFor(() => (new TaskBoard(fixture.root).list(argusId).length > 0 ? argusId : null));
      const task = new TaskBoard(fixture.root).list(argusId)[0];

      // The child dispatcher assigns the task to its own worker session, which
      // the fake opencode binary exits. The test then reports through that same
      // session, exactly as the real worker's report_done MCP call would.
      await waitFor(() => {
        const assigned = new TaskBoard(fixture.root).get(task.id);
        return assigned?.status === 'assigned' && assigned.assigneeSession ? assigned.assigneeSession : null;
      });
      const workerId = new TaskBoard(fixture.root).get(task.id)!.assigneeSession!;
      const board = new TaskBoard(fixture.root);
      const registry = new ToolRegistry({
        projectRoot: fixture.root,
        sessionId: workerId,
        policy: 'child',
        isManager: false,
        riskyTools: false,
        confirm: async () => false,
      });

      const started = Date.now();
      await registry.call('report_done', {
        summary: 'did it',
        files_changed: ['proof.txt'],
        tests_run: '',
        uncertainties: '',
      });
      await waitFor(() => (board.get(task.id)?.status === 'done' ? task.id : null), 10000);
      const elapsed = Date.now() - started;

      expect(elapsed, `stderr: ${stderr}`).toBeLessThan(10000);
      expect(board.get(task.id)?.status).toBe('done');
      expect(board.get(task.id)?.workerReport?.summary).toBe('did it');

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
      expect(code).toBe(0);
    } finally {
      saveConfig(previousConfig);
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
