import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NotesStore } from '../../src/notes/store.js';
import { getDb } from '../../src/core/state.js';
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

  it('rolls back note metadata, history and search when saving the file fails', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const created = store.createNote('Original', 'original canary');
      const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('simulated disk failure'); });
      try {
        expect(() => store.updateNote(created.id, { title: 'New', body: 'replacement' }, created)).toThrow('simulated disk failure');
      } finally {
        rename.mockRestore();
      }
      expect(store.readNote(created.id)).toEqual(created);
      expect(store.versions(created.id)).toHaveLength(1);
      expect(store.searchNotes('canary')).toHaveLength(1);
      expect(store.searchNotes('replacement')).toHaveLength(0);
      expect(fs.readdirSync(path.join(fixture.root, '.flightdeck', 'notes'))).toEqual([`${created.id}.md`]);
      expect(store.updateNote(created.id, { body: 'retry' }, created).version).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('removes a newly written file when the database commit fails', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const db = getDb(fixture.root);
      db.exec(`
        CREATE TABLE commit_guard (note_id TEXT REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_note_commit AFTER INSERT ON notes
        BEGIN INSERT INTO commit_guard VALUES ('missing-parent'); END;
      `);
      expect(() => store.createNote('Failed commit', 'orphan canary')).toThrow('FOREIGN KEY constraint failed');
      expect(store.listNotes()).toEqual([]);
      expect(store.versions('failed-commit')).toEqual([]);
      expect(store.searchNotes('canary')).toEqual([]);
      expect(fs.readdirSync(path.join(fixture.root, '.flightdeck', 'notes'))).toEqual([]);
      db.exec('DROP TRIGGER reject_note_commit');
      expect(store.createNote('Failed commit', 'retry').id).toBe('failed-commit');
    } finally {
      fixture.cleanup();
    }
  });

  it('restores the exact previous file, metadata, history and search when an update commit fails', () => {
    const fixture = makeRepo();
    try {
      const store = new NotesStore(fixture.root);
      const created = store.createNote('Original', 'original canary');
      const file = path.join(fixture.root, '.flightdeck', 'notes', `${created.id}.md`);
      const originalFile = '---\ntitle: "Original"\ncustom: preserve-this-field\n---\noriginal canary';
      fs.writeFileSync(file, originalFile);
      const db = getDb(fixture.root);
      db.exec(`
        CREATE TABLE commit_guard (note_id TEXT REFERENCES notes(id) DEFERRABLE INITIALLY DEFERRED);
        CREATE TRIGGER reject_note_commit AFTER UPDATE ON notes
        BEGIN INSERT INTO commit_guard VALUES ('missing-parent'); END;
      `);
      expect(() => store.updateNote(created.id, { title: 'Replacement', body: 'replacement' }, created)).toThrow('FOREIGN KEY constraint failed');
      expect(fs.readFileSync(file, 'utf8')).toBe(originalFile);
      expect(store.readNote(created.id)).toEqual(created);
      expect(store.versions(created.id)).toHaveLength(1);
      expect(store.searchNotes('canary')).toHaveLength(1);
      expect(store.searchNotes('replacement')).toHaveLength(0);
      expect(fs.readdirSync(path.join(fixture.root, '.flightdeck', 'notes'))).toEqual([`${created.id}.md`]);
      db.exec('DROP TRIGGER reject_note_commit');
      expect(store.updateNote(created.id, { body: 'retry' }, created).version).toBe(2);
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
