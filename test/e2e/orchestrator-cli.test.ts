import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { runCli, makeRepo } from '../helpers.js';

describe('orchestrator CLI', () => {
  it('prints the board as JSON', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      new TaskBoard(fixture.root).create(argus.id, [
        { title: 'first task', spec: 'do it', dependsOn: [] },
      ]);

      const result = runCli(['argus', 'board', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { title: string; status: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].title).toBe('first task');
      expect(parsed[0].status).toBe('pending');
    } finally {
      fixture.cleanup();
    }
  });

  it('prints the budget with its tier', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });

      const result = runCli(['argus', 'budget', argus.id, '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { spent: number; tier: string };
      expect(parsed.spent).toBe(0);
      expect(parsed.tier).toBe('normal');
    } finally {
      fixture.cleanup();
    }
  });

  it('exits non-zero for an unknown argus id', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['argus', 'budget', 'nope', '--json'], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
