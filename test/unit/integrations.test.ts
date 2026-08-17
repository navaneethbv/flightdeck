import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Integrations } from '../../src/integrations/index.js';
import {
  verifyJira,
  fetchJiraIssues,
  extractJiraConfig,
  wrapUntrustedContent as wrapJira,
} from '../../src/integrations/jira.js';
import {
  verifyGithub,
  fetchGithubPrs,
  fetchGithubPr,
} from '../../src/integrations/github.js';
import {
  verifySlack,
  fetchSlackMessages,
} from '../../src/integrations/slack.js';
import * as keychain from '../../src/secrets/keychain.js';
import { makeRepo } from '../helpers.js';

describe('Integrations Subsystem', () => {
  let fixture: ReturnType<typeof makeRepo>;
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
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  describe('Jira Module', () => {
    it('extractJiraConfig validates all credentials', () => {
      expect(() => extractJiraConfig({ domain: null, email: 'a@b.com', token: 'tok' })).toThrow(/not configured/);
      expect(() => extractJiraConfig({ domain: 'dom', email: null, token: 'tok' })).toThrow(/not configured/);
      expect(() => extractJiraConfig({ domain: 'dom', email: 'a@b.com', token: null })).toThrow(/not configured/);
      expect(extractJiraConfig({ domain: 'dom.atlassian.net/', email: 'a@b.com', token: 'tok' })).toEqual({
        domain: 'dom.atlassian.net/',
        email: 'a@b.com',
        token: 'tok',
      });
    });

    it('verifyJira calls endpoint and handles success and errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as any);

      await verifyJira({ domain: 'my-dom.atlassian.net/', email: 'me@test.com', token: 'sec' });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://my-dom.atlassian.net/rest/api/2/myself',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }),
        })
      );

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as any);
      await expect(verifyJira({ domain: 'my-dom.atlassian.net', email: 'me@test.com', token: 'bad' })).rejects.toThrow(
        /Jira verification failed: 401/
      );
    });

    it('fetchJiraIssues handles search results and errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          issues: [
            {
              key: 'PROJ-1',
              fields: {
                summary: 'Fix bug',
                status: { name: 'In Progress' },
                assignee: { displayName: 'Alice' },
                issuetype: { name: 'Bug' },
                updated: '2026-08-16T12:00:00.000Z',
              },
            },
          ],
        }),
      } as any);

      const issues = await fetchJiraIssues({ domain: 'dom.atlassian.net', email: 'e', token: 't' });
      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe('PROJ-1');
      expect(issues[0].summary).toContain('Fix bug');
      expect(issues[0].summary).toContain('<<<UNTRUSTED_CONTENT>>>');
      expect(issues[0].url).toBe('https://dom.atlassian.net/browse/PROJ-1');

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any);
      await expect(fetchJiraIssues({ domain: 'dom.atlassian.net', email: 'e', token: 't' })).rejects.toThrow(
        /Jira search failed: 500/
      );
    });

    it('wraps untrusted content', () => {
      expect(wrapJira('unsafe text')).toBe('<<<UNTRUSTED_CONTENT>>>\nunsafe text\n<<</UNTRUSTED_CONTENT>>>');
    });
  });

  describe('GitHub Module', () => {
    it('verifyGithub tests user endpoint and handles error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as any);

      await verifyGithub('gh-token');
      expect(fetchSpy).toHaveBeenCalledWith('https://api.github.com/user', expect.anything());

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 401,
      } as any);
      await expect(verifyGithub('bad-token')).rejects.toThrow(/GitHub verification failed: 401/);
    });

    it('fetchGithubPrs fetches search vs repo prs and handles errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              number: 42,
              title: 'Add feature',
              state: 'open',
              html_url: 'https://github.com/owner/repo/pull/42',
              user: { login: 'octocat' },
              updated_at: '2026-08-16',
              head: { ref: 'feat/test' },
            },
          ],
        }),
      } as any);

      const searchPrs = await fetchGithubPrs('token');
      expect(searchPrs).toHaveLength(1);
      expect(searchPrs[0].number).toBe(42);
      expect(searchPrs[0].branch).toBe('feat/test');

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            number: 99,
            title: 'Repo PR',
            state: 'closed',
            base: { repo: { full_name: 'owner/repo' } },
            user: { login: 'dev' },
            updated_at: '2026-08-16',
            head: { ref: 'patch' },
          },
        ],
      } as any);

      const repoPrs = await fetchGithubPrs('token', { repo: 'owner/repo', state: 'closed' });
      expect(repoPrs).toHaveLength(1);
      expect(repoPrs[0].url).toBe('https://github.com/owner/repo/pull/99');

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as any);
      await expect(fetchGithubPrs('token')).rejects.toThrow(/GitHub PR fetch failed: 403/);
    });

    it('fetchGithubPr fetches single PR, handles 404 and errors', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          number: 10,
          title: 'Single PR',
          state: 'open',
          html_url: 'https://github.com/o/r/pull/10',
          user: { login: 'user1' },
          updated_at: '2026-08-16',
          head: { ref: 'main' },
        }),
      } as any);

      const pr = await fetchGithubPr('token', 'o/r', 10);
      expect(pr?.title).toContain('Single PR');

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as any);
      expect(await fetchGithubPr('token', 'o/r', 999)).toBeNull();

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as any);
      await expect(fetchGithubPr('token', 'o/r', 10)).rejects.toThrow(/GitHub PR fetch failed: 500/);
    });
  });

  describe('Slack Module', () => {
    it('verifySlack tests auth.test and handles error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        json: async () => ({ ok: true }),
      } as any);

      await verifySlack('xoxp-valid');
      expect(fetchSpy).toHaveBeenCalledWith('https://slack.com/api/auth.test', expect.anything());

      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'invalid_auth' }),
      } as any);
      await expect(verifySlack('xoxp-bad')).rejects.toThrow(/Slack verification failed: invalid_auth/);
    });

    it('fetchSlackMessages lists channels and histories', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          json: async () => ({
            ok: true,
            channels: [{ id: 'C123', name: 'general' }],
          }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({
            ok: true,
            messages: [
              { ts: '123.456', user: 'U1', text: 'Hello team', permalink: 'https://slack.com/p1' },
            ],
          }),
        } as any);

      const messages = await fetchSlackMessages('token', { max: 10 });
      expect(messages).toHaveLength(1);
      expect(messages[0].channel).toBe('general');
      expect(messages[0].text).toContain('Hello team');

      // Channel list failure
      fetchSpy.mockResolvedValueOnce({
        json: async () => ({ ok: false, error: 'not_authed' }),
      } as any);
      await expect(fetchSlackMessages('token')).rejects.toThrow(/Slack conversation list failed/);
    });
  });

  describe('Integrations Class', () => {
    it('handles auth, deauth, and isConfigured for jira, github, and slack', async () => {
      const integrations = new Integrations(fixture.root);

      expect(integrations.isConfigured('jira')).toBe(false);
      expect(integrations.isConfigured('github')).toBe(false);
      expect(integrations.isConfigured('slack')).toBe(false);
      expect(integrations.configuredKinds()).toEqual([]);

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, issues: [], items: [], channels: [] }),
      } as any);

      await expect(integrations.auth('jira', { token: 'tok' })).rejects.toThrow(/requires --domain and --email/);
      await integrations.auth('jira', { domain: 'dom.atlassian.net', email: 'me@dom.com', token: 'jtok' });
      expect(integrations.isConfigured('jira')).toBe(true);

      await integrations.auth('github', { token: 'ghtok' });
      expect(integrations.isConfigured('github')).toBe(true);

      await integrations.auth('slack', { token: 'sltok' });
      expect(integrations.isConfigured('slack')).toBe(true);

      expect(integrations.configuredKinds().sort()).toEqual(['github', 'jira', 'slack']);

      integrations.deauth('jira');
      expect(integrations.isConfigured('jira')).toBe(false);
      integrations.deauth('github');
      integrations.deauth('slack');
      expect(integrations.configuredKinds()).toEqual([]);
    });

    it('queries Jira issues with cache and force refresh', async () => {
      const integrations = new Integrations(fixture.root);
      secretsMap.set('jira:domain', 'dom.atlassian.net');
      secretsMap.set('jira:email', 'e@d.com');
      secretsMap.set('jira:token', 'tok');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          issues: [{ key: 'KEY-1', fields: { summary: 'S1', status: { name: 'Open' }, assignee: { displayName: 'Dev' }, issuetype: { name: 'Task' }, updated: '2026' } }],
        }),
      } as any);

      const list1 = await integrations.listJiraIssues();
      expect(list1).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call uses cache
      const list2 = await integrations.listJiraIssues();
      expect(list2).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Force refresh bypasses cache
      const list3 = await integrations.listJiraIssues({ force: true });
      expect(list3).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // Search issues
      const search = await integrations.searchJiraIssues('login');
      expect(search).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('queries GitHub PRs with cache and single PR retrieval', async () => {
      const integrations = new Integrations(fixture.root);
      secretsMap.set('github:token', 'ghtok');

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          items: [{ number: 101, title: 'Pr 101', state: 'open', html_url: 'https://github.com/r/p/101', user: { login: 'user' }, updated_at: '2026', head: { ref: 'b1' } }],
        }),
      } as any);

      const prs1 = await integrations.listGithubPrs();
      expect(prs1).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Cache hit
      const prs2 = await integrations.listGithubPrs();
      expect(prs2).toHaveLength(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Get PR from cache
      const singleCached = await integrations.getGithubPr('r/p', 101);
      expect(singleCached?.number).toBe(101);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Single PR not in cache triggers fetch
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          number: 202,
          title: 'Pr 202',
          state: 'closed',
          html_url: 'https://github.com/r/p/202',
          user: { login: 'user2' },
          updated_at: '2026',
          head: { ref: 'b2' },
        }),
      } as any);
      const singleFetched = await integrations.getGithubPr('r/p', 202);
      expect(singleFetched?.number).toBe(202);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('queries Slack messages with cache and force refresh', async () => {
      const integrations = new Integrations(fixture.root);
      secretsMap.set('slack:token', 'sltok');

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
        } as any)
        .mockResolvedValueOnce({
          json: async () => ({ ok: true, messages: [{ ts: '1.1', user: 'U', text: 'Msg', permalink: 'p' }] }),
        } as any);

      const msgs1 = await integrations.listSlackMessages();
      expect(msgs1).toHaveLength(1);

      // Cached
      const msgs2 = await integrations.listSlackMessages();
      expect(msgs2).toHaveLength(1);
    });

    it('syncToTable synchronizes data for jira, github, and slack into tables', async () => {
      const integrations = new Integrations(fixture.root);
      secretsMap.set('jira:domain', 'dom.atlassian.net');
      secretsMap.set('jira:email', 'e@d.com');
      secretsMap.set('jira:token', 'tok');
      secretsMap.set('github:token', 'ghtok');
      secretsMap.set('slack:token', 'sltok');

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
        const u = String(url);
        if (u.includes('atlassian.net')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              issues: [{ key: 'J-1', fields: { summary: 'Sum', status: { name: 'Open' }, assignee: null, issuetype: { name: 'Bug' }, updated: '2026' } }],
            }),
          } as any;
        }
        if (u.includes('api.github.com')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              items: [{ number: 5, title: 'GH-5', state: 'open', html_url: 'u', user: null, updated_at: '2026', head: { ref: 'h' } }],
            }),
          } as any;
        }
        if (u.includes('conversations.list')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'dev' }] }),
          } as any;
        }
        if (u.includes('conversations.history')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, messages: [{ ts: '9.9', user: null, text: 'Hi', permalink: 'l' }] }),
          } as any;
        }
        return { ok: true, status: 200, json: async () => ({}) } as any;
      });

      const jSync = await integrations.syncToTable('jira');
      expect(jSync).toEqual({ table: 'jira_issues', count: 1 });
      // Repeat to test already-exists table branch
      await integrations.syncToTable('jira');

      const gSync = await integrations.syncToTable('github');
      expect(gSync).toEqual({ table: 'github_prs', count: 1 });
      // Repeat
      await integrations.syncToTable('github');

      const sSync = await integrations.syncToTable('slack');
      expect(sSync).toEqual({ table: 'slack_messages', count: 1 });
      // Repeat
      await integrations.syncToTable('slack');

      await expect(integrations.syncToTable('unknown' as any)).rejects.toThrow(/unknown integration/);
    });
  });
});
