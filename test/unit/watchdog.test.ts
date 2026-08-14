import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../src/sessions/manager.js';
import { WatchdogManager } from '../../src/watchdog/manager.js';
import { makeRepo } from '../helpers.js';
import { getDb } from '../../src/core/state.js';

describe('WatchdogManager', () => {
  it('detects hung sessions and inspects waiting permission prompts', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const s1 = sm.createSession({ name: 'active', harness: 'claude', cwd: fixture.root });
      const s2 = sm.createSession({ name: 'hung', harness: 'claude', cwd: fixture.root });

      const db = getDb(fixture.root);
      const oldTime = Date.now() - 600 * 1000;
      db.prepare("UPDATE sessions SET status = 'running', last_activity_at = ? WHERE id = ?").run(oldTime, s2.id);
      db.prepare("UPDATE sessions SET status = 'running', last_activity_at = ? WHERE id = ?").run(Date.now(), s1.id);

      const logsDir = path.join(fixture.root, '.flightdeck', 'logs', 'sessions');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, `${s2.id}.log`), 'Running task...\nDo you want to proceed with file edit? [y/N]\n');

      const watchdog = new WatchdogManager(fixture.root);
      const hung = watchdog.listHung(300);
      expect(hung.map((s) => s.id)).toContain(s2.id);
      expect(hung.map((s) => s.id)).not.toContain(s1.id);

      const inspection = watchdog.inspect(s2.id, 300);
      expect(inspection.isStuck).toBe(true);
      expect(inspection.hasPrompt).toBe(true);
      expect(inspection.recentLogs).toContain('[y/N]');
    } finally {
      fixture.cleanup();
    }
  });

  it('kills hung sessions', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const s = sm.createSession({ name: 'hung-to-kill', harness: 'claude', cwd: fixture.root });
      const db = getDb(fixture.root);
      const oldTime = Date.now() - 600 * 1000;
      db.prepare("UPDATE sessions SET status = 'running', last_activity_at = ? WHERE id = ?").run(oldTime, s.id);

      const watchdog = new WatchdogManager(fixture.root);
      const res = await watchdog.killHung(300);
      expect(res.killed).toContain(s.id);
      expect(sm.get(s.id)?.status).toBe('stopped');
    } finally {
      fixture.cleanup();
    }
  });
});
