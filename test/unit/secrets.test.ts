import { describe, it, expect, vi, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import {
  getSecret,
  setSecret,
  deleteSecret,
  resolveSecret,
  secretNames,
} from '../../src/secrets/keychain.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

describe('Secrets & Keychain Subsystem', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.restoreAllMocks();
  });

  it('reads secrets from FLIGHTDECK_SECRET_* env vars', () => {
    process.env.FLIGHTDECK_SECRET_API_KEY = 'env-value';
    try {
      expect(getSecret('api_key')).toBe('env-value');
      expect(getSecret('API_KEY')).toBe('env-value');
      expect(getSecret('missing')).toBeNull();
    } finally {
      delete process.env.FLIGHTDECK_SECRET_API_KEY;
    }
  });

  it('resolveSecret returns value or throws when missing', () => {
    process.env.FLIGHTDECK_SECRET_TOKEN = 'my-token';
    try {
      expect(resolveSecret('token')).toBe('my-token');
    } finally {
      delete process.env.FLIGHTDECK_SECRET_TOKEN;
    }
    expect(() => resolveSecret('definitely-not-set')).toThrow(/not set/);
  });

  it('throws on setSecret on non-mac platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => setSecret('my_key', 'val')).toThrow(/requires macOS Keychain/);
    expect(getSecret('my_key')).toBeNull();
    expect(secretNames()).toEqual([]);
  });

  it('calls security CLI for set, get, delete, and list on macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const execMock = vi.mocked(childProcess.execFileSync).mockImplementation((cmd, args) => {
      const a = args as string[];
      if (a[0] === 'add-generic-password') {
        return Buffer.from('');
      }
      if (a[0] === 'find-generic-password') {
        return Buffer.from('keychain-val\n');
      }
      if (a[0] === 'delete-generic-password') {
        return Buffer.from('');
      }
      if (a[0] === 'dump-keychain') {
        return Buffer.from('"acct"<blob>=0x00000008  secret:alpha\n"acct"<blob>=0x00000008  other:beta\n');
      }
      return Buffer.from('');
    });

    setSecret('my_key', 'val');
    expect(execMock).toHaveBeenCalledWith('security', expect.arrayContaining(['add-generic-password', '-a', 'secret:my_key', '-w', 'val']));

    expect(getSecret('my_key')).toBe('keychain-val');
    expect(execMock).toHaveBeenCalledWith('security', expect.arrayContaining(['find-generic-password', '-a', 'secret:my_key']));

    deleteSecret('my_key');
    expect(execMock).toHaveBeenCalledWith('security', expect.arrayContaining(['delete-generic-password', '-a', 'secret:my_key']));

    const names = secretNames();
    expect(names).toEqual(['alpha']);
  });

  it('handles security errors gracefully in get, delete, and list', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error('security error');
    });

    expect(getSecret('missing_key')).toBeNull();
    expect(() => deleteSecret('missing_key')).not.toThrow();
    expect(secretNames()).toEqual([]);
  });
});
