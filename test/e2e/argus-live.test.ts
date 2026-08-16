import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { TelemetryStore } from '../../src/sessions/telemetry.js';
import { NotesStore } from '../../src/notes/store.js';
import { saveConfig } from '../../src/core/config.js';
import { spawnCli, sleep } from '../helpers.js';

const LIVE = process.env.FLIGHTDECK_LIVE_ARGUS_E2E === '1';

function hasBinary(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe('argus live topology (opt-in)', () => {
  it(
    'runs a Codex brain with an OpenCode worker end to end',
    { timeout: 120000, skip: !LIVE || !hasBinary('codex') || !hasBinary('opencode') },
    async () => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-live-'));
      const previousGuard = process.env.FLIGHTDECK_FORBID_REAL_HARNESS;
      delete process.env.FLIGHTDECK_FORBID_REAL_HARNESS;
      try {
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fixture });
        execFileSync('git', ['config', 'user.email', 'live@example.com'], { cwd: fixture });
        execFileSync('git', ['config', 'user.name', 'Live Test'], { cwd: fixture });
        fs.writeFileSync(path.join(fixture, 'proof.txt'), 'init\n');
        execFileSync('git', ['add', '.'], { cwd: fixture });
        execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: fixture });

        saveConfig({
          defaultHarness: 'opencode',
          profileDir: {},
          argus: {
            defaultPulseSec: 2,
            defaultChildLimit: 2,
            allowedLimits: [2, 4, 8, 16],
            gateTestCommand: 'grep -q "OpenCode worker completed" proof.txt',
            gateLintCommand: '',
          },
          models: {},
        });

        const mission = new NotesStore(fixture).createNote(
          'mission',
          'Plan exactly one task. The worker must append the line "OpenCode worker completed" to the file proof.txt, verify it with `grep -q "OpenCode worker completed" proof.txt`, then call report_done with an honest summary.'
        );

        const child = spawnCli(
          [
            'argus', 'start',
            '--name', 'codex-opencode',
            '--mission', mission.id,
            '--brain-harness', 'codex',
            '--brain-plan-model', 'gpt-5.6-sol',
            '--brain-review-model', 'gpt-5.6-terra',
            '--worker-harness', 'opencode',
            '--budget-window', '1h',
            '--budget-max-tokens', '100000',
            '--children', '2',
            '--pulse', '2s',
          ],
          { cwd: fixture }
        );

        const board = new TaskBoard(fixture);
        const manager = new ArgusManager(fixture);
        let argus = manager.list().find((a) => a.name === 'codex-opencode');
        const deadline = Date.now() + 110_000;
        while (Date.now() < deadline && !argus) {
          await sleep(500);
          argus = manager.list().find((a) => a.name === 'codex-opencode');
        }
        expect(argus, 'argus row should appear').toBeDefined();

        while (Date.now() < deadline) {
          await sleep(2000);
          const tasks = board.list(argus!.id);
          if (tasks.length > 0 && tasks[0].status === 'done') break;
        }

        const done = board.list(argus!.id).find((t) => t.status === 'done');
        expect(done, 'the task should reach done').toBeDefined();
        const worker = new SessionManager(fixture).get(done!.assigneeSession!);

        expect(argus!.brainHarness).toBe('codex');
        expect(argus!.workerHarnesses).toEqual(['opencode']);
        expect(board.list(argus!.id)).toHaveLength(1);
        expect(done!.workerReport).not.toBeNull();
        expect(fs.readFileSync(path.join(worker!.cwd, 'proof.txt'), 'utf8')).toContain(
          'OpenCode worker completed'
        );
        const brainSession = new SessionManager(fixture)
          .list()
          .find((session) => session.policy === 'brain' && session.argusParent === argus!.id);
        expect(brainSession).toBeDefined();
        expect(new TelemetryStore(fixture).get(brainSession!.id)?.model).not.toBeNull();

        child.kill('SIGTERM');
      } finally {
        if (previousGuard !== undefined) process.env.FLIGHTDECK_FORBID_REAL_HARNESS = previousGuard;
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        saveConfig({
          defaultHarness: 'claude',
          profileDir: {},
          argus: {
            defaultPulseSec: 60,
            defaultChildLimit: 8,
            allowedLimits: [2, 4, 8, 16],
            gateTestCommand: 'npm test',
            gateLintCommand: 'npm run lint',
          },
          models: {},
        });
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    }
  );
});
