import { describe, it, expect } from 'vitest';
import { extractJson, parsePlan, parseReview, parseAnswer } from '../../src/argus/brain.js';

describe('extractJson', () => {
  it('finds the JSON object inside conversational output', () => {
    const stdout = 'Here is the plan you asked for:\n{"tasks": []}\nLet me know.';
    expect(extractJson(stdout)).toEqual({ tasks: [] });
  });

  it('finds JSON inside a fenced code block', () => {
    const stdout = 'Result:\n```json\n{"answer": "yes", "faq_key": "k"}\n```\n';
    expect(extractJson(stdout)).toEqual({ answer: 'yes', faq_key: 'k' });
  });

  it('prefers the last JSON object when several appear', () => {
    const stdout = '{"tasks": [{"title": "draft", "spec": "s"}]}\nActually:\n{"tasks": []}';
    expect(extractJson(stdout)).toEqual({ tasks: [] });
  });

  it('throws when no JSON object is present', () => {
    expect(() => extractJson('I could not complete that.')).toThrow(/no JSON object/);
  });
});

describe('parsePlan', () => {
  it('parses tasks and defaults a missing depends_on', () => {
    const drafts = parsePlan('{"tasks":[{"title":"a","spec":"do a"}]}');
    expect(drafts).toEqual([{ title: 'a', spec: 'do a', dependsOn: [] }]);
  });

  it('maps depends_on indices through unchanged', () => {
    const drafts = parsePlan(
      '{"tasks":[{"title":"a","spec":"x","depends_on":[]},{"title":"b","spec":"y","depends_on":[0]}]}'
    );
    expect(drafts[1].dependsOn).toEqual([0]);
  });

  it('rejects an empty task list', () => {
    expect(() => parsePlan('{"tasks":[]}')).toThrow();
  });

  it('rejects a task missing a spec', () => {
    expect(() => parsePlan('{"tasks":[{"title":"a"}]}')).toThrow();
  });
});

describe('parseReview', () => {
  it('parses a batch of verdicts', () => {
    const verdicts = parseReview(
      '{"verdicts":[{"task_id":"t1","verdict":"accept"},{"task_id":"t2","verdict":"revise","reason":"no tests"}]}'
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({ taskId: 't1', verdict: 'accept', reason: null, paths: [] });
    expect(verdicts[1].reason).toBe('no tests');
  });

  it('parses a need_files verdict with paths', () => {
    const verdicts = parseReview(
      '{"verdicts":[{"task_id":"t1","verdict":"need_files","paths":["src/a.ts"]}]}'
    );
    expect(verdicts[0].verdict).toBe('need_files');
    expect(verdicts[0].paths).toEqual(['src/a.ts']);
  });

  it('rejects an unknown verdict value', () => {
    expect(() => parseReview('{"verdicts":[{"task_id":"t1","verdict":"maybe"}]}')).toThrow();
  });
});

describe('parseAnswer', () => {
  it('parses an answer and its faq key', () => {
    expect(parseAnswer('{"answer":"use vitest","faq_key":"test-command"}')).toEqual({
      answer: 'use vitest',
      faqKey: 'test-command',
    });
  });
});
