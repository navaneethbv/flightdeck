import type { DatabaseSync } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import { TablesStore } from '../tables/store.js';
import { TaskBoard } from './board.js';
import { log } from '../core/logger.js';

/**
 * Human overrides of the brain's decisions.
 *
 * Lives in its own module so the fleet console and the CLI call identical
 * functions, per the contract's rule that anything reachable from a dashboard
 * is reachable from the CLI.
 */
export class Override {
  private readonly db: DatabaseSync;
  private readonly board: TaskBoard;
  private readonly tables: TablesStore;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.board = new TaskBoard(this.projectRoot);
    this.tables = new TablesStore(this.projectRoot);
  }

  /** Every override is attributed to the human, so the log distinguishes it from a brain verdict. */
  private record(argusId: string | undefined, event: string, detail: string): void {
    if (!argusId) return;
    try {
      this.tables.insertRow('argus_progress', {
        argus_id: argusId,
        session_id: null,
        event,
        detail,
      });
    } catch (err) {
      log.error(`failed to record override: ${(err as Error).message}`);
    }
  }

  acceptTask(taskId: string, argusId?: string): void {
    this.board.recordVerdict(taskId, 'accept', 'accepted by human override');
    this.record(argusId, 'human_accept', taskId);
  }

  rejectTask(taskId: string, reason: string, argusId?: string): void {
    this.board.recordVerdict(taskId, 'revise', `human override: ${reason}`);
    this.record(argusId, 'human_reject', `${taskId}: ${reason}`);
  }

  unblockTask(taskId: string, argusId?: string): void {
    this.db
      .prepare("UPDATE tasks SET status = 'pending', attempts = 0, updated_at = ? WHERE id = ?")
      .run(now(), taskId);
    this.record(argusId, 'human_unblock', taskId);
  }

  prioritizeTask(taskId: string, argusId?: string): void {
    const row = this.db.prepare('SELECT MAX(priority) AS top FROM tasks').get() as { top: number | null };
    const next = Number(row.top ?? 0) + 1;
    this.db
      .prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')
      .run(next, now(), taskId);
    this.record(argusId, 'human_prioritize', taskId);
  }

  /**
   * Drains the review queue now, ignoring the ladder's batching but NOT the
   * ceiling. A human asking for a review must not be able to silently exceed
   * the budget that protects the rate limit. The ceiling check lives in the
   * manager's `drainReviews({ force: true })` path so the CLI, console, and
   * pulse share one boundary.
   */
  async forceReview(argusId: string, manager: { drainReviews: (id: string, opts?: { force?: boolean }) => Promise<void> }): Promise<void> {
    this.record(argusId, 'human_force_review', 'forcing the review queue now');
    await manager.drainReviews(argusId, { force: true });
  }
}
