import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cliDistPath, makeRepo } from '../helpers.js';

describe('dashboard shutdown', () => {
  it('exits naturally with an unanswered confirmation instead of leaking its timer', () => {
    const fixture = makeRepo();
    try {
      const dir = path.join(fixture.root, '.flightdeck', 'playbooks');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'confirm.yml'), 'name: confirm\nsteps:\n  - id: delete\n    type: mcp\n    tool: note_delete\n    arguments:\n      id: missing\n');
      const script = `
        const { createWebServer } = await import(process.argv[2]);
        const server = createWebServer({ projectRoot: process.argv[1], port: 0 });
        const base = 'http://127.0.0.1:' + await server.start();
        const headers = { 'X-Flightdeck-Token': server.capabilityToken };
        const response = await fetch(base + '/api/toolkit/run', { method: 'POST', headers, body: JSON.stringify({ action: 'confirm' }) });
        const { runId } = await response.json();
        const run = await (await fetch(base + '/api/toolkit/run/' + runId, { headers })).json();
        if (run.status !== 'awaiting_confirmation') throw new Error('Confirmation was not pending');
        await server.stop();
        console.log('stopped');
      `;
      const moduleUrl = pathToFileURL(path.resolve(path.dirname(cliDistPath()), '../server/index.js')).href;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, fixture.root, moduleUrl], { encoding: 'utf8', timeout: 5000, env: process.env });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe('stopped');
    } finally {
      fixture.cleanup();
    }
  });
});
