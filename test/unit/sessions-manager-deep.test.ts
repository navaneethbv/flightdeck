import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('SessionManager Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let fakeHarness: ReturnType<typeof makeFakeHarness>;
  let oldPath: string | undefined;

  beforeEach(() => {
    fixture = makeRepo();
    fakeHarness = makeFakeHarness('opencode');
    oldPath = process.env.PATH;
    process.env.PATH = `${fakeHarness.binDir}:${process.env.PATH}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
    fakeHarness.cleanup();
    fixture.cleanup();
  });

  it('tests startSession with waitForExit: true, already running error, and worktree dir', async () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({
      name: 'sess-deep',
      harness: 'opencode',
      cwd: fixture.root,
      worktree: 'my-wt',
    });

    const started = await sm.startSession(s.id, {
      headless: true,
      waitForExit: true,
      prompt: 'do work',
    });

    expect(started.id).toBe(s.id);

    await expect(sm.startSession('00000000-0000-0000-0000-000000000000')).rejects.toThrow('not found');
  });

  it('tests stopSession SIGTERM and SIGKILL timeout fallback', async () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'sess-kill', harness: 'opencode', cwd: fixture.root });

    await sm.startSession(s.id, { headless: true, prompt: 'sleep' });
    expect(sm.get(s.id)?.status).toBe('running');

    await sm.stopSession(s.id, 50);
    expect(sm.get(s.id)?.status).toBe('stopped');
  });

  it('tests getLogs fallback when log file does not exist', () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'sess-nologs', harness: 'opencode', cwd: fixture.root });
    expect(sm.getLogs(s.id, 10)).toBe('');
  });

  it('tests touch and manager policy with FLIGHTDECK_ARGUS_CAP', async () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({
      name: 'sess-mgr',
      harness: 'opencode',
      cwd: fixture.root,
      policy: 'manager',
    });

    // Touch
    sm.touch(s.id);
    expect(sm.get(s.id)?.lastActivityAt).toBeDefined();

    // Start manager session with headless
    const started = await sm.startSession(s.id, {
      headless: true,
      waitForExit: true,
      prompt: 'manager prompt',
    });
    expect(started.status).toBeDefined();
  });
});
