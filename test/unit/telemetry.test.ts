import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/sessions/manager.js';
import {
  TelemetryStore,
  TelemetryCollector,
  computeCost,
  parseClaudeLine,
  parseCodexLine,
  parseOpencodeLine,
  parseGeminiLine,
  renderClaudeLine,
  renderCodexLine,
  renderOpencodeLine,
  renderGeminiLine,
  type TelemetryLineHandlers,
} from '../../src/sessions/telemetry.js';
import { TablesStore } from '../../src/tables/store.js';
import { makeRepo } from '../helpers.js';

const CLAUDE_RESULT_LINE = JSON.stringify({
  type: 'result',
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0.33321,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 32605,
    cache_read_input_tokens: 14150,
    output_tokens: 3,
  },
  modelUsage: { 'claude-opus-5': { canonicalModel: 'claude-opus-5' } },
  result: 'done',
});

const CLAUDE_ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'done' }] },
});

const CLAUDE_SYSTEM_LINE = JSON.stringify({ type: 'system', subtype: 'init' });

const CODEX_TURN_LINE = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 25726, cached_input_tokens: 11008, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
});

const OPENCODE_STEP_LINE = JSON.stringify({
  type: 'step_finish',
  part: {
    type: 'step-finish',
    tokens: { total: 67783, input: 59568, output: 23, reasoning: 0, cache: { write: 0, read: 8192 } },
    cost: 0.0041844488,
  },
});

/** A session_telemetry row is FK-bound to a sessions row, as in production. */
function makeSessionId(root: string): string {
  const manager = new SessionManager(root);
  return manager.createSession({ name: 'telemetry-test', harness: 'claude', cwd: root }).id;
}

describe('per-adapter telemetry extraction', () => {
  it('claude: extracts model, usage, and turns from the result event', () => {
    const ext = parseClaudeLine(CLAUDE_RESULT_LINE);
    expect(ext).toEqual({
      model: 'claude-opus-5',
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 14150,
      cacheWriteTokens: 32605,
      turns: 1,
    });
    expect(parseClaudeLine(CLAUDE_ASSISTANT_LINE)).toBeNull();
    expect(parseClaudeLine(CLAUDE_SYSTEM_LINE)).toBeNull();
    expect(parseClaudeLine('not json')).toBeNull();
  });

  it('claude: a stream with no usage event reports nothing', () => {
    const fixture = makeRepo();
    try {
      const nullId = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, nullId, {
        parseLine: parseClaudeLine,
        renderLine: renderClaudeLine,
      });
      collector.feed(CLAUDE_SYSTEM_LINE + '\n' + CLAUDE_ASSISTANT_LINE + '\n', 'stdout');
      collector.flush();
      expect(new TelemetryStore(fixture.root).get(nullId)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('codex: extracts split usage, model stays null (codex never reports it)', () => {
    expect(parseCodexLine(CODEX_TURN_LINE)).toEqual({
      inputTokens: 25726,
      outputTokens: 5,
      cacheReadTokens: 11008,
      turns: 1,
    });
    expect(parseCodexLine(JSON.stringify({ type: 'thread.started' }))).toBeNull();
    expect(parseCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }))).toBeNull();
  });

  it('opencode: model arrives from the stderr log line, usage from step_finish', () => {
    expect(
      parseOpencodeLine(
        'timestamp=2026-08-15T05:54:40.732Z level=INFO message=stream providerID=opencode-go modelID=deepseek-v4-flash session.id=abc'
      )
    ).toEqual({ model: 'deepseek-v4-flash' });
    expect(parseOpencodeLine(OPENCODE_STEP_LINE)).toEqual({
      inputTokens: 59568,
      outputTokens: 23,
      cacheReadTokens: 8192,
      turns: 1,
    });
    expect(parseOpencodeLine(JSON.stringify({ type: 'step_start' }))).toBeNull();
  });

  it('gemini: extractor is declared but reports nothing', () => {
    expect(parseGeminiLine('anything at all')).toBeNull();
    expect(parseGeminiLine('')).toBeNull();
  });
});

