import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArgusManager, type BrainFn } from '../../src/argus/manager.js';
import { getDb } from '../../src/core/state.js';
import { NotesStore } from '../../src/notes/store.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo } from '../helpers.js';

describe('Argus stop issued from another process', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it('keeps the in-flight pulse from dispatching workers after the stop', async () => {
    const mission = new NotesStore(fixture.root).createNote('mission', 'two tasks');
    // `deck argus stop` runs in its own process with its own ArgusManager, so
    // the running loop only learns about the stop through the database row.
    const brain: BrainFn = async (root, argusId, opts) => {
      if (opts.label !== 'plan') return '{}';
      await new ArgusManager(root).stop(argusId);
      return JSON.stringify({
        tasks: [
          { title: 'Task A', spec: 'Do A', depends_on: [] },
          { title: 'Task B', spec: 'Do B', depends_on: [] },
        ],
      });
    };
    const manager = new ArgusManager(fixture.root, brain);
    const argus = manager.start({ name: 'stop-mid-pulse', missionNoteId: mission.id });
    // start() creates the row stopped; runForever flips it to running before pulsing.
    getDb(fixture.root).prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(argus.id);

    await manager.pulse(argus.id);

    const workers = new SessionManager(fixture.root)
      .list()
      .filter((s) => s.argusParent === argus.id && s.policy === 'child');
    expect(workers).toHaveLength(0);
  });
});
