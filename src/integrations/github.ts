export interface GithubPr {
  number: number;
  title: string;
  state: string;
  author: string | null;
  url: string;
  updated: string;
  branch: string;
}

const BASE = 'https://api.github.com';

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'flightdeck',
  };
}

export async function verifyGithub(token: string): Promise<void> {
  const res = await fetch(`${BASE}/user`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub verification failed: ${res.status}`);
}

export function wrapUntrustedContent(content: string): string {
  return `<<<UNTRUSTED_CONTENT>>>\n${content}\n<<</UNTRUSTED_CONTENT>>>`;
}

export async function fetchGithubPrs(
  token: string,
  opts: { state?: 'open' | 'closed' | 'all'; max?: number; repo?: string } = {}
): Promise<GithubPr[]> {
  const state = opts.state ?? 'open';
  const url = opts.repo
    ? `${BASE}/repos/${opts.repo}/pulls?state=${state}&per_page=${opts.max ?? 30}`
    : `${BASE}/search/issues?q=type:pr+state:${state}+author:@me&per_page=${opts.max ?? 30}`;
  const res = await fetch(url, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub PR fetch failed: ${res.status}`);
  const data = await res.json();
  const items = Array.isArray(data) ? data : ((data as { items?: unknown[] }).items ?? []);
  return (items as Record<string, unknown>[]).map((pr) => {
    const n = Number(pr.number ?? 0);
    const head = (pr as { head?: { ref?: string } }).head;
    const repo = (pr as { base?: { repo?: { full_name?: string } } }).base?.repo?.full_name;
    const titleStr = typeof pr.title === 'string' ? pr.title : '';
    const stateStr = typeof pr.state === 'string' ? pr.state : '';
    const urlStr = typeof pr.html_url === 'string' ? pr.html_url : '';
    const updatedStr = typeof pr.updated_at === 'string' ? pr.updated_at : '';
    return {
      number: n,
      title: wrapUntrustedContent(titleStr),
      state: stateStr,
      author: (pr as { user?: { login?: string } }).user?.login ?? null,
      url: repo ? `https://github.com/${repo}/pull/${n}` : urlStr,
      updated: updatedStr,
      branch: head?.ref ?? '',
    };
  });
}

export async function fetchGithubPr(
  token: string,
  repo: string,
  number: number
): Promise<GithubPr | null> {
  const res = await fetch(`${BASE}/repos/${repo}/pulls/${number}`, { headers: headers(token) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GitHub PR fetch failed: ${res.status}`);
  }
  const pr = (await res.json()) as Record<string, unknown>;
  const head = (pr as { head?: { ref?: string } }).head;
  const titleStr = typeof pr.title === 'string' ? pr.title : '';
  const stateStr = typeof pr.state === 'string' ? pr.state : '';
  const urlStr = typeof pr.html_url === 'string' ? pr.html_url : '';
  const updatedStr = typeof pr.updated_at === 'string' ? pr.updated_at : '';
  return {
    number: Number(pr.number ?? 0),
    title: wrapUntrustedContent(titleStr),
    state: stateStr,
    author: (pr as { user?: { login?: string } }).user?.login ?? null,
    url: urlStr,
    updated: updatedStr,
    branch: head?.ref ?? '',
  };
}
