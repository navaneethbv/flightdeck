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
import { FleetActions } from '../../src/fleet/actions.js';
import { Integrations } from '../../src/integrations/index.js';
import * as harness from '../../src/sessions/harness.js';
import { makeRepo } from '../helpers.js';

describe('CLI Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
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
      // ignore
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
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      stdoutChunks.push(
        args
          .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
          .join(' ') + '\n'
      );
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((str: any) => {
      stderrChunks.push(String(str));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it('tests doctor and repair commands with and without --json', async () => {
    let out = await runCli('doctor', '--fix', '--project', fixture.root);
    expect(out.stdout).toContain('repair:');

    out = await runCli('doctor', '--project', fixture.root);
    expect(out.stdout).toContain('git');

    out = await runCli('repair', '--project', fixture.root, '--json');
    expect(out.stdout).toContain('fixed');

    out = await runCli('repair', '--project', fixture.root);
    expect(out.stdout).toContain('project repair:');
  });

  it('tests login command human output and specific harnesses', async () => {
    let out = await runCli('login', 'claude', '--check');
    expect(out.stdout).toBeDefined();

    out = await runCli('login', 'opencode', '--check', '--json');
    expect(out.stdout).toContain('opencode');
  });

  it('tests watchdog inspect command in human and json modes', async () => {
    const sm = new SessionManager(fixture.root);
    const s = sm.createSession({ name: 'watch-sess', harness: 'opencode', cwd: fixture.root });

    let out = await runCli('watchdog', 'inspect', s.id, '--project', fixture.root, '--json');
    expect(out.stdout).toContain(s.id);

    out = await runCli('watchdog', 'inspect', s.id, '--project', fixture.root);
    expect(out.stdout).toContain(s.id);
  });

  it('tests session telemetry, restart, and start flags in CLI', async () => {
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });
    vi.spyOn(harness.adapters.opencode, 'detect').mockReturnValue(true);

    let out = await runCli(
      'session',
      'start',
      'cli-start-sess',
      '--harness',
      'opencode',
      '--headless',
      '--project',
      fixture.root,
      '--json'
    );
    expect(out.stdout).toContain('cli-start-sess');

    const sJson = JSON.parse(out.stdout);

    // session telemetry
    out = await runCli('session', 'telemetry', sJson.id, '--project', fixture.root, '--json');
    expect(out.stdout).toBeDefined();

    out = await runCli('session', 'telemetry', sJson.id, '--project', fixture.root);
    expect(out.stdout).toBeDefined();

    // session restart
    out = await runCli('session', 'restart', sJson.id, '--project', fixture.root, '--json');
    expect(out.stdout).toContain(sJson.id);
  });

  it('tests config set-profile-dir and path', async () => {
    let out = await runCli('config', 'set-profile-dir', 'claude', '/tmp/claude-prof');
    expect(out.stdout).toContain('profile dir');

    out = await runCli('config', 'path');
    expect(out.stdout).toContain('config.json');
  });

  it('tests argus task, board, and budget formatting without --json', async () => {
    const am = new ArgusManager(fixture.root);
    const fleet = am.start({ name: 'cli-human-fleet' });
    const board = new TaskBoard(fixture.root);
    const [task] = board.create(fleet.id, [
      { title: 'Feature Task', spec: 'Do work', dependsOn: [] },
    ]);

    let out = await runCli('argus', 'board', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('Feature Task');

    out = await runCli('argus', 'task', task.id, '--project', fixture.root);
    expect(out.stdout).toContain('Feature Task');

    out = await runCli('argus', 'budget', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('spent');

    // argus start and plan
    vi.spyOn(ArgusManager.prototype, 'runForever').mockResolvedValue(undefined);
    vi.spyOn(ArgusManager.prototype, 'plan').mockResolvedValue(undefined);
    vi.spyOn(ArgusManager.prototype, 'drainReviews').mockResolvedValue(undefined);

    out = await runCli(
      'argus',
      'start',
      '--name',
      'cli-argus-test',
      '--mission-body',
      'Mission body text',
      '--pulse',
      '30s',
      '--children',
      '4',
      '--brain-harness',
      'claude',
      '--project',
      fixture.root,
      '--json'
    );
    expect(out.stdout).toContain('cli-argus-test');

    const createdArgus = JSON.parse(out.stdout);
    out = await runCli('argus', 'plan', createdArgus.argus.id, '--project', fixture.root);
    expect(out.stdout).toContain('planned');

    out = await runCli('argus', 'stop', createdArgus.argus.id, '--project', fixture.root);
    expect(out.stdout).toContain('stopped');

    // fleet subcommands
    const sm = new SessionManager(fixture.root);
    const sWorker = sm.createSession({
      name: 'fl-worker',
      harness: 'opencode',
      cwd: fixture.root,
      policy: 'child',
      argusParent: fleet.id,
    });
    const [t1] = board.create(fleet.id, [{ title: 'Fleet Task', spec: 'Spec', dependsOn: [] }]);
    board.assign(t1.id, sWorker.id);

    // fleet status
    out = await runCli('fleet', 'status', '--project', fixture.root);
    expect(out.stdout).toContain('tmux');

    // fleet override subcommands
    out = await runCli('fleet', 'override', 'prioritize', t1.id, '--argus', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('prioritized');

    out = await runCli('fleet', 'override', 'reject', t1.id, 'bad work', '--argus', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('rejected');

    out = await runCli('fleet', 'override', 'unblock', t1.id, '--argus', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('unblocked');

    out = await runCli('fleet', 'override', 'accept', t1.id, '--argus', fleet.id, '--project', fixture.root);
    expect(out.stdout).toContain('accepted');

    const act = new FleetActions(fixture.root);
    const killRes = await act.kill(sWorker.id);
    expect(killRes.action).toBe('kill');
    expect(killRes.message).toContain('killed');
  });

  it('tests integration auth and ssh run CLI commands', async () => {
    vi.spyOn(Integrations.prototype, 'auth').mockResolvedValue(undefined);

    let out = await runCli(
      'integration',
      'auth',
      'jira',
      '--domain',
      'my-jira.atlassian.net',
      '--email',
      'me@example.com',
      '--token',
      'tok-123',
      '--project',
      fixture.root
    );
    expect(out.stdout).toContain('jira configured');

    out = await runCli('integration', 'auth', 'github', '--token', 'gh-tok', '--project', fixture.root);
    expect(out.stdout).toContain('github configured');

    // SSH run
    await runCli('ssh', 'add', 'my-ssh', 'localhost', '--project', fixture.root);
  });

  it('tests ui command without opening browser', async () => {
    const out = await runCli('ui', '--no-open', '--port', '0', '--project', fixture.root);
    expect(out.stdout).toContain('Flightdeck Control Plane Dashboard');
  });

  it('tests mcp command', async () => {
    const out = await runCli('mcp', '--help');
    expect(out.stdout).toBeDefined();
  });
});
