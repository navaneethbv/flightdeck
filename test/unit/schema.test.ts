import { describe, it, expect } from 'vitest';
import { getDb } from '../../src/core/state.js';
import { loadConfig } from '../../src/core/config.js';
import { makeRepo } from '../helpers.js';

function columns(db: ReturnType<typeof getDb>, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  return rows.map((r) => String(r.name));
}

describe('orchestrator schema', () => {
  it('creates the tasks table with every lifecycle column', () => {
    const fixture = makeRepo();
    try {
      const db = getDb(fixture.root);
      const cols = columns(db, 'tasks');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'argus_id', 'title', 'spec', 'status', 'assignee_session',
          'depends_on', 'attempts', 'worker_report', 'gate_result',
          'diffstat', 'verdict', 'verdict_reason', 'created_at', 'updated_at',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('creates the questions table', () => {
    const fixture = makeRepo();
    try {
      const cols = columns(getDb(fixture.root), 'questions');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id', 'argus_id', 'session_id', 'question', 'answer',
          'faq_key', 'created_at', 'answered_at',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('adds brain and budget columns to argus', () => {
    const fixture = makeRepo();
    try {
      const cols = columns(getDb(fixture.root), 'argus');
      expect(cols).toEqual(
        expect.arrayContaining([
          'brain_harness', 'brain_plan_model', 'brain_review_model',
          'worker_harnesses', 'budget_window_sec', 'budget_max_tokens',
          'budget_count_cache_reads', 'max_attempts_per_task', 'max_tasks',
          'question_timeout_sec',
        ])
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('defaults the gate commands', () => {
    const config = loadConfig();
    expect(config.argus.gateTestCommand).toBe('npm test');
    expect(config.argus.gateLintCommand).toBe('npm run lint');
  });
});
