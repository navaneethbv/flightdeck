import { describe, it, expect } from 'vitest';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('FleetManager', () => {
  it('names the tmux session deterministically from the project root', () => {
    const fixture = makeRepo();
    try {
      const a = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).tmuxSessionName();
      const b = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).tmuxSessionName();
      expect(a).toBe(b);
      expect(a).toMatch(/^flightdeck-[0-9a-f]{8}$/);
    } finally {
      fixture.cleanup();
    }
  });

  it('excludes brain sessions from the fleet', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      sm.createSession({
        name: 'b1', harness: 'claude', cwd: fixture.root, policy: 'brain',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const fleet = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).fleetSessions();
      expect(fleet.map((s) => s.id)).toEqual([worker.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('splits a pane and tags it when a worker has none', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      // list-panes returns only the console pane, then split-window returns %5.
      const { run, calls } = fakeRunner([
        { status: 0, stdout: '%0\t\tconsole\n', stderr: '' },
        { status: 0, stdout: '%5\n', stderr: '' },
      ]);
      new FleetManager(fixture.root, new Tmux(run)).reconcile();

      const split = calls.find((c) => c[0] === 'split-window');
      expect(split).toBeDefined();
      expect(split!.join(' ')).toContain('session follow');
      expect(split!.join(' ')).toContain(worker.id);

      const tag = calls.find((c) => c[0] === 'set-option');
      expect(tag).toEqual(['set-option', '-p', '-t', '%5', '@fd_session', worker.id]);
      expect(calls.some((c) => c[0] === 'select-layout')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('kills a pane whose session has been gone past the grace period', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'stopped', ended_at = ? WHERE id = ?")
        .run(now() - 120_000, worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      new FleetManager(fixture.root, new Tmux(run)).reconcile();

      expect(calls.some((c) => c[0] === 'kill-pane' && c[2] === '%5')).toBe(true);
      expect(calls.some((c) => c[0] === 'split-window')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('creates the tmux session only when it is absent', () => {
    const fixture = makeRepo();
    try {
      const present = fakeRunner([{ status: 0, stdout: '', stderr: '' }]);
      new FleetManager(fixture.root, new Tmux(present.run)).ensureSession();
      expect(present.calls.some((c) => c[0] === 'new-session')).toBe(false);

      const absent = fakeRunner([{ status: 1, stdout: '', stderr: '' }]);
      new FleetManager(fixture.root, new Tmux(absent.run)).ensureSession();
      expect(absent.calls.some((c) => c[0] === 'new-session')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('stopWorker stops the process but refuses brain and manager sessions', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);
      const brain = sm.createSession({
        name: 'b1', harness: 'claude', cwd: fixture.root, policy: 'brain',
      });
      const manager = new FleetManager(fixture.root, new Tmux(fakeRunner().run));

      await manager.stopWorker(worker.id);
      expect(sm.get(worker.id)?.status).toBe('stopped');
      await expect(manager.stopWorker(brain.id)).rejects.toThrow(/not a worker/);
    } finally {
      fixture.cleanup();
    }
  });
});
