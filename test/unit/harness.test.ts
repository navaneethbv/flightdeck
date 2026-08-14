import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter, adapters, detectedHarnesses } from '../../src/sessions/harness.js';
import { HARNESSES, isHarnessKind, type Session } from '../../src/core/types.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('Harness adapters', () => {
  it('includes gemini in HARNESSES and isHarnessKind', () => {
    expect(HARNESSES).toContain('gemini');
    expect(isHarnessKind('gemini')).toBe(true);
    expect(isHarnessKind('claude')).toBe(true);
    expect(isHarnessKind('codex')).toBe(true);
    expect(isHarnessKind('opencode')).toBe(true);
    expect(isHarnessKind('unknown')).toBe(false);
  });

  it('provides the gemini adapter with correct args and config generation', () => {
    const gemini = getAdapter('gemini');
    expect(gemini).toBeDefined();
    expect(gemini.kind).toBe('gemini');
    expect(gemini.displayName).toContain('Gemini');
    expect(gemini.binary).toBe('gemini');

    const interactive = gemini.interactiveArgs();
    expect(interactive).toEqual([]);

    const headless = gemini.headlessArgs('build a feature', { autonomy: true });
    expect(headless).toContain('run');
    expect(headless).toContain('build a feature');
    expect(headless).toContain('--auto-approve');

    const fixture = makeRepo();
    try {
      const mockSession: Session = {
        id: 'sess-123',
        name: 'test-session',
        harness: 'gemini',
        projectRoot: fixture.root,
        worktree: null,
        cwd: fixture.root,
        pid: null,
        status: 'stopped',
        token: 'token-abc',
        policy: 'default',
        argusParent: null,
        task: null,
        startedAt: 0,
        endedAt: null,
        lastActivityAt: 0,
        exitCode: null,
      };

      gemini.writeMcpConfig(mockSession, fixture.root);

      const mcpJson = path.join(fixture.root, '.mcp.json');
      expect(fs.existsSync(mcpJson)).toBe(true);
      const parsedMcp = JSON.parse(fs.readFileSync(mcpJson, 'utf8'));
      expect(parsedMcp.mcpServers.flightdeck).toBeDefined();
      expect(parsedMcp.mcpServers.flightdeck.args).toContain('sess-123');

      const geminiSettings = path.join(fixture.root, '.gemini', 'settings.json');
      expect(fs.existsSync(geminiSettings)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('detects fake gemini binary on PATH', () => {
    const fake = makeFakeHarness('gemini');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
      expect(adapters.gemini.detect()).toBe(true);
      expect(detectedHarnesses()).toContain('gemini');
    } finally {
      process.env.PATH = oldPath;
      fake.cleanup();
    }
  });
});
