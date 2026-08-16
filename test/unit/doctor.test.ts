import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function runDoctor(env?: NodeJS.ProcessEnv): { checks: DoctorCheck[]; ok: boolean } {
  const result = runCli(['doctor', '--json'], { cwd: process.cwd(), env });
  return JSON.parse(result.stdout) as { checks: DoctorCheck[]; ok: boolean };
}

describe('deck doctor', () => {
  it('reports an installed harness as authenticated only when its credential file exists', () => {
    const fake = makeFakeHarness('claude');
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-doctor-profile-'));
    const oldPath = process.env.PATH;
    try {
      writeConfig({ profileDir: { claude: profileDir } });
      process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;

      const withoutCred = runDoctor();
      expect(withoutCred.checks.find((c) => c.name === 'harness:claude')).toMatchObject({
        ok: true,
        detail: 'claude detected',
      });
      expect(withoutCred.checks.find((c) => c.name === 'auth:claude')).toMatchObject({
        ok: false,
        detail: 'not authenticated',
      });

      fs.writeFileSync(path.join(profileDir, '.credentials.json'), '{}');
      const withCred = runDoctor();
      expect(withCred.checks.find((c) => c.name === 'auth:claude')).toMatchObject({
        ok: true,
        detail: 'authenticated',
      });
    } finally {
      process.env.PATH = oldPath;
      clearConfig();
      fs.rmSync(profileDir, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  it('omits the auth check for a harness that is not installed', () => {
    const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'flightdeck-doctor-empty-'));
    try {
      const { checks } = runDoctor({ PATH: emptyBin });
      expect(checks.some((c) => c.name === 'auth:claude')).toBe(false);
      expect(checks.find((c) => c.name === 'harness:claude')).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});
