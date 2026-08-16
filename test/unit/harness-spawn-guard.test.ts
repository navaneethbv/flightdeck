import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('real harness spawn guard', () => {
  it('refuses to start a session whose binary is not a fixture stub', async () => {
    const fixture = makeRepo();
    try {
      const sessions = new SessionManager(fixture.root);
      const session = sessions.createSession({
        name: 'w1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
      });
      // No stub on PATH: this would otherwise resolve the real binary.
      await expect(
        sessions.startSession(session.id, { headless: true, prompt: 'x', waitForExit: true })
      ).rejects.toThrow(/refusing to spawn the real "opencode" binary/);
    } finally {
      fixture.cleanup();
    }
  });

  it('allows a stub inside the temporary fixture directory', async () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('opencode');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    try {
      const sessions = new SessionManager(fixture.root);
      const session = sessions.createSession({
        name: 'w1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
      });
      await expect(
        sessions.startSession(session.id, { headless: true, prompt: 'x', waitForExit: true })
      ).resolves.toBeDefined();
    } finally {
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
