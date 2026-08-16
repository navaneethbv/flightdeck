import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Fixture {
  root: string;
  cleanup(): void;
}

export function makeRepo(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Flightdeck Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function makeFakeHarness(binName: string): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  // Never echo "$@". The argv carries the brain prompt, and that prompt
  // contains a JSON format example. `extractJson` takes the last balanced
  // JSON object in the stream, so echoing argv returns a schema-valid plan
  // and the manager dispatches real workers for a task nobody asked for.
  const script = `#!/bin/bash\necho "flightdeck fake ${binName}" >&2\nexit 0\n`;
  fs.writeFileSync(path.join(binDir, binName), script, { mode: 0o755 });
  return {
    binDir,
    cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }),
  };
}

export function cliDistPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'dist', 'cli', 'index.js');
}

export function runCli(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const result = spawnSync(process.execPath, [cliDistPath(), ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status ?? -1 };
}

export function spawnCli(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): ReturnType<typeof spawn> {
  return spawn(process.execPath, [cliDistPath(), ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
