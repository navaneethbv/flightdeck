import { normalizeProjectRoot } from '../core/paths.js';
import { FleetManager } from './manager.js';
import { ArgusManager } from '../argus/manager.js';
import { TaskBoard } from '../argus/board.js';
import { Override } from '../argus/override.js';
import { TablesStore } from '../tables/store.js';

export interface FleetActionResult {
  action:
    | 'claim'
    | 'release'
    | 'kill'
    | 'spawn'
    | 'accept'
    | 'reject'
    | 'unblock'
    | 'prioritize'
    | 'force-review';
  message: string;
  argusId?: string;
  sessionId?: string;
  taskId?: string | null;
  resumed?: boolean;
}

/**
 * The one shared action boundary for the Fleet console and the CLI. Every
 * console key calls exactly the same method its CLI equivalent calls, so
 * anything reachable from a dashboard is reachable from the command line and
 * the two can never drift.
 */
export class FleetActions {
  private readonly projectRoot: string;
  private readonly fleet: FleetManager;
  private readonly argus: ArgusManager;
  private readonly board: TaskBoard;
  private readonly override: Override;
  private readonly tables: TablesStore;

  constructor(
    projectRoot: string,
    deps?: {
      fleet?: FleetManager;
      argus?: ArgusManager;
      board?: TaskBoard;
      override?: Override;
    }
  ) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.fleet = deps?.fleet ?? new FleetManager(this.projectRoot);
    this.argus = deps?.argus ?? new ArgusManager(this.projectRoot);
    this.board = deps?.board ?? new TaskBoard(this.projectRoot);
    this.override = deps?.override ?? new Override(this.projectRoot);
    this.tables = new TablesStore(this.projectRoot);
  }

  private record(argusId: string | undefined, event: string, detail: string): void {
    if (!argusId) return;
    try {
      this.tables.insertRow('argus_progress', {
        argus_id: argusId,
        session_id: null,
        event,
        detail,
      });
    } catch {
      // best-effort audit row
    }
  }

  async claim(sessionId: string): Promise<FleetActionResult> {
    await this.fleet.claim(sessionId);
    return { action: 'claim', sessionId, message: `claimed ${sessionId}` };
  }

  async release(sessionId: string, resume = false): Promise<FleetActionResult> {
    await this.fleet.release(sessionId, { resume });
    return {
      action: 'release',
      sessionId,
      resumed: resume,
      message: resume ? `released ${sessionId} and resumed headless` : `released ${sessionId}`,
    };
  }

  /**
   * Stops the worker, blocks its active task, and preserves the worktree so a
   * human can inspect it before unblocking. A worker with no active task is
   * stopped without touching the board.
   */
  async kill(sessionId: string): Promise<FleetActionResult> {
    const sessions = this.fleet.fleetSessions().find((s) => s.id === sessionId);
    if (!sessions) throw new Error(`session "${sessionId}" not found`);
    const activeTask = this.board.listByAssignee(sessionId).find(
      (t) => t.status === 'assigned' || t.status === 'revising' || t.status === 'reported'
    );
    const argusId = activeTask?.argusId;
    await this.fleet.stopWorker(sessionId);
    if (activeTask) {
      this.board.block(
        activeTask.id,
        'worker killed by human; inspect the preserved worktree before unblocking'
      );
      this.record(argusId, 'human_kill', activeTask.id);
      return {
        action: 'kill',
        sessionId,
        taskId: activeTask.id,
        argusId,
        message: `killed ${sessionId} and blocked ${activeTask.id}; worktree preserved`,
      };
    }
    this.record(argusId, 'human_kill', sessionId);
    return { action: 'kill', sessionId, taskId: null, message: `killed ${sessionId}` };
  }

  async spawnNext(argusId: string): Promise<FleetActionResult> {
    const { task, session } = await this.argus.spawnNextWorker(argusId);
    return {
      action: 'spawn',
      argusId,
      taskId: task.id,
      sessionId: session.id,
      message: `spawned ${session.name} for ${task.title}`,
    };
  }

  accept(taskId: string, argusId: string): FleetActionResult {
    this.override.acceptTask(taskId, argusId);
    return { action: 'accept', taskId, argusId, message: `accepted ${taskId}` };
  }

  reject(taskId: string, reason: string, argusId: string): FleetActionResult {
    this.override.rejectTask(taskId, reason, argusId);
    return { action: 'reject', taskId, argusId, message: `rejected ${taskId}` };
  }

  unblock(taskId: string, argusId: string): FleetActionResult {
    this.override.unblockTask(taskId, argusId);
    return { action: 'unblock', taskId, argusId, message: `unblocked ${taskId}` };
  }

  prioritize(taskId: string, argusId: string): FleetActionResult {
    this.override.prioritizeTask(taskId, argusId);
    return { action: 'prioritize', taskId, argusId, message: `prioritized ${taskId}` };
  }

  async forceReview(argusId: string): Promise<FleetActionResult> {
    await this.override.forceReview(argusId, this.argus);
    return { action: 'force-review', argusId, message: 'review queue drained' };
  }
}
