import { describe, it, expect } from 'vitest';
import { runCli } from '../helpers.js';

describe('CLI Main Entrypoint', () => {
  it('prints its version and exits successfully as a real CLI process', () => {
    const result = runCli(['--version'], { cwd: process.cwd() });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('0.1.0');
    expect(result.stderr).not.toContain('error:');
  });
});