describe('cost computation from the config rate table', () => {
  it('computes cost for a known model from token counts', () => {
    const cost = computeCost('claude-opus-5', {
      input: 2,
      output: 3,
      cacheRead: 14150,
      cacheWrite: 32605,
    });
    expect(cost).not.toBeNull();
    expect(cost!).toBeCloseTo((2 * 15 + 3 * 75 + 14150 * 1.5 + 32605 * 18.75) / 1_000_000, 10);
  });

  it('an unknown model yields a null cost, never zero', () => {
    expect(computeCost('not-a-real-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(computeCost(null, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(computeCost(undefined, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it('no token usage means no cost', () => {
    expect(computeCost('claude-opus-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});

describe('telemetry collector persistence', () => {
  it('accumulates usage and persists a row with computed cost', () => {
    const fixture = makeRepo();
    try {
      const id = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, id, {
        parseLine: parseClaudeLine,
        renderLine: renderClaudeLine,
      });
      collector.feed(CLAUDE_ASSISTANT_LINE + '\n', 'stdout');
      collector.feed(CLAUDE_RESULT_LINE + '\n', 'stdout');
      collector.flush();

      const telemetry = new TelemetryStore(fixture.root).get(id);
      expect(telemetry?.model).toBe('claude-opus-5');
      expect(telemetry?.inputTokens).toBe(2);
      expect(telemetry?.outputTokens).toBe(3);
      expect(telemetry?.cachedTokens).toBe(32605 + 14150);
      expect(telemetry?.turns).toBe(1);
      expect(telemetry?.costUsd).toBeCloseTo((2 * 15 + 3 * 75 + 14150 * 1.5 + 32605 * 18.75) / 1_000_000, 10);
    } finally {
      fixture.cleanup();
    }
  });

  it('codex: usage persists with null model and null cost', () => {
    const fixture = makeRepo();
    try {
      const id = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, id, {
        parseLine: parseCodexLine,
        renderLine: renderCodexLine,
      });
      collector.feed(CODEX_TURN_LINE + '\n', 'stdout');
      collector.flush();

      const telemetry = new TelemetryStore(fixture.root).get(id);
      expect(telemetry?.model).toBeNull();
      expect(telemetry?.inputTokens).toBe(25726);
      expect(telemetry?.outputTokens).toBe(5);
      expect(telemetry?.cachedTokens).toBe(11008);
      expect(telemetry?.costUsd).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('opencode: model from stderr combines with usage from stdout', () => {
    const fixture = makeRepo();
    try {
      const id = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, id, {
        parseLine: parseOpencodeLine,
        renderLine: renderOpencodeLine,
      });
      collector.feed('level=INFO message=stream providerID=opencode-go modelID=deepseek-v4-flash session.id=x\n', 'stderr');
      collector.feed(OPENCODE_STEP_LINE + '\n', 'stdout');
      collector.flush();

      const telemetry = new TelemetryStore(fixture.root).get(id);
      expect(telemetry?.model).toBe('deepseek-v4-flash');
      expect(telemetry?.inputTokens).toBe(59568);
      expect(telemetry?.outputTokens).toBe(23);
      expect(telemetry?.cachedTokens).toBe(8192);
      expect(telemetry?.costUsd).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('a JSON event split across chunks is still parsed', () => {
    const fixture = makeRepo();
    try {
      const id = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, id, {
        parseLine: parseClaudeLine,
        renderLine: renderClaudeLine,
      });
      const line = CLAUDE_RESULT_LINE;
      const half = Math.floor(line.length / 2);
      collector.feed(line.slice(0, half), 'stdout');
      collector.feed(line.slice(half) + '\n', 'stdout');
      collector.flush();

      const telemetry = new TelemetryStore(fixture.root).get(id);
      expect(telemetry?.model).toBe('claude-opus-5');
      expect(telemetry?.inputTokens).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('session log stays human-readable', () => {
  it('claude renders assistant text and never leaks JSONL into the log', () => {
    const fixture = makeRepo();
    try {
      const id = makeSessionId(fixture.root);
      const collector = new TelemetryCollector(fixture.root, id, {
        parseLine: parseClaudeLine,
        renderLine: renderClaudeLine,
      });
      const log = collector.feed(CLAUDE_SYSTEM_LINE + '\n', 'stdout');
      const log2 = collector.feed(CLAUDE_ASSISTANT_LINE + '\n', 'stdout');
      const log3 = collector.feed(CLAUDE_RESULT_LINE + '\n', 'stdout');
      const log4 = collector.feed('some debug noise on stderr', 'stderr');

      expect(log).toBe('');
      expect(log2).toBe('done\n');
      expect(log3).toBe('');
      expect(log4).toBe('');

      const rendered = log + log2 + log3 + log4;
      expect(rendered).not.toContain('modelUsage');
      expect(rendered).not.toContain('"type"');
      expect(rendered).toContain('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('codex renders agent messages and drops the event noise', () => {
    expect(
      renderCodexLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'finished the task' } }), 'stdout')
    ).toBe('finished the task');
    expect(renderCodexLine(CODEX_TURN_LINE, 'stdout')).toBeNull();
    expect(renderCodexLine('OpenAI Codex v0.147.0', 'stderr')).toBeNull();
  });

  it('opencode renders text events and drops stderr print-logs noise', () => {
    expect(
      renderOpencodeLine(JSON.stringify({ type: 'text', part: { type: 'text', text: 'a readable answer' } }), 'stdout')
    ).toBe('a readable answer');
    expect(renderOpencodeLine(OPENCODE_STEP_LINE, 'stdout')).toBeNull();
    expect(renderOpencodeLine('level=INFO message=stream modelID=deepseek-v4-flash', 'stderr')).toBeNull();
  });

  it('gemini passes plain text through untouched', () => {
    expect(renderGeminiLine('some plain text', 'stdout')).toBe('some plain text');
    expect(renderGeminiLine('some stderr', 'stderr')).toBe('some stderr');
  });
});

describe('progress is only ever a real Argus completion', () => {
  it('is null for sessions Argus does not own', () => {
    const fixture = makeRepo();
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({ name: 'free', harness: 'claude', cwd: fixture.root });
      const store = new TelemetryStore(fixture.root);
      store.upsert(session.id, { model: 'claude-opus-5', inputTokens: 1, outputTokens: 1 });
      expect(store.get(session.id)?.progress).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('is null for an Argus child that has pulse state but no completion', () => {
    const fixture = makeRepo();
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({
        name: 'child',
        harness: 'claude',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'argus-1',
        task: 'do the thing',
      });
      const tables = new TablesStore(fixture.root);
      tables.createTable('argus_progress', [
        { name: 'argus_id', type: 'text' },
        { name: 'session_id', type: 'text' },
        { name: 'event', type: 'text' },
        { name: 'detail', type: 'text' },
      ]);
      tables.insertRow('argus_progress', { argus_id: 'argus-1', session_id: session.id, event: 'child_spawned', detail: 'spawned' });

      const store = new TelemetryStore(fixture.root);
      store.upsert(session.id, { model: 'claude-opus-5', inputTokens: 1, outputTokens: 1 });
      expect(store.get(session.id)?.progress).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('is 100 once Argus records a child_completed row', () => {
    const fixture = makeRepo();
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({
        name: 'child',
        harness: 'claude',
        cwd: fixture.root,
        policy: 'child',
        argusParent: 'argus-1',
        task: 'do the thing',
      });
      const tables = new TablesStore(fixture.root);
      tables.createTable('argus_progress', [
        { name: 'argus_id', type: 'text' },
        { name: 'session_id', type: 'text' },
        { name: 'event', type: 'text' },
        { name: 'detail', type: 'text' },
      ]);
      tables.insertRow('argus_progress', { argus_id: 'argus-1', session_id: session.id, event: 'child_spawned', detail: 'spawned' });
      tables.insertRow('argus_progress', { argus_id: 'argus-1', session_id: session.id, event: 'child_completed', detail: 'exit=0' });

      const store = new TelemetryStore(fixture.root);
      store.upsert(session.id, { model: 'claude-opus-5', inputTokens: 1, outputTokens: 1 });
      expect(store.get(session.id)?.progress).toBe(100);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('end-to-end: a spawned claude session records telemetry and a readable log', () => {
  it('wires the collector through SessionManager', async () => {
    const fixture = makeRepo();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    const script = `#!/bin/bash
echo '${CLAUDE_SYSTEM_LINE}'
echo '${CLAUDE_ASSISTANT_LINE}'
echo '${CLAUDE_RESULT_LINE}'
exit 0
`;
    fs.writeFileSync(path.join(binDir, 'claude'), script, { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ''}`;
    try {
      const manager = new SessionManager(fixture.root);
      const session = manager.createSession({ name: 'probe', harness: 'claude', cwd: fixture.root });
      await manager.startSession(session.id, { headless: true, prompt: 'say hi', waitForExit: true });

      const logs = manager.getLogs(session.id);
      expect(logs).toContain('done');
      expect(logs).not.toContain('modelUsage');
      expect(logs).not.toContain('"type"');

      const telemetry = new TelemetryStore(fixture.root).get(session.id);
      expect(telemetry?.model).toBe('claude-opus-5');
      expect(telemetry?.inputTokens).toBe(2);
      expect(telemetry?.outputTokens).toBe(3);
      expect(telemetry?.turns).toBe(1);
      expect(telemetry?.costUsd).not.toBeNull();
    } finally {
      process.env.PATH = oldPath ?? '';
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });
});

// Keep the handlers type referenced so the interface stays exercised.
export type { TelemetryLineHandlers };
