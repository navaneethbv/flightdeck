import { describe, it, expect, vi } from 'vitest';

describe('CLI Main Entrypoint', () => {
  it('imports cli/index.ts and executes version flag without error', async () => {
    const oldArgv = process.argv;
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      process.argv = ['node', 'deck', '--version'];
      await import('../../src/cli/index.js');
      expect(writeSpy).toHaveBeenCalled();
    } finally {
      process.argv = oldArgv;
      writeSpy.mockRestore();
    }
  });
});
