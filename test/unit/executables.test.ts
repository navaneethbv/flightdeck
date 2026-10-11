import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { findExecutable, requireExecutable } from '../../src/core/executables.js';
import { makeFakeHarness } from '../helpers.js';

afterEach(() => { vi.unstubAllEnvs(); });

describe('executable lookup', () => {
  it('rejects empty and relative PATH entries instead of searching a repository', () => {
    vi.stubEnv('PATH', ['', '.', 'node_modules/.bin'].join(path.delimiter));
    expect(findExecutable('git')).toBeNull();
    expect(() => requireExecutable('git')).toThrow('not found in absolute PATH directories');
  });

  it('keeps installed tools in absolute PATH directories available', () => {
    const harness = makeFakeHarness('test-tool');
    try {
      vi.stubEnv('PATH', ['', '.', harness.binDir].join(path.delimiter));
      expect(requireExecutable('test-tool')).toBe(path.join(harness.binDir, 'test-tool'));
      expect(findExecutable('missing-tool')).toBeNull();
    } finally {
      harness.cleanup();
    }
  });
});
