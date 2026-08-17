import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  TelemetryStore,
  TelemetryCollector,
  renderClaudeLine,
  renderCodexLine,
  renderOpencodeLine,
  renderGeminiLine,
  computeCost,
} from '../../src/sessions/telemetry.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo } from '../helpers.js';

describe('Telemetry Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('tests TelemetryStore list() and get() methods', () => {
    const store = new TelemetryStore(fixture.root);
    const sm = new SessionManager(fixture.root);
    const s1 = sm.createSession({ name: 't-sess-1', harness: 'opencode', cwd: fixture.root });
    const s2 = sm.createSession({ name: 't-sess-2', harness: 'opencode', cwd: fixture.root });

    store.upsert(s1.id, {
      model: 'claude-3-5-sonnet',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      costUsd: 0.001,
      turns: 1,
    });

    store.upsert(s2.id, {
      model: 'gpt-4o',
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 0,
      costUsd: 0.002,
      turns: 2,
    });

    const list = store.list();
    expect(list.length).toBe(2);
    expect(store.get(s1.id)?.model).toBe('claude-3-5-sonnet');
    expect(store.get('unknown-id')).toBeNull();
  });

  it('tests renderLine variations for all harnesses', () => {
    // Claude with string content
    const claudeStr = JSON.stringify({ type: 'assistant', message: { content: 'String message' } });
    expect(renderClaudeLine(claudeStr, 'stdout')).toBe('String message');
    expect(renderClaudeLine(claudeStr, 'stderr')).toBeNull();

    // Invalid JSON starting with {
    expect(renderClaudeLine('{ invalid json', 'stdout')).toBeNull();

    // Codex non-agent message
    expect(renderCodexLine(JSON.stringify({ type: 'other' }), 'stdout')).toBeNull();
    expect(renderCodexLine('not json', 'stderr')).toBeNull();

    // Opencode non-text
    expect(renderOpencodeLine(JSON.stringify({ type: 'step_start' }), 'stdout')).toBeNull();

    // Gemini passthrough
    expect(renderGeminiLine('Hello from Gemini', 'stdout')).toBe('Hello from Gemini');
  });

  it('tests TelemetryCollector flush with partial buffers and updates', () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'flush-sess', harness: 'opencode', cwd: fixture.root });

    const collector = new TelemetryCollector(fixture.root, s.id, {
      parseLine: (l) => (l.includes('TOKENS') ? { inputTokens: 50, outputTokens: 10 } : null),
      renderLine: (l) => `LOG: ${l}`,
    });

    // feed partial line
    const chunkOut = collector.feed('partial line TOKENS', 'stdout');
    expect(chunkOut).toBe('');

    // flush partial line
    const flushed = collector.flush();
    expect(flushed).toContain('LOG: partial line TOKENS');

    const store = new TelemetryStore(fixture.root);
    const tel = store.get(s.id);
    expect(tel?.inputTokens).toBe(50);
  });

  it('tests computeCost with missing rates and null models', () => {
    expect(computeCost(null, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(computeCost('nonexistent-model', { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});
