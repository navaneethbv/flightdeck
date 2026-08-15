import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb, now } from '../core/state.js';
import type { DatabaseSync } from 'node:sqlite';

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
    const target = this.buildTarget(host);
    const sshArgs: string[] = [];
    if (host.auth === 'key') {
      if (!host.keyFile) throw new Error(`host "${host.name}" has no key file configured`);
      if (!fs.existsSync(host.keyFile)) throw new Error(`key file not found: ${host.keyFile}`);
      sshArgs.push('-i', host.keyFile);
    }
    if (host.auth === 'password') {
      try {
        execFileSync('which', ['sshpass']);
      } catch {
        throw new Error('password auth requires sshpass on PATH');
      }
      const passArgs = ['-e', 'ssh', ...sshArgs, ...target.split(' '), command];
      const out = await new Promise<{ stdout: string; exitCode: number }>((resolve) => {
        const child = spawn('sshpass', passArgs, {
          env: { ...process.env, SSHPASS: process.env.FLIGHTDECK_SSH_PASSWORD ?? '' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', () => undefined);
        child.on('exit', (code) => resolve({ stdout, exitCode: code ?? -1 }));
      });
      return out;
    }
    return new Promise((resolve) => {
      const child = spawn('ssh', [...sshArgs, ...target.split(' '), command], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stdout += d));
      child.on('exit', (code) => resolve({ stdout, exitCode: code ?? -1 }));
    });
  }
}

export function sshVersion(): string {
  try {
    return execFileSync('ssh', ['-V'], { stdio: 'pipe' }).toString();
  } catch {
    return 'not found';
  }
}
