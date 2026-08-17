import { execFileSync } from 'node:child_process';

const SERVICE = 'flightdeck';

function envName(name: string): string {
  return `FLIGHTDECK_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function keychainSet(account: string, value: string): void {
  execFileSync('security', [
    'add-generic-password',
    '-a',
    account,
    '-s',
    SERVICE,
    '-w',
    value,
    '-U',
  ]);
}

function keychainGet(account: string): string | null {
  try {
    const out = execFileSync('security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      SERVICE,
      '-w',
    ]);
    return out.toString().trim();
  } catch {
    return null;
  }
}

function keychainDelete(account: string): void {
  try {
    execFileSync('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
  } catch {
    // already absent
  }
}

function isMac(): boolean {
  return process.platform === 'darwin';
}

export function setSecret(name: string, value: string): void {
  if (isMac()) {
    keychainSet(`secret:${name}`, value);
  } else {
    throw new Error('secret storage requires macOS Keychain; set an env var instead');
  }
}

export function getSecret(name: string): string | null {
  const fromEnv = process.env[envName(name)];
  if (fromEnv !== undefined) return fromEnv;
  if (isMac()) return keychainGet(`secret:${name}`);
  return null;
}

export function deleteSecret(name: string): void {
  if (isMac()) keychainDelete(`secret:${name}`);
}

export function resolveSecret(name: string): string {
  const value = getSecret(name);
  if (value === null) {
    throw new Error(`secret "${name}" is not set`);
  }
  return value;
}

export function secretNames(): string[] {
  if (!isMac()) return [];
  try {
    const out = execFileSync('security', ['dump-keychain', '-s', SERVICE]).toString();
    const names: string[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/"acct"<blob>=(?:0x[0-9a-fA-F]+\s+)?"?([^"\r\n]+)"?/);
      if (m) names.push(m[1].trim());
    }
    return names.filter((n) => n.startsWith('secret:')).map((n) => n.slice('secret:'.length));
  } catch {
    return [];
  }
}
