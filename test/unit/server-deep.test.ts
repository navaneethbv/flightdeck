import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWebServer } from '../../src/server/index.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { createQuota } from '../../src/argus/quota.js';
import { PlaybookEngine } from '../../src/playbooks/engine.js';
import { makeRepo } from '../helpers.js';

describe('Web Server Deep Coverage Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let serverInstance: ReturnType<typeof createWebServer>;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    fixture = makeRepo();
    serverInstance = createWebServer({
      projectRoot: fixture.root,
      port: 0,
      confirmTimeoutMs: 1000,
    });
    const port = await serverInstance.start();
    baseUrl = `http://127.0.0.1:${port}`;
    token = serverInstance.capabilityToken;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await serverInstance.stop();
    fixture.cleanup();
  });

  async function api(path: string, options: RequestInit = {}): Promise<{ status: number; data: any; headers: Headers }> {
    const headers = new Headers(options.headers || {});
    if (!headers.has('X-Flightdeck-Token')) {
      headers.set('X-Flightdeck-Token', token);
    }
    if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    let data: any = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  it('tests /api/sessions/start, /stop, and /logs endpoints', async () => {
    vi.spyOn(SessionManager.prototype, 'startSession').mockImplementation(async function (this: SessionManager, id: string) {
      return this.get(id)!;
    });

    const startRes = await api('/api/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ name: 'sess-api', harness: 'opencode', policy: 'full' }),
    });
    expect(startRes.status).toBe(200);
    expect(startRes.data.id).toBeDefined();
    expect(startRes.data.token).toBeUndefined(); // stripped from public response

    const sessionId = startRes.data.id;

    // Logs
    const logsRes = await api(`/api/sessions/${sessionId}/logs`);
    expect(logsRes.status).toBe(200);
    expect(logsRes.data.id).toBe(sessionId);

    // Stop
    const stopRes = await api(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    expect(stopRes.data.stopped).toBe(true);

    // Invalid session ID
    const badStop = await api('/api/sessions/not-a-uuid/stop', { method: 'POST' });
    expect(badStop.status).toBe(400);
  });

  it('tests /api/argus lifecycle: start, pulse, pause, resume, fleet, stop', async () => {
    createQuota('pool-srv', { maxTokens: 1000000, windowSec: 3600 });
    vi.spyOn(ArgusManager.prototype, 'pulse').mockResolvedValue(1);

    const startRes = await api('/api/argus/start', {
      method: 'POST',
      body: JSON.stringify({ name: 'argus-srv', pulseSec: 30, childLimit: 4 }),
    });
    expect(startRes.status).toBe(200);
    const argusId = startRes.data.id;

    // Fleet info
    const fleetRes = await api(`/api/argus/${argusId}/fleet`);
    expect(fleetRes.status).toBe(200);
    expect(fleetRes.data.argus.id).toBe(argusId);
    expect(fleetRes.data.budget).toBeDefined();

    // Pulse
    const pulseRes = await api('/api/argus/pulse', {
      method: 'POST',
      body: JSON.stringify({ id: argusId }),
    });
    expect(pulseRes.status).toBe(200);
    expect(pulseRes.data.progress).toBe(1);

    // Quotas listing
    const quotasRes = await api('/api/quotas');
    expect(quotasRes.status).toBe(200);
    expect(Array.isArray(quotasRes.data)).toBe(true);

    // Stop
    const stopRes = await api(`/api/argus/${argusId}/stop`, { method: 'POST' });
    expect(stopRes.status).toBe(200);
    expect(stopRes.data.stopped).toBe(true);

    // Pause & Resume
    const pauseRes = await api(`/api/argus/${argusId}/pause`, { method: 'POST' });
    expect(pauseRes.status).toBe(400); // already stopped
  });

  it('tests /api/notes and /api/messages APIs', async () => {
    // Note create
    const createNoteRes = await api('/api/notes/create', {
      method: 'POST',
      body: JSON.stringify({ title: 'Server Note', body: 'Server Body' }),
    });
    expect(createNoteRes.status).toBe(200);
    const noteId = createNoteRes.data.id;

    // Note update
    const updateNoteRes = await api('/api/notes/update', {
      method: 'POST',
      body: JSON.stringify({ id: noteId, title: 'Updated Title' }),
    });
    expect(updateNoteRes.status).toBe(200);
    expect(updateNoteRes.data.title).toBe('Updated Title');

    // Message send
    const msgRes = await api('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify({ fromSession: 'user', toSession: 'agent-1', body: 'Server Message' }),
    });
    expect(msgRes.status).toBe(200);
    expect(msgRes.data.body).toBe('Server Message');
  });

  it('tests toolkit runs, polling, and confirmations', async () => {
    vi.spyOn(PlaybookEngine.prototype, 'run').mockResolvedValue({
      ok: true,
      results: {},
    });

    // Run builtin or custom action
    const runRes = await api('/api/toolkit/run', {
      method: 'POST',
      body: JSON.stringify({ action: 'ci-check' }),
    });
    expect(runRes.status).toBe(202);
    const runId = runRes.data.runId;

    // Poll run status
    const pollRes = await api(`/api/toolkit/run/${runId}`);
    expect(pollRes.status).toBe(200);
    expect(pollRes.data.runId).toBe(runId);

    // 404 for unknown run
    const unknownRun = await api('/api/toolkit/run/nonexistent-run');
    expect(unknownRun.status).toBe(404);

    // Confirm endpoint with unknown ID
    const confirmRes = await api('/api/toolkit/confirm', {
      method: 'POST',
      body: JSON.stringify({ confirmId: 'invalid-id', operation: 'op', ok: true }),
    });
    expect(confirmRes.status).toBe(404);
  });

  it('tests capability token rejection, SSE connection, and unknown routes', async () => {
    const unauth = await fetch(`${baseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(unauth.status).toBe(401);

    // Static asset / SPA route fallback
    const staticRes = await api('/dashboard');
    expect(staticRes.status).toBe(200);

    // Connect to SSE stream via ?token= query parameter
    const ctrl = new AbortController();
    const sse = fetch(`${baseUrl}/api/events?token=${token}`, {
      signal: ctrl.signal,
    });
    // Wait briefly and abort
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    await sse.catch(() => {});
  });
});
