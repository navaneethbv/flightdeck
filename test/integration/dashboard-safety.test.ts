import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createWebServer } from '../../src/server/index.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { makeRepo } from '../helpers.js';

describe('dashboard request and confirmation safety', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let server: ReturnType<typeof createWebServer>;
  let base: string;

  beforeEach(async () => {
    fixture = makeRepo();
    server = createWebServer({ projectRoot: fixture.root, port: 0, confirmTimeoutMs: 800 });
    base = `http://127.0.0.1:${await server.start()}`;
  });

  afterEach(async () => {
    await server.stop();
    fixture.cleanup();
  });

  function request(route: string, body?: unknown) {
    // The base is this test server on 127.0.0.1; every route is supplied by the test.
    return fetch(`${base}${route}`, { // nosemgrep: rules_lgpl.javascript.ssrf.rule-node-ssrf
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Flightdeck-Token': server.capabilityToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function playbook(name: string, yaml: string) {
    const dir = path.join(fixture.root, '.flightdeck', 'playbooks');
    // Isolated temporary repository fixture; no external path input.
    fs.mkdirSync(dir, { recursive: true }); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    fs.writeFileSync(path.join(dir, `${name}.yml`), yaml); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
  }

  it.each([{ body: null }, { body: [] }, { body: 'text' }, { body: 1 }])('rejects a non-object JSON request: $body', async ({ body }) => {
    const response = await request('/api/notes/create', body);
    expect(response.status).toBe(400);
    expect(new NotesStore(fixture.root).list()).toHaveLength(0);
  });

  it('bounds legacy and workspace JSON requests without modifying notes', async () => {
    const body = { title: 'Too large', body: 'x'.repeat(1024 * 1024) };
    for (const route of ['/api/notes/create', '/api/workspace/notes']) {
      const response = await request(route, body);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: 'Request body exceeds 1 MiB' });
    }
    expect(new NotesStore(fixture.root).list()).toHaveLength(0);
    expect((await request('/api/state')).status).toBe(200);
  });

  it('never discloses the manager capability in an Argus creation response', async () => {
    const response = await request('/api/argus/start', { name: 'Review mission' });
    expect(response.status).toBe(200);
    const text = await response.text();
    const fleet = JSON.parse(text);
    const stored = new ArgusManager(fixture.root).get(fleet.id)!;
    expect(stored.cap).toBeTruthy();
    expect(fleet.cap).toBeUndefined();
    expect(text).not.toContain(stored.cap);
  });

  it('rejects playbook paths outside the configured directories', async () => {
    const file = path.join(fixture.root, '.flightdeck', 'outside.yml');
    // Isolated temporary repository fixture; no external path input.
    fs.mkdirSync(path.dirname(file), { recursive: true }); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    fs.writeFileSync(file, 'name: outside\nsteps:\n  - id: write\n    type: note\n    operation: create\n    title: Escaped\n    body: forbidden\n'); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    const response = await request('/api/toolkit/run', { action: '../outside' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid playbook name' });
    expect(new NotesStore(fixture.root).list()).toHaveLength(0);
  });

  it('returns JSON for unknown API routes', async () => {
    const response = await request('/api/missing');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('rejects malformed run identifiers without crashing the server', async () => {
    expect((await request('/api/toolkit/run/%ZZ')).status).toBe(404);
    expect((await request('/api/state')).status).toBe(200);
  });

  it('requires approval before a direct shell step can write to the project', async () => {
    playbook('write-file', 'name: write-file\nsteps:\n  - id: write\n    type: bash\n    command: "printf approved > marker.txt"\n');
    const start = await request('/api/toolkit/run', { action: 'write-file' });
    const { runId } = await start.json();
    const run = await (await request(`/api/toolkit/run/${runId}`)).json();
    expect(run.status).toBe('awaiting_confirmation');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.existsSync(path.join(fixture.root, 'marker.txt'))).toBe(false); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    await request('/api/toolkit/confirm', { confirmId: run.confirm.id, operation: run.confirm.operation, ok: false });
    const denied = await (await request(`/api/toolkit/run/${runId}`)).json();
    expect(denied.status).toBe('failed');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.existsSync(path.join(fixture.root, 'marker.txt'))).toBe(false); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
  });

  it('resolves nested project playbooks and approves their external steps', async () => {
    playbook('outer', 'name: outer\nsteps:\n  - id: nested\n    type: playbook\n    name: inner\n');
    playbook('inner', 'name: inner\nsteps:\n  - id: write\n    type: bash\n    command: "printf approved > marker.txt"\n');
    const { runId } = await (await request('/api/toolkit/run', { action: 'outer' })).json();
    const run = await (await request(`/api/toolkit/run/${runId}`)).json();
    expect(run.status).toBe('awaiting_confirmation');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.existsSync(path.join(fixture.root, 'marker.txt'))).toBe(false); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    await request('/api/toolkit/confirm', { confirmId: run.confirm.id, operation: run.confirm.operation, ok: true });
    expect((await (await request(`/api/toolkit/run/${runId}`)).json()).status).toBe('succeeded');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.readFileSync(path.join(fixture.root, 'marker.txt'), 'utf8')).toBe('approved'); // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
  });

  it('shows the approved HTTP destination without disclosing request secrets', async () => {
    playbook('http', 'name: http\nsteps:\n  - id: send\n    type: http\n    method: POST\n    url: https://api.example.com/?token=private-token\n    headers:\n      Authorization: private-header\n    body: private-body\n');
    const { runId } = await (await request('/api/toolkit/run', { action: 'http' })).json();
    const run = await (await request(`/api/toolkit/run/${runId}`)).json();
    expect(run.confirm.prompt).toContain('POST request to https://api.example.com');
    expect(JSON.stringify(run)).not.toContain('private-');
    await request('/api/toolkit/confirm', { confirmId: run.confirm.id, operation: run.confirm.operation, ok: false });
    expect((await (await request(`/api/toolkit/run/${runId}`)).json()).status).toBe('failed');
  });

  it('invalidates a timed-out step confirmation before it can execute later', async () => {
    const note = new NotesStore(fixture.root).createNote('Keep', 'Do not delete after timeout');
    playbook('timeout', `name: timeout\nsteps:\n  - id: delete\n    type: mcp\n    timeout: 0.2\n    tool: note_delete\n    arguments:\n      id: ${note.id}\n`);
    const { runId } = await (await request('/api/toolkit/run', { action: 'timeout' })).json();
    const route = `/api/toolkit/run/${runId}`;
    const { confirm } = await (await request(route)).json();
    expect(confirm).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await (await request(route)).json()).status).toBe('failed');
    const late = await request('/api/toolkit/confirm', { confirmId: confirm.id, operation: confirm.operation, ok: true });
    expect(late.status).toBe(404);
    expect(new NotesStore(fixture.root).readNote(note.id)?.body).toBe(note.body);
  });

  it('serializes parallel confirmation prompts so both decisions can be made', async () => {
    const notes = new NotesStore(fixture.root);
    const first = notes.createNote('First', 'Keep until approved');
    const second = notes.createNote('Second', 'Keep until approved');
    playbook('parallel-delete', `name: parallel-delete
steps:
  - id: both
    type: parallel
    branches:
      - - id: first
          type: mcp
          tool: note_delete
          arguments:
            id: ${first.id}
      - - id: second
          type: mcp
          tool: note_delete
          arguments:
            id: ${second.id}
`);
    const start = await request('/api/toolkit/run', { action: 'parallel-delete' });
    const { runId } = await start.json();
    const route = `/api/toolkit/run/${runId}`;
    const firstRun = await (await request(route)).json();
    expect(firstRun.status).toBe('awaiting_confirmation');
    expect(notes.list()).toHaveLength(2);
    await request('/api/toolkit/confirm', { ...firstRun.confirm, confirmId: firstRun.confirm.id, ok: true });
    const secondRun = await (await request(route)).json();
    expect(secondRun.status).toBe('awaiting_confirmation');
    expect(secondRun.confirm.id).not.toBe(firstRun.confirm.id);
    expect(notes.list()).toHaveLength(1);
    await request('/api/toolkit/confirm', { ...secondRun.confirm, confirmId: secondRun.confirm.id, ok: true });
    const complete = await (await request(route)).json();
    expect(complete.status).toBe('succeeded');
    expect(notes.list()).toHaveLength(0);
  });
});
