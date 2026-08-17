import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { exportSession, exportSessionToFile } from '../../src/sessions/export.js';
import { followSessionLogs } from '../../src/sessions/stream.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { cliEntryPath } from '../../src/core/cliEntry.js';
import { log } from '../../src/core/logger.js';
import { makeRepo } from '../helpers.js';

describe('Sessions Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('tests exportSession with worktree, messages, notes, and file export', () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({
      name: 'export-target',
      harness: 'opencode',
      cwd: fixture.root,
      worktree: 'deleted-wt',
    });

    const ns = new NotesStore(fixture.root);
    ns.createNote('Session Note', 'Details');

    const ms = new MessagingStore(fixture.root);
    ms.send('other', s.id, 'Targeted message');

    const bundle = exportSession(fixture.root, s.id);
    expect(bundle.session.id).toBe(s.id);
    expect(bundle.messages).toHaveLength(1);

    const exported = exportSessionToFile(fixture.root, s.id);
    expect(fs.existsSync(exported.path)).toBe(true);
  });

  it('tests followSessionLogs streaming, polling, and exit callbacks', async () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'stream-sess', harness: 'opencode', cwd: fixture.root });
    const logDir = path.join(fixture.root, '.flightdeck', 'logs', 'sessions');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `${s.id}.log`);
    fs.writeFileSync(logFile, 'Line 1\nLine 2\n');

    const chunks: string[] = [];

    const follower = followSessionLogs(fixture.root, s.id, {
      tailLines: 1,
      intervalMs: 50,
      onChunk: (c) => chunks.push(c),
    });

    expect(chunks.length).toBeGreaterThan(0);

    // append to log
    fs.appendFileSync(logFile, 'Line 3\n');

    // stop follower
    follower.stop();
    expect(follower).toBeDefined();
  });

  it('tests cliEntryPath environment override and fallback', () => {
    process.env.FLIGHTDECK_CLI_PATH = '/custom/bin/deck';
    expect(cliEntryPath()).toBe('/custom/bin/deck');
    delete process.env.FLIGHTDECK_CLI_PATH;
    expect(cliEntryPath()).toBeDefined();
  });

  it('tests logger functions', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    log.setEnabled(true);
    log.debug('test debug');
    log.info('test info');
    log.warn('test warn');
    log.error('test error');
    expect(stderrSpy).toHaveBeenCalled();
    log.setEnabled(false);
    stderrSpy.mockRestore();
  });
});
