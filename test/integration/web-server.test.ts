import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { createWebServer } from '../../src/server/index.js';
import { makeRepo } from '../helpers.js';

describe('Web GUI Server', () => {
  it('serves static UI assets and API state over HTTP', async () => {
    const fixture = makeRepo();
    const server = createWebServer({
      port: 0,
      projectRoot: fixture.root,
    });

    try {
      const port = await server.start();
      expect(port).toBeGreaterThan(0);

      // 1. Check HTML index
      const indexRes = await fetch(`http://127.0.0.1:${port}/`);
      expect(indexRes.status).toBe(200);
      const html = await indexRes.text();
      expect(html).toContain('Flightdeck Control Plane');
      expect(html).toContain('Lloyd');
      expect(html).toContain('Toolkit');

      // 2. Check CSS
      const cssRes = await fetch(`http://127.0.0.1:${port}/styles.css`);
      expect(cssRes.status).toBe(200);
      const css = await cssRes.text();
      expect(css).toContain('--bg-canvas');

      // 3. Check JS
      const jsRes = await fetch(`http://127.0.0.1:${port}/app.js`);
      expect(jsRes.status).toBe(200);
      const js = await jsRes.text();
      expect(js).toContain('fetchState');

      // 4. Check /api/state
      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
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
    const server = createWebServer({
      port: 0,
      projectRoot: fixture.root,
    });

    try {
      const port = await server.start();

      // Start Session
      const startRes = await fetch(`http://127.0.0.1:${port}/api/sessions/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'api-sess-1',
          harness: 'gemini',
          task: 'test web api',
          headless: true,
        }),
      });
      expect(startRes.status).toBe(200);
      const session = await startRes.json();
      expect(session.name).toBe('api-sess-1');
      expect(session.harness).toBe('gemini');

      // Send Message
      const msgRes = await fetch(`http://127.0.0.1:${port}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toSession: session.id,
          body: 'Hello from Flightdeck Web UI',
          fromSession: 'user',
        }),
      });
      expect(msgRes.status).toBe(200);
      const msg = await msgRes.json();
      expect(msg.body).toBe('Hello from Flightdeck Web UI');

      // Get Logs
      const logsRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/logs`);
      expect(logsRes.status).toBe(200);
      const logsData = await logsRes.json();
      expect(logsData.id).toBe(session.id);

      // Stop Session
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/stop`, {
        method: 'POST',
      });
      expect(stopRes.status).toBe(200);
      const stopData = await stopRes.json();
      expect(stopData.stopped).toBe(true);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });
});
