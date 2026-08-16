import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { runCli, makeRepo } from '../helpers.js';

function makeBin(name: string): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  fs.writeFileSync(path.join(binDir, name), '#!/bin/bash\necho fake\nexit 0\n', { mode: 0o755 });
  return { binDir, cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }) };
}

describe('fleet CLI', () => {
  it('reports fleet status as JSON without needing tmux', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['fleet', 'status', '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { tmux: boolean; sessions: unknown[] };
      expect(parsed).toHaveProperty('tmux');
      expect(Array.isArray(parsed.sessions)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails clearly when tmux is missing', () => {
    const fixture = makeRepo();
    try {
      // An empty PATH guarantees tmux cannot be found.
      const result = runCli(['fleet'], { cwd: fixture.root, env: { PATH: '/nonexistent' } });
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/tmux/i);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a task through the override subcommand', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);

      const result = runCli(['fleet', 'override', 'accept', task.id, '--argus', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { action: string; taskId: string };
      expect(parsed.action).toBe('accept');
      expect(parsed.taskId).toBe(task.id);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('prioritizes a task through the override subcommand', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [a, b] = board.create(argus.id, [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);

      const result = runCli(['fleet', 'override', 'prioritize', b.id, '--argus', argus.id], { cwd: fixture.root });
      expect(result.code).toBe(0);
      expect(board.dispatchable(argus.id).map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses a task override when multiple fleets exist without --argus', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      manager.start({ name: 'one' });
      manager.start({ name: 'two' });

      const result = runCli(['fleet', 'override', 'accept', 'anything'], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/multiple fleets/);
    } finally {
      fixture.cleanup();
    }
  });

  it('spawns one worker for the next dispatchable task with --json', async () => {
    const fixture = makeRepo();
    const fake = makeBin('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet', workerHarnesses: ['opencode'] });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);

      const result = runCli(['fleet', 'worker', 'start', '--argus', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { action: string; taskId: string };
      expect(parsed.action).toBe('spawn');
      expect(parsed.taskId).toBe(task.id);
      expect(board.get(task.id)?.status).toBe('assigned');
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('refuses to kill without --yes in a non-interactive process', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: argus.id,
      });

      const result = runCli(['fleet', 'kill', worker.id], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/confirm|--yes/);
    } finally {
      fixture.cleanup();
    }
  });

  it('kills a worker and blocks its active task with --yes --json', () => {
    const fixture = makeRepo();
    const fake = makeBin('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);
      const worker = new SessionManager(fixture.root).createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: argus.id,
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);
      board.assign(task.id, worker.id);

      const result = runCli(['fleet', 'kill', worker.id, '--yes', '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { action: string; taskId: string };
      expect(parsed.action).toBe('kill');
      expect(parsed.taskId).toBe(task.id);
      expect(board.get(task.id)?.status).toBe('blocked');
      expect(new SessionManager(fixture.root).get(worker.id)?.status).toBe('stopped');
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('releases with --resume --json through the shared action shape', () => {
    const fixture = makeRepo();
    const fake = makeBin('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const worker = new SessionManager(fixture.root).createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: argus.id,
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running', claimed_at = 123 WHERE id = ?")
        .run(worker.id);

      const result = runCli(['fleet', 'release', worker.id, '--resume', '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { action: string; resumed: boolean };
      expect(parsed.action).toBe('release');
      expect(parsed.resumed).toBe(true);
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
