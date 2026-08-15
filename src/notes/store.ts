import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getDb, now } from '../core/state.js';
import { notesDir } from '../core/paths.js';

export interface Note {
  id: string;
  title: string;
  body: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface NoteSearchResult {
  id: string;
  title: string;
  snippet: string;
}

function noteFilePath(projectRoot: string, id: string): string {
  return path.join(notesDir(projectRoot), `${id}.md`);
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return slug || 'note';
}

function parseFile(content: string): { title: string; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { title: '', body: content };
  try {
    const meta = YAML.parse(m[1]) as { title?: unknown };
    return { title: typeof meta.title === 'string' ? meta.title : '', body: m[2] };
  } catch {
    return { title: '', body: content };
  }
}

function serializeFile(title: string, body: string): string {
  return `---\n${YAML.stringify({ title }).trim()}\n---\n${body}`;
}

function syncFts(db: unknown, noteId: string, title: string, body: string): void {
  const d = db as import('node:sqlite').DatabaseSync;
  try {
    d.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(noteId);
  } catch {
    // ignore
  }
  d.prepare('INSERT INTO notes_fts (note_id, title, body) VALUES (?, ?, ?)').run(
    noteId,
    title,
    body
  );
}

export class NotesStore {
  private db;

  constructor(private readonly projectRoot: string) {
    this.db = getDb(projectRoot);
    fs.mkdirSync(notesDir(projectRoot), { recursive: true });
  }

  createNote(title: string, body: string): Note {
    const slug = slugify(title);
    let id = slug;
    if (fs.existsSync(noteFilePath(this.projectRoot, id))) {
      id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    }
    const ts = now();
    this.db
      .prepare('INSERT INTO notes (id, title, slug, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, title, slug, 1, ts, ts);
    this.db
      .prepare('INSERT INTO notes_versions (note_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, 1, title, body, ts);
    syncFts(this.db, id, title, body);
    fs.writeFileSync(noteFilePath(this.projectRoot, id), serializeFile(title, body));
    return { id, title, body, version: 1, createdAt: ts, updatedAt: ts };
  }

  readNote(id: string): Note | null {
    const meta = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!meta) return null;
    const filePath = noteFilePath(this.projectRoot, id);
    const { title, body } = fs.existsSync(filePath) ? parseFile(fs.readFileSync(filePath, 'utf8')) : { title: String(meta.title), body: '' };
    return {
      id,
      title,
      body,
      version: Number(meta.current_version),
      createdAt: Number(meta.created_at),
      updatedAt: Number(meta.updated_at),
    };
  }

  listNotes(): Note[] {
    const metas = this.db.prepare('SELECT id FROM notes ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return metas
      .map((m) => this.readNote(String(m.id)))
      .filter((n): n is Note => n !== null);
  }

  list(): Note[] {
    return this.listNotes();
  }

  updateNote(id: string, changes: { title?: string; body?: string }): Note {
    const current = this.readNote(id);
    if (!current) throw new Error(`note "${id}" not found`);
    const title = changes.title ?? current.title;
    const body = changes.body ?? current.body;
    const nextVersion = current.version + 1;
    const ts = now();
    this.db
      .prepare('INSERT INTO notes_versions (note_id, version, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, nextVersion, title, body, ts);
    this.db.prepare('UPDATE notes SET title = ?, current_version = ?, updated_at = ? WHERE id = ?').run(
      title,
      nextVersion,
      ts,
      id
    );
    syncFts(this.db, id, title, body);
    fs.writeFileSync(noteFilePath(this.projectRoot, id), serializeFile(title, body));
    return { ...current, title, body, version: nextVersion, updatedAt: ts };
  }

  versions(id: string): { version: number; title: string; createdAt: number }[] {
    const rows = this.db
      .prepare('SELECT version, title, created_at FROM notes_versions WHERE note_id = ? ORDER BY version')
      .all(id) as Record<string, unknown>[];
    return rows.map((r) => ({
      version: Number(r.version),
      title: String(r.title),
      createdAt: Number(r.created_at),
    }));
  }

  searchNotes(query: string): NoteSearchResult[] {
    const safeQuery = query.replace(/[^\w\s]/g, ' ').trim();
    if (!safeQuery) return [];
    try {
      const rows = this.db
        .prepare('SELECT note_id, title, body FROM notes_fts WHERE notes_fts MATCH ?')
        .all(safeQuery) as Record<string, unknown>[];
      const seen = new Set<string>();
      const out: NoteSearchResult[] = [];
      for (const r of rows) {
        const id = String(r.note_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const body = String(r.body ?? '');
        const lowerBody = body.toLowerCase();
        const firstTerm = safeQuery.toLowerCase().split(/\s+/)[0] ?? '';
        const idx = lowerBody.indexOf(firstTerm);
        let snippet = '';
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(body.length, idx + 70);
          snippet = (start > 0 ? '...' : '') + body.slice(start, end).trim() + (end < body.length ? '...' : '');
        } else {
          snippet = body.slice(0, 100).trim();
        }
        out.push({ id, title: String(r.title), snippet });
      }
      return out;
    } catch {
      return [];
    }
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM notes_versions WHERE note_id = ?').run(id);
    try {
      this.db.prepare('DELETE FROM notes_fts WHERE note_id = ?').run(id);
    } catch {
      // ignore
    }
    const filePath = noteFilePath(this.projectRoot, id);
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
  }
}
