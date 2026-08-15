import { getDb, now } from '../core/state.js';
import { deleteSecret, getSecret, setSecret } from '../secrets/keychain.js';
import type { IntegrationKind } from '../core/types.js';
import { TablesStore } from '../tables/store.js';
import {
  verifyJira,
  fetchJiraIssues,
  extractJiraConfig,
  type JiraIssue,
} from './jira.js';
import { verifyGithub, fetchGithubPrs, fetchGithubPr, type GithubPr } from './github.js';
import { verifySlack, fetchSlackMessages, type SlackMessage } from './slack.js';
import type { DatabaseSync } from 'node:sqlite';

export interface IntegrationAuthOptions {
  domain?: string;
  email?: string;
  token: string;
  repo?: string;
}

const KINDS: IntegrationKind[] = ['jira', 'github', 'slack'];

function cacheKey(kind: string, suffix = ''): string {
  return suffix ? `${kind}:${suffix}` : kind;
}

export class Integrations {
  private readonly db: DatabaseSync;
  constructor(private readonly projectRoot: string) {
    this.db = getDb(projectRoot);
  }

  isConfigured(kind: IntegrationKind): boolean {
    switch (kind) {
      case 'jira':
        return getSecret('jira:token') !== null;
      case 'github':
        return getSecret('github:token') !== null;
      case 'slack':
        return getSecret('slack:token') !== null;
    }
  }

  async auth(kind: IntegrationKind, opts: IntegrationAuthOptions): Promise<void> {
    if (kind === 'jira') {
      if (!opts.domain || !opts.email) throw new Error('jira auth requires --domain and --email');
      await verifyJira({ domain: opts.domain, email: opts.email, token: opts.token });
      setSecret('jira:domain', opts.domain);
      setSecret('jira:email', opts.email);
      setSecret('jira:token', opts.token);
    } else if (kind === 'github') {
      await verifyGithub(opts.token);
      setSecret('github:token', opts.token);
    } else if (kind === 'slack') {
      await verifySlack(opts.token);
      setSecret('slack:token', opts.token);
    }
    await this.refresh(kind);
  }

  deauth(kind: IntegrationKind): void {
    for (const name of ['domain', 'email', 'token']) {
      deleteSecret(`${kind}:${name}`);
    }
    this.db.prepare('DELETE FROM integration_cache WHERE kind = ?').run(kind);
  }

  private cached<T>(kind: string, suffix = ''): { data: T; fetchedAt: number } | null {
    const row = this.db
      .prepare('SELECT data_json, fetched_at FROM integration_cache WHERE cache_key = ?')
      .get(cacheKey(kind, suffix)) as { data_json: string; fetched_at: number } | undefined;
    if (!row) return null;
    return { data: JSON.parse(row.data_json) as T, fetchedAt: row.fetched_at };
  }

  private putCache(kind: string, data: unknown, suffix = ''): void {
    this.db
      .prepare('INSERT OR REPLACE INTO integration_cache (cache_key, kind, data_json, fetched_at) VALUES (?, ?, ?, ?)')
      .run(cacheKey(kind, suffix), kind, JSON.stringify(data), now());
  }

  async refresh(kind: IntegrationKind): Promise<void> {
    if (kind === 'jira') {
      const config = this.jiraConfig();
      const issues = await fetchJiraIssues(config);
      this.putCache('jira', issues);
    } else if (kind === 'github') {
      const token = this.requireToken('github');
      const prs = await fetchGithubPrs(token, {});
      this.putCache('github', prs);
    } else if (kind === 'slack') {
      const token = this.requireToken('slack');
      const messages = await fetchSlackMessages(token);
      this.putCache('slack', messages);
    }
  }

  async listJiraIssues(opts: { jql?: string; max?: number; force?: boolean } = {}): Promise<JiraIssue[]> {
    const config = this.jiraConfig();
    if (opts.force) {
      const issues = await fetchJiraIssues(config, { jql: opts.jql, max: opts.max });
      this.putCache('jira', issues);
      return issues;
    }
    const cached = this.cached<JiraIssue[]>('jira');
    if (cached) return cached.data;
    const issues = await fetchJiraIssues(config, { jql: opts.jql, max: opts.max });
    this.putCache('jira', issues);
    return issues;
  }

  async searchJiraIssues(query: string, max = 10): Promise<JiraIssue[]> {
    const config = this.jiraConfig();
    const issues = await fetchJiraIssues(config, { jql: `text ~ "${query}" ORDER BY updated DESC`, max });
    return issues;
  }

