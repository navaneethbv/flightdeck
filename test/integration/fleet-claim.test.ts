import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('claim and release', () => {
  it('respawns the pane interactively and keeps the MCP config and token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      await sm.startSession(worker.id, {
        headless: true, prompt: 'work', waitForExit: true,
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      const mcpConfig = path.join(fixture.root, '.mcp.json');
      expect(fs.existsSync(mcpConfig)).toBe(true);
      const before = fs.readFileSync(mcpConfig, 'utf8');

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).claim(worker.id);

      const respawn = calls.find((c) => c[0] === 'respawn-pane');
      expect(respawn).toBeDefined();
      expect(respawn![3]).toBe('%5');
      expect(respawn!.slice(respawn!.indexOf('--') + 1)).toEqual(['claude']);
      // The token must appear nowhere in the tmux invocation, including in a
      // -e value: every tmux argument is visible to `ps`.
      expect(respawn!.join(' ')).not.toContain(worker.token);

      // The MCP config and token survive, so worker tools keep working.
      expect(fs.readFileSync(mcpConfig, 'utf8')).toBe(before);
      expect(sm.get(worker.id)?.token).toBe(worker.token);
      expect(sm.get(worker.id)?.claimedAt).not.toBeNull();
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('passes the session id but never the token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).claim(worker.id);

      const respawn = calls.find((c) => c[0] === 'respawn-pane')!;
      const envFlags = respawn.filter((_, i) => respawn[i - 1] === '-e');
      expect(envFlags).toContain(`FLIGHTDECK_SESSION_ID=${worker.id}`);
      // Nothing reads FLIGHTDECK_SESSION_TOKEN from the environment, and the
      // generated MCP config already carries the token to the MCP server. So
      // claim passes it nowhere, and no `ps` ever sees it.
      expect(envFlags.some((f) => f.startsWith('FLIGHTDECK_SESSION_TOKEN'))).toBe(false);
      expect(envFlags.join(' ')).not.toContain(worker.token);
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('clears claimed_at and returns the pane to following on release', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running', claimed_at = 123 WHERE id = ?")
        .run(worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).release(worker.id);

      expect(sm.get(worker.id)?.claimedAt).toBeNull();
      const respawn = calls.find((c) => c[0] === 'respawn-pane')!;
      expect(respawn.join(' ')).toContain('session follow');
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses to claim a session that has no pane', async () => {
    const fixture = makeRepo();
    try {
      const worker = new SessionManager(fixture.root).createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      const { run } = fakeRunner([{ status: 0, stdout: '%0\t\tconsole\n', stderr: '' }]);
      await expect(
        new FleetManager(fixture.root, new Tmux(run)).claim(worker.id)
      ).rejects.toThrow(/no fleet pane/);
    } finally {
      fixture.cleanup();
    }
  });
});
