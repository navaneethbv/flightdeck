import fs from 'node:fs';
import path from 'node:path';
import { normalizeProjectRoot } from '../core/paths.js';
import { SessionManager } from './manager.js';

export interface FollowOptions {
  tailLines?: number;
  intervalMs?: number;
  onChunk: (chunk: string) => void;
  onExit?: (status: string) => void;
}

export function followSessionLogs(
  projectRoot: string,
  sessionId: string,
  opts: FollowOptions
): { stop: () => void } {
  const root = normalizeProjectRoot(projectRoot);
  const sm = new SessionManager(root);
  const logFile = path.join(root, '.flightdeck', 'logs', 'sessions', `${sessionId}.log`);

  let position = 0;
  let stopped = false;

  if (fs.existsSync(logFile)) {
    const stats = fs.statSync(logFile);
    if (opts.tailLines && opts.tailLines > 0) {
      const full = fs.readFileSync(logFile, 'utf8');
      const lines = full.split('\n');
      const tail = lines.slice(-opts.tailLines).join('\n');
      opts.onChunk(tail + (tail.endsWith('\n') ? '' : '\n'));
      position = stats.size;
    } else {
      const initial = fs.readFileSync(logFile, 'utf8');
      opts.onChunk(initial);
      position = stats.size;
    }
  }

  let wasRunning = sm.get(sessionId)?.status === 'running';

  const poll = (): void => {
    if (stopped) return;
    try {
      if (fs.existsSync(logFile)) {
        const stats = fs.statSync(logFile);
        if (stats.size > position) {
          const fd = fs.openSync(logFile, 'r');
          const buffer = Buffer.alloc(stats.size - position);
          fs.readSync(fd, buffer, 0, buffer.length, position);
          fs.closeSync(fd);
          position = stats.size;
          opts.onChunk(buffer.toString('utf8'));
        }
      }

      const session = sm.get(sessionId);
      if (session) {
        if (session.status === 'running') {
          wasRunning = true;
        } else if (wasRunning) {
          stopped = true;
          clearInterval(timer);
          opts.onExit?.(session.status);
          return;
        }
      }
    } catch {
      // transient read error during rotation or flush
    }
  };

  const timer = setInterval(poll, opts.intervalMs ?? 300);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
