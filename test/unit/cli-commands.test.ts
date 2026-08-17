import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs';
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
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { getDb } from '../../src/core/state.js';
import * as keychain from '../../src/secrets/keychain.js';
import { makeRepo } from '../helpers.js';

describe('CLI Commands In-Process Execution Suite', () => {
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
    return program;
  }

  async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    stdoutChunks = [];
    stderrChunks = [];
    const prog = createProgram();
    try {
      await prog.parseAsync(args, { from: 'user' });
    } catch (err: any) {
      if (err.code !== 'commander.helpDisplayed' && err.code !== 'commander.version') {
        // captured
      }
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
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  describe('Session & Worktree CLI', () => {
    it('exercises session and worktree commands', async () => {
      const sm = new SessionManager(fixture.root);
      const sess = sm.createSession({ name: 'test-sess', harness: 'opencode', cwd: fixture.root });

      // session list
      let out = await runCli('session', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain(sess.id);
      out = await runCli('session', 'list', '--project', fixture.root);
      expect(out.stdout).toContain(sess.id.slice(0, 8));

      // session logs
      out = await runCli('session', 'logs', sess.id, '--project', fixture.root);
      expect(out.stdout).toBeDefined();

      // session export
      out = await runCli('session', 'export', sess.id, '--project', fixture.root);
      expect(out.stdout).toBeDefined();

      // session stop
      out = await runCli('session', 'stop', sess.id, '--project', fixture.root);
      expect(out.stdout).toContain('stopped');

      // worktree create, list, status, diff, merge, remove
      out = await runCli('worktree', 'create', 'wt-cli', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('wt-cli');
      out = await runCli('worktree', 'create', 'wt-cli-2', '--project', fixture.root);
      expect(out.stdout).toContain('created worktree');

      out = await runCli('worktree', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('wt-cli');
      out = await runCli('worktree', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('wt-cli');

      out = await runCli('worktree', 'status', 'wt-cli', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('wt-cli');
      out = await runCli('worktree', 'status', 'wt-cli', '--project', fixture.root);

      out = await runCli('worktree', 'diff', 'wt-cli', '--project', fixture.root);
      expect(out.stdout).toContain('no changes');

      out = await runCli('worktree', 'merge', 'wt-cli', '--dry-run', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('merged');

      out = await runCli('worktree', 'remove', 'wt-cli', '--project', fixture.root);
      expect(out.stdout).toContain('removed worktree');
    });
  });

  describe('Note, Table, and Message CLI', () => {
    it('exercises note commands', async () => {
      let out = await runCli('note', 'create', 'Note 1', '-b', 'Content 1', '--project', fixture.root, '--json');
      const noteJson = JSON.parse(out.stdout);
      expect(noteJson.id).toBeDefined();

      out = await runCli('note', 'create', 'Note 2', '-b', 'Content 2', '--project', fixture.root);
      expect(out.stdout).toContain('created note');

      out = await runCli('note', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Note 1');
      out = await runCli('note', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('Note 1');

      out = await runCli('note', 'read', noteJson.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Note 1');
      out = await runCli('note', 'read', noteJson.id, '--project', fixture.root);
      expect(out.stdout).toContain('Note 1');

      out = await runCli('note', 'update', noteJson.id, '--title', 'Note 1 Updated', '-b', 'New Body', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Note 1 Updated');

      out = await runCli('note', 'search', 'Updated', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Note 1 Updated');
      out = await runCli('note', 'search', 'Updated', '--project', fixture.root);
      expect(out.stdout).toContain('Note 1 Updated');

      out = await runCli('note', 'delete', noteJson.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('deleted');
    });

    it('exercises table commands', async () => {
      const cols = JSON.stringify([{ name: 'id', type: 'number' }, { name: 'name', type: 'text' }]);
      let out = await runCli('table', 'create', 'users', '--columns', cols, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('users');
      out = await runCli('table', 'create', 'items', '--columns', cols, '--project', fixture.root);
      expect(out.stdout).toContain('created table');

      out = await runCli('table', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('users');
      out = await runCli('table', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('users');

      out = await runCli('table', 'insert', 'users', '--data', '{"id":1,"name":"Alice"}', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('rowid');

      out = await runCli('table', 'query', 'users', '--where', '{"name":"Alice"}', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Alice');
      out = await runCli('table', 'query', 'users', '--project', fixture.root);
      expect(out.stdout).toContain('Alice');

      out = await runCli('table', 'update', 'users', '--rowid', '1', '--data', '{"name":"Alice Updated"}', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('updated');

      out = await runCli('table', 'aggregate', 'users', '--fn', 'count', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('value');

      out = await runCli('table', 'drop', 'users', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('dropped');
    });

    it('exercises message commands', async () => {
      let out = await runCli('message', 'send', '--to', 'agent-2', 'Hello Agent', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Hello Agent');
      out = await runCli('message', 'send', '--to', 'agent-3', 'Hi there', '--project', fixture.root);
      expect(out.stdout).toContain('sent message');

      out = await runCli('message', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Hello Agent');
      out = await runCli('message', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('Hello Agent');
    });
  });

  describe('Playbook, Integration, and SSH CLI', () => {
    it('exercises playbook commands', async () => {
      const pbYaml = `name: cli-pb\ndescription: CLI test\nsteps:\n  - id: s1\n    type: bash\n    command: echo "ran"\n`;
      const pbFile = path.join(fixture.root, 'test-pb.yml');
      fs.writeFileSync(pbFile, pbYaml);

      let out = await runCli('playbook', 'save', 'cli-pb', pbFile, '--project', fixture.root);
      expect(out.stdout).toContain('saved playbook');

      out = await runCli('playbook', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('cli-pb');
      out = await runCli('playbook', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('cli-pb');

      out = await runCli('playbook', 'run', 'cli-pb', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('ok');
    });

    it('exercises integration and ssh commands', async () => {
      vi.spyOn(keychain, 'getSecret').mockReturnValue('mock-token');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ items: [{ number: 1, title: 'PR 1' }] }),
      } as any);

      let out = await runCli('integration', 'status', '--project', fixture.root, '--json');
      expect(out.stdout).toBeDefined();

      out = await runCli('integration', 'refresh', 'github', '--project', fixture.root);
      expect(out.stdout).toContain('refreshed');

      out = await runCli('integration', 'sync', 'github', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('github_prs');

      out = await runCli('integration', 'deauth', 'github', '--project', fixture.root);
      expect(out.stdout).toContain('removed');

      // SSH commands
      out = await runCli('ssh', 'add', 'host-1', '192.168.1.1', '--user', 'admin', '--project', fixture.root);
      expect(out.stdout).toContain('added host');
      out = await runCli('ssh', 'add', 'host-2', '192.168.1.2', '--project', fixture.root);
      expect(out.stdout).toContain('added host');

      out = await runCli('ssh', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('host-1');
      out = await runCli('ssh', 'list', '--project', fixture.root);
      expect(out.stdout).toContain('host-1');

      out = await runCli('ssh', 'remove', 'host-1', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('removed');
    });
  });

  describe('Quota, Argus, Fleet, Config, Doctor, Watchdog, UI CLI', () => {
    it('exercises quota, argus, fleet, config, doctor, watchdog, ui commands', async () => {
      // Quota
      let out = await runCli('quota', 'create', 'pool-cli', '--max-tokens', '500000', '--window', '1h', '--json');
      expect(out.stdout).toContain('pool-cli');
      out = await runCli('quota', 'create', 'pool-cli-2', '--max-tokens', '100000', '--window', '30m');
      expect(out.stdout).toContain('created quota');

      out = await runCli('quota', 'list', '--json');
      expect(out.stdout).toContain('pool-cli');
      out = await runCli('quota', 'list');
      expect(out.stdout).toContain('pool-cli');

      out = await runCli('quota', 'show', 'pool-cli', '--json');
      expect(out.stdout).toContain('pool-cli');
      out = await runCli('quota', 'show', 'pool-cli');
      expect(out.stdout).toContain('pool-cli');

      // Argus
      const argusMgr = new ArgusManager(fixture.root);
      const argus = argusMgr.start({ name: 'mission-cli', quotaId: 'pool-cli' });

      out = await runCli('argus', 'init', 'my-feature', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('my-feature');

      out = await runCli('argus', 'status', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('mission-cli');
      out = await runCli('argus', 'status', '--project', fixture.root);
      expect(out.stdout).toContain('mission-cli');

      out = await runCli('argus', 'status', argus.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('mission-cli');
      out = await runCli('argus', 'status', argus.id, '--project', fixture.root);
      expect(out.stdout).toContain('mission-cli');

      out = await runCli('argus', 'budget', argus.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('tier');
      out = await runCli('argus', 'budget', argus.id, '--project', fixture.root);
      expect(out.stdout).toContain('tier');

      getDb(fixture.root).prepare("UPDATE argus SET status = 'running' WHERE id = ?").run(argus.id);
      out = await runCli('argus', 'pause', argus.id, '--project', fixture.root);
      expect(out.stdout).toContain('paused');

      out = await runCli('argus', 'resume', argus.id, '--project', fixture.root);
      expect(out.stdout).toContain('resumed');

      // Argus Tasks
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'Task 1', spec: 'Spec 1', dependsOn: [] }]);
      const allTasks = getDb(fixture.root).prepare('SELECT * FROM tasks').all();
      console.log('all tasks in db:', allTasks);

      out = await runCli('argus', 'board', argus.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Task 1');
      out = await runCli('argus', 'board', argus.id, '--project', fixture.root);
      expect(out.stdout).toContain('Task 1');

      out = await runCli('argus', 'task', task.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('Task 1');
      out = await runCli('argus', 'task', task.id, '--project', fixture.root);
      expect(out.stdout).toContain('Task 1');

      // Fleet
      out = await runCli('fleet', 'status', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('tmuxSession');

      out = await runCli('fleet', 'override', 'accept', task.id, '--argus', argus.id, '--project', fixture.root, '--json');
      if (!out.stdout) console.error('fleet override accept error:', out.stderr);
      expect(out.stdout).toContain('accepted');

      out = await runCli('fleet', 'override', 'prioritize', task.id, '--argus', argus.id, '--project', fixture.root, '--json');
      expect(out.stdout).toContain('prioritize');

      // Config
      out = await runCli('config', 'get', '--json');
      expect(out.stdout).toContain('defaultHarness');
      out = await runCli('config', 'get');
      expect(out.stdout).toContain('default harness');

      out = await runCli('config', 'set-default-harness', 'claude');
      expect(out.stdout).toContain('claude');

      out = await runCli('config', 'path');
      expect(out.stdout).toBeDefined();

      // Doctor, Login, Watchdog
      out = await runCli('doctor', '--project', fixture.root, '--json');
      expect(out.stdout).toContain('git');

      out = await runCli('login', 'claude', '--check', '--json');
      expect(out.stdout).toContain('claude');

      out = await runCli('watchdog', 'list', '--project', fixture.root, '--json');
      expect(out.stdout).toBeDefined();
    });
  });
});
