import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertGitRepo,
  createWorktree,
  removeWorktree,
  worktreeStatus,
  worktreeDiff,
  worktreeMerge,
} from '../../src/worktrees/manager.js';
import { makeRepo } from '../helpers.js';

describe('Worktrees Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('tests error paths: non-git repo, duplicate create, and missing worktrees', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'non-repo-'));
    try {
      expect(() => assertGitRepo(nonRepo)).toThrow('not inside a Git work tree');
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }

    createWorktree(fixture.root, 'wt-dup');
    expect(() => createWorktree(fixture.root, 'wt-dup')).toThrow('already exists');

    expect(() => worktreeStatus(fixture.root, 'non-existent')).toThrow('does not exist');
    expect(() => worktreeDiff(fixture.root, 'non-existent')).toThrow('does not exist');
    expect(() => worktreeMerge(fixture.root, 'non-existent', {})).toThrow('does not exist');
    expect(() => removeWorktree(fixture.root, 'non-existent')).toThrow('does not exist');
  });

  it('tests worktree merge with non-dry run and target branch checkout', () => {
    const wt = createWorktree(fixture.root, 'wt-mergeable');
    fs.writeFileSync(path.join(wt.path, 'merged-file.txt'), 'content');

    const status = worktreeStatus(fixture.root, 'wt-mergeable');
    expect(status.untracked.length).toBeGreaterThan(0);

    const res = worktreeMerge(fixture.root, 'wt-mergeable', { dryRun: false });
    expect(res).toBeDefined();
  });
});
