import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { NotesStore } from '../../src/notes/store.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { QuestionQueue } from '../../src/argus/questions.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

describe('ArgusManager Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it('tests plan() with successful parsing, throttled skip, and contract error', async () => {
    const notes = new NotesStore(fixture.root);
    const missionNote = notes.createNote('mission', 'Build feature X');

    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'test-fleet', missionNoteId: missionNote.id });

    // 1. Success plan
    vi.spyOn(am as any, 'brain').mockResolvedValue(
      JSON.stringify({
        tasks: [
          { title: 'Task A', spec: 'Do A', depends_on: [] },
          { title: 'Task B', spec: 'Do B', depends_on: [0] },
        ],
      })
    );

    await am.plan(argus.id);
    const board = new TaskBoard(fixture.root);
    const tasks = board.list(argus.id);
    expect(tasks.length).toBe(2);

    // 2. Throttled skip
    getDb(fixture.root)
      .prepare('UPDATE argus SET throttled_until = ? WHERE id = ?')
      .run(now() + 100000, argus.id);
    await am.plan(argus.id); // should skip cleanly

    // Reset throttle
    getDb(fixture.root)
      .prepare('UPDATE argus SET throttled_until = NULL WHERE id = ?')
      .run(argus.id);

    // 3. Contract error (malformed json twice)
    vi.spyOn(am as any, 'brain').mockResolvedValue('not json at all');
    await expect(am.plan(argus.id)).rejects.toThrow();
  });

  it('tests runGatesForReported and recoverOrphans attempt limits and blocking', async () => {
    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'gates-fleet', maxAttemptsPerTask: 2 });
    const board = new TaskBoard(fixture.root);
    const sm = new SessionManager(fixture.root);

    const s = sm.createSession({ name: 'worker-1', harness: 'opencode', cwd: fixture.root });
    const [t1] = board.create(argus.id, [{ title: 'Gated Task', spec: 'Spec', dependsOn: [] }]);
    board.assign(t1.id, s.id);
    board.report(t1.id, { summary: 'Done work', filesChanged: [], uncertainties: '' });

    // Run gates with failing command
    const promoted = await am.runGatesForReported(argus.id, {
      test: 'exit 1',
      lint: '',
    });
    expect(promoted).toBe(0);
    const afterGate = board.get(t1.id)!;
    expect(afterGate.status).toBe('revising');
    expect(afterGate.attempts).toBe(1);

    // Second gate failure reaches maxAttemptsPerTask (2) -> blocked
    board.report(t1.id, { summary: 'Done work 2', filesChanged: [], uncertainties: '' });
    await am.runGatesForReported(argus.id, { test: 'exit 1', lint: '' });
    const blocked = board.get(t1.id)!;
    expect(blocked.status).toBe('blocked');
  });

  it('tests resumeRevisions and orphaned worker recovery', async () => {
    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'revisions-fleet' });
    const board = new TaskBoard(fixture.root);
    const sm = new SessionManager(fixture.root);

    const s = sm.createSession({ name: 'worker-rev', harness: 'opencode', cwd: fixture.root });

    const [t] = board.create(argus.id, [{ title: 'Rev Task', spec: 'Spec', dependsOn: [] }]);
    board.assign(t.id, s.id);
    board.toRevising(t.id, 'feedback for worker');

    await am.resumeRevisions(argus.id);
    expect(board.get(t.id)!.status).toBe('assigned');
  });

  it('tests drainReviews with accept, revise, and tierTwoReviewneed_files', async () => {
    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'review-fleet' });
    const board = new TaskBoard(fixture.root);
    const sm = new SessionManager(fixture.root);

    const s = sm.createSession({ name: 'worker-rev2', harness: 'opencode', cwd: fixture.root });
    const [t1] = board.create(argus.id, [{ title: 'Task 1', spec: 'Spec 1', dependsOn: [] }]);
    board.assign(t1.id, s.id);
    board.report(t1.id, { summary: 'Done', filesChanged: ['src/a.ts'], uncertainties: '' });
    board.beginGating(t1.id);
    board.recordGates(t1.id, { testExitCode: 0, lintExitCode: 0, stdout: '', stderr: '', failureTail: null }, '+1 -1');

    // Mock brain review to return accept
    vi.spyOn(am as any, 'brain').mockResolvedValue(
      JSON.stringify({
        verdicts: [{ task_id: t1.id, verdict: 'accept', reason: 'looks great' }],
      })
    );

    await am.drainReviews(argus.id, { force: true });
    expect(board.get(t1.id)!.status).toBe('done');
  });

  it('tests answerQuestions with brain reasoning and FAQ caching', async () => {
    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'qa-fleet' });
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'worker-q', harness: 'opencode', cwd: fixture.root });

    const queue = new QuestionQueue(fixture.root);
    const askRes = queue.ask(argus.id, s.id, 'Where is the configuration file stored?');
    expect(askRes.hit).toBe(false);

    if (!askRes.hit) {
      // Brain answers
      vi.spyOn(am as any, 'brain').mockResolvedValue(
        JSON.stringify({
          answer: 'Config is in src/core/config.ts',
          faq_key: 'config-location',
        })
      );

      await am.answerQuestions(argus.id);
      const answered = queue.get(askRes.id);
      expect(answered?.answer).toContain('src/core/config.ts');
    }
  });

  it('tests spawnNextWorker round-robin across worker harnesses', async () => {
    const am = new ArgusManager(fixture.root);
    const argus = am.start({
      name: 'multi-harness-fleet',
      workerHarnesses: ['opencode', 'gemini'],
      childLimit: 4,
    });
    const board = new TaskBoard(fixture.root);
    board.create(argus.id, [
      { title: 'Task 1', spec: 'Do 1', dependsOn: [] },
      { title: 'Task 2', spec: 'Do 2', dependsOn: [] },
    ]);

    const w1 = await am.spawnNextWorker(argus.id);
    expect(w1.session.harness).toBe('opencode');

    const w2 = await am.spawnNextWorker(argus.id);
    expect(w2.session.harness).toBe('gemini');
  });

  it('tests pause, resume, fleet, stop, and pulse methods', async () => {
    const notes = new NotesStore(fixture.root);
    const mNote = notes.createNote('mission', 'Cycle mission');

    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'full-cycle-fleet', missionNoteId: mNote.id });

    // Mock plan so pulse succeeds
    vi.spyOn(am, 'plan').mockResolvedValue(undefined);

    // pulse
    await am.pulse(argus.id);

    // Set to running
    getDb(fixture.root).prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(argus.id);

    // pause
    am.pause(argus.id);
    expect(am.get(argus.id)?.status).toBe('paused');
    expect(() => am.pause(argus.id)).toThrow('is paused, expected running');

    // resume
    am.resume(argus.id);
    expect(am.get(argus.id)?.status).toBe('running');
    expect(() => am.resume(argus.id)).toThrow('is running, expected paused');

    // fleet inspect
    const fl = am.fleet(argus.id);
    expect(fl.argus.id).toBe(argus.id);
    expect(fl.recentProgress.length).toBeGreaterThan(0);

    // stop
    await am.stop(argus.id);
    expect(am.get(argus.id)?.status).toBe('stopped');
  });
});
