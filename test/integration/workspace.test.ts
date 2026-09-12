import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createWebServer } from '../../src/server/index.js';
import { NotesStore, type Note } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { createWorktree } from '../../src/worktrees/manager.js';
import { makeRepo } from '../helpers.js';

describe('authenticated dashboard workspace', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let server: ReturnType<typeof createWebServer>;
  let port: number;
  let notes: NotesStore;

  beforeEach(async () => {
    fixture = makeRepo();
    notes = new NotesStore(fixture.root);
    server = createWebServer({ projectRoot: fixture.root, port: 0 });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    fixture.cleanup();
  });

  function request(resource: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/workspace/${resource}`, {
      method,
      headers: { 'X-Flightdeck-Token': server.capabilityToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function rawRequest(resource: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/workspace/${resource}`, method: body === undefined ? 'GET' : 'POST', headers: { 'X-Flightdeck-Token': server.capabilityToken } }, (res) => {
        let content = '';
        res.on('data', (chunk) => { content += String(chunk); });
        res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: content }); });
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  }

  it('gates every resource and write with the existing server capability', async () => {
    for (const [resource, method] of [['notes/example', 'GET'], ['notes', 'POST'], ['notes/example', 'PATCH'], ['tables/example', 'GET'], ['worktrees/example', 'GET']]) {
      const url = `http://127.0.0.1:${port}/api/workspace/${resource}`;
      expect((await fetch(url, { method })).status).toBe(401);
      expect((await fetch(`${url}?token=${server.capabilityToken}`, { method })).status).toBe(401);
      expect((await fetch(url, { method, headers: { 'X-Flightdeck-Token': 'wrong' } })).status).toBe(401);
    }
  });

  it('creates and reads literal note content, saves a matching snapshot, and broadcasts success', async () => {
    const events = await fetch(`http://127.0.0.1:${port}/api/events?token=${server.capabilityToken}`);
    const reader = events.body!.getReader();
    try {
      await reader.read();
      const title = '<img src=x onerror=alert(1)>';
      const body = '# Draft\n<script>alert(1)</script>';
      const created = await request('notes', 'POST', { title, body });
      expect(created.status).toBe(201);
      const note = await created.json() as Note;
      expect(note).toMatchObject({ title, body, version: 1 });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"update"');
      expect(await (await request(`notes/${note.id}`)).json()).toEqual(note);
      const saved = await request(`notes/${note.id}`, 'PATCH', { title: 'Revised', body: 'updated', expected: note });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ title: 'Revised', body: 'updated', version: 2 });
      expect(notes.readNote(note.id)).toMatchObject({ title: 'Revised', body: 'updated', version: 2 });
      expect(notes.versions(note.id)).toHaveLength(2);
    } finally {
      await reader.cancel();
    }
  });

  it('rejects competing saves and disk edits without replacing the saved note or history', async () => {
    const original = notes.createNote('Concurrent', 'original');
    const results = await Promise.all(['first', 'second'].map((body) => request(`notes/${original.id}`, 'PATCH', { title: original.title, body, expected: original })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(notes.versions(original.id)).toHaveLength(2);
    const saved = notes.readNote(original.id)!;
    const file = path.join(fixture.root, '.flightdeck', 'notes', `${original.id}.md`);
    fs.writeFileSync(file, '---\ntitle: External title\n---\nexternal body');
    const stale = await request(`notes/${original.id}`, 'PATCH', { title: 'My draft', body: 'retain my draft', expected: saved });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain('changed');
    expect(notes.readNote(original.id)).toMatchObject({ version: 2, title: 'External title', body: 'external body' });
    expect(notes.versions(original.id)).toHaveLength(2);
    expect(notes.searchNotes(saved.body)).toHaveLength(1);
    const current = notes.readNote(original.id)!;
    expect((await request(`notes/${original.id}`, 'PATCH', { title: current.title, body: 'accepted', expected: current })).status).toBe(200);
  });

  it('rejects malformed JSON, invalid fields and incomplete snapshots, and bounds chunked bodies', async () => {
    const note = notes.createNote('Existing', 'unchanged');
    expect((await rawRequest('notes', '{')).status).toBe(400);
    for (const body of [null, [], {}, { title: '', body: '' }, { title: 'Title', body: 123 }]) {
      expect((await request('notes', 'POST', body)).status).toBe(400);
    }
    for (const expected of [undefined, {}, { version: 1 }, { version: -1, title: '', body: '' }]) {
      expect((await request(`notes/${note.id}`, 'PATCH', { title: 'New', body: 'New', expected })).status).toBe(400);
    }
    expect((await rawRequest('notes', JSON.stringify({ title: 'Large', body: 'a'.repeat(1024 * 1024) }))).status).toBe(413);
    expect(notes.listNotes()).toHaveLength(1);
    expect(notes.readNote(note.id)?.version).toBe(1);
  });

  it('reports disk write failures without leaving a created note or history behind', async () => {
    const response = await request('notes', 'POST', { title: 'a'.repeat(300), body: 'failed write canary' });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('ENAMETOOLONG');
    expect(notes.listNotes()).toEqual([]);
    expect(notes.versions('a'.repeat(300))).toEqual([]);
    expect(notes.searchNotes('canary')).toEqual([]);
    expect(fs.readdirSync(path.join(fixture.root, '.flightdeck', 'notes'))).toEqual([]);
  });

  it('rejects raw and encoded traversal, arbitrary SQL or Git inputs, and escaped note symlinks', async () => {
    for (const resource of ['notes', 'tables', 'worktrees']) {
      for (const id of ['../../secret', '%2e%2e%2fsecret', '%252e%252e%252fsecret', '%00', '%ZZ', 'a%5cb']) {
        const response = await rawRequest(`${resource}/${id}`);
        expect(response.status, `${resource}/${id}`).toBe(400);
      }
    }
    expect((await request('tables/example?where=1')).status).toBe(400);
    expect((await request('worktrees/example?base=HEAD')).status).toBe(400);
    expect((await request('notes/example?path=/tmp')).status).toBe(400);
    const outside = makeRepo();
    try {
      const note = notes.createNote('Symlink', 'safe');
      const target = path.join(outside.root, 'secret.md');
      fs.writeFileSync(target, 'private canary');
      const file = path.join(fixture.root, '.flightdeck', 'notes', `${note.id}.md`);
      fs.unlinkSync(file);
      fs.symlinkSync(target, file);
      const result = await request(`notes/${note.id}`);
      expect(result.status).toBe(400);
      expect(JSON.stringify(await result.json())).not.toContain('private canary');
      expect((await request(`notes/${note.id}`, 'PATCH', { title: 'overwrite', body: 'overwrite', expected: note })).status).toBe(400);
      expect(fs.readFileSync(target, 'utf8')).toBe('private canary');
    } finally {
      outside.cleanup();
    }
  });

  it('requires resource membership in the served project', async () => {
    const outside = makeRepo();
    try {
      const foreign = new NotesStore(outside.root).createNote('Foreign', 'private');
      new TablesStore(outside.root).createTable('Foreign', [{ name: 'value', type: 'text' }]);
      createWorktree(outside.root, 'foreign');
      for (const resource of [`notes/${foreign.id}`, 'tables/Foreign', 'worktrees/foreign']) {
        const result = await request(resource);
        expect(result.status).toBe(404);
        expect(await result.json()).toEqual({ error: expect.any(String) });
      }
      fs.mkdirSync(path.join(fixture.root, '.flightdeck', 'worktrees', 'unregistered'), { recursive: true });
      expect((await request('worktrees/unregistered')).status).toBe(404);
      expect((await request(`notes/${foreign.id}`, 'PATCH', { title: 'New', body: 'New', expected: foreign })).status).toBe(404);
    } finally {
      outside.cleanup();
    }
  });

  it('paginates all rows in stable rowid order with bounded and validated limits', async () => {
    const tables = new TablesStore(fixture.root);
    const table = tables.createTable('Records', [{ name: 'label', type: 'text' }, { name: 'enabled', type: 'boolean' }]);
    for (let index = 0; index < 102; index++) tables.insertRow(table.name, { label: `row ${index}`, enabled: index % 2 === 0 });
    const rows: Record<string, unknown>[] = [];
    for (const offset of [0, 50, 100]) {
      const result = await request(`tables/Records?offset=${offset}&limit=50`);
      expect(result.status).toBe(200);
      const page = await result.json();
      expect(page.table).toMatchObject({ name: table.name, columns: table.columns });
      expect(page.offset).toBe(offset);
      expect(page.hasMore).toBe(offset < 100);
      rows.push(...page.rows);
    }
    expect(rows.map((row) => row.rowid)).toEqual(Array.from({ length: 102 }, (_, index) => index + 1));
    expect((await (await request('tables/Records?limit=1000')).json()).rows).toHaveLength(100);
    expect(await (await request('tables/Records?offset=500')).json()).toMatchObject({ rows: [], offset: 500, hasMore: false });
    for (const query of ['offset=-1', 'offset=1.5', 'offset=9007199254740992', 'limit=0', 'limit=-2', 'limit=NaN', 'limit=', 'offset=0&offset=1']) {
      expect((await request(`tables/Records?${query}`)).status, query).toBe(400);
    }
  });

  it('includes committed, staged and unstaged tracked changes and accurate untracked filenames', async () => {
    const wt = createWorktree(fixture.root, 'review');
    fs.writeFileSync(path.join(wt.path, 'committed.txt'), 'committed marker\n');
    git(wt.path, 'add', 'committed.txt');
    git(wt.path, 'commit', '-qm', 'Add work');
    fs.writeFileSync(path.join(wt.path, 'staged.txt'), 'staged marker\n');
    git(wt.path, 'add', 'staged.txt');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'unstaged marker\n');
    const untracked = 'space and\nnewline.txt';
    fs.writeFileSync(path.join(wt.path, untracked), 'untracked marker');
    const response = await request('worktrees/review');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.status).toMatchObject({ branch: 'flightdeck/review', clean: false, ahead: 1, untracked: [untracked] });
    expect(result.status.modified).toEqual(['README.md', 'staged.txt']);
    expect(result.diff).toMatchObject({ base: 'main', filesChanged: 3 });
    expect(result.diff.comparison).toContain('merge base');
    for (const marker of ['committed marker', 'staged marker', 'unstaged marker']) expect(result.diff.diff).toContain(marker);
    expect(result.diff.diff).not.toContain('untracked marker');
  });

  it('uses the master base when main does not exist and surfaces broken Git state', async () => {
    git(fixture.root, 'branch', '-m', 'master');
    const wt = createWorktree(fixture.root, 'master-work');
    const clean = await request('worktrees/master-work');
    expect(clean.status).toBe(200);
    expect(await clean.json()).toMatchObject({ status: { clean: true, ahead: 0 }, diff: { base: 'master', diff: '', filesChanged: 0 } });
    fs.writeFileSync(path.join(wt.path, '.git'), 'gitdir: /missing/workspace-test-git\n');
    const broken = await request('worktrees/master-work');
    expect(broken.status).toBe(500);
    expect((await broken.json()).error).toContain('git rev-parse failed');
  });

  it('fails honestly when a diff exceeds its bounded output', async () => {
    const wt = createWorktree(fixture.root, 'large');
    fs.writeFileSync(path.join(wt.path, 'README.md'), 'large change\n'.repeat(100_000));
    const response = await request('worktrees/large');
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain('git diff failed');
  });
});
