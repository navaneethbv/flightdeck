import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Session, SessionPolicy } from '../core/types.js';
import { SessionManager } from '../sessions/manager.js';
import { createWorktree, listWorktrees, removeWorktree, worktreeStatus, worktreeDiff, worktreeMerge } from '../worktrees/manager.js';
import { WatchdogManager } from '../watchdog/manager.js';
import { NotesStore } from '../notes/store.js';
import { TablesStore, type ColumnDef } from '../tables/store.js';
import { MessagingStore } from '../messaging/store.js';
import { SshStore } from '../ssh/hosts.js';
import { Integrations } from '../integrations/index.js';
import { PlaybookEngine, type EngineServices } from '../playbooks/engine.js';
import { parsePlaybookYaml } from '../playbooks/parser.js';
import type { Playbook } from '../playbooks/types.js';
import { playbooksDir, globalPlaybooksDir } from '../core/paths.js';
import { getDefaultHarness } from '../core/config.js';
import { getAdapter } from '../sessions/harness.js';
import { resolveSecret } from '../secrets/keychain.js';
import { exportSession } from '../sessions/export.js';
import { renderMissionTemplate } from '../argus/templates.js';
import { repairProject } from '../core/repair.js';
import { TaskBoard } from '../argus/board.js';
import { QuestionQueue } from '../argus/questions.js';
import { getDb } from '../core/state.js';

function asStr(val: unknown, fallback = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return fallback;
}

function asOptStr(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return undefined;
}

export type ToolRisk = 'read' | 'additive' | 'destructive' | 'external';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: ToolRisk;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface McpContext {
  projectRoot: string;
  sessionId: string | null;
  policy: SessionPolicy;
  isManager: boolean;
  riskyTools: boolean;
  confirm: (action: string) => Promise<boolean>;
}

export class ToolRegistry {
  private readonly sessions: SessionManager;
  private readonly notes: NotesStore;
  private readonly tables: TablesStore;
  private readonly messaging: MessagingStore;
  private readonly ssh: SshStore;
  private readonly integrations: Integrations;
  private readonly board: TaskBoard;
  private readonly questions: QuestionQueue;
  readonly tools: Map<string, ToolDef> = new Map();

  constructor(private readonly ctx: McpContext) {
    this.sessions = new SessionManager(ctx.projectRoot);
    this.notes = new NotesStore(ctx.projectRoot);
    this.tables = new TablesStore(ctx.projectRoot);
    this.messaging = new MessagingStore(ctx.projectRoot);
    this.ssh = new SshStore(ctx.projectRoot);
    this.integrations = new Integrations(ctx.projectRoot);
    this.board = new TaskBoard(ctx.projectRoot);
    this.questions = new QuestionQueue(ctx.projectRoot);
    this.registerAll();
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const def = this.tools.get(tool);
    if (!def) throw new Error(`unknown tool "${tool}"`);
    const gate = this.permissionError(def);
    if (gate) throw new Error(gate);
    return def.handler(args);
  }

  private permissionError(def: ToolDef): string | null {
    if (def.risk === 'read' || def.risk === 'additive') return null;
    const allowed = this.ctx.isManager && this.ctx.riskyTools;
    if (allowed) return null;
    if (def.risk === 'external' && this.ctx.policy === 'child') {
      return `tool "${def.name}" is denied for Argus children unless risky tools are enabled`;
    }
    return `tool "${def.name}" requires confirmation from the user (denied automatically for agent sessions)`;
  }

