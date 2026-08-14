import fs from 'node:fs';
import path from 'node:path';
import { globalLogsDir } from './paths.js';

let enabled = process.env.FLIGHTDECK_DEBUG === '1';
let activeFile: string | null = null;

function ensureFile(): string {
  if (activeFile) return activeFile;
  fs.mkdirSync(globalLogsDir, { recursive: true });
  const name = `flightdeck-${new Date().toISOString().slice(0, 10)}.log`;
  activeFile = path.join(globalLogsDir, name);
  return activeFile;
}

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ')}`;
  try {
    fs.appendFileSync(ensureFile(), line + '\n');
  } catch {
    // logging must never crash the app
  }
  if (enabled) {
    process.stderr.write(line + '\n');
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug(...args: unknown[]): void {
    write('debug', args);
  },
  info(...args: unknown[]): void {
    write('info', args);
  },
  warn(...args: unknown[]): void {
    write('warn', args);
  },
  error(...args: unknown[]): void {
    write('error', args);
  },
  setEnabled(v: boolean): void {
    enabled = v;
  },
};
