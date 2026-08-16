import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../../src/sessions/harness.js';
import { makeFakeHarness, runCli } from '../helpers.js';

const CONFIG_PATH = path.join(process.env.FLIGHTDECK_HOME ?? '', 'config.json');

function writeConfig(partial: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(partial));
}

function clearConfig(): void {
  try {
    fs.rmSync(CONFIG_PATH);
  } catch {
    // no config written yet
  }
}

function fakeBinary(name: string, body: string): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), `flightdeck-bin-${name}-`));
  fs.writeFileSync(path.join(binDir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return binDir;
}

describe('deck login', () => {
  it('declares the interactive login subcommand for every harness', () => {
    expect(adapters.claude.loginArgs()).toEqual(['login']);
    expect(adapters.codex.loginArgs()).toEqual(['login']);
    expect(adapters.opencode.loginArgs()).toEqual(['auth', 'login']);
    expect(adapters.gemini.loginArgs()).toEqual(['login']);
  });

  it('resolves credential-file candidates from env overrides', () => {
    expect(adapters.claude.authFiles({ CLAUDE_CONFIG_DIR: '/cfg/claude' })).toEqual([
      '/cfg/claude/.credentials.json',
    ]);
    expect(adapters.codex.authFiles({ CODEX_HOME: '/cfg/codex' })).toEqual(['/cfg/codex/auth.json']);
    expect(adapters.opencode.authFiles({ XDG_DATA_HOME: '/cfg/xdg' })).toEqual([
      '/cfg/xdg/opencode/auth.json',
    ]);
    expect(adapters.gemini.authFiles({ GEMINI_HOME: '/cfg/gemini' })).toEqual(['/cfg/gemini/auth.json']);
  });

  it('runs the harness login flow and reports success', () => {
    const fake = makeFakeHarness('claude');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
      const result = runCli(['login', 'claude', '--json'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        results: { kind: string; installed: boolean; action: string; ok: boolean; exitCode: number | null }[];
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.results).toEqual([
        { kind: 'claude', installed: true, action: 'login', ok: true, exitCode: 0 },
      ]);
    } finally {
      process.env.PATH = oldPath;
      fake.cleanup();
    }
  });

  it('reports a harness whose login flow failed and exits non-zero', () => {
    const binDir = fakeBinary('codex', 'exit 3');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${oldPath ?? ''}`;
      const result = runCli(['login', 'codex', '--json'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.results[0]).toMatchObject({ kind: 'codex', installed: true, ok: false, exitCode: 3 });
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown harness', () => {
    const result = runCli(['login', 'bogus'], { cwd: process.cwd() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown harness "bogus"');
  });

  it('check reports authenticated only when a credential file exists', () => {
    const fake = makeFakeHarness('claude');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-login-profile-'));
    const credentialFile = path.join(profileDir, '.credentials.json');
    const oldPath = process.env.PATH;
    try {
      writeConfig({ profileDir: { claude: profileDir } });
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;

      const withoutCred = runCli(['login', 'claude', '--check', '--json'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(withoutCred.code).toBe(1);
      expect(JSON.parse(withoutCred.stdout).results[0]).toMatchObject({
        kind: 'claude',
        installed: true,
        action: 'check',
        authenticated: false,
        ok: false,
      });

      fs.writeFileSync(credentialFile, '{}');
      const withCred = runCli(['login', 'claude', '--check', '--json'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(withCred.code).toBe(0);
      expect(JSON.parse(withCred.stdout).results[0]).toMatchObject({
        kind: 'claude',
        installed: true,
        action: 'check',
        authenticated: true,
        ok: true,
      });
    } finally {
      process.env.PATH = oldPath;
      clearConfig();
      fs.rmSync(profileDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  it('check reports a missing harness as not authenticated and exits non-zero', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-none-'));
    try {
      const result = runCli(['login', 'claude', '--check', '--json'], {
        cwd: process.cwd(),
        env: { PATH: emptyBin },
      });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.results).toEqual([
        { kind: 'claude', installed: false, action: 'check', ok: false, exitCode: null, authenticated: false },
      ]);
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('prints a readable result in interactive mode', () => {
    const fake = makeFakeHarness('gemini');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
      const result = runCli(['login', 'gemini'], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('gemini');
      expect(result.stdout).toContain('login ok');
    } finally {
      process.env.PATH = oldPath;
      fake.cleanup();
    }
  });

  it('reports when no harness is installed without failing', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-empty-'));
    try {
      const result = runCli(['login', '--json'], { cwd: process.cwd(), env: { PATH: emptyBin } });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.results).toEqual([]);
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('reports an explicitly named harness that is not installed', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-missing-'));
    try {
      const result = runCli(['login', 'opencode', '--json'], { cwd: process.cwd(), env: { PATH: emptyBin } });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.results).toEqual([
        { kind: 'opencode', installed: false, action: 'login', ok: false, exitCode: null },
      ]);
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('--check reports a named but uninstalled harness as not authenticated', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-check-missing-'));
    try {
      const result = runCli(['login', 'gemini', '--check', '--json'], {
        cwd: process.cwd(),
        env: { PATH: emptyBin },
      });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.results[0]).toMatchObject({
        kind: 'gemini',
        installed: false,
        action: 'check',
        authenticated: false,
        ok: false,
      });
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('targets every installed harness by default', () => {
    const fakes = ['claude', 'codex', 'opencode', 'gemini'].map((name) => makeFakeHarness(name));
    const oldPath = process.env.PATH;
    try {
      const pathWithFakes = [...fakes.map((f) => f.binDir), oldPath ?? ''].join(':');
      process.env.PATH = pathWithFakes;
      const result = runCli(['login', '--json'], { cwd: process.cwd(), env: { PATH: pathWithFakes } });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.results).toEqual([
        { kind: 'claude', installed: true, action: 'login', ok: true, exitCode: 0 },
        { kind: 'codex', installed: true, action: 'login', ok: true, exitCode: 0 },
        { kind: 'opencode', installed: true, action: 'login', ok: true, exitCode: 0 },
        { kind: 'gemini', installed: true, action: 'login', ok: true, exitCode: 0 },
      ]);
    } finally {
      process.env.PATH = oldPath;
      fakes.forEach((f) => f.cleanup());
    }
  });

  it('aggregates mixed results across named harnesses and exits non-zero', () => {
    const fake = makeFakeHarness('claude');
    const binDir = fakeBinary('codex', 'exit 3');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${fake.binDir}:${binDir}:${oldPath ?? ''}`;
      const result = runCli(['login', 'claude', 'codex', '--json'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; results: unknown[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.results).toEqual([
        { kind: 'claude', installed: true, action: 'login', ok: true, exitCode: 0 },
        { kind: 'codex', installed: true, action: 'login', ok: false, exitCode: 3 },
      ]);
    } finally {
      process.env.PATH = oldPath;
      fake.cleanup();
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('prints a readable FAIL line when the login flow fails interactively', () => {
    const binDir = fakeBinary('opencode', 'exit 7');
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${binDir}:${oldPath ?? ''}`;
      const result = runCli(['login', 'opencode'], { cwd: process.cwd(), env: { PATH: process.env.PATH } });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain('opencode');
      expect(result.stdout).toContain('login failed');
      expect(result.stdout).toContain('(exit 7)');
    } finally {
      process.env.PATH = oldPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('prints a readable check result in interactive mode', () => {
    const fake = makeFakeHarness('claude');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-login-profile-'));
    const oldPath = process.env.PATH;
    try {
      writeConfig({ profileDir: { claude: profileDir } });
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;

      const withoutCred = runCli(['login', 'claude', '--check'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(withoutCred.code).toBe(1);
      expect(withoutCred.stdout).toContain('not authenticated');

      fs.writeFileSync(path.join(profileDir, '.credentials.json'), '{}');
      const withCred = runCli(['login', 'claude', '--check'], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
      });
      expect(withCred.code).toBe(0);
      expect(withCred.stdout).toContain('authenticated');
      expect(withCred.stdout).not.toContain('not authenticated');
    } finally {
      process.env.PATH = oldPath;
      clearConfig();
      fs.rmSync(profileDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  it('falls back to the home directory when no config or env pins a profile dir', () => {
    const HOME = '/flightdeck-test-home';
    expect(adapters.claude.authFiles({ HOME })).toEqual(['/flightdeck-test-home/.claude/.credentials.json']);
    expect(adapters.codex.authFiles({ HOME })).toEqual(['/flightdeck-test-home/.codex/auth.json']);
    expect(adapters.gemini.authFiles({ HOME })).toEqual(['/flightdeck-test-home/.gemini/auth.json']);
    expect(adapters.opencode.authFiles({ HOME })).toEqual(['/flightdeck-test-home/.local/share/opencode/auth.json']);
  });
});