  private register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  private registerAll(): void {
    const s = this.ctx;
    const sessions = this.sessions;
    const notes = this.notes;
    const tables = this.tables;
    const messaging = this.messaging;
    const ssh = this.ssh;
    const integrations = this.integrations;

    this.register({
      name: 'create_session',
      description: 'Create a new coding-agent session in this project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          harness: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
          worktree: { type: 'string' },
        },
        required: ['name'],
      },
      risk: 'additive',
      handler: async (args) => {
        const wt = asOptStr(args.worktree);
        const cwd = wt
          ? path.join(s.projectRoot, '.flightdeck', 'worktrees', wt)
          : s.projectRoot;
        const session = sessions.createSession({
          name: asStr(args.name),
          harness: (args.harness as Session['harness']) ?? getDefaultHarness(),
          worktree: wt ?? null,
          cwd,
        });
        return session;
      },
    });

    this.register({
      name: 'list_sessions',
      description: 'List sessions in this project.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => sessions.list(),
    });

    this.register({
      name: 'get_session',
      description: 'Get details for one session.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      risk: 'read',
      handler: async (args) => {
        const session = sessions.get(String(args.id));
        if (!session) throw new Error(`session "${args.id}" not found`);
        return session;
      },
    });

    this.register({
      name: 'create_worktree',
      description: 'Create an isolated Git worktree for a new task.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      risk: 'additive',
      handler: async (args) => createWorktree(s.projectRoot, String(args.name), s.sessionId ?? undefined),
    });

    this.register({
      name: 'list_worktrees',
      description: 'List worktrees in this project.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => listWorktrees(s.projectRoot),
    });

    this.register({
      name: 'remove_worktree',
      description: 'Remove a worktree.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      risk: 'destructive',
      handler: async (args) => {
        removeWorktree(s.projectRoot, String(args.name));
        return { removed: true };
      },
    });

    this.register({
      name: 'worktree_status',
      description: 'Get git status of a worktree (clean/dirty, modified, untracked, ahead).',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      risk: 'read',
      handler: async (args) => worktreeStatus(s.projectRoot, String(args.name)),
    });

    this.register({
      name: 'worktree_diff',
      description: 'Get git diff of a worktree against the base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          base_branch: { type: 'string' },
        },
        required: ['name'],
      },
      risk: 'read',
      handler: async (args) =>
        worktreeDiff(
          s.projectRoot,
          asStr(args.name),
          asStr(args.base_branch, 'main')
        ),
    });

    this.register({
      name: 'worktree_merge',
      description: 'Merge a worktree branch into the base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          target_branch: { type: 'string' },
          dry_run: { type: 'boolean' },
        },
        required: ['name'],
      },
      risk: 'destructive',
      handler: async (args) =>
        worktreeMerge(s.projectRoot, asStr(args.name), {
          targetBranch: asOptStr(args.target_branch),
          dryRun: args.dry_run === true,
        }),
    });

    this.register({
      name: 'session_status',
      description: 'Status of a session.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      risk: 'read',
      handler: async (args) => sessions.get(String(args.id)),
    });

    this.register({
      name: 'session_logs',
      description: 'Get recent output logs from a session.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tail: { type: 'number' },
        },
        required: ['id'],
      },
      risk: 'read',
      handler: async (args) => ({
        id: args.id,
        logs: sessions.getLogs(String(args.id), args.tail !== undefined ? Number(args.tail) : 100),
      }),
    });

    this.register({
      name: 'session_export',
      description: 'Export complete session bundle (status, logs, git diffs, notes, messages).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      risk: 'read',
      handler: async (args) => exportSession(s.projectRoot, String(args.id)),
    });

    this.register({
      name: 'argus_init_mission',
      description: 'Create a structured Mission note using a template (feature, refactor, audit, bugfix).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          template: { type: 'string', enum: ['feature', 'refactor', 'audit', 'bugfix'] },
          title: { type: 'string' },
        },
        required: ['name'],
      },
      risk: 'additive',
      handler: async (args) => {
        const name = asStr(args.name);
        const title = asOptStr(args.title) ?? name;
        const template = (args.template as 'feature' | 'refactor' | 'audit' | 'bugfix') ?? 'feature';
        const body = renderMissionTemplate(template, title);
        return notes.createNote(`${name}-mission`, body);
      },
    });

    this.register({
      name: 'project_repair',
      description: 'Check and self-heal project integrity, git worktrees, and dead sessions.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'additive',
      handler: async () => repairProject(s.projectRoot),
    });

    const watchdog = new WatchdogManager(s.projectRoot);
    this.register({
      name: 'watchdog_status',
      description: 'List hung or stuck agent sessions.',
      inputSchema: {
        type: 'object',
        properties: { timeout_seconds: { type: 'number' } },
      },
      risk: 'read',
      handler: async (args) =>
        watchdog.listHung(args.timeout_seconds !== undefined ? Number(args.timeout_seconds) : 300),
    });

    this.register({
      name: 'watchdog_inspect',
      description: 'Inspect a session for stuck state, hung loops, or waiting permission prompts.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          timeout_seconds: { type: 'number' },
        },
        required: ['id'],
      },
      risk: 'read',
      handler: async (args) =>
        watchdog.inspect(
          asStr(args.id),
          args.timeout_seconds !== undefined ? Number(args.timeout_seconds) : 300
        ),
    });

    const noteTools: [string, { description: string; inputSchema: Record<string, unknown>; risk: ToolRisk; handler: (a: Record<string, unknown>) => Promise<unknown> }][] = [
      ['note_create', {
        description: 'Create a note in the project notes store.',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] },
        risk: 'additive',
        handler: async (a: Record<string, unknown>) => notes.createNote(asStr(a.title), asStr(a.body)),
      }],
      ['note_read', {
        description: 'Read a note by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        risk: 'read',
        handler: async (a: Record<string, unknown>) => {
          const note = notes.readNote(asStr(a.id));
          if (!note) throw new Error(`note "${a.id}" not found`);
          return note;
        },
      }],
      ['note_update', {
        description: 'Update a note title and/or body (new version).',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['id'] },
        risk: 'additive',
        handler: async (a: Record<string, unknown>) => notes.updateNote(asStr(a.id), {
          title: asOptStr(a.title),
          body: asOptStr(a.body),
        }),
      }],
      ['note_search', {
        description: 'Full-text search notes.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        risk: 'read',
        handler: async (a: Record<string, unknown>) => notes.searchNotes(String(a.query)),
      }],
      ['note_list', {
        description: 'List notes, most recently updated first.',
        inputSchema: { type: 'object', properties: {} },
        risk: 'read',
        handler: async () => notes.listNotes(),
      }],
      ['note_delete', {
        description: 'Delete a note by id.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        risk: 'destructive',
        handler: async (a: Record<string, unknown>) => {
          notes.deleteNote(String(a.id));
          return { deleted: a.id };
        },
      }],
    ];
    for (const [name, def] of noteTools) {
      this.register({ name, description: def.description, inputSchema: def.inputSchema, risk: def.risk, handler: def.handler });
    }

    this.register({
      name: 'table_create',
      description: 'Create a typed table.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          columns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'boolean', 'date'] }, relation: { type: 'string' } }, required: ['name', 'type'] } },
          idempotency_key: { type: 'string' },
        },
        required: ['name', 'columns'],
      },
      risk: 'additive',
      handler: async (args) =>
        tables.createTable(
          asStr(args.name),
          (args.columns as ColumnDef[]) ?? [],
          asOptStr(args.idempotency_key)
        ),
    });

    this.register({
      name: 'table_insert',
      description: 'Insert a row into a table.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, data: { type: 'object' } },
        required: ['name', 'data'],
      },
      risk: 'additive',
      handler: async (args) => tables.insertRow(asStr(args.name), (args.data as Record<string, unknown>) ?? {}),
    });

    this.register({
      name: 'table_list',
      description: 'List structured project tables and their schemas.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => tables.listTables(),
    });

    this.register({
      name: 'table_query',
      description: 'Query rows from a table with optional equality filters.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          where: { type: 'object' },
          limit: { type: 'number' },
          order_by: { type: 'object', properties: { col: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
        },
        required: ['name'],
      },
      risk: 'read',
      handler: async (args) =>
        tables.query(asStr(args.name), {
          where: args.where as Record<string, unknown> | undefined,
          limit: args.limit !== undefined ? Number(args.limit) : undefined,
          orderBy: args.order_by as { col: string; dir?: 'asc' | 'desc' } | undefined,
        }),
    });

    this.register({
      name: 'table_update',
      description: 'Update a row by rowid.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, rowid: { type: 'number' }, data: { type: 'object' } },
        required: ['name', 'rowid', 'data'],
      },
      risk: 'additive',
      handler: async (args) => {
        tables.updateRow(asStr(args.name), Number(args.rowid), (args.data as Record<string, unknown>) ?? {});
        return { updated: true };
      },
    });

    this.register({
      name: 'table_aggregate',
      description: 'Aggregate a column (count/sum/avg/min/max), optionally grouped.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          fn: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
          column: { type: 'string' },
          group_by: { type: 'string' },
        },
        required: ['name', 'fn'],
      },
      risk: 'read',
      handler: async (args) =>
        tables.aggregate(
          asStr(args.name),
          args.fn as 'count' | 'sum' | 'avg' | 'min' | 'max',
          asOptStr(args.column),
          asOptStr(args.group_by)
        ),
    });

    this.register({
      name: 'table_drop',
      description: 'Drop a table.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      risk: 'destructive',
      handler: async (args) => {
        tables.dropTable(asStr(args.name));
        return { dropped: args.name };
      },
    });

    this.register({
      name: 'message_send',
      description: 'Send a message to another session (or broadcast).',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'string' } },
        required: ['body'],
      },
      risk: 'additive',
      handler: async (args) =>
        messaging.send(s.sessionId ?? 'agent', asOptStr(args.to) ?? null, asStr(args.body)),
    });

    const board = this.board;
    const questions = this.questions;

    // Worker-facing. All three are read or additive so a `policy: 'child'`
    // session can call them without a risky-tools grant.
    this.register({
      name: 'task_get',
      description: 'Get the task currently assigned to this session, with its full spec.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => {
        if (!s.sessionId) throw new Error('task_get requires a session');
        const mine = board
          .listByAssignee(s.sessionId)
          .find((t) => t.status === 'assigned' || t.status === 'revising');
        if (!mine) throw new Error('no task is currently assigned to this session');
        return {
          id: mine.id,
          title: mine.title,
          spec: mine.spec,
          status: mine.status,
          attempts: mine.attempts,
          previousFeedback: mine.verdictReason,
        };
      },
    });

    this.register({
      name: 'report_done',
      description:
        'Report the assigned task complete. Provide an honest summary; automated test and lint gates run immediately afterwards and will return the task to you if they fail.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tests_run: { type: 'string' },
          uncertainties: { type: 'string' },
        },
        required: ['summary'],
      },
      risk: 'additive',
      handler: async (args) => {
        if (!s.sessionId) throw new Error('report_done requires a session');
        const mine = board
          .listByAssignee(s.sessionId)
          .find((t) => t.status === 'assigned' || t.status === 'revising');
        if (!mine) throw new Error('no task is currently assigned to this session');
        const files = Array.isArray(args.files_changed)
          ? (args.files_changed as unknown[]).map((f) => asStr(f))
          : [];
        board.report(mine.id, {
          summary: asStr(args.summary),
          filesChanged: files,
          testsRun: asStr(args.tests_run),
          uncertainties: asStr(args.uncertainties),
        });
        return { ok: true, taskId: mine.id, next: 'gates' };
      },
    });

    this.register({
      name: 'ask_manager',
      description:
        'Ask the orchestrator a question. Answers are cached, so repeated questions are free. If no answer arrives in time, proceed on your best judgment and record the assumption in your report.',
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
        required: ['question'],
      },
      risk: 'additive',
      handler: async (args) => {
        if (!s.sessionId) throw new Error('ask_manager requires a session');
        const session = sessions.get(s.sessionId);
        const argusId = session?.argusParent;
        if (!argusId) throw new Error('ask_manager is only available to fleet workers');

        const question = asStr(args.question);
        const asked = questions.ask(argusId, s.sessionId, question);
        if (asked.hit) return { answer: asked.answer, cached: true };

        const row = getDb(s.projectRoot)
          .prepare('SELECT question_timeout_sec FROM argus WHERE id = ?')
          .get(argusId) as { question_timeout_sec?: number } | undefined;
        const timeoutMs = Number(row?.question_timeout_sec ?? 120) * 1000;

        const answer = await questions.waitForAnswer(asked.id, timeoutMs);
        if (answer !== null) return { answer, cached: false };
        return {
          answer: null,
          cached: false,
          directive:
            'No answer available in time. Proceed on your best judgment and record the assumption in the uncertainties field of your report.',
        };
      },
    });

    this.register({
      name: 'message_list',
      description: 'List recent messages.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, limit: { type: 'number' } },
      },
      risk: 'read',
      handler: async (args) =>
        messaging.list({
          to: asOptStr(args.to),
          limit: args.limit !== undefined ? Number(args.limit) : undefined,
        }),
    });

    this.register({
      name: 'message_poll',
      description: 'Poll for new messages to a session since a message id.',
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, since_id: { type: 'number' } },
        required: ['to'],
      },
      risk: 'read',
      handler: async (args) => messaging.poll(asStr(args.to), args.since_id !== undefined ? Number(args.since_id) : 0),
    });

    this.register({
      name: 'list_jira_issues',
      description: 'List unresolved Jira issues assigned to the user (cached).',
      inputSchema: {
        type: 'object',
        properties: {
          jql: { type: 'string' },
          max: { type: 'number' },
          force: { type: 'boolean' },
        },
      },
      risk: 'read',
      handler: async (a) =>
        integrations.listJiraIssues({
          jql: asOptStr(a.jql),
          max: a.max !== undefined ? Number(a.max) : undefined,
          force: a.force === true,
        }),
    });

    this.register({
      name: 'search_jira_issues',
      description: 'Search Jira issues by text.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max: { type: 'number' },
        },
        required: ['query'],
      },
      risk: 'read',
      handler: async (a) =>
        integrations.searchJiraIssues(String(a.query), a.max !== undefined ? Number(a.max) : 10),
    });

    this.register({
      name: 'list_github_prs',
      description: 'List GitHub PRs for the user (cached).',
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          max: { type: 'number' },
          force: { type: 'boolean' },
        },
      },
      risk: 'read',
      handler: async (a) =>
        integrations.listGithubPrs({
          state: a.state as 'open' | 'closed' | 'all' | undefined,
          max: a.max !== undefined ? Number(a.max) : undefined,
          force: a.force === true,
        }),
    });

    this.register({
      name: 'get_github_pr',
      description: 'Get a specific GitHub PR.',
      inputSchema: {
        type: 'object',
        properties: {
          repo: { type: 'string' },
          number: { type: 'number' },
        },
        required: ['repo', 'number'],
      },
      risk: 'read',
      handler: async (a) => integrations.getGithubPr(String(a.repo), Number(a.number)),
    });

    this.register({
      name: 'list_slack_messages',
      description: 'List recent Slack messages (cached).',
      inputSchema: {
        type: 'object',
        properties: {
          max: { type: 'number' },
          force: { type: 'boolean' },
        },
      },
      risk: 'read',
      handler: async (a) =>
        integrations.listSlackMessages({
          max: a.max !== undefined ? Number(a.max) : undefined,
          force: a.force === true,
        }),
    });

    this.register({
      name: 'refresh_integration',
      description: 'Force-refresh the integration cache for a provider.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['jira', 'github', 'slack'] },
        },
        required: ['kind'],
      },
      risk: 'additive',
      handler: async (a) => {
        const kind = String(a.kind);
        if (kind !== 'jira' && kind !== 'github' && kind !== 'slack') {
          throw new Error(`unknown integration "${kind}"`);
        }
        await integrations.refresh(kind);
        return { refreshed: kind };
      },
    });

    this.register({
      name: 'sync_integration_to_table',
      description: 'Sync Jira, GitHub, or Slack records directly into project tables.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['jira', 'github', 'slack'] },
        },
        required: ['kind'],
      },
      risk: 'additive',
      handler: async (a) => {
        const kind = String(a.kind);
        if (kind !== 'jira' && kind !== 'github' && kind !== 'slack') {
          throw new Error(`unknown integration "${kind}"`);
        }
        return integrations.syncToTable(kind);
      },
    });

    this.register({
      name: 'ssh_host_add',
      description: 'Add a saved SSH host.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          host: { type: 'string' },
          port: { type: 'number' },
          user: { type: 'string' },
          auth: { type: 'string', enum: ['agent', 'key', 'password'] },
          key_file: { type: 'string' },
        },
        required: ['name', 'host'],
      },
      risk: 'additive',
      handler: async (args) =>
        ssh.add({
          name: asStr(args.name),
          host: asStr(args.host),
          port: args.port !== undefined ? Number(args.port) : null,
          user: asOptStr(args.user) ?? null,
          auth: (args.auth as 'agent' | 'key' | 'password' | undefined) ?? 'agent',
          keyFile: asOptStr(args.key_file) ?? null,
          createdAt: 0,
        }),
    });

    this.register({
      name: 'ssh_host_remove',
      description: 'Remove a saved SSH host.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
      risk: 'destructive',
      handler: async (args) => {
        ssh.remove(String(args.name));
        return { removed: args.name };
      },
    });

    this.register({
      name: 'ssh_list_hosts',
      description: 'List saved SSH hosts.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => ssh.list(),
    });

    this.register({
      name: 'ssh_run',
      description: 'Run a command on a saved SSH host and return output.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, command: { type: 'string' } },
        required: ['name', 'command'],
      },
      risk: 'external',
      handler: async (args) => {
        const host = ssh.get(String(args.name));
        if (!host) throw new Error(`ssh host "${args.name}" not found`);
        return ssh.run(host, String(args.command));
      },
    });

    this.register({
      name: 'playbook_list',
      description: 'List available playbooks.',
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      handler: async () => this.listPlaybooks(),
    });

    this.register({
      name: 'playbook_save',
      description: 'Save a playbook from YAML content.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, content: { type: 'string' } },
        required: ['name', 'content'],
      },
      risk: 'additive',
      handler: async (args) => {
        const name = String(args.name);
        parsePlaybookYaml(String(args.content), name);
        const dir = playbooksDir(s.projectRoot);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${name}.yml`), String(args.content));
        return { saved: name };
      },
    });

    this.register({
      name: 'playbook_run',
      description: 'Run a playbook.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' }, inputs: { type: 'object' } },
        required: ['name'],
      },
      risk: 'external',
      handler: async (args) => {
        const playbook = this.readPlaybook(String(args.name));
        if (!playbook) throw new Error(`playbook "${args.name}" not found`);
        const engine = new PlaybookEngine(this.engineServices());
        return engine.run(playbook, { inputs: (args.inputs as Record<string, unknown> | undefined) ?? {} });
      },
    });
  }

  private listPlaybooks(): string[] {
    const dirs = [playbooksDir(this.ctx.projectRoot), globalPlaybooksDir];
    const names = new Set<string>();
    for (const dir of dirs) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith('.yml')) names.add(file.slice(0, -4));
        }
      } catch {
        // dir missing
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  private readPlaybook(name: string): Playbook | null {
    const candidates = [
      path.join(playbooksDir(this.ctx.projectRoot), `${name}.yml`),
      path.join(globalPlaybooksDir, `${name}.yml`),
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) return parsePlaybookYaml(fs.readFileSync(file, 'utf8'), name);
    }
    return null;
  }

  private engineServices(): EngineServices {
    return {
      projectRoot: this.ctx.projectRoot,
      tables: this.tables,
      notes: this.notes,
      messaging: this.messaging,
      callMcpTool: async (tool, args) => this.call(tool, args),
      runHeadlessPrompt: async (prompt) => {
        const harness = getAdapter(getDefaultHarness());
        const args = harness.headlessArgs(prompt, {});
        const out = spawnSync(harness.binary, args, {
          cwd: this.ctx.projectRoot,
          env: { ...process.env, ...harness.profileEnv({} as Session) },
          encoding: 'utf8',
          timeout: 120000,
          maxBuffer: 20 * 1024 * 1024,
        });
        return { stdout: out.stdout ?? out.stderr ?? '', exitCode: out.status ?? -1 };
      },
      readPlaybook: (name) => this.readPlaybook(name),
      confirm: this.ctx.confirm,
      fromSession: this.ctx.sessionId,
    };
  }

  // resolveSecret re-exported so the secret template resolver and this module share one source
  static resolveSecret(name: string): string {
    return resolveSecret(name);
  }
}
