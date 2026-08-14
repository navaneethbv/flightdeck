import { normalizeProjectRoot } from '../core/paths.js';
import { now } from '../core/state.js';
import { SessionManager } from '../sessions/manager.js';
import type { Session } from '../core/types.js';

export interface WatchdogInspection {
  session: Session;
  isStuck: boolean;
  hasPrompt: boolean;
  lastActiveSecAgo: number;
  recentLogs: string;
}

export class WatchdogManager {
  private readonly projectRoot: string;
  private readonly sessions: SessionManager;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.sessions = new SessionManager(this.projectRoot);
  }

  listHung(timeoutSeconds = 300): Session[] {
    const list = this.sessions.list();
    const thresholdMs = timeoutSeconds * 1000;
    const currentTs = now();
    return list.filter((s) => s.status === 'running' && currentTs - s.lastActivityAt > thresholdMs);
  }

  inspect(id: string, timeoutSeconds = 300): WatchdogInspection {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`session "${id}" not found`);

    const currentTs = now();
    const lastActiveSecAgo = Math.floor((currentTs - session.lastActivityAt) / 1000);
    const isStuck = session.status === 'running' && lastActiveSecAgo > timeoutSeconds;

    const recentLogs = this.sessions.getLogs(id, 25);
    const hasPrompt =
      /\[y\/N\]|\(y\/n\)|allow\?|permit\?|question:|please confirm/i.test(recentLogs);

    return {
      session,
      isStuck,
      hasPrompt,
      lastActiveSecAgo,
      recentLogs,
    };
  }

  async killHung(timeoutSeconds = 300): Promise<{ killed: string[] }> {
    const hung = this.listHung(timeoutSeconds);
    const killed: string[] = [];
    for (const s of hung) {
      await this.sessions.stopSession(s.id);
      killed.push(s.id);
    }
    return { killed };
  }
}
