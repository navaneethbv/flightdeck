import { describe, it, expect, afterAll } from 'vitest';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { cliEntryPath } from '../../src/core/cliEntry.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, sleep } from '../helpers.js';

const tmux = new Tmux();
const hasTmux = tmux.hasTmux();
const created: string[] = [];

afterAll(() => {
  for (const name of created) {
    tmux.killSessionByName(name);
  }
});

function sendKeys(paneId: string, keys: string): void {
  tmux.run(['send-keys', '-t', paneId, keys]);
}

/** Whether the OS process behind a pane is still running. Distinguishes a
 * genuinely stuck-but-alive process (slow CI cold start) from one that has
 * exited without tmux yet reflecting it. */
function paneProcessAlive(paneId: string): boolean {
  const pid = tmux.run(['display-message', '-p', '-t', paneId, '#{pane_pid}']).stdout.trim();
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until the console pane has rendered the workers section. */
async function waitForConsole(paneId: string, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    last = tmux.run(['capture-pane', '-t', paneId, '-p', '-S', '-200']).stdout;
    if (last.includes('Workers')) return;
    const alive = tmux.run(['list-panes', '-t', paneId, '-F', '#{pane_dead}']).stdout.trim();
    if (alive === '1') throw new Error(`console pane exited early; pane contents:\n${last}`);
    if (Date.now() > deadline) {
      const processAlive = paneProcessAlive(paneId);
      throw new Error(
        `console pane never rendered (pane process alive: ${processAlive}); pane contents:\n${last}`
      );
    }
    await sleep(250);
  }
}

describe.skipIf(!hasTmux)('fleet window against real tmux', () => {
  it('creates a session, reconciles a worker pane, and tags it', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const fleet = new FleetManager(fixture.root);
      created.push(fleet.tmuxSessionName());

      fleet.ensureSession();
      expect(tmux.sessionExists(fleet.tmuxSessionName())).toBe(true);

      fleet.reconcile();
      const panes = tmux.listPanes(fleet.tmuxSessionName());
      expect(panes.length).toBeGreaterThanOrEqual(2);
      expect(panes.some((p) => p.sessionId === worker.id)).toBe(true);

      // Reconcile is idempotent: a second pass must add nothing.
      fleet.reconcile();
      expect(tmux.listPanes(fleet.tmuxSessionName())).toHaveLength(panes.length);
    } finally {
      fixture.cleanup();
    }
  });

  it('keeps panes stable while the console selects workers and tasks', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet', workerHarnesses: ['opencode'] });
      const board = new TaskBoard(fixture.root);
      const [a, b] = board.create(argus.id, [
        { title: 'a', spec: 'do a', dependsOn: [] },
        { title: 'b', spec: 'do b', dependsOn: [] },
      ]);

      const workerA = sm.createSession({
        name: 'worker-a', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: argus.id,
      });
      const workerB = sm.createSession({
        name: 'worker-b', harness: 'opencode', cwd: fixture.root, policy: 'child', argusParent: argus.id,
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id IN (?, ?)")
        .run(workerA.id, workerB.id);

      const fleet = new FleetManager(fixture.root);
      created.push(fleet.tmuxSessionName());
      new Tmux().newSession(
        fleet.tmuxSessionName(),
        fixture.root,
        [process.execPath, cliEntryPath(), 'fleet', 'console', '--project', fixture.root],
        { width: 200, height: 60 }
      );
      fleet.reconcile();
      const before = tmux.listPanes(fleet.tmuxSessionName());
      expect(before.length).toBeGreaterThanOrEqual(3);

      // Exercise a non-destructive action through the console: the focus starts
      // on workers; Tab moves to tasks, then p prioritizes the selected task.
      const consolePane = before.find((p) => p.sessionId === null);
      expect(consolePane, 'console pane must exist').toBeDefined();
      tmux.run(['select-pane', '-t', consolePane!.paneId]);
      await waitForConsole(consolePane!.paneId);
      sendKeys(consolePane!.paneId, 'Tab');
      await sleep(400);
      sendKeys(consolePane!.paneId, 'p');
      await sleep(800);

      // Pane count and pane-session metadata remain stable.
      const after = tmux.listPanes(fleet.tmuxSessionName());
      expect(after).toHaveLength(before.length);
      for (const p of before) {
        const now = after.find((q) => q.paneId === p.paneId);
        expect(now?.sessionId).toBe(p.sessionId);
      }

      // The prioritize action routed through the reducer calls the shared
      // FleetActions service, which bumps the priority of the selected task.
      const selected = board.get(a.id);
      expect(selected?.priority).toBeGreaterThan(0);
      expect(board.get(b.id)?.priority).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});
