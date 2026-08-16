import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../../src/core/state.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { invokeBrain } from '../../src/argus/brain.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

function seedArgus(root: string): void {
  getDb(root)
    .prepare(
      "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, brain_harness) VALUES ('a1', 'a', ?, 'cap', 4, 60, 'running', ?, 'claude')"
    )
    .run(root, now());
}

describe('brain sessions', () => {
  it('never writes an MCP config, so a brain can never hold a session token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({
        name: 'brain-1',
        harness: 'claude',
        cwd: fixture.root,
        policy: 'brain',
      });
      await manager.startSession(session.id, {
        headless: true,
        prompt: 'hi',
        waitForExit: true,
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      const fs = await import('node:fs');
      expect(fs.existsSync(`${fixture.root}/.mcp.json`)).toBe(false);
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('returns the brain stdout and records a brain-policy session', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    fs.writeFileSync(
      path.join(harness.binDir, 'claude'),
      '#!/bin/bash\necho "fake claude ran with: $@"\nexit 0\n',
      { mode: 0o755 }
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      seedArgus(fixture.root);
      const stdout = await invokeBrain(fixture.root, 'a1', {
        prompt: 'plan this',
        model: null,
        label: 'plan',
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      expect(stdout).toContain('fake claude ran with');

      const sessions = new SessionManager(fixture.root)
        .list()
        .filter((s) => s.policy === 'brain');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].argusParent).toBe('a1');
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });
});
