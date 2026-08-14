import { describe, it, expect } from 'vitest';
import { NotesStore } from '../../src/notes/store.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager, parseTasks } from '../../src/argus/manager.js';
import { makeRepo, makeFakeHarness, spawnCli, sleep } from '../helpers.js';

describe('Argus', () => {
  it('parses tasks from a mission note', () => {
    expect(parseTasks('- fix the bug\n- ship the feature\n')).toEqual(['fix the bug', 'ship the feature']);
    expect(parseTasks('single task text')).toEqual(['single task text']);
    expect(parseTasks('')).toEqual([]);
  });

  it('spawns children and records progress on pulse', async () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('claude');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('mission', '- implement the login endpoint\n- write tests\n- update the README');
      const manager = new ArgusManager(fixture.root);
      const argus = manager.start({ name: 'e2e', missionNoteId: mission.id, childLimit: 2, pulseSec: 1 });

      await manager.pulse(argus.id);
      const fleet = manager.fleet(argus.id);
      expect(fleet.children.length).toBeGreaterThanOrEqual(1);
      expect(fleet.recentProgress.length).toBeGreaterThan(0);

      await manager.pulse(argus.id);
      const fleet2 = manager.fleet(argus.id);
      expect(fleet2.children.length).toBeLessThanOrEqual(2);

      const sessions = new SessionManager(fixture.root).list();
      for (const child of fleet2.children) {
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
    const fake = makeFakeHarness('claude');
    const notes = new NotesStore(fixture.root);
    const mission = notes.createNote('mission', '- task one\n- task two');
    try {
      const child = spawnCli(
        ['argus', 'start', '--name', 'e2e-loop', '--mission', mission.id, '--children', '2', '--pulse', '1s'],
        { cwd: fixture.root, env: { PATH: `${fake.binDir}:${process.env.PATH ?? ''}` } }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d));

      await sleep(4500);

      const manager = new ArgusManager(fixture.root);
      const argus = manager.list().find((a) => a.name === 'e2e-loop');
      expect(argus).toBeDefined();
      expect(argus!.status).toBe('running');
      const fleet = manager.fleet(argus!.id);
      expect(fleet.children.length).toBeGreaterThanOrEqual(1);

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
      expect(code).toBe(0);
      expect(manager.get(argus!.id)!.status).toBe('stopped');
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
