import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runGates, computeDiffstat } from '../../src/argus/gates.js';
import { makeRepo } from '../helpers.js';

describe('runGates', () => {
  it('reports success when both commands exit zero', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, { test: 'exit 0', lint: 'exit 0' });
      expect(result.testExitCode).toBe(0);
      expect(result.lintExitCode).toBe(0);
      expect(result.failureTail).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('captures the failing command output in the tail', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, {
        test: 'echo "3 tests failed" && exit 1',
        lint: 'exit 0',
      });
      expect(result.testExitCode).toBe(1);
      expect(result.failureTail).toContain('3 tests failed');
    } finally {
      fixture.cleanup();
    }
  });

  it('skips a gate whose command is empty', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, { test: '', lint: 'exit 0' });
      expect(result.testExitCode).toBeNull();
      expect(result.lintExitCode).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('truncates a very long failure tail', () => {
    const fixture = makeRepo();
    try {
      const result = runGates(fixture.root, {
        test: 'for i in $(seq 1 200); do echo "line $i"; done && exit 1',
        lint: '',
      });
      expect(result.failureTail.split('\n').length).toBeLessThanOrEqual(40);
      expect(result.failureTail).toContain('line 200');
      expect(result.failureTail).not.toContain('line 1\n');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('computeDiffstat', () => {
  it('summarises uncommitted changes', () => {
    const fixture = makeRepo();
    try {
      fs.writeFileSync(path.join(fixture.root, 'README.md'), '# fixture\nchanged\n');
      const stat = computeDiffstat(fixture.root);
      expect(stat).toContain('README.md');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns an empty string in a clean worktree', () => {
    const fixture = makeRepo();
    try {
      expect(computeDiffstat(fixture.root).trim()).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
