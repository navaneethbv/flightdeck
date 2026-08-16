import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('real harness spawn guard', () => {
  it('refuses to start a session whose binary is not a fixture stub', async () => {
    const fixture = makeRepo();
    // The guard's boundary is "resolves inside os.tmpdir()". A real install
    // must be simulated outside that boundary rather than relying on whether
    // opencode happens to be installed on the machine running this test: CI
    // runners have no coding-agent binaries installed at all, so `which`
    // would find nothing, the guard would allow the spawn as unenforceable,
    // and the process would merely fail with ENOENT instead of the guard's
    // own rejection, which is what this test must assert.
    const realDir = fs.mkdtempSync(path.join(os.homedir(), '.flightdeck-real-bin-'));
    fs.writeFileSync(path.join(realDir, 'opencode'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${realDir}:${oldPath ?? ''}`;
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
      ).rejects.toThrow(/refusing to spawn the real "opencode" binary/);
    } finally {
      process.env.PATH = oldPath ?? '';
      fs.rmSync(realDir, { recursive: true, force: true });
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
