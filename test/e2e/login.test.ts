import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, makeRepo, makeFakeHarness } from '../helpers.js';

interface LoginResult {
  kind: string;
  installed: boolean;
  action: 'login' | 'check';
  ok: boolean;
  exitCode: number | null;
  authenticated?: boolean;
}

interface LoginReport {
  ok: boolean;
  results: LoginResult[];
}

/** A fake harness binary that records its invocation args to a marker file. */
function fakeWithMarker(name: string, marker: string): { binDir: string; cleanup(): void } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
  fs.writeFileSync(path.join(binDir, name), `#!/bin/bash\necho "$@" >> "${marker}"\nexit 0\n`, {
    mode: 0o755,
  });
  return { binDir, cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }) };
}

/**
 * Create an isolated `FLIGHTDECK_HOME` whose config points `profileDir.<harness>`
 * at a throwaway directory, so auth status depends only on files this test
 * creates and never on the host's real credential store or a shared config.
 */
function isolateHome(harness: string): { home: string; profile: string; cleanup(): void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-home-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-auth-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profileDir: { [harness]: profile } }));
  return {
    home,
    profile,
    cleanup: () => {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * A minimal PATH with the fake bin dir plus `/usr/bin` and `/bin`. Keeps
 * `which` resolvable while making detection deterministic: the only harness
 * reported installed is the fake one, regardless of what the host has.
 */
function hermeticPath(binDir: string): string {
  return `${binDir}:/usr/bin:/bin`;
}

describe('deck login', () => {
  it('reports every installed harness as not authenticated without running a login flow', () => {
    const fixture = makeRepo();
    const marker = path.join(os.tmpdir(), `flightdeck-login-marker-${Date.now()}`);
    const fake = fakeWithMarker('claude', marker);
    const isolated = isolateHome('claude');
    try {
      const result = runCli(['login', '--check', '--json'], {
        cwd: fixture.root,
        env: { FLIGHTDECK_HOME: isolated.home, PATH: hermeticPath(fake.binDir) },
      });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as LoginReport;
      expect(report.ok).toBe(false);
      expect(report.results).toHaveLength(1);
      expect(report.results[0]).toMatchObject({
        kind: 'claude',
        installed: true,
        action: 'check',
        authenticated: false,
        ok: false,
      });
      // `--check` must never invoke the harness binary.
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fake.cleanup();
      isolated.cleanup();
      fixture.cleanup();
      fs.rmSync(marker, { force: true });
    }
  });

  it('reports authenticated when a credential file exists', () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('claude');
    const isolated = isolateHome('claude');
    fs.writeFileSync(path.join(isolated.profile, '.credentials.json'), '{}');
    try {
      const result = runCli(['login', 'claude', '--check', '--json'], {
        cwd: fixture.root,
        env: { FLIGHTDECK_HOME: isolated.home, PATH: hermeticPath(fake.binDir) },
      });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as LoginReport;
      expect(report.ok).toBe(true);
      expect(report.results[0]).toMatchObject({
        kind: 'claude',
        installed: true,
        action: 'check',
        authenticated: true,
        ok: true,
      });
    } finally {
      fake.cleanup();
      isolated.cleanup();
      fixture.cleanup();
    }
  });

  it('runs the harness login flow and captures JSON output', () => {
    const fixture = makeRepo();
    const marker = path.join(os.tmpdir(), `flightdeck-login-marker-${Date.now()}-run`);
    const fake = fakeWithMarker('claude', marker);
    try {
      const result = runCli(['login', 'claude', '--json'], {
        cwd: fixture.root,
        env: { PATH: hermeticPath(fake.binDir) },
      });
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout) as LoginReport;
      expect(report.ok).toBe(true);
      expect(report.results[0]).toMatchObject({
        kind: 'claude',
        installed: true,
        action: 'login',
        ok: true,
        exitCode: 0,
      });
      // The fake binary was invoked with the harness's login subcommand.
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('login');
    } finally {
      fake.cleanup();
      fixture.cleanup();
      fs.rmSync(marker, { force: true });
    }
  });

  it('reports failure and exits non-zero when the login flow fails', () => {
    const fixture = makeRepo();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-'));
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/bash\nexit 3\n', { mode: 0o755 });
    try {
      const result = runCli(['login', 'claude', '--json'], {
        cwd: fixture.root,
        env: { PATH: hermeticPath(binDir) },
      });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as LoginReport;
      expect(report.results[0]).toMatchObject({
        kind: 'claude',
        action: 'login',
        ok: false,
        exitCode: 3,
      });
    } finally {
      fs.rmSync(binDir, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('treats an empty set of detected harnesses as a clean no-op', () => {
    const fixture = makeRepo();
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-bin-empty-'));
    try {
      const result = runCli(['login', '--check', '--json'], {
        cwd: fixture.root,
        env: { PATH: hermeticPath(emptyBin) },
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ ok: true, results: [] });
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
      fixture.cleanup();
    }
  });

  it('rejects an unknown harness name', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['login', 'nope'], { cwd: fixture.root });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/unknown harness "nope"/);
    } finally {
      fixture.cleanup();
    }
  });

  it('prints a human-readable summary in non-JSON mode', () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('opencode');
    try {
      const result = runCli(['login', 'opencode'], {
        cwd: fixture.root,
        env: { PATH: hermeticPath(fake.binDir) },
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/ok\s+opencode\s+login ok/);
    } finally {
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
