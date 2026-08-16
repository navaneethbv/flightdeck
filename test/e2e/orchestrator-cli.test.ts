import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { runCli, spawnCli, makeRepo } from '../helpers.js';

/** Polls `probe` until it returns a truthy value or `timeoutMs` elapses. */
async function waitFor<T>(probe: () => T | null, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the argus fleet to be created');
    await new Promise((r) => setTimeout(r, 100));
  }
}

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

  it('documents the Codex brain and OpenCode worker flags', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['argus', 'start', '--help'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--brain-harness <claude|codex>');
      expect(result.stdout).toContain('--worker-harness <opencode|gemini>');
      expect(result.stdout).toContain('--budget-max-tokens <count>');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an invalid brain before starting the foreground loop', () => {
    const fixture = makeRepo();
    try {
      const result = runCli([
        'argus',
        'start',
        '--mission-body',
        'test mission',
        '--brain-harness',
        'opencode',
      ], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('brain harness must be claude or codex');
    } finally {
      fixture.cleanup();
    }
  });

  it('starts with a Codex brain and OpenCode worker through the configured flags', async () => {
    const fixture = makeRepo();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    const codex =
      "#!/bin/bash\necho '{\"tasks\":[{\"title\":\"task one\",\"spec\":\"do task one\",\"depends_on\":[]}]}'\nexit 0\n";
    fs.writeFileSync(path.join(binDir, 'codex'), codex, { mode: 0o755 });
    fs.writeFileSync(path.join(binDir, 'opencode'), '#!/bin/bash\necho "fake opencode ran with: $@"\nexit 0\n', { mode: 0o755 });
    try {
      const child = spawnCli(
        [
          'argus', 'start',
          '--name', 'codex-opencode',
          '--mission-body', 'implement one task',
          '--brain-harness', 'codex',
          '--brain-plan-model', 'gpt-5.6-sol',
          '--brain-review-model', 'gpt-5.6-terra',
          '--worker-harness', 'opencode',
          '--budget-window', '2h',
          '--budget-max-tokens', '250000',
          '--children', '2',
          '--pulse', '1s',
        ],
        { cwd: fixture.root, env: { PATH: `${binDir}:${process.env.PATH ?? ''}` } }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));

      await waitFor(() => {
        const found = new ArgusManager(fixture.root).list().find((a) => a.name === 'codex-opencode');
        return found ?? null;
      });

      const manager = new ArgusManager(fixture.root);
      const argus = manager.list().find((a) => a.name === 'codex-opencode');
      expect(argus, `stderr: ${stderr}`).toBeDefined();
      expect(argus!.brainHarness).toBe('codex');
      expect(argus!.brainPlanModel).toBe('gpt-5.6-sol');
      expect(argus!.brainReviewModel).toBe('gpt-5.6-terra');
      expect(argus!.workerHarnesses).toEqual(['opencode']);
      expect(argus!.budgetWindowSec).toBe(7200);
      expect(argus!.budgetMaxTokens).toBe(250000);
      await waitFor(() => {
        const tasks = new TaskBoard(fixture.root).list(argus!.id);
        return tasks.length === 1 ? tasks : null;
      });
      expect(new TaskBoard(fixture.root).list(argus!.id)).toHaveLength(1);

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
      expect(code).toBe(0);
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});
