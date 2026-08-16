import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NotesStore } from '../../src/notes/store.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { TablesStore } from '../../src/tables/store.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, makeFakeHarness, spawnCli } from '../helpers.js';

/** Polls `probe` until it returns a truthy value or `timeoutMs` elapses. */
async function waitFor<T>(probe: () => T | null, timeoutMs = 15000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('timed out waiting for the argus fleet to be ready');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A fake brain that returns a fixed plan, so no model is ever invoked. */
function fakeBrain(planJson: string) {
  return async (_root: string, _argusId: string, opts: { label: string }): Promise<string> =>
    opts.label === 'plan' ? planJson : '{}';
}

/**
 * A binDir with a claude that plans via JSON and an opencode that just echoes,
 * so a real CLI fleet loop stays hermetic: the brain call returns board rows
 * and the spawned workers are inert.
 */
function makeFleetHarness(): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  const claude =
    "#!/bin/bash\necho '{\"tasks\":[{\"title\":\"task one\",\"spec\":\"do task one\",\"depends_on\":[]},{\"title\":\"task two\",\"spec\":\"do task two\",\"depends_on\":[]}]}'\nexit 0\n";
  fs.writeFileSync(path.join(binDir, 'claude'), claude, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, 'opencode'), '#!/bin/bash\nwhile true; do sleep 1; done\n', { mode: 0o755 });
  return { binDir, cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }) };
}

describe('Argus', () => {
  it('turns a mission into board rows and spawns workers on pulse', async () => {
    const fixture = makeRepo();
    const fake = makeFleetHarness();
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const brain = fakeBrain(
        '{"tasks":[{"title":"login","spec":"add login","depends_on":[]},{"title":"tests","spec":"test login","depends_on":[]}]}'
      );
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('mission', '- implement the login endpoint\n- write tests\n- update the README');
      const manager = new ArgusManager(fixture.root, brain);
      const argus = manager.start({ name: 'e2e', missionNoteId: mission.id, childLimit: 2, pulseSec: 1 });
      // Dispatch reads worker_harnesses; pin it to the fake claude so no real
      // opencode process is spawned.
      getDb(fixture.root)
        .prepare('UPDATE argus SET worker_harnesses = ? WHERE id = ?')
        .run('["claude"]', argus.id);

      await manager.pulse(argus.id);

      const board = new TaskBoard(fixture.root);
      const tasks = board.list(argus.id);
      expect(tasks).toHaveLength(2);
      expect(tasks[0].status).toBe('assigned');

      const fleet = manager.fleet(argus.id);
      expect(fleet.children.length).toBeGreaterThanOrEqual(1);
      expect(fleet.recentProgress.length).toBeGreaterThan(0);

      await manager.pulse(argus.id);
      expect(new TaskBoard(fixture.root).list(argus.id)).toHaveLength(2);

      const sessions = new SessionManager(fixture.root).list();
      for (const child of manager.fleet(argus.id).children) {
        const s = child.session!;
        expect(sessions.find((x) => x.id === s.id)?.policy).toBe('child');
      }
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('runs the full argus start loop and stops gracefully', async () => {
    const fixture = makeRepo();
    const fake = makeFleetHarness();
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- task one\n- task two');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'e2e-loop', '--mission', mission.id, '--children', '2', '--pulse', '1s'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));

      await waitFor(() => {
        const found = new ArgusManager(fixture.root).list().find((a) => a.name === 'e2e-loop');
        if (!found || found.status !== 'running') return null;
        const board = new TaskBoard(fixture.root).list(found.id);
        if (board.length !== 2) return null;
        const fleet = new ArgusManager(fixture.root).fleet(found.id);
        if (fleet.children.length < 1) return null;
        // The session row exists as soon as createSession assigns the task, but
        // the spawn completes only when writeProgress records 'worker_spawned'.
        // Wait for the event so the post-poll assertion cannot race it.
        const events = fleet.recentProgress.map((p) => String(p.event));
        if (!events.includes('worker_spawned')) return null;
        return found;
      });

      const manager = new ArgusManager(fixture.root);
      const argus = manager.list().find((a) => a.name === 'e2e-loop');
      expect(argus, `stderr: ${stderr}`).toBeDefined();
      expect(argus!.status).toBe('running');
      // The fake claude brain plans the mission into board rows; the loop then
      // dispatches workers against them.
      expect(new TaskBoard(fixture.root).list(argus!.id)).toHaveLength(2);
      const fleet = manager.fleet(argus!.id);
      expect(fleet.children.length).toBeGreaterThanOrEqual(1);
      expect(fleet.recentProgress.map((p) => String(p.event))).toEqual(
        expect.arrayContaining(['planned', 'worker_spawned'])
      );

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
      expect(code).toBe(0);
      expect(manager.get(argus!.id)!.status).toBe('stopped');
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('stops its worker sessions when the manager is signalled', async () => {
    const fixture = makeRepo();
    const fake = makeFleetHarness();
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- task one\n- task two');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'e2e-stop', '--mission', mission.id, '--children', '2', '--pulse', '1s'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );

      await waitFor(() => {
        const found = new ArgusManager(fixture.root).list().find((a) => a.name === 'e2e-stop');
        if (!found || found.status !== 'running') return null;
        const sessions = new SessionManager(fixture.root).list().filter((s) => s.policy === 'child');
        if (sessions.length < 2 || !sessions.every((s) => s.status === 'running')) return null;
        return found;
      });

      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('close', resolve));

      const sessions = new SessionManager(fixture.root).list().filter((s) => s.policy === 'child');
      expect(sessions.length).toBeGreaterThan(0);
      for (const s of sessions) {
        expect(s.status, `child ${s.name} was orphaned`).not.toBe('running');
      }
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
