import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { PlaybookEngine, type EngineServices } from '../../src/playbooks/engine.js';
import { parsePlaybookYaml } from '../../src/playbooks/parser.js';
import { NotesStore } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';

describe('playbook HTTP destinations', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let services: EngineServices;

  beforeEach(() => {
    fixture = makeRepo();
    services = {
      projectRoot: fixture.root,
      tables: new TablesStore(fixture.root),
      notes: new NotesStore(fixture.root),
      messaging: new MessagingStore(fixture.root),
      callMcpTool: vi.fn(),
      runHeadlessPrompt: vi.fn(),
      readPlaybook: () => null,
      confirm: async () => false,
      approveExternal: vi.fn(async () => true),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fixture.cleanup();
  });

  function run(url: string, inputs: Record<string, unknown> = {}, origins?: string[]) {
    const playbook = parsePlaybookYaml(`name: http-test
inputs:
  - name: target
  - name: path
steps:
  - id: request
    type: http
    url: ${JSON.stringify(url)}
    ${origins ? `allowed_origins: ${JSON.stringify(origins)}` : ''}
`);
    return new PlaybookEngine(services).run(playbook, { inputs });
  }

  it('allows templated paths while preserving the origin declared on disk', async () => {
    const request = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', request);
    expect((await run('https://api.example.com/{{ inputs.path }}', { path: '/other.example/private' })).ok).toBe(true);
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe('https://api.example.com');
    expect(url.pathname).toBe('//other.example/private');
    expect(init.redirect).toBe('error');
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'https://api.example.com.attacker.invalid/',
    'https://api.example.com@attacker.invalid/',
    'https://api.example.com:8443/',
    'https://user:secret@api.example.com/',
    'file:///etc/passwd',
  ])('rejects an input outside the declared origin: %s', async (target) => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const result = await run('{{ inputs.target }}', { target }, ['https://api.example.com']);
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(services.approveExternal).not.toHaveBeenCalled();
  });

  it('requires an on-disk allowlist for a fully templated URL', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const result = await run('{{ inputs.target }}', { target: 'https://api.example.com/' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('allowed_origins');
    expect(request).not.toHaveBeenCalled();
  });

  it('allows an exact origin listed on disk', async () => {
    const request = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', request);
    const result = await run('{{ inputs.target }}', { target: 'https://api.example.com/v1?key=private' }, ['https://api.example.com']);
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    'https://{{ inputs.host }}',
    'file:///private',
    'https://user:password@api.example.com',
    'https://api.example.com/private',
    'https://api.example.com?key=value',
    'https://api.example.com#fragment',
  ])('rejects an invalid declared origin: %s', (origin) => {
    expect(() => run('{{ inputs.target }}', {}, [origin])).toThrow();
  });

  it('never follows a redirect, even after the initial destination is approved', async () => {
    const destinations: string[] = [];
    const server = createServer((req, res) => {
      destinations.push(req.url ?? '/');
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/private' });
      }
      res.end('sensitive');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      const result = await run(`http://127.0.0.1:${address.port}/start`);
      expect(result.ok).toBe(false);
      expect(destinations).toEqual(['/start']);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    }
  });
});
