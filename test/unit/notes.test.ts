import { describe, it, expect } from 'vitest';
import { NotesStore } from '../../src/notes/store.js';
import { makeRepo } from '../helpers.js';

describe('NotesStore', () => {
  it('creates, reads, updates, and versions notes', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const created = store.createNote('Hello World', 'first body');
      expect(created.title).toBe('Hello World');
      expect(created.version).toBe(1);

      const read = store.readNote(created.id);
      expect(read?.body).toBe('first body');

      const updated = store.updateNote(created.id, { body: 'second body' });
      expect(updated.version).toBe(2);
      expect(updated.body).toBe('second body');

      const versions = store.versions(created.id);
      expect(versions).toHaveLength(2);

      expect(store.readNote(created.id)?.body).toBe('second body');
    } finally {
      fixture.cleanup();
    }
  });

  it('searches notes with full-text index without duplicating updated notes and provides snippets', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const note = store.createNote('Alpha', 'the quick brown fox jumped high');
      store.updateNote(note.id, { body: 'the quick brown fox jumped even higher' });
      store.updateNote(note.id, { body: 'the quick brown fox jumped to the moon' });
      store.createNote('Beta', 'jumps over the lazy dog');

      const results = store.searchNotes('fox');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(note.id);
      expect(results[0].title).toBe('Alpha');
      expect(results[0].snippet).toContain('fox');
    } finally {
      fixture.cleanup();
    }
  });

  it('deletes notes', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const note = store.createNote('Temp', 'x');
      store.deleteNote(note.id);
      expect(store.readNote(note.id)).toBeNull();
      expect(store.listNotes()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});