  async listGithubPrs(opts: { state?: 'open' | 'closed' | 'all'; max?: number; force?: boolean } = {}): Promise<GithubPr[]> {
    const token = this.requireToken('github');
    if (opts.force) {
      const prs = await fetchGithubPrs(token, { state: opts.state, max: opts.max });
      this.putCache('github', prs);
      return prs;
    }
    const cached = this.cached<GithubPr[]>('github');
    if (cached) return cached.data;
    const prs = await fetchGithubPrs(token, { state: opts.state, max: opts.max });
    this.putCache('github', prs);
    return prs;
  }

  async getGithubPr(repo: string, number: number): Promise<GithubPr | null> {
    const token = this.requireToken('github');
    const cached = this.cached<GithubPr[]>('github');
    if (cached) {
      const found = cached.data.find((p) => p.number === number);
      if (found) return found;
    }
    return fetchGithubPr(token, repo, number);
  }

  async listSlackMessages(opts: { max?: number; force?: boolean } = {}): Promise<SlackMessage[]> {
    const token = this.requireToken('slack');
    if (opts.force) {
      const messages = await fetchSlackMessages(token, { max: opts.max });
      this.putCache('slack', messages);
      return messages;
    }
    const cached = this.cached<SlackMessage[]>('slack');
    if (cached) return cached.data;
    const messages = await fetchSlackMessages(token, { max: opts.max });
    this.putCache('slack', messages);
    return messages;
  }

  async syncToTable(kind: IntegrationKind): Promise<{ table: string; count: number }> {
    const tables = new TablesStore(this.projectRoot);
    if (kind === 'jira') {
      const issues = await this.listJiraIssues({ force: true });
      try {
        tables.createTable(
          'jira_issues',
          [
            { name: 'key', type: 'text' },
            { name: 'summary', type: 'text' },
            { name: 'status', type: 'text' },
            { name: 'assignee', type: 'text' },
            { name: 'type', type: 'text' },
            { name: 'url', type: 'text' },
            { name: 'updated', type: 'text' },
          ],
          'key'
        );
      } catch {
        // already exists
      }
      for (const issue of issues) {
        tables.insertRow('jira_issues', {
          key: issue.key,
          summary: issue.summary,
          status: issue.status,
          assignee: issue.assignee ?? '',
          type: issue.type,
          url: issue.url,
          updated: issue.updated,
        });
      }
      return { table: 'jira_issues', count: issues.length };
    } else if (kind === 'github') {
      const prs = await this.listGithubPrs({ force: true });
      try {
        tables.createTable(
          'github_prs',
          [
            { name: 'number', type: 'number' },
            { name: 'title', type: 'text' },
            { name: 'state', type: 'text' },
            { name: 'author', type: 'text' },
            { name: 'url', type: 'text' },
            { name: 'branch', type: 'text' },
            { name: 'updated', type: 'text' },
          ],
          'number'
        );
      } catch {
        // already exists
      }
      for (const pr of prs) {
        tables.insertRow('github_prs', {
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.author ?? '',
          url: pr.url,
          branch: pr.branch,
          updated: pr.updated,
        });
      }
      return { table: 'github_prs', count: prs.length };
    } else if (kind === 'slack') {
      const messages = await this.listSlackMessages({ force: true });
      try {
        tables.createTable(
          'slack_messages',
          [
            { name: 'ts', type: 'text' },
            { name: 'channel', type: 'text' },
            { name: 'user', type: 'text' },
            { name: 'text', type: 'text' },
            { name: 'permalink', type: 'text' },
          ],
          'ts'
        );
      } catch {
        // already exists
      }
      for (const msg of messages) {
        tables.insertRow('slack_messages', {
          ts: msg.ts,
          channel: msg.channel,
          user: msg.user ?? '',
          text: msg.text,
          permalink: msg.permalink,
        });
      }
      return { table: 'slack_messages', count: messages.length };
    }
    throw new Error(`unknown integration "${kind}"`);
  }

  configuredKinds(): IntegrationKind[] {
    return KINDS.filter((k) => this.isConfigured(k));
  }

  private requireToken(kind: 'github' | 'slack'): string {
    const token = getSecret(`${kind}:token`);
    if (!token) throw new Error(`${kind} is not configured; run \`deck integration auth ${kind}\` first`);
    return token;
  }

  private jiraConfig(): { domain: string; email: string; token: string } {
    return extractJiraConfig({
      domain: getSecret('jira:domain'),
      email: getSecret('jira:email'),
      token: getSecret('jira:token'),
    });
  }
}
