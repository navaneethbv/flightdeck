import fs from 'node:fs';
import path from 'node:path';
import { normalizeProjectRoot } from '../core/paths.js';
import { SessionManager } from './manager.js';
import { MessagingStore } from '../messaging/store.js';
import { NotesStore } from '../notes/store.js';
import { worktreeStatus, worktreeDiff } from '../worktrees/manager.js';
import type { Session } from '../core/types.js';

export interface SessionBundle {
  version: '1.0';
  exportedAt: number;
  session: Session;
  logs: string;
  worktree: {
    name: string | null;
    status: ReturnType<typeof worktreeStatus> | null;
    diff: string | null;
  };
  messages: ReturnType<MessagingStore['list']>;
  notes: ReturnType<NotesStore['list']>;
}

export function exportSession(projectRoot: string, sessionId: string): SessionBundle {
  const root = normalizeProjectRoot(projectRoot);
  const sm = new SessionManager(root);
  const session = sm.get(sessionId);
  if (!session) throw new Error(`session "${sessionId}" not found`);

  const logs = sm.getLogs(sessionId, 500);

  let wtStatus = null;
  let wtDiff = null;
  if (session.worktree) {
    try {
      wtStatus = worktreeStatus(root, session.worktree);
      wtDiff = worktreeDiff(root, session.worktree).diff;
    } catch {
      // worktree might have been deleted
    }
  }

  const messaging = new MessagingStore(root);
  const allMessages = messaging.list({ limit: 100 });
  const sessionMessages = allMessages.filter(
    (m) => m.fromSession === sessionId || m.toSession === sessionId
  );

  const notesStore = new NotesStore(root);
  const allNotes = notesStore.list();
  const sessionNotes = allNotes.filter(
    (n) => n.createdAt >= session.startedAt && (!session.endedAt || n.createdAt <= session.endedAt + 60000)
  );

  return {
    version: '1.0',
    exportedAt: Date.now(),
    session,
    logs,
    worktree: {
      name: session.worktree,
      status: wtStatus,
      diff: wtDiff,
    },
    messages: sessionMessages,
    notes: sessionNotes,
  };
}

export function exportSessionToFile(
  projectRoot: string,
  sessionId: string,
  outPath?: string
): { path: string; bundle: SessionBundle } {
  const root = normalizeProjectRoot(projectRoot);
  const bundle = exportSession(root, sessionId);
  const targetPath =
    outPath ?? path.join(root, '.flightdeck', `session-${sessionId}-export.json`);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(bundle, null, 2), 'utf8');

  return { path: targetPath, bundle };
}
