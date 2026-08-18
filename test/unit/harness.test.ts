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

  it('uses parse-friendly session args while keeping llm-step headless args as plain text', () => {
    const claudeSession = getAdapter('claude').sessionArgs('hi', {});
    expect(claudeSession).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--verbose']);
    expect(getAdapter('claude').headlessArgs('hi', {})).toEqual(['-p', 'hi', '--output-format', 'text']);

    const opencodeSession = getAdapter('opencode').sessionArgs('hi', {});
    expect(opencodeSession).toEqual(['run', '--format', 'json', '--print-logs', '--', 'hi']);
    expect(getAdapter('opencode').headlessArgs('hi', {})).toEqual(['run', '--', 'hi']);

    expect(getAdapter('codex').sessionArgs('hi', {})).toEqual(['exec', '--json', '--', 'hi']);
    expect(getAdapter('codex').headlessArgs('hi', {})).toEqual(['exec', '--json', '--', 'hi']);
    expect(getAdapter('gemini').sessionArgs('hi', {})).toEqual(['run', 'hi']);
  });

  it('starts an autonomous OpenCode worker with the supported auto flag', () => {
    expect(getAdapter('opencode').sessionArgs('implement task', { autonomy: true })).toEqual([
      'run',
      '--format',
      'json',
      '--print-logs',
      '--auto',
      '--',
      'implement task',
    ]);
  });

  it('places Codex options before the prompt and grants workspace writes only in autonomy mode', () => {
    expect(getAdapter('codex').sessionArgs('plan work', { model: 'gpt-5.6-sol' })).toEqual([
      'exec',
      '--json',
      '--model',
      'gpt-5.6-sol',
      '--',
      'plan work',
    ]);

    expect(getAdapter('codex').sessionArgs('implement task', { autonomy: true })).toEqual([
      'exec',
      '--json',
      '--approve-for-me',
      '--',
      'implement task',
    ]);
  });

  it('every adapter declares a telemetry extractor and a log renderer', () => {
    for (const kind of HARNESSES) {
      const adapter = getAdapter(kind);
      expect(typeof adapter.telemetry).toBe('function');
      expect(typeof adapter.renderLine).toBe('function');
    }
  });
});
