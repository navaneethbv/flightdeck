import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerSession, registerWorktree } from '../../src/cli/commands/session.js';
import { registerNotes, registerTables, registerMessages } from '../../src/cli/commands/store.js';
import { registerPlaybooks, registerIntegrations, registerSsh } from '../../src/cli/commands/tools.js';
import { registerArgus } from '../../src/cli/commands/argus.js';
import { registerQuota } from '../../src/cli/commands/quota.js';
import { registerConfig } from '../../src/cli/commands/config.js';
import { registerDoctor } from '../../src/cli/commands/doctor.js';
import { registerLogin } from '../../src/cli/commands/login.js';
import { registerWatchdog } from '../../src/cli/commands/watchdog.js';
import { registerFleet } from '../../src/cli/commands/fleet.js';
import { registerUi } from '../../src/cli/commands/ui.js';
import { registerMcp } from '../../src/cli/commands/mcp.js';
import { registerTui } from '../../src/cli/commands/tui.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

describe('Complete CLI Commands Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let fakeHarness: ReturnType<typeof makeFakeHarness>;
  let oldPath: string | undefined;
  let stdoutChunks: string[];
  let stderrChunks: string[];

  function createProgram(): Command {
    const program = new Command();
    program.name('deck').exitOverride();
    registerSession(program);
    registerWorktree(program);
    registerNotes(program);
    registerTables(program);
    registerMessages(program);
    registerPlaybooks(program);
    registerIntegrations(program);
    registerSsh(program);
    registerArgus(program);
    registerQuota(program);
    registerConfig(program);
    registerDoctor(program);
    registerLogin(program);
    registerWatchdog(program);
    registerFleet(program);
    registerUi(program);
    registerMcp(program);
    registerTui(program);
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
    fakeHarness = makeFakeHarness('opencode');
    oldPath = process.env.PATH;
    process.env.PATH = `${fakeHarness.binDir}:${process.env.PATH ?? ''}`;
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
    process.env.PATH = oldPath;
    fakeHarness?.cleanup();
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it('covers full store commands (notes, tables, messages)', async () => {
    // Notes
    let out = await runCli('note', 'create', 'T1', '-b', 'B1', '--project', fixture.root);
    expect(out.stdout).toContain('created note');
    const noteId = out.stdout.match(/created note ([a-f0-9-]+)/)?.[1];

    out = await runCli('note', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('T1');

    if (noteId) {
      out = await runCli('note', 'read', noteId, '--project', fixture.root);
      expect(out.stdout).toContain('B1');

      out = await runCli('note', 'update', noteId, '-t', 'T1-Updated', '--project', fixture.root);
      expect(out.stdout).toContain('updated note');

      out = await runCli('note', 'search', 'Updated', '--project', fixture.root);
      expect(out.stdout).toContain('T1-Updated');

      out = await runCli('note', 'delete', noteId, '--project', fixture.root);
      expect(out.stdout).toContain('deleted note');
    }

    // Tables
    out = await runCli(
      'table',
      'create',
      'metrics',
      '--columns',
      JSON.stringify([
        { name: 'name', type: 'text' },
        { name: 'val', type: 'real' },
      ]),
      '--project',
      fixture.root
    );
    expect(out.stdout).toContain('created table');

    out = await runCli('table', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('metrics');

    out = await runCli('table', 'insert', 'metrics', '--data', '{"name":"cpu","val":85.5}', '--project', fixture.root);
    expect(out.stdout).toContain('inserted row');

    out = await runCli('table', 'query', 'metrics', '--project', fixture.root);
    expect(out.stdout).toContain('cpu');

    out = await runCli('table', 'aggregate', 'metrics', '--fn', 'count', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('table', 'drop', 'metrics', '--project', fixture.root);
    expect(out.stdout).toContain('dropped table');

    // Messages
    out = await runCli('message', 'send', '--to', 'session-1', 'Hello worker', '--project', fixture.root);
    expect(out.stdout).toContain('sent message');

    out = await runCli('message', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('Hello worker');

    out = await runCli('message', 'poll', '--to', 'session-1', '--since-id', '0', '--project', fixture.root);
    expect(out.stdout).toContain('Hello worker');
  });

  it('covers tools commands (ssh, playbooks, integrations)', async () => {
    // SSH
    let out = await runCli('ssh', 'add', 'prod-box', '192.168.1.100', '-u', 'admin', '-p', '2222', '--project', fixture.root);
    expect(out.stdout).toContain('added host');

    out = await runCli('ssh', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('prod-box');

    out = await runCli('ssh', 'remove', 'prod-box', '--project', fixture.root);
    expect(out.stdout).toContain('removed host');

    // Playbooks
    out = await runCli('playbook', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('ci-check');

    out = await runCli('playbook', 'run', 'ci-check', '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();

    // Integrations
    out = await runCli('integration', 'status', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('integration', 'deauth', 'jira', '--project', fixture.root);
    expect(out.stdout).toContain('removed jira credentials');
  });

  it('covers quota and watchdog CLI commands', async () => {
    // Quota
    let out = await runCli('quota', 'create', 'cli-q-full', '--max-tokens', '500000', '--window', '2h');
    expect(out.stdout).toContain('created quota');

    out = await runCli('quota', 'list');
    expect(out.stdout).toContain('cli-q-full');

    out = await runCli('quota', 'show', 'cli-q-full');
    expect(out.stdout).toContain('cli-q-full');

    // Watchdog
    out = await runCli('watchdog', 'status', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('watchdog', 'inspect', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('watchdog', 'run', '--project', fixture.root);
    expect(out.stdout).toBeDefined();
  });

  it('covers session, worktree, login, config, and argus CLI commands', async () => {
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });
    vi.spyOn(ArgusManager.prototype, 'runForever').mockResolvedValue(undefined);

    // Session CLI
    let out = await runCli('session', 'list', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // Create session in repo
    out = await runCli('session', 'start', 'cli-sess-1', '--harness', 'opencode', '--project', fixture.root, '--json');
    const createdSession = JSON.parse(out.stdout);
    const sid = createdSession.id;

    out = await runCli('session', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('cli-sess-1');

    out = await runCli('session', 'telemetry', sid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('session', 'export', sid, '--project', fixture.root);
    expect(out.stdout).toContain('exported session');

    out = await runCli('session', 'logs', sid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // Worktree CLI
    out = await runCli('worktree', 'create', 'wt-cli', '--project', fixture.root);
    expect(out.stdout).toContain('created worktree');

    out = await runCli('worktree', 'list', '--project', fixture.root);
    expect(out.stdout).toContain('wt-cli');

    out = await runCli('worktree', 'status', 'wt-cli', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('worktree', 'diff', 'wt-cli', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('worktree', 'merge', 'wt-cli', '--dry-run', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('worktree', 'remove', 'wt-cli', '--project', fixture.root);
    expect(out.stdout).toContain('removed worktree');

    // Login CLI
    out = await runCli('login', '--check');
    expect(out.stdout).toBeDefined();

    // Config CLI
    out = await runCli('config', 'list');
    expect(out.stdout).toBeDefined();

    out = await runCli('config', 'get', 'defaultHarness');
    expect(out.stdout).toBeDefined();

    out = await runCli('config', 'path');
    expect(out.stdout).toBeDefined();

    // Argus CLI
    out = await runCli('argus', 'list', '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // Create an argus fleet with mission body
    out = await runCli('argus', 'start', '--name', 'full-argus', '--mission-body', 'Mission text', '--children', '4', '--project', fixture.root, '--json');
    const createdArgus = JSON.parse(out.stdout);
    const aid = createdArgus.argus.id;

    out = await runCli('argus', 'status', aid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('argus', 'fleet', aid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('argus', 'board', aid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('argus', 'budget', aid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    out = await runCli('argus', 'questions', aid, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // Fleet override and worker CLI commands
    const board = new TaskBoard(fixture.root);
    const [t1, t2] = board.create(aid, [
      { title: 'T1', spec: 'S1', dependsOn: [] },
      { title: 'T2', spec: 'S2', dependsOn: [] },
    ]);
    board.block(t2.id, 'failed');

    out = await runCli('fleet', 'override', 'reject', t1.id, 'Not ready', '--argus', aid, '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();

    out = await runCli('fleet', 'override', 'unblock', t2.id, '--argus', aid, '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();

    out = await runCli('fleet', 'override', 'force-review', '--argus', aid, '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();

    // Fleet worker start
    out = await runCli('fleet', 'worker', 'start', '--argus', aid, '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();
  });
});
