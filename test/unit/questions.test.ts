import { describe, it, expect } from 'vitest';
import { QuestionQueue } from '../../src/argus/questions.js';
import { makeRepo } from '../helpers.js';

describe('QuestionQueue', () => {
  it('misses on a cold cache and queues the question', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const result = queue.ask('a1', 's1', 'What is the test command?');
      expect(result.hit).toBe(false);
      expect(queue.pending('a1')).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('serves a repeat question from the FAQ without queueing it', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const first = queue.ask('a1', 's1', 'What is the test command?');
      if (first.hit) throw new Error('expected a cache miss');
      queue.answer(first.id, 'Run npm test', 'test-command');

      const second = queue.ask('a1', 's2', 'What is the test command?');
      expect(second).toEqual({ hit: true, answer: 'Run npm test' });
      expect(queue.pending('a1')).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('matches on keyword overlap despite punctuation and case', () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const first = queue.ask('a1', 's1', 'What is the test command?');
      if (first.hit) throw new Error('expected a cache miss');
      queue.answer(first.id, 'Run npm test', 'test-command');

      const second = queue.ask('a1', 's2', 'what is the TEST command');
      expect(second.hit).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('resolves waitForAnswer once the answer lands', async () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's1', 'Which auth pattern?');
      if (asked.hit) throw new Error('expected a cache miss');

      setTimeout(() => queue.answer(asked.id, 'Use the session token', 'auth'), 60);
      const answer = await queue.waitForAnswer(asked.id, 2000);
      expect(answer).toBe('Use the session token');
    } finally {
      fixture.cleanup();
    }
  });

  it('returns null when the brain does not answer in time, so the worker is never stalled', async () => {
    const fixture = makeRepo();
    try {
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask('a1', 's1', 'Anything?');
      if (asked.hit) throw new Error('expected a cache miss');
      expect(await queue.waitForAnswer(asked.id, 250)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });
});
