import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FleetActions } from '../../src/fleet/actions.js';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux, type TmuxRunner } from '../../src/fleet/tmux.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

function fakeRunner(withPane?: string): TmuxRunner {
  return () => ({
    status: 0,
    stdout: withPane ? `%0\t\tconsole\n%5\t${withPane}\tw1\n` : '%0\t\tconsole\n',
    stderr: '',
  });
}

function seedFleet(root: string, opts: { tasks: number; limit?: number }) {
  const manager = new ArgusManager(root, async () => '{}');
  const argus = manager.start({ name: 'fleet', childLimit: opts.limit ?? 4 });
  const board = new TaskBoard(root);
  const tasks = board.create(
    argus.id,
    Array.from({ length: opts.tasks }, (_, i) => ({ title: `t${i}`, spec: `do ${i}`, dependsOn: [] }))
  );
  const worker = new SessionManager(root).createSession({
    name: 'worker-1', harness: 'opencode', cwd: root, policy: 'child', argusParent: argus.id,
  });
  return { manager, argus, board, tasks, worker };
}

describe('FleetActions', () => {
  it('claims and releases a worker through the shared service', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('opencode');
    try {
      const { worker } = seedFleet(fixture.root, { tasks: 1 });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);
      const fleet = new FleetManager(fixture.root, new Tmux(fakeRunner(worker.id)));
      const actions = new FleetActions(fixture.root, { fleet });
      expect(await actions.claim(worker.id)).toEqual({ action: 'claim', sessionId: worker.id, message: expect.any(String) });
      expect(await actions.release(worker.id, true)).toEqual({
        action: 'release', sessionId: worker.id, resumed: true, message: expect.any(String),
      });
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('spawns a worker for the highest-priority dispatchable task', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      const { argus, board, tasks } = seedFleet(fixture.root, { tasks: 2 });
      const [low, high] = tasks;
      getDb(fixture.root).prepare('UPDATE tasks SET priority = 1 WHERE id = ?').run(high.id);
      const actions = new FleetActions(fixture.root);
      const result = await actions.spawnNext(argus.id);
      expect(result).toMatchObject({ action: 'spawn', taskId: high.id });
      expect(board.get(high.id)?.status).toBe('assigned');
      expect(board.get(low.id)?.status).toBe('pending');
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('rejects spawning without an argus, without a task, or at the child limit', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      const actions = new FleetActions(fixture.root);
      await expect(actions.spawnNext('nope')).rejects.toThrow(/not found/);

      const { argus } = seedFleet(fixture.root, { tasks: 0 });
      await expect(actions.spawnNext(argus.id)).rejects.toThrow(/no dispatchable task/);

      const full = seedFleet(fixture.root, { tasks: 1, limit: 2 });
      getDb(fixture.root)
        .prepare('UPDATE argus SET child_limit = 2 WHERE id = ?')
        .run(full.argus.id);
      // Simulate a full fleet by making both worker sessions running.
      const second = new SessionManager(fixture.root).createSession({
        name: 'worker-2', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: full.argus.id,
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id IN (?, ?)")
        .run(full.worker.id, second.id);
      await expect(actions.spawnNext(full.argus.id)).rejects.toThrow(/child limit/);
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('kills a worker, blocks its active task, and preserves the worktree', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      const { board, tasks, worker } = seedFleet(fixture.root, { tasks: 1 });
      const task = tasks[0];
      const worktree = path.join(fixture.root, '.flightdeck', 'worktrees', 'kill-keep');
      fs.mkdirSync(worktree, { recursive: true });
      fs.writeFileSync(path.join(worktree, 'proof.txt'), 'work');
      getDb(fixture.root)
        .prepare("UPDATE sessions SET cwd = ?, status = 'running' WHERE id = ?")
        .run(worktree, worker.id);
      board.assign(task.id, worker.id);

      const actions = new FleetActions(fixture.root);
      const result = await actions.kill(worker.id);
      expect(result).toMatchObject({ action: 'kill', sessionId: worker.id, taskId: task.id });
      expect(new SessionManager(fixture.root).get(worker.id)?.status).toBe('stopped');
      expect(board.get(task.id)?.status).toBe('blocked');
      expect(String(board.get(task.id)?.verdictReason)).toContain('killed by human');
      expect(fs.existsSync(worktree)).toBe(true);
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('records a human override through the shared action', () => {
    const fixture = makeRepo();
    try {
      const { argus, board, tasks } = seedFleet(fixture.root, { tasks: 1 });
      const actions = new FleetActions(fixture.root);
      actions.accept(tasks[0].id, argus.id);
      expect(board.get(tasks[0].id)?.status).toBe('done');
      actions.reject(tasks[0].id, 'not good enough', argus.id);
      expect(board.get(tasks[0].id)?.status).toBe('revising');
      actions.unblock(tasks[0].id, argus.id);
      expect(board.get(tasks[0].id)?.status).toBe('pending');
    } finally {
      fixture.cleanup();
    }
  });

  it('force-reviews through the manager', async () => {
    const fixture = makeRepo();
    try {
      const { argus, board, tasks } = seedFleet(fixture.root, { tasks: 1 });
      const task = tasks[0];
      board.assign(task.id, 'w0');
      board.report(task.id, { summary: 's', filesChanged: [], testsRun: '', uncertainties: '' });
      board.beginGating(task.id);
      board.recordGates(task.id, { testExitCode: 0, lintExitCode: 0, failureTail: '' }, '');
      const actions = new FleetActions(fixture.root);
      const result = await actions.forceReview(argus.id);
      expect(result).toMatchObject({ action: 'force-review' });
    } finally {
      fixture.cleanup();
    }
  });
});
