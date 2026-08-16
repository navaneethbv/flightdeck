import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import { NotesStore } from '../notes/store.js';
import type { Question } from '../core/types.js';

export type AskResult = { hit: true; answer: string } | { hit: false; id: number };

const FAQ_TITLE = 'flightdeck-faq';
const MATCH_THRESHOLD = 0.6;
const POLL_INTERVAL_MS = 50;

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
  'what', 'which', 'how', 'why', 'when', 'where', 'to', 'of', 'in',
  'on', 'for', 'i', 'we', 'should', 'can', 'this', 'that', 'it',
]);

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
  );
}

/**
 * Jaccard overlap of significant words. Deliberately naive: a miss costs one
 * brain call, whereas embeddings would add a dependency and an index to
 * maintain. Revisit if the observed miss rate is high.
 */
export function similarity(a: string, b: string): number {
  const setA = keywords(a);
  const setB = keywords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  const union = new Set([...setA, ...setB]).size;
  return shared / union;
}

function rowToQuestion(row: Record<string, unknown>): Question {
  return {
    id: Number(row.id),
    argusId: String(row.argus_id),
    sessionId: String(row.session_id),
    question: String(row.question),
    answer: typeof row.answer === 'string' ? row.answer : null,
    faqKey: typeof row.faq_key === 'string' ? row.faq_key : null,
    createdAt: Number(row.created_at),
    answeredAt: row.answered_at === null ? null : Number(row.answered_at),
    failedAt: row.failed_at === null || row.failed_at === undefined ? null : Number(row.failed_at),
  };
}

export class QuestionQueue {
  private readonly db: DatabaseSync;
  private readonly notes: NotesStore;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.notes = new NotesStore(this.projectRoot);
  }

  /** Every previously answered question in this project, newest first. */
  private answered(argusId: string): Question[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM questions WHERE argus_id = ? AND answer IS NOT NULL ORDER BY id DESC'
      )
      .all(argusId) as Record<string, unknown>[];
    return rows.map(rowToQuestion);
  }

  faqLookup(argusId: string, question: string): string | null {
    for (const prior of this.answered(argusId)) {
      if (similarity(prior.question, question) >= MATCH_THRESHOLD) {
        return prior.answer;
      }
    }
    return null;
  }

  ask(argusId: string, sessionId: string, question: string): AskResult {
    const cached = this.faqLookup(argusId, question);
    if (cached !== null) return { hit: true, answer: cached };

    const result = this.db
      .prepare(
        'INSERT INTO questions (argus_id, session_id, question, created_at) VALUES (?, ?, ?, ?)'
      )
      .run(...([argusId, sessionId, question, now()] as SQLInputValue[]));
    return { hit: false, id: Number(result.lastInsertRowid) };
  }

  pending(argusId: string): Question[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM questions WHERE argus_id = ? AND answer IS NULL AND failed_at IS NULL ORDER BY id ASC'
      )
      .all(argusId) as Record<string, unknown>[];
    return rows.map(rowToQuestion);
  }

  /**
   * Marks a question the brain could not answer. The answer stays null so the
   * waiting worker still receives its normal timeout directive and the FAQ is
   * never poisoned with a failure, but the question leaves the pending set so
   * the scheduler cannot re-invoke a brain that already failed twice.
   */
  markFailed(id: number, reason: string): void {
    this.db
      .prepare('UPDATE questions SET failed_at = ?, faq_key = ? WHERE id = ?')
      .run(...([now(), `failed:${reason.slice(0, 80)}`, id] as SQLInputValue[]));
  }

  get(id: number): Question | null {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToQuestion(row) : null;
  }

  /** Records the answer and appends it to the human-readable FAQ note. */
  answer(id: number, answer: string, faqKey: string): void {
    this.db
      .prepare('UPDATE questions SET answer = ?, faq_key = ?, answered_at = ? WHERE id = ?')
      .run(...([answer, faqKey, now(), id] as SQLInputValue[]));
    this.appendToFaqNote(faqKey, answer);
  }

  private appendToFaqNote(faqKey: string, answer: string): void {
    const existing = this.notes.list().find((n) => n.title === FAQ_TITLE);
    const entry = `\n## ${faqKey}\n\n${answer}\n`;
    if (existing) {
      const full = this.notes.readNote(existing.id);
      this.notes.updateNote(existing.id, { body: `${full?.body ?? ''}${entry}` });
      return;
    }
    this.notes.createNote(FAQ_TITLE, `# Fleet FAQ\n${entry}`);
  }

  /**
   * Resolves with the answer, or null on timeout. Null is not an error: a
   * throttled brain must slow review throughput without ever stalling a
   * worker, so the caller proceeds on best judgment instead.
   */
  async waitForAnswer(id: number, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const question = this.get(id);
      if (question?.answer) return question.answer;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return null;
  }
}
