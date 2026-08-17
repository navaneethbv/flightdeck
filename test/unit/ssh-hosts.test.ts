import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { SshStore, type SshHost } from '../../src/ssh/hosts.js';
import { makeRepo } from '../helpers.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    execFileSync: vi.fn(),
  };
});

describe('SshStore', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let store: SshStore;

  beforeEach(() => {
    fixture = makeRepo();
    store = new SshStore(fixture.root);
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('adds, gets, lists, and removes hosts', () => {
    const host: SshHost = {
      name: 'prod-1',
      host: '192.168.1.10',
      port: 2222,
      user: 'deploy',
      auth: 'agent',
      keyFile: null,
      createdAt: Date.now(),
    };
    expect(store.get('prod-1')).toBeNull();
    store.add(host);
    expect(store.get('prod-1')).toMatchObject({
      name: 'prod-1',
      host: '192.168.1.10',
      port: 2222,
      user: 'deploy',
      auth: 'agent',
      keyFile: null,
    });
    expect(store.list()).toHaveLength(1);

    expect(() => store.add(host)).toThrow(/already exists/);

    store.remove('prod-1');
    expect(store.get('prod-1')).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('builds target correctly with various user and port combinations', () => {
    expect(store.buildTarget({ name: 'h1', host: 'example.com', port: null, user: null, auth: 'agent', keyFile: null, createdAt: 0 })).toBe('example.com');
    expect(store.buildTarget({ name: 'h2', host: 'example.com', port: null, user: 'alice', auth: 'agent', keyFile: null, createdAt: 0 })).toBe('alice@example.com');
    expect(store.buildTarget({ name: 'h3', host: 'example.com', port: 2200, user: 'alice', auth: 'agent', keyFile: null, createdAt: 0 })).toBe('-p 2200 alice@example.com');
  });

  it('verifies ~/.ssh/config existence', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    existsSpy.mockReturnValueOnce(true);
    expect(() => store.verifyConfig()).not.toThrow();

    existsSpy.mockReturnValueOnce(false);
    expect(() => store.verifyConfig()).toThrow(/~[\/\\]\.ssh[\/\\]config not found/);
  });

  it('runs command with agent auth', async () => {
    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    const spawnMock = vi.mocked(childProcess.spawn).mockImplementation(() => {
      setTimeout(() => {
        fakeChild.stdout.emit('data', 'hello remote');
        fakeChild.emit('exit', 0);
      }, 5);
      return fakeChild;
    });

    const host: SshHost = {
      name: 'agent-host',
      host: 'remote.test',
      port: null,
      user: 'user',
      auth: 'agent',
      keyFile: null,
      createdAt: 0,
    };
    const res = await store.run(host, 'uptime');
    expect(res.stdout).toBe('hello remote');
    expect(res.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledWith('ssh', ['user@remote.test', 'uptime'], expect.anything());
  });

  it('handles key auth validation and run', async () => {
    const hostNoKey: SshHost = {
      name: 'key-host',
      host: 'remote.test',
      port: null,
      user: null,
      auth: 'key',
      keyFile: null,
      createdAt: 0,
    };
    await expect(store.run(hostNoKey, 'uptime')).rejects.toThrow(/no key file configured/);

    const hostBadKey: SshHost = {
      ...hostNoKey,
      keyFile: '/nonexistent/id_rsa',
    };
    await expect(store.run(hostBadKey, 'uptime')).rejects.toThrow(/key file not found/);

    const validKeyPath = path.join(fixture.root, 'id_rsa');
    fs.writeFileSync(validKeyPath, 'key-data');
    const hostValidKey: SshHost = {
      ...hostNoKey,
      keyFile: validKeyPath,
    };

    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      setTimeout(() => {
        fakeChild.stdout.emit('data', 'key ok');
        fakeChild.emit('exit', 0);
      }, 5);
      return fakeChild;
    });

    const res = await store.run(hostValidKey, 'ls');
    expect(res.stdout).toBe('key ok');
    expect(res.exitCode).toBe(0);
  });

  it('handles password auth validation and run', async () => {
    const hostPass: SshHost = {
      name: 'pass-host',
      host: 'remote.test',
      port: null,
      user: 'root',
      auth: 'password',
      keyFile: null,
      createdAt: 0,
    };

    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    await expect(store.run(hostPass, 'uptime')).rejects.toThrow(/password auth requires sshpass/);

    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from('/usr/bin/sshpass'));
    const fakeChild = new EventEmitter() as any;
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    vi.mocked(childProcess.spawn).mockImplementation(() => {
      setTimeout(() => {
        fakeChild.stdout.emit('data', 'pass ok');
        fakeChild.emit('exit', 0);
      }, 5);
      return fakeChild;
    });

    const res = await store.run(hostPass, 'whoami');
    expect(res.stdout).toBe('pass ok');
    expect(res.exitCode).toBe(0);
  });
});
