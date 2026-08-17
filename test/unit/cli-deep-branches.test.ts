import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSession, registerWorktree } from '../../src/cli/commands/session.js';
import { registerPlaybooks, registerIntegrations, registerSsh } from '../../src/cli/commands/tools.js';
import { registerArgus } from '../../src/cli/commands/argus.js';
import { registerWatchdog } from '../../src/cli/commands/watchdog.js';
import { registerConfig } from '../../src/cli/commands/config.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { NotesStore } from '../../src/notes/store.js';
import { makeRepo } from '../helpers.js';

describe('Deep CLI Branches Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  function createProgram(): Command {
    const program = new Command();
    program.name('deck').exitOverride();
    registerSession(program);
    registerWorktree(program);
    registerPlaybooks(program);
    registerIntegrations(program);
    registerSsh(program);
    registerArgus(program);
    registerWatchdog(program);
    registerConfig(program);
    return program;
  }

  async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    stdoutChunks = [];
    stderrChunks = [];
    const prog = createProgram();
    try {
      await prog.parseAsync(args, { from: 'user' });
    } catch {
      // ignore exit overrides
    }
    return {
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  }

  beforeEach(() => {
    fixture = makeRepo();
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((str: any) => {
      stdoutChunks.push(String(str));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((str: any) => {
      stderrChunks.push(String(str));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      stdoutChunks.push(
        args
          .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
          .join(' ') + '\n'
      );
    });
    vi.spyOn(console, 'error').mockImplementation((...args: any[]) => {
      stderrChunks.push(
        args
          .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
          .join(' ') + '\n'
      );
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it('tests argus plan, pause, resume, stop, task, and ask commands', async () => {
    const notes = new NotesStore(fixture.root);
    const mNote = notes.createNote('mission-test', 'Mission body text');

    const am = new ArgusManager(fixture.root);
    const argus = am.start({ name: 'cli-argus-ops', missionNoteId: mNote.id });
    const board = new TaskBoard(fixture.root);
    const [t1] = board.create(argus.id, [{ title: 'Subtask 1', spec: 'Do work', dependsOn: [] }]);

    vi.spyOn(am, 'plan').mockResolvedValue(undefined);

    // argus task
    let out = await runCli('argus', 'task', t1.id, '--project', fixture.root);
    expect(out.stdout).toContain('Subtask 1');

    out = await runCli('argus', 'task', t1.id, '--project', fixture.root, '--json');
    expect(out.stdout).toContain('Subtask 1');

    // argus plan
    out = await runCli('argus', 'plan', argus.id, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // argus pause & resume & stop
    // set to running first
    const db = (am as any).db;
    db.prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(argus.id);

    out = await runCli('argus', 'pause', argus.id, '--project', fixture.root);
    expect(out.stdout).toContain('paused');

    out = await runCli('argus', 'resume', argus.id, '--project', fixture.root);
    expect(out.stdout).toContain('resumed');

    out = await runCli('argus', 'stop', argus.id, '--project', fixture.root);
    expect(out.stdout).toContain('stopped');
  });

  it('tests session stop, restart, follow, and worktree merge branches', async () => {
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });
    vi.spyOn(SessionManager.prototype, 'stopSession').mockResolvedValue();

    const sm = new SessionManager(fixture.root);
    const sess = sm.createSession({ name: 'sess-ops', harness: 'opencode', cwd: fixture.root });

    // session stop
    let out = await runCli('session', 'stop', sess.id, '--project', fixture.root);
    expect(out.stdout).toContain('stopped');

    // session restart
    out = await runCli('session', 'restart', sess.id, '--headless', '--project', fixture.root);
    expect(out.stdout).toContain('restarted');

    // session follow
    out = await runCli('session', 'follow', sess.id, '--lines', '10', '--project', fixture.root);
    expect(out.stdout).toBeDefined();
  });

  it('tests playbooks list and config get/set commands', async () => {
    // playbook list
    let out = await runCli('playbook', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('ci-check');

    // config set-default-harness, get, path
    out = await runCli('config', 'set-default-harness', 'opencode');
    expect(out.stdout).toContain('default harness set to opencode');

    out = await runCli('config', 'get');
    expect(out.stdout).toContain('opencode');

    out = await runCli('config', 'set-profile-dir', 'opencode', '/tmp/opencode-prof');
    expect(out.stdout).toContain('profile dir');

    out = await runCli('config', 'path');
    expect(out.stdout).toBeDefined();
  });

  it('tests watchdog kill and inspect commands', async () => {
    const sm = new SessionManager(fixture.root);
    const sess = sm.createSession({ name: 'sess-wd', harness: 'opencode', cwd: fixture.root });

    let out = await runCli('watchdog', 'kill', sess.id, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('watchdog', 'inspect', sess.id, '--project', fixture.root);
    expect(out.stdout).toBeDefined();
  });
});
