import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, now } from '../../src/core/state.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { invokeBrain } from '../../src/argus/brain.js';
import { createQuota, quotaSpent } from '../../src/argus/quota.js';
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

  it("records quota usage using the quota's own countCacheReads, not the mission's default", async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    fs.writeFileSync(
      path.join(harness.binDir, 'claude'),
      `#!/bin/bash\necho '{"type":"result","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":30}}'\nexit 0\n`,
      { mode: 0o755 }
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${harness.binDir}:${oldPath ?? ''}`;
    try {
      const quotaId = `quota-${crypto.randomUUID().slice(0, 8)}`;
      // countCacheReads: false on the quota, while the mission row below
      // still carries budget_count_cache_reads = 1 (the default), so this
      // only passes if invokeBrain reads the quota's own setting.
      createQuota(quotaId, { maxTokens: 10000, windowSec: 3600, countCacheReads: false });
      getDb(fixture.root)
        .prepare(
          "INSERT INTO argus (id, name, project_root, cap, child_limit, pulse_sec, status, created_at, brain_harness, quota_id, budget_count_cache_reads) VALUES ('a2', 'a', ?, 'cap', 4, 60, 'running', ?, 'claude', ?, 1)"
        )
        .run(fixture.root, now(), quotaId);

      await invokeBrain(fixture.root, 'a2', {
        prompt: 'plan this',
        model: null,
        label: 'plan',
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });

      expect(quotaSpent(quotaId, 3600)).toBe(150);
    } finally {
      process.env.PATH = oldPath ?? '';
      harness.cleanup();
      fixture.cleanup();
    }
  });
});
