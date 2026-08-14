import { describe, it, expect } from 'vitest';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';

describe('MessagingStore', () => {
  it('sends, lists, and polls messages', () => {
    const fixture = makeRepo();
    try {
      const store = new MessagingStore(fixture.root);
      store.send('a', 'b', 'hello b');
      store.send('c', 'b', 'hello b from c');
      store.send('b', 'a', 'hi a');

      const toB = store.list({ to: 'b' });
      expect(toB).toHaveLength(2);

      const firstId = toB[0].id;
      const polled = store.poll('b', firstId);
      expect(polled).toHaveLength(1);
      expect(polled[0].fromSession).toBe('c');

      const polledAgain = store.poll('b', firstId);
      expect(polledAgain).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});
