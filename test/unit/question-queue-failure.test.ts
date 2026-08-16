import { describe, it, expect } from 'vitest';
import { QuestionQueue } from '../../src/argus/questions.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { makeRepo } from '../helpers.js';

describe('QuestionQueue failure state', () => {
  it('drops a failed question from the pending set without answering it', () => {
    const fixture = makeRepo();
    try {
      const argus = new ArgusManager(fixture.root, async () => '{}').start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'what is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');

      expect(queue.pending(argus.id)).toHaveLength(1);
      queue.markFailed(asked.id, 'brain answer output was malformed twice');

      expect(queue.pending(argus.id)).toHaveLength(0);
      const row = queue.get(asked.id);
      expect(row?.answer).toBeNull();
      expect(row?.failedAt).not.toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('does not serve a failed question from the FAQ cache', () => {
    const fixture = makeRepo();
    try {
      const argus = new ArgusManager(fixture.root, async () => '{}').start({ name: 'fleet' });
      const queue = new QuestionQueue(fixture.root);
      const asked = queue.ask(argus.id, 'worker-1', 'what is the test command?');
      if (asked.hit) throw new Error('expected a cache miss');
      queue.markFailed(asked.id, 'malformed');

      const again = queue.ask(argus.id, 'worker-2', 'what is the test command?');
      expect(again.hit).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
