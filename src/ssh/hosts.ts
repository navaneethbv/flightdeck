import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, now } from '../core/state.js';
import type { DatabaseSync } from 'node:sqlite';
import { findExecutable, requireExecutable } from '../core/executables.js';

export interface SshHost {
  name: string;
  host: string;
  port: number | null;
  user: string | null;
  auth: 'agent' | 'key' | 'password';
  keyFile: string | null;
  createdAt: number;
}

function rowToHost(row: Record<string, unknown>): SshHost {
  return {
    name: String(row.name),
    host: String(row.host),
    port: row.port === null ? null : Number(row.port),
    user: typeof row.user === 'string' ? row.user : null,
    auth: row.auth as SshHost['auth'],
    keyFile: typeof row.key_file === 'string' ? row.key_file : null,
    createdAt: Number(row.created_at),
  };
}

export class SshStore {
  private readonly db: DatabaseSync;
  constructor(private readonly projectRoot: string) {
    this.db = getDb(projectRoot);
  }

  add(host: SshHost): SshHost {
    if (this.get(host.name)) throw new Error(`ssh host "${host.name}" already exists`);
    this.db
      .prepare('INSERT INTO ssh_hosts (name, host, port, user, auth, key_file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(host.name, host.host, host.port, host.user, host.auth, host.keyFile, now());
    return host;
  }

  get(name: string): SshHost | null {
    const row = this.db.prepare('SELECT * FROM ssh_hosts WHERE name = ?').get(name) as Record<string, unknown> | undefined;
    return row ? rowToHost(row) : null;
  }

  list(): SshHost[] {
    const rows = this.db.prepare('SELECT * FROM ssh_hosts ORDER BY name').all() as Record<string, unknown>[];
    return rows.map(rowToHost);
  }

  remove(name: string): void {
    this.db.prepare('DELETE FROM ssh_hosts WHERE name = ?').run(name);
  }

  buildTarget(host: SshHost): string {
    const at = host.user ? `${host.user}@${host.host}` : host.host;
    return host.port ? `-p ${host.port} ${at}` : at;
  }

  verifyConfig(): void {
    const configPath = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(configPath)) {
      throw new Error('~/.ssh/config not found; create it before adding hosts');
    }
  }

  async run(host: SshHost, command: string): Promise<{ stdout: string; exitCode: number }> {
    const sshArgs: string[] = [];
    if (host.auth === 'key') {
      if (!host.keyFile) throw new Error(`host "${host.name}" has no key file configured`);
      if (!fs.existsSync(host.keyFile)) throw new Error(`key file not found: ${host.keyFile}`);
      sshArgs.push('-i', host.keyFile);
    }
    if (host.port !== null) {
      if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error('Invalid SSH port');
      sshArgs.push('-p', String(host.port));
    }
    const target = host.user ? `${host.user}@${host.host}` : host.host;
    sshArgs.push('--', target, command);
    let binary = requireExecutable('ssh');
    let args = sshArgs;
    if (host.auth === 'password') {
      const sshpass = findExecutable('sshpass');
      if (!sshpass) throw new Error('password auth requires sshpass on PATH');
      args = ['-e', binary, ...sshArgs];
      binary = sshpass;
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        env: host.auth === 'password' ? { ...process.env, SSHPASS: process.env.FLIGHTDECK_SSH_PASSWORD ?? '' } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => { resolve({ stdout, exitCode: code ?? -1 }); });
    });
  }
}

export function sshVersion(): string {
  try {
    return execFileSync(requireExecutable('ssh'), ['-V'], { stdio: 'pipe' }).toString();
  } catch {
    return 'not found';
  }
}
