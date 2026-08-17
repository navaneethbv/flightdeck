import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolRegistry, type McpContext } from '../../src/mcp/tools.js';
import { serveMcp } from '../../src/mcp/server.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { getDb } from '../../src/core/state.js';
import * as keychain from '../../src/secrets/keychain.js';
import { makeRepo } from '../helpers.js';

describe('MCP Tools & Server Complete Unit Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let ctx: McpContext;
  let registry: ToolRegistry;
  let secretsMap: Map<string, string>;

  beforeEach(() => {
    fixture = makeRepo();
    secretsMap = new Map<string, string>();
    vi.spyOn(keychain, 'getSecret').mockImplementation((k: string) => secretsMap.get(k) ?? null);
    vi.spyOn(keychain, 'setSecret').mockImplementation((k: string, v: string) => {
      secretsMap.set(k, v);
    });
    vi.spyOn(keychain, 'deleteSecret').mockImplementation((k: string) => {
      secretsMap.delete(k);
    });

    ctx = {
      projectRoot: fixture.root,
      sessionId: null,
      policy: 'default',
      isManager: true,
      riskyTools: true,
      confirm: async () => true,
    };
    registry = new ToolRegistry(ctx);
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  describe('Permission & Risk Gates', () => {
    it('enforces read, additive, destructive, external risks under different policies', async () => {
      const normalCtx: McpContext = {
        projectRoot: fixture.root,
        sessionId: null,
        policy: 'default',
        isManager: false,
        riskyTools: false,
        confirm: async () => false,
      };
      const normalRegistry = new ToolRegistry(normalCtx);

      // Read tools pass
      await expect(normalRegistry.call('list_sessions', {})).resolves.toBeDefined();

      // Additive tools pass
      const note = (await normalRegistry.call('note_create', { title: 'Test', body: 'Content' })) as any;
      expect(note.id).toBeDefined();

      // Destructive tools fail for normal agents without manager+riskyTools
      await expect(normalRegistry.call('remove_worktree', { name: 'wt' })).rejects.toThrow(
        /requires confirmation from the user/
      );

      // External tools fail with specific message for Argus children
      const childCtx: McpContext = {
        ...normalCtx,
        policy: 'child',
      };
      const childRegistry = new ToolRegistry(childCtx);
      await expect(childRegistry.call('ssh_run', { name: 'h', command: 'ls' })).rejects.toThrow(
        /denied for Argus children/
      );

      // Unknown tool throws
      await expect(normalRegistry.call('nonexistent_tool', {})).rejects.toThrow(/unknown tool/);
    });
  });

  describe('Session Tools', () => {
    it('create_session, get_session, list_sessions, session_status, session_logs, session_export', async () => {
      const created = (await registry.call('create_session', { name: 'agent-1', harness: 'opencode' })) as any;
      expect(created.id).toBeDefined();
      expect(created.name).toBe('agent-1');

      const fetched = (await registry.call('get_session', { id: created.id })) as any;
      expect(fetched.id).toBe(created.id);

      const status = (await registry.call('session_status', { id: created.id })) as any;
      expect(status.id).toBe(created.id);

      const logs = (await registry.call('session_logs', { id: created.id, tail: 10 })) as any;
      expect(logs.id).toBe(created.id);

      const exported = (await registry.call('session_export', { id: created.id })) as any;
      expect(exported.session.id).toBe(created.id);

      const list = (await registry.call('list_sessions', {})) as any[];
      expect(list.some((s) => s.id === created.id)).toBe(true);

      await expect(registry.call('get_session', { id: 'nonexistent' })).rejects.toThrow(/not found/);
    });
  });

  describe('Worktree Tools', () => {
    it('create_worktree, list_worktrees, worktree_status, worktree_diff, worktree_merge, remove_worktree', async () => {
      const created = (await registry.call('create_worktree', { name: 'feature-1' })) as any;
      expect(created.name).toBe('feature-1');

      const list = (await registry.call('list_worktrees', {})) as any[];
      expect(list.some((w) => w.name === 'feature-1')).toBe(true);

      const status = (await registry.call('worktree_status', { name: 'feature-1' })) as any;
      expect(status.name).toBe('feature-1');

      const diff = (await registry.call('worktree_diff', { name: 'feature-1' })) as any;
      expect(diff.diff).toBeDefined();

      const merge = (await registry.call('worktree_merge', { name: 'feature-1', dry_run: true })) as any;
      expect(merge.merged).toBe(true);

      const removed = (await registry.call('remove_worktree', { name: 'feature-1' })) as any;
      expect(removed.removed).toBe(true);
    });
  });

  describe('Notes Tools', () => {
    it('note_create, note_read, note_update, note_list, note_delete, note_search', async () => {
      const created = (await registry.call('note_create', { title: 'Design', body: 'Specs here' })) as any;
      expect(created.id).toBeDefined();

      const fetched = (await registry.call('note_read', { id: created.id })) as any;
      expect(fetched.title).toBe('Design');

      const updated = (await registry.call('note_update', { id: created.id, title: 'Design V2', body: 'Updated specs' })) as any;
      expect(updated.version).toBe(2);

      const list = (await registry.call('note_list', {})) as any[];
      expect(list.length).toBeGreaterThan(0);

      const search = (await registry.call('note_search', { query: 'Updated' })) as any[];
      expect(search.length).toBeGreaterThan(0);

      const deleted = (await registry.call('note_delete', { id: created.id })) as any;
      expect(deleted.deleted).toBe(created.id);

      await expect(registry.call('note_read', { id: 'nonexistent' })).rejects.toThrow(/not found/);
    });
  });

  describe('Tables Tools', () => {
    it('table_create, table_insert, table_query, table_list, table_update, table_aggregate, table_drop', async () => {
      await registry.call('table_create', {
        name: 'users',
        columns: [
          { name: 'id', type: 'number' },
          { name: 'username', type: 'text' },
          { name: 'active', type: 'boolean' },
        ],
        idempotency_key: 'id',
      });

      const inserted = (await registry.call('table_insert', {
        name: 'users',
        data: { id: 1, username: 'alice', active: true },
      })) as any;
      expect(inserted.rowid).toBeDefined();

      const tables = (await registry.call('table_list', {})) as any[];
      expect(tables.map((t) => t.name)).toContain('users');

      const rows = (await registry.call('table_query', {
        name: 'users',
        where: { username: 'alice' },
        limit: 10,
      })) as any[];
      expect(rows).toHaveLength(1);

      const updated = (await registry.call('table_update', {
        name: 'users',
        rowid: 1,
        data: { username: 'alice_updated' },
      })) as any;
      expect(updated.updated).toBe(true);

      const agg = (await registry.call('table_aggregate', {
        name: 'users',
        fn: 'count',
      })) as any[];
      expect(Array.isArray(agg)).toBe(true);

      const dropped = (await registry.call('table_drop', { name: 'users' })) as any;
      expect(dropped.dropped).toBe('users');
    });
  });

  describe('Messaging Tools', () => {
    it('message_send, message_list, message_poll', async () => {
      const sent = (await registry.call('message_send', {
        to: 'agent-2',
        body: 'Hello',
      })) as any;
      expect(sent.id).toBeDefined();

      const list = (await registry.call('message_list', { to: 'agent-2' })) as any[];
      expect(list).toHaveLength(1);

      const polled = (await registry.call('message_poll', { to: 'agent-2' })) as any[];
      expect(polled).toHaveLength(1);
    });
  });

  describe('SSH Tools', () => {
    it('ssh_host_add, ssh_list_hosts, ssh_run, ssh_host_remove', async () => {
      const added = (await registry.call('ssh_host_add', {
        name: 'test-host',
        host: '10.0.0.1',
        port: 22,
        user: 'admin',
        auth: 'agent',
      })) as any;
      expect(added.name).toBe('test-host');

      const list = (await registry.call('ssh_list_hosts', {})) as any[];
      expect(list.some((h) => h.name === 'test-host')).toBe(true);

      await expect(registry.call('ssh_run', { name: 'nonexistent', command: 'ls' })).rejects.toThrow(/not found/);

      const removed = (await registry.call('ssh_host_remove', { name: 'test-host' })) as any;
      expect(removed.removed).toBe('test-host');
    });
  });

  describe('Argus & Worker Tools', () => {
    it('task_get, report_done, ask_manager, argus_init_mission', async () => {
      const argusManager = new ArgusManager(fixture.root);
      const argus = argusManager.start({ name: 'm1' });
      getDb(fixture.root).prepare("UPDATE argus SET question_timeout_sec = 0 WHERE id = ?").run(argus.id);

      const sm = new SessionManager(fixture.root);
      const workerSess = sm.createSession({
        name: 'worker-1',
        harness: 'opencode',
        cwd: fixture.root,
        policy: 'child',
        argusParent: argus.id,
      });

      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [
        {
          title: 'Task 1',
          spec: 'Spec',
          dependsOn: [],
        },
      ]);
      board.assign(task.id, workerSess.id);

      const workerCtx: McpContext = {
        projectRoot: fixture.root,
        sessionId: workerSess.id,
        policy: 'child',
        isManager: false,
        riskyTools: false,
        confirm: async () => false,
      };
      const workerReg = new ToolRegistry(workerCtx);

      const got = (await workerReg.call('task_get', {})) as any;
      expect(got.title).toBe('Task 1');

      const asked = (await workerReg.call('ask_manager', { question: 'What is next?' })) as any;
      expect(asked).toBeDefined();

      const reported = (await workerReg.call('report_done', { summary: 'Done with task 1' })) as any;
      expect(reported.ok).toBe(true);

      const initMission = (await registry.call('argus_init_mission', {
        name: 'feature-x',
        template: 'feature',
        title: 'Feature X',
      })) as any;
      expect(initMission.id).toBeDefined();
    });
  });

  describe('Integration Tools (Jira, GitHub, Slack)', () => {
    it('list_jira_issues, search_jira_issues, list_github_prs, get_github_pr, list_slack_messages, refresh_integration, sync_integration_to_table', async () => {
      secretsMap.set('jira:domain', 'dom.atlassian.net');
      secretsMap.set('jira:email', 'dev@dom.com');
      secretsMap.set('jira:token', 'jtok');
      secretsMap.set('github:token', 'ghtok');
      secretsMap.set('slack:token', 'sltok');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const parsed = new URL(String(url));
        const host = parsed.hostname;
        const path = parsed.pathname;
        if (host === 'dom.atlassian.net') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ issues: [{ key: 'J-1', fields: { summary: 'Bug', status: { name: 'Open' } } }] }),
          } as any;
        }
        if (host === 'api.github.com' && path.includes('/repos/o/r/pulls/1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ number: 1, title: 'PR 1', state: 'open', html_url: 'u' }),
          } as any;
        }
        if (host === 'api.github.com') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ items: [{ number: 1, title: 'PR 1', state: 'open', html_url: 'u' }] }),
          } as any;
        }
        if (host === 'slack.com' && path.includes('/conversations.list')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }] }) } as any;
        }
        if (host === 'slack.com' && path.includes('/conversations.history')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, messages: [{ ts: '1.1', text: 'Hello' }] }) } as any;
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      });

      const jList = (await registry.call('list_jira_issues', {})) as any[];
      expect(jList).toHaveLength(1);

      const jSearch = (await registry.call('search_jira_issues', { query: 'test' })) as any[];
      expect(jSearch).toHaveLength(1);

      const gList = (await registry.call('list_github_prs', {})) as any[];
      expect(gList).toHaveLength(1);

      const gGet = (await registry.call('get_github_pr', { repo: 'o/r', number: 1 })) as any;
      expect(gGet.number).toBe(1);

      const sList = (await registry.call('list_slack_messages', {})) as any[];
      expect(sList).toHaveLength(1);

      const refreshed = (await registry.call('refresh_integration', { kind: 'jira' })) as any;
      expect(refreshed.refreshed).toBe('jira');

      const synced = (await registry.call('sync_integration_to_table', { kind: 'github' })) as any;
      expect(synced.table).toBe('github_prs');
    });
  });

  describe('Watchdog, Playbook, and Repair Tools', () => {
    it('watchdog_status, watchdog_inspect, project_repair, playbook_save, playbook_list, playbook_run, resolveSecret', async () => {
      const sess = new SessionManager(fixture.root).createSession({ name: 's1', harness: 'opencode', cwd: fixture.root });
      const inspected = (await registry.call('watchdog_inspect', { id: sess.id })) as any;
      expect(inspected.session).toBeDefined();

      const stuckList = (await registry.call('watchdog_status', {})) as any[];
      expect(Array.isArray(stuckList)).toBe(true);

      const repaired = (await registry.call('project_repair', {})) as any;
      expect(repaired.ok).toBe(true);

      const yaml = `name: simple\ndescription: test\nsteps:\n  - id: s1\n    type: note\n    operation: create\n    title: Playbook Note\n    body: Done\n`;
      const saved = (await registry.call('playbook_save', { name: 'simple', content: yaml })) as any;
      expect(saved.saved).toBe('simple');

      const pList = (await registry.call('playbook_list', {})) as string[];
      expect(pList).toContain('simple');

      const ran = (await registry.call('playbook_run', { name: 'simple' })) as any;
      expect(ran.ok).toBe(true);

      vi.spyOn(keychain, 'resolveSecret').mockReturnValue('my-secret-val');
      expect(ToolRegistry.resolveSecret('test-key')).toBe('my-secret-val');
    });
  });

  describe('serveMcp Function', () => {
    it('validates session existence and token match', async () => {
      await expect(
        serveMcp({
          projectRoot: fixture.root,
          sessionId: 'nonexistent',
          token: 'tok',
        })
      ).rejects.toThrow(/not found/);

      const sess = new SessionManager(fixture.root).createSession({ name: 'mcp-sess', harness: 'opencode', cwd: fixture.root });
      await expect(
        serveMcp({
          projectRoot: fixture.root,
          sessionId: sess.id,
          token: 'wrong-tok',
        })
      ).rejects.toThrow(/invalid session token/);
    });
  });
});
