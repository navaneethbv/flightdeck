import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createWebServer } from '../../src/server/index.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo } from '../helpers.js';

interface StartedServer {
  server: ReturnType<typeof createWebServer>;
  port: number;
  token: string;
}

async function startServer(opts: { projectRoot: string; confirmTimeoutMs?: number }): Promise<StartedServer> {
  const server = createWebServer({
    port: 0,
    projectRoot: opts.projectRoot,
    confirmTimeoutMs: opts.confirmTimeoutMs,
  });
  const port = await server.start();
  return { server, port, token: server.capabilityToken };
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), 'X-Flightdeck-Token': token },
  };
}

function writeDestructivePlaybook(fixture: { root: string }): void {
  const dir = path.join(fixture.root, '.flightdeck', 'playbooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'drop-note.yml'),
    [
      'name: drop-note',
      'steps:',
      '  - id: del',
      '    type: mcp',
      '    tool: note_delete',
      '    arguments:',
      '      id: does-not-exist',
      '',
    ].join('\n')
  );
}

async function pollRunStatus(
  port: number,
  token: string,
  runId: string,
  statuses: string[],
  timeoutMs = 8000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${base(port)}/api/toolkit/run/${runId}`, authed(token));
    const run = (await res.json()) as Record<string, unknown>;
    if (statuses.includes(String(run.status))) return run;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${statuses.join(' or ')}; last status was "${run.status}"`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Send a raw HTTP request over a socket. fetch normalizes dot segments in the
 * URL, so an attacker's traversal path can only be exercised over the raw
 * request target, which is exactly what the server must reject.
 */
function rawRequest(port: number, method: string, requestTarget: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const head = [
        `${method} ${requestTarget} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: close',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ].join('\r\n');
      socket.write(head);
    });
    let data = '';
    socket.on('data', (chunk) => (data += chunk.toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('close', () => resolve(data));
  });
}

describe('Web GUI Server', () => {
  it('serves static UI assets and API state over HTTP', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      expect(port).toBeGreaterThan(0);

      // 1. Check HTML index
      const indexRes = await fetch(`${base(port)}/`);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain('Flightdeck Control Plane');
      expect(html).toContain('Toolkit');

      // 2. Check CSS
      const cssRes = await fetch(`${base(port)}/styles.css`);
      expect(cssRes.status).toBe(200);
      const css = await cssRes.text();
      expect(css).toContain('--bg-canvas');

      // 3. Check JS
      const jsRes = await fetch(`${base(port)}/app.js`);
      expect(jsRes.status).toBe(200);
      const js = await jsRes.text();
      expect(js).toContain('fetchState');

      // 4. Check /api/state
      const stateRes = await fetch(`${base(port)}/api/state`, authed(token));
      expect(stateRes.status).toBe(200);
      const state = await stateRes.json();
      expect(state.projectRoot).toBe(fs.realpathSync(fixture.root));
      expect(Array.isArray(state.sessions)).toBe(true);
      expect(Array.isArray(state.notes)).toBe(true);
      expect(Array.isArray(state.tables)).toBe(true);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('handles session lifecycle and messages via REST API', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      // Start Session
      const startRes = await fetch(
        `${base(port)}/api/sessions/start`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'api-sess-1',
            harness: 'gemini',
            task: 'test web api',
            headless: true,
          }),
        })
      );
      expect(startRes.status).toBe(200);
      const session = await startRes.json();
      expect(session.name).toBe('api-sess-1');
      expect(session.harness).toBe('gemini');
      expect(session.token).toBeUndefined();

      // Send Message
      const msgRes = await fetch(
        `${base(port)}/api/messages/send`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toSession: session.id,
            body: 'Hello from Flightdeck Web UI',
            fromSession: 'user',
          }),
        })
      );
      expect(msgRes.status).toBe(200);
      const msg = await msgRes.json();
      expect(msg.body).toBe('Hello from Flightdeck Web UI');

      // Get Logs
      const logsRes = await fetch(`${base(port)}/api/sessions/${session.id}/logs`, authed(token));
      expect(logsRes.status).toBe(200);
      const logsData = await logsRes.json();
      expect(logsData.id).toBe(session.id);

      // Stop Session
      const stopRes = await fetch(
        `${base(port)}/api/sessions/${session.id}/stop`,
        authed(token, { method: 'POST' })
      );
      expect(stopRes.status).toBe(200);
      const stopData = await stopRes.json();
      expect(stopData.stopped).toBe(true);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('never ships session tokens or the Argus capability to the browser', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      const sm = new SessionManager(fixture.root);
      const session = sm.createSession({
        name: 'secret-holder',
        harness: 'claude',
        worktree: null,
        cwd: fixture.root,
      });
      expect(session.token).toBeTruthy();

      const res = await fetch(`${base(port)}/api/state`, authed(token));
      const raw = await res.text();

      // The token gates this session's MCP server; the cap gates manager
      // privilege. Neither may appear anywhere in the payload.
      expect(raw).not.toContain(session.token);
      const state = JSON.parse(raw);
      for (const s of state.sessions) {
        expect(s.token).toBeUndefined();
      }
      for (const fleet of state.argus) {
        expect(fleet.cap).toBeUndefined();
      }
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('serves a dashboard with no fabricated entities and no invented metrics', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      const html = await (await fetch(`${base(port)}/`)).text();
      const js = await (await fetch(`${base(port)}/app.js`)).text();

      // Names, accounts and paths traced from the reference screenshot.
      for (const ghost of [
        'Lloyd',
        'Randy Marsh',
        'caffeine-604',
        'Bendar',
        'Morty',
        'slidefade',
        'nturemedias',
        'Internal Tickets',
        'SwiftTerm',
        'TiltRun',
      ]) {
        expect(html).not.toContain(ghost);
        expect(js).not.toContain(ghost);
      }

      // On an empty project the fleet is genuinely empty.
      const state = await (await fetch(`${base(port)}/api/state`, authed(token))).json();
      expect(state.sessions).toHaveLength(0);
      expect(state.argus).toHaveLength(0);

      // The toolkit is generated from playbooks that actually resolve, so it
      // only ever offers the built-ins plus whatever the project defines.
      expect(state.playbooks).toContain('ci-check');
      expect(state.playbooks).not.toContain('flightdeck-dmg');
      expect(state.playbooks).not.toContain('open-xcode');
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('rejects every /api/* request that does not present the capability token', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      // No token at all.
      const noToken = await fetch(`${base(port)}/api/state`);
      expect(noToken.status).toBe(401);

      // A wrong token.
      const wrongToken = await fetch(`${base(port)}/api/state`, {
        headers: { 'X-Flightdeck-Token': 'not-the-token' },
      });
      expect(wrongToken.status).toBe(401);

      // A query-string token is rejected everywhere except /api/events, so the
      // token does not leak through history, referrers, or request logs.
      const queryToken = await fetch(`${base(port)}/api/state?token=${token}`);
      expect(queryToken.status).toBe(401);

      // Actions are gated the same way.
      const actionNoToken = await fetch(`${base(port)}/api/toolkit/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ci-check' }),
      });
      expect(actionNoToken.status).toBe(401);

      // The real token passes.
      const ok = await fetch(`${base(port)}/api/state`, authed(token));
      expect(ok.status).toBe(200);

      // Static assets stay open so the page can load and read the token.
      expect((await fetch(`${base(port)}/`)).status).toBe(200);

      // /api/events is the documented exception: EventSource cannot set
      // headers, so it accepts the token in the query string.
      const sseNoToken = await fetch(`${base(port)}/api/events`);
      expect(sseNoToken.status).toBe(401);
      const sseOk = await fetch(`${base(port)}/api/events?token=${token}`);
      expect(sseOk.status).toBe(200);
      await sseOk.body?.cancel();
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('reports a real error, never a success state, when a toolkit action does not resolve', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      const res = await fetch(
        `${base(port)}/api/toolkit/run`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'no-such-playbook' }),
        })
      );
      expect(res.ok).toBe(false);
      const payload = await res.json();
      expect(payload.error).toContain('no-such-playbook');

      // The client has a distinct failure renderer and never paints a success
      // state for a failed run.
      const js = await (await fetch(`${base(port)}/app.js`)).text();
      expect(js).toContain('toolkitFailure');
      expect(js).toContain('toolkitSuccess');
      expect(js).toContain('✕');
      expect(js).toContain('Failed');
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('does not run a destructive tool until the confirmation round trip approves it', async () => {
    const fixture = makeRepo();
    writeDestructivePlaybook(fixture);
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      const start = await fetch(
        `${base(port)}/api/toolkit/run`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'drop-note' }),
        })
      );
      expect(start.status).toBe(202);
      const { runId } = await start.json();

      // The run suspends awaiting a human decision; the tool is not invoked.
      const waiting = await pollRunStatus(port, token, runId, ['awaiting_confirmation']);
      expect(waiting.status).toBe('awaiting_confirmation');
      const confirm = waiting.confirm as { id: string; operation: string; prompt: string };
      expect(confirm.id).toBeTruthy();
      expect(confirm.operation).toContain('tool:note_delete');
      expect(String(confirm.prompt)).toContain('note_delete');

      // Denying the challenge fails the run with a visible error.
      const deny = await fetch(
        `${base(port)}/api/toolkit/confirm`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: confirm.id, operation: confirm.operation, ok: false }),
        })
      );
      expect(deny.status).toBe(200);
      const failed = await pollRunStatus(port, token, runId, ['failed']);
      expect(String(failed.error)).toContain('not approved');
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('fails a run whose confirmation is never answered (no auto-approval)', async () => {
    const fixture = makeRepo();
    writeDestructivePlaybook(fixture);
    const { server, port, token } = await startServer({ projectRoot: fixture.root, confirmTimeoutMs: 100 });

    try {
      const start = await fetch(
        `${base(port)}/api/toolkit/run`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'drop-note' }),
        })
      );
      expect(start.status).toBe(202);
      const { runId } = await start.json();

      // Nothing confirms the challenge; it expires and the run fails closed.
      const failed = await pollRunStatus(port, token, runId, ['failed']);
      expect(String(failed.error)).toContain('not approved');
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('consumes a confirmation exactly once and only for its bound operation', async () => {
    const fixture = makeRepo();
    writeDestructivePlaybook(fixture);
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      const start = await fetch(
        `${base(port)}/api/toolkit/run`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'drop-note' }),
        })
      );
      const { runId } = await start.json();
      const waiting = await pollRunStatus(port, token, runId, ['awaiting_confirmation']);
      const confirm = waiting.confirm as { id: string; operation: string };

      // A confirm that does not match the pending operation is rejected.
      const mismatch = await fetch(
        `${base(port)}/api/toolkit/confirm`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: confirm.id, operation: 'tool:some_other_tool:deadbeef', ok: true }),
        })
      );
      expect(mismatch.status).toBe(400);

      // An unknown confirm id is rejected.
      const ghost = await fetch(
        `${base(port)}/api/toolkit/confirm`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: 'does-not-exist', operation: confirm.operation, ok: true }),
        })
      );
      expect(ghost.status).toBe(404);

      // The real challenge is still pending and approves exactly once.
      const approve = await fetch(
        `${base(port)}/api/toolkit/confirm`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: confirm.id, operation: confirm.operation, ok: true }),
        })
      );
      expect(approve.status).toBe(200);
      await pollRunStatus(port, token, runId, ['succeeded']);

      // Replaying the consumed challenge is rejected.
      const replay = await fetch(
        `${base(port)}/api/toolkit/confirm`,
        authed(token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmId: confirm.id, operation: confirm.operation, ok: true }),
        })
      );
      expect(replay.status).toBe(404);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('rejects path traversal in session id routes and never grants cross-origin reads', async () => {
    const fixture = makeRepo();
    const { server, port, token } = await startServer({ projectRoot: fixture.root });

    try {
      // An attacker's raw request target with .. segments reaches the server
      // intact; the id must be rejected before it becomes a filesystem path.
      const traversal = `${'../'.repeat(20)}etc/secret`;
      const logsRaw = await rawRequest(port, 'GET', `/api/sessions/${traversal}/logs`, {
        'X-Flightdeck-Token': token,
      });
      expect(logsRaw).toMatch(/^HTTP\/1\.1 400 /);
      expect(logsRaw).toContain('invalid session id');
      expect(logsRaw).not.toContain('SECRET');

      const stopRaw = await rawRequest(port, 'POST', `/api/sessions/${traversal}/stop`, {
        'X-Flightdeck-Token': token,
      });
      expect(stopRaw).toMatch(/^HTTP\/1\.1 400 /);
      expect(stopRaw).toContain('invalid session id');

      // A well-formed but unknown id is not a traversal: it yields empty logs.
      const unknown = await fetch(
        `${base(port)}/api/sessions/00000000-0000-0000-0000-000000000000/logs`,
        authed(token)
      );
      expect(unknown.status).toBe(200);
      expect((await unknown.json()).logs).toBe('');

      // No API response may carry a CORS grant, so a visited web page cannot
      // read dashboard state cross-origin (the token would buy nothing).
      const stateRes = await fetch(`${base(port)}/api/state`, authed(token));
      expect(stateRes.headers.get('access-control-allow-origin')).toBeNull();
      const opt = await rawRequest(port, 'OPTIONS', '/api/state', {
        'X-Flightdeck-Token': token,
      });
      expect(opt).not.toContain('Access-Control-Allow-Origin');
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('getLogs never reads outside the session log directory', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const logsDir = path.join(fixture.root, '.flightdeck', 'logs', 'sessions');
      fs.mkdirSync(logsDir, { recursive: true });

      const realId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      fs.writeFileSync(path.join(logsDir, `${realId}.log`), 'real logs');
      expect(sm.getLogs(realId)).toBe('real logs');

      // Canaries just outside the directory must never be reachable, even
      // though the paths resolve to files that really exist.
      fs.writeFileSync(path.join(fixture.root, '.flightdeck', 'logs', 'canary.log'), 'SECRET-CANARY');
      fs.writeFileSync(path.join(fixture.root, 'secret.log'), 'SECRET-ROOT');
      expect(sm.getLogs('../canary')).toBe('');
      expect(sm.getLogs('../../../secret')).toBe('');
    } finally {
      fixture.cleanup();
    }
  });
});
