import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { runCli, makeRepo } from '../helpers.js';

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

      const result = runCli(['fleet', 'override', 'accept', task.id], { cwd: fixture.root });
      expect(result.code).toBe(0);
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

      const result = runCli(['fleet', 'override', 'prioritize', b.id], { cwd: fixture.root });
      expect(result.code).toBe(0);
      expect(board.dispatchable(argus.id).map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      fixture.cleanup();
    }
  });
});
