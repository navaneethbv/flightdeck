import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { notesDir } from '../core/paths.js';
import { NotesStore, NoteConflictError, type NoteSnapshot } from '../notes/store.js';
import { TablesStore } from '../tables/store.js';
import { listWorktrees, worktreeStatus, worktreeDiff } from '../worktrees/manager.js';

const MAX_BODY_BYTES = 1024 * 1024;

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const value = await new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(new RequestError(413, 'Request body exceeds 1 MiB'));
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new RequestError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
  if (!object(value)) throw new RequestError(400, 'Request body must be an object');
  return value;
}

function noteFields(value: Record<string, unknown>): { title: string; body: string } {
  if (typeof value.title !== 'string' || !value.title.trim() || typeof value.body !== 'string') {
    throw new RequestError(400, 'A non-empty title and a string body are required');
  }
  return { title: value.title, body: value.body };
}

function expectedSnapshot(value: unknown): NoteSnapshot {
  if (!object(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.title !== 'string' || typeof value.body !== 'string') {
    throw new RequestError(400, 'Expected note version, title, and body are required');
  }
  return { version: Number(value.version), title: value.title, body: value.body };
}

function identifier(raw: string, resource: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new RequestError(400, `Invalid ${resource} identifier`);
  }
  const valid = resource === 'tables' ? /^[A-Za-z]\w*$/.test(id)
    : resource === 'notes' ? /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
      : /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(id) && id.split('/').every((part) => part && part !== '.' && part !== '..');
  if (!valid) throw new RequestError(400, `Invalid ${resource} identifier`);
  return id;
}

function assertInsideProject(projectRoot: string, resourcePath: string): void {
  const realPath = fs.realpathSync(resourcePath);
  const relative = path.relative(fs.realpathSync(projectRoot), realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RequestError(400, 'Resource is outside the served project');
  }
}

function pageNumber(params: URLSearchParams, key: string, fallback: number, minimum: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
    throw new RequestError(400, `Invalid ${key}`);
  }
  return value;
}

/** Called only after the dashboard's existing capability-token gate. */
export async function handleWorkspaceRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectRoot: string,
  sendJson: (res: ServerResponse, status: number, data: unknown) => void,
  broadcastUpdate: () => void
): Promise<void> {
  try {
    // Inspect the raw target before URL normalization can discard traversal.
    const [pathname, query = ''] = (req.url ?? '').split('?');
    const match = /^\/api\/workspace\/(notes|tables|worktrees)(?:\/(.*))?$/.exec(pathname);
    if (!match) throw new RequestError(404, 'Workspace endpoint not found');
    const [, resource, rawId] = match;
    const params = new URLSearchParams(query);
    const allowedParams = resource === 'tables' ? ['offset', 'limit'] : [];
    for (const key of params.keys()) {
      if (!allowedParams.includes(key) || params.getAll(key).length !== 1) throw new RequestError(400, 'Unsupported query parameters');
    }
    if (resource === 'notes') {
      const notes = new NotesStore(projectRoot);
      assertInsideProject(projectRoot, notesDir(projectRoot));
      if (rawId === undefined && req.method === 'POST') {
        const fields = noteFields(await readBody(req));
        const note = notes.createNote(fields.title, fields.body);
        broadcastUpdate();
        sendJson(res, 201, note);
        return;
      }
      const id = identifier(rawId ?? '', resource);
      const file = path.join(notesDir(projectRoot), `${id}.md`);
      if (fs.existsSync(file)) assertInsideProject(projectRoot, file);
      const current = notes.readNote(id);
      if (!current) throw new RequestError(404, 'Note not found');
      if (req.method === 'GET') {
        sendJson(res, 200, current);
        return;
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        assertInsideProject(projectRoot, notesDir(projectRoot));
        if (fs.existsSync(file)) assertInsideProject(projectRoot, file);
        const note = notes.updateNote(id, noteFields(body), expectedSnapshot(body.expected));
        broadcastUpdate();
        sendJson(res, 200, note);
        return;
      }
    } else if (resource === 'tables' && req.method === 'GET') {
      const name = identifier(rawId ?? '', resource);
      const offset = pageNumber(params, 'offset', 0, 0);
      const limit = Math.min(pageNumber(params, 'limit', 50, 1), 100);
      const tables = new TablesStore(projectRoot);
      const table = tables.getTable(name);
      if (!table) throw new RequestError(404, 'Table not found');
      const rows = tables.query(name, { offset, limit: limit + 1 });
      sendJson(res, 200, { table, rows: rows.slice(0, limit), offset, hasMore: rows.length > limit });
      return;
    } else if (resource === 'worktrees' && req.method === 'GET') {
      const name = identifier(rawId ?? '', resource);
      const worktree = listWorktrees(projectRoot).find((entry) => entry.name === name);
      if (!worktree) throw new RequestError(404, 'Worktree not found');
      assertInsideProject(projectRoot, worktree.path);
      sendJson(res, 200, { status: worktreeStatus(projectRoot, name), diff: worktreeDiff(projectRoot, name) });
      return;
    }
    throw new RequestError(400, 'Unsupported workspace operation');
  } catch (error) {
    const status = error instanceof RequestError ? error.status : error instanceof NoteConflictError ? 409 : 500;
    sendJson(res, status, { error: error instanceof Error ? error.message : 'Workspace operation failed' });
  }
}
