export interface JiraConfig {
  domain: string;
  email: string;
  token: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  type: string;
  url: string;
  updated: string;
}

export interface JiraCredentialLookup {
  domain: string | null;
  email: string | null;
  token: string | null;
}

function cleanDomain(domain: string): string {
  let end = domain.length;
  while (end > 0 && domain.codePointAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return domain.slice(0, end);
}

function apiUrl(config: JiraConfig, path: string): string {
  const domain = cleanDomain(config.domain);
  return `https://${domain}/rest/api/${path}`;
}

function basicAuthHeader(email: string, token: string): string {
  const credentials = `${email}:${token}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

export async function verifyJira(config: JiraConfig): Promise<void> {
  const res = await fetch(apiUrl(config, '2/myself'), {
    headers: { Authorization: basicAuthHeader(config.email, config.token) },
  });
  if (!res.ok) throw new Error(`Jira verification failed: ${res.status}`);
}

export function wrapUntrustedContent(content: string): string {
  return `<<<UNTRUSTED_CONTENT>>>\n${content}\n<<</UNTRUSTED_CONTENT>>>`;
}

export async function fetchJiraIssues(
  config: JiraConfig,
  opts: { jql?: string; max?: number } = {}
): Promise<JiraIssue[]> {
  const jql = opts.jql ?? 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
  const params = new URLSearchParams({ jql, maxResults: String(opts.max ?? 50) });
  const res = await fetch(`${apiUrl(config, '2/search')}?${params}`, {
    headers: { Authorization: basicAuthHeader(config.email, config.token) },
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status}`);
  const data = (await res.json()) as {
    issues?: {
      key: string;
      fields: {
        summary?: string;
        status?: { name?: string };
        assignee?: { displayName?: string } | null;
        issuetype?: { name?: string };
        updated?: string;
      };
    }[];
  };
  const domain = cleanDomain(config.domain);
  return (data.issues ?? []).map((issue) => ({
    key: issue.key,
    summary: wrapUntrustedContent(issue.fields.summary ?? ''),
    status: issue.fields.status?.name ?? '',
    assignee: issue.fields.assignee?.displayName ?? null,
    type: issue.fields.issuetype?.name ?? '',
    url: `https://${domain}/browse/${issue.key}`,
    updated: issue.fields.updated ?? '',
  }));
}

export function extractJiraConfig(lookup: JiraCredentialLookup): JiraConfig {
  if (!lookup.domain || !lookup.email || !lookup.token) {
    throw new Error('Jira is not configured; run `deck integration auth jira` first');
  }
  return { domain: lookup.domain, email: lookup.email, token: lookup.token };
}
