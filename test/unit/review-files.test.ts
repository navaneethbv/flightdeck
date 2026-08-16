import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadReviewFiles } from '../../src/argus/review-files.js';

function makeWorktree(): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-worktree-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('loadReviewFiles', () => {
  it('returns a normal in-worktree file', () => {
    const wt = makeWorktree();
    try {
      fs.mkdirSync(path.join(wt.root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(wt.root, 'src', 'a.ts'), 'export const a = 1;\n');
      const files = loadReviewFiles(wt.root, ['src/a.ts']);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: 'src/a.ts',
        content: 'export const a = 1;\n',
        error: null,
        truncated: false,
      });
    } finally {
      wt.cleanup();
    }
  });

  it('rejects a path escaping the worktree', () => {
    const wt = makeWorktree();
    try {
      fs.writeFileSync(path.join(wt.root, 'outside.txt'), 'secret');
      const files = loadReviewFiles(wt.root, ['../outside.txt']);
      expect(files[0].content).toBeNull();
      expect(files[0].error).not.toBeNull();
    } finally {
      wt.cleanup();
    }
  });

  it('rejects an absolute path', () => {
    const wt = makeWorktree();
    try {
      const files = loadReviewFiles(wt.root, ['/etc/passwd']);
      expect(files[0].content).toBeNull();
      expect(files[0].error).not.toBeNull();
    } finally {
      wt.cleanup();
    }
  });

  it('rejects a symlink that resolves outside the worktree', () => {
    const wt = makeWorktree();
    try {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(wt.root, 'link.txt'));
      const files = loadReviewFiles(wt.root, ['link.txt']);
      expect(files[0].content).toBeNull();
      expect(files[0].error).not.toBeNull();
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      wt.cleanup();
    }
  });

  it('rejects generated config, state, and environment files', () => {
    const wt = makeWorktree();
    try {
      for (const name of ['.git/config', '.flightdeck/state.db', '.mcp.json', 'mcp.json', 'opencode.json', '.gemini/settings.json', '.env.local']) {
        fs.mkdirSync(path.dirname(path.join(wt.root, name)), { recursive: true });
        fs.writeFileSync(path.join(wt.root, name), 'x');
      }
      const files = loadReviewFiles(wt.root, [
        '.git/config', '.flightdeck/state.db', '.mcp.json', 'mcp.json', 'opencode.json', '.gemini/settings.json', '.env.local',
      ]);
      for (const file of files) {
        expect(file.content).toBeNull();
        expect(file.error).not.toBeNull();
      }
    } finally {
      wt.cleanup();
    }
  });

  it('truncates a file larger than 32 KiB', () => {
    const wt = makeWorktree();
    try {
      const big = 'x'.repeat(40 * 1024);
      fs.writeFileSync(path.join(wt.root, 'big.txt'), big);
      const files = loadReviewFiles(wt.root, ['big.txt']);
      expect(files[0].truncated).toBe(true);
      expect(files[0].content!.length).toBeLessThanOrEqual(32 * 1024);
    } finally {
      wt.cleanup();
    }
  });

  it('limits the request to eight files', () => {
    const wt = makeWorktree();
    try {
      const requests: string[] = [];
      for (let i = 0; i < 12; i++) {
        fs.writeFileSync(path.join(wt.root, `f${i}.txt`), `file ${i}`);
        requests.push(`f${i}.txt`);
      }
      const files = loadReviewFiles(wt.root, requests);
      expect(files).toHaveLength(8);
    } finally {
      wt.cleanup();
    }
  });

  it('never attaches more than 128 KiB of combined content', () => {
    const wt = makeWorktree();
    try {
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(path.join(wt.root, `big${i}.txt`), 'y'.repeat(30 * 1024));
      }
      const files = loadReviewFiles(wt.root, ['big0.txt', 'big1.txt', 'big2.txt', 'big3.txt', 'big4.txt', 'big5.txt', 'big6.txt', 'big7.txt']);
      const total = files.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
      expect(total).toBeLessThanOrEqual(128 * 1024);
    } finally {
      wt.cleanup();
    }
  });
});
