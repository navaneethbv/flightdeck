import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SessionManager } from '../../src/sessions/manager.js';
import { exportSession, exportSessionToFile } from '../../src/sessions/export.js';
import { followSessionLogs } from '../../src/sessions/stream.js';
import { repairProject } from '../../src/core/repair.js';
import { renderMissionTemplate } from '../../src/argus/templates.js';
import { makeRepo, sleep } from '../helpers.js';
import { getDb } from '../../src/core/state.js';

describe('Mission Templates', () => {
  it('renders standard mission templates with objectives and guardrails', () => {
    const feature = renderMissionTemplate('feature', 'Add Vector Search');
    expect(feature).toContain('# Mission: Add Vector Search');
    expect(feature).toContain('## Objectives');
    expect(feature).toContain('Guardrails');

    const refactor = renderMissionTemplate('refactor', 'Core Engine');
    expect(refactor).toContain('# Mission: Core Engine');

    const audit = renderMissionTemplate('audit', 'Security Scan');
    expect(audit).toContain('# Mission: Security Scan');

    const bugfix = renderMissionTemplate('bugfix', 'Memory Leak');
    expect(bugfix).toContain('# Mission: Memory Leak');
  });
});

describe('Session Export and Log Stream', () => {
  it('exports complete session bundle with logs and metadata to a file', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const s = sm.createSession({ name: 'export-test', harness: 'gemini', cwd: fixture.root });

      const logsDir = path.join(fixture.root, '.flightdeck', 'logs', 'sessions');
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(path.join(logsDir, `${s.id}.log`), 'line 1\nline 2\n');

      const bundle = exportSession(fixture.root, s.id);
      expect(bundle.session.id).toBe(s.id);
      expect(bundle.logs).toContain('line 1');

      const exportRes = exportSessionToFile(fixture.root, s.id);
      expect(fs.existsSync(exportRes.path)).toBe(true);
      const fileData = JSON.parse(fs.readFileSync(exportRes.path, 'utf8'));
      expect(fileData.session.name).toBe('export-test');
    } finally {
      fixture.cleanup();
    }
  });

  it('streams session log chunks in spectator mode', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const s = sm.createSession({ name: 'stream-test', harness: 'claude', cwd: fixture.root });

      const logsDir = path.join(fixture.root, '.flightdeck', 'logs', 'sessions');
      fs.mkdirSync(logsDir, { recursive: true });
      const logFile = path.join(logsDir, `${s.id}.log`);
      fs.writeFileSync(logFile, 'start of log\n');

      const chunks: string[] = [];
      const handle = followSessionLogs(fixture.root, s.id, {
        tailLines: 10,
        intervalMs: 50,
        onChunk: (c) => chunks.push(c),
      });

      await sleep(100);
      fs.appendFileSync(logFile, 'second line\n');
      await sleep(150);

      handle.stop();
      const combined = chunks.join('');
      expect(combined).toContain('start of log');
      expect(combined).toContain('second line');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Project Repair', () => {
  it('repairs broken directories and stale dead session states', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const dead = sm.createSession({ name: 'dead-session', harness: 'claude', cwd: fixture.root });

      const db = getDb(fixture.root);
      db.prepare("UPDATE sessions SET status = 'running', pid = 999999 WHERE id = ?").run(dead.id);

      const result = repairProject(fixture.root);
      expect(result.ok).toBe(true);
      expect(result.fixed.some((f) => f.includes('repaired dead running session'))).toBe(true);

      const updated = sm.get(dead.id);
      expect(updated?.status).toBe('stopped');
    } finally {
      fixture.cleanup();
    }
  });
});
