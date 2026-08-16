import fs from 'node:fs';
import path from 'node:path';

export interface ReviewFile {
  path: string;
  content: string | null;
  error: string | null;
  truncated: boolean;
}

const MAX_FILES = 8;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024;

const DENIED_PATTERNS = [
  /^\.git(?:\/|$)/,
  /^\.flightdeck(?:\/|$)/,
  /^\.mcp\.json$/,
  /^mcp\.json$/,
  /^opencode\.json$/,
  /^\.gemini(?:\/|$)/,
  /^\.env(?:\.[a-z0-9]+)?$/,
];

function denied(relative: string): boolean {
  return DENIED_PATTERNS.some((pattern) => pattern.test(relative));
}

function isWithin(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${path.sep}`) || candidate === root;
}

function resolveReviewPath(realRoot: string, request: string): { realPath?: string; error?: string } {
  // Resolve against the real worktree root so the traversal check is not
  // defeated by a parent path being a symlink (for example /tmp on macOS).
  const candidate = path.resolve(realRoot, request);
  const relative = path.relative(realRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: `path "${request}" is outside the worker worktree` };
  }
  if (denied(relative)) {
    return { error: `path "${request}" is a generated config, state, or environment file` };
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(candidate);
  } catch {
    return { error: `path "${request}" does not exist` };
  }
  if (!isWithin(realRoot, realPath)) {
    return { error: `path "${request}" resolves outside the worker worktree` };
  }

  return { realPath };
}

function readReviewFile(realPath: string, request: string): { content?: string; error?: string } {
  try {
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) {
      return { error: `path "${request}" is not a regular file` };
    }
  } catch {
    return { error: `path "${request}" cannot be read` };
  }

  try {
    const content = fs.readFileSync(realPath, 'utf8');
    return { content };
  } catch {
    return { error: `path "${request}" cannot be read` };
  }
}

/**
 * Loads the brain-requested files from one worker worktree, bounded and
 * path-safe. Each request is resolved against the worktree root, both the
 * resolved candidate and its real path must stay inside the real worktree
 * root, and generated config, state, git internals, and environment files are
 * always denied. A bad request yields a per-path error instead of throwing, so
 * one bad path cannot discard the safe attachments of the same verdict.
 */
export function loadReviewFiles(worktree: string, requestedPaths: string[]): ReviewFile[] {
  const realRoot = fs.realpathSync(worktree);
  const requests = requestedPaths.slice(0, MAX_FILES);
  const files: ReviewFile[] = [];

  let total = 0;
  for (const request of requests) {
    const result: ReviewFile = {
      path: request.replaceAll(path.sep, '/'),
      content: null,
      error: null,
      truncated: false,
    };

    const resolved = resolveReviewPath(realRoot, request);
    if (resolved.error || !resolved.realPath) {
      result.error = resolved.error ?? `path "${request}" cannot be resolved`;
      files.push(result);
      continue;
    }

    const read = readReviewFile(resolved.realPath, request);
    if (read.error || read.content === undefined) {
      result.error = read.error ?? `path "${request}" cannot be read`;
      files.push(result);
      continue;
    }

    let content = read.content;
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
      result.truncated = true;
    }
    const room = MAX_TOTAL_BYTES - total;
    if (content.length > room) {
      content = content.slice(0, room);
      result.truncated = true;
    }
    total += content.length;
    result.content = content;
    files.push(result);
  }

  return files;
}
