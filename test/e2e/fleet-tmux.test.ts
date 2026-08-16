import { describe, it, expect, afterAll } from 'vitest';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

const tmux = new Tmux();
const hasTmux = tmux.hasTmux();
const created: string[] = [];

afterAll(() => {
  for (const name of created) {
    tmux.killSessionByName(name);
  }
});

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
});
