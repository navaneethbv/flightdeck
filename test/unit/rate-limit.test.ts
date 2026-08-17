import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/sessions/harness.js';

describe('detectRateLimit', () => {
  it('detects a Claude rate-limit message and suggests a backoff', () => {
    const output = 'Error: Claude AI usage limit reached. Please try again later. (429)';
    const backoff = adapters.claude.detectRateLimit?.(output);
    expect(backoff).not.toBeNull();
    expect(backoff as number).toBeGreaterThan(0);
  });

  it('does not flag normal Claude stream-json output', () => {
    const output = '{"type":"result","usage":{"input_tokens":100,"output_tokens":50}}\n';
    expect(adapters.claude.detectRateLimit?.(output)).toBeNull();
  });

  it('detects a Codex rate-limit message and suggests a backoff', () => {
    const output = '{"type":"error","message":"Rate limit exceeded, please retry later"}';
    const backoff = adapters.codex.detectRateLimit?.(output);
    expect(backoff).not.toBeNull();
    expect(backoff as number).toBeGreaterThan(0);
  });

  it('does not flag normal Codex turn.completed output', () => {
    const output = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}';
    expect(adapters.codex.detectRateLimit?.(output)).toBeNull();
  });

  it('is undefined on worker-only harnesses, which never need it', () => {
    expect(adapters.opencode.detectRateLimit).toBeUndefined();
    expect(adapters.gemini.detectRateLimit).toBeUndefined();
  });
});
