import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  worktreeStatus,
  worktreeDiff,
  worktreeMerge,
} from '../../src/worktrees/manager.js';
import { hooksDir } from '../../src/core/paths.js';
import { makeRepo } from '../helpers.js';
import { spawnSync } from 'node:child_process';

describe('worktrees', () => {
  it('creates an isolated worktree on the flightdeck branch', () => {
    const fixture = makeRepo();
    try {
      const info = createWorktree(fixture.root, 'feature-x');
      expect(fs.existsSync(info.path)).toBe(true);
      expect(info.branch).toBe('flightdeck/feature-x');
      expect(listWorktrees(fixture.root).some((w) => w.name === 'feature-x')).toBe(true);
      removeWorktree(fixture.root, 'feature-x');
      expect(listWorktrees(fixture.root).some((w) => w.name === 'feature-x')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('inspects status, computes diff, and merges clean worktrees', () => {
    const fixture = makeRepo();
    try {
      const info = createWorktree(fixture.root, 'feature-status');
      let status = worktreeStatus(fixture.root, 'feature-status');
      expect(status.clean).toBe(true);

      fs.writeFileSync(path.join(info.path, 'feature.txt'), 'hello from worktree\n');
      status = worktreeStatus(fixture.root, 'feature-status');
      expect(status.clean).toBe(false);
      expect(status.untracked).toContain('feature.txt');

      spawnSync('git', ['-C', info.path, 'add', '.'], { encoding: 'utf8' });
      spawnSync('git', ['-C', info.path, 'commit', '-m', 'add feature'], { encoding: 'utf8' });

      status = worktreeStatus(fixture.root, 'feature-status');
      expect(status.clean).toBe(true);
      expect(status.ahead).toBe(1);

      const diff = worktreeDiff(fixture.root, 'feature-status', 'main');
      expect(diff.diff).toContain('hello from worktree');
      expect(diff.filesChanged).toBeGreaterThanOrEqual(1);

      const dryMerge = worktreeMerge(fixture.root, 'feature-status', { dryRun: true });
      expect(dryMerge.merged).toBe(true);

      const realMerge = worktreeMerge(fixture.root, 'feature-status');
      expect(realMerge.merged).toBe(true);
      expect(fs.existsSync(path.join(fixture.root, 'feature.txt'))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('runs post-create hooks with FLIGHTDECK_WORKTREE set', () => {
    const fixture = makeRepo();
    try {
      fs.mkdirSync(hooksDir(fixture.root), { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir(fixture.root), 'prepare.sh'),
        `#!/bin/bash\necho "$FLIGHTDECK_WORKTREE" > "$FLIGHTDECK_WORKTREE/marker.txt"\n`
      );
      const info = createWorktree(fixture.root, 'hooked');
      const marker = fs.readFileSync(path.join(info.path, 'marker.txt'), 'utf8').trim();
      expect(marker).toBe(info.path);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails session start when a hook fails', () => {
    const fixture = makeRepo();
    try {
      fs.mkdirSync(hooksDir(fixture.root), { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir(fixture.root), 'fail.sh'),
        `#!/bin/bash\necho "boom" >&2\nexit 5\n`
      );
      expect(() => createWorktree(fixture.root, 'bad')).toThrow(/hook "fail.sh" failed/);
    } finally {
      fixture.cleanup();
    }
  });
});
