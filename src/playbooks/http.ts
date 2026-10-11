import type { HttpStep } from './types.js';

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('HTTP steps require an http or https URL');
  }
  if (url.username || url.password) throw new Error('HTTP URL credentials are not allowed; use headers instead');
  return url;
}

export function parseHttpOrigins(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('allowed_origins must be a non-empty array of literal HTTP origins');
  }
  return value.map((entry: unknown) => {
    if (typeof entry !== 'string' || entry.includes('{{')) throw new Error('allowed_origins must contain literal HTTP origins');
    const url = parseHttpUrl(entry);
    if (url.pathname !== '/' || url.search || url.hash) throw new Error('allowed_origins must not contain paths, queries, or fragments');
    return url.origin;
  });
}

function declaredOrigin(url: string): string {
  try {
    return parseHttpUrl(url).origin;
  } catch {
    throw new Error('HTTP steps with a templated origin require literal allowed_origins in the playbook');
  }
}

/** Inputs may select a configured origin and supply a path, never introduce a host. */
export function resolveHttpDestination(step: HttpStep, resolved: string): URL {
  const origins = parseHttpOrigins(step.allowedOrigins) ?? [declaredOrigin(step.url)];
  const target = parseHttpUrl(resolved);
  const origin = origins.find((candidate) => candidate === target.origin);
  if (!origin) throw new Error('HTTP destination is outside the playbook allowed_origins');
  // Construct from the trusted origin and assign URL components separately.
  // A path starting with // must remain a path, not become a new authority.
  const destination = new URL(origin);
  destination.pathname = target.pathname;
  destination.search = target.search;
  return destination;
}
