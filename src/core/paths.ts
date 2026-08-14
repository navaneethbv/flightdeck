import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const globalDir = process.env.FLIGHTDECK_HOME ?? path.join(os.homedir(), '.flightdeck');
export const globalConfigPath = path.join(globalDir, 'config.json');
export const globalLogsDir = path.join(globalDir, 'logs');
export const globalPlaybooksDir = path.join(globalDir, 'playbooks');

export function normalizeProjectRoot(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export function projectFlightdeckDir(projectRoot: string): string {
  return path.join(projectRoot, '.flightdeck');
}

export function stateDbPath(projectRoot: string): string {
  return path.join(projectFlightdeckDir(projectRoot), 'state.db');
}

export function notesDir(projectRoot: string): string {
  return path.join(projectFlightdeckDir(projectRoot), 'notes');
}

export function worktreesDir(projectRoot: string): string {
  return path.join(projectFlightdeckDir(projectRoot), 'worktrees');
}

export function playbooksDir(projectRoot: string): string {
  return path.join(projectFlightdeckDir(projectRoot), 'playbooks');
}

export function hooksDir(projectRoot: string): string {
  return path.join(projectFlightdeckDir(projectRoot), 'hooks', 'post-create');
}

export function gitignorePath(projectRoot: string): string {
  return path.join(projectRoot, '.gitignore');
}

export function worktreePath(projectRoot: string, name: string): string {
  return path.join(worktreesDir(projectRoot), name);
}
