import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { serveMcp } from '../../src/mcp/server.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  class MockStdioServerTransport {
    async start() {}
    async close() {}
  }
  return {
    StdioServerTransport: MockStdioServerTransport,
  };
});

describe('MCP Server Unit Suite', () => {
  let fixture: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    fixture = makeRepo();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  it('connects MCP server with tools for child, manager, and default sessions', async () => {
    const sm = new SessionManager(fixture.root);
    const argusMgr = new ArgusManager(fixture.root);
    const argus = argusMgr.start({ name: 'm1' });

    // Child session
    const childSess = sm.createSession({
      name: 'child-1',
      harness: 'opencode',
      cwd: fixture.root,
      policy: 'child',
      argusParent: argus.id,
    });

    await expect(
      serveMcp({
        projectRoot: fixture.root,
        sessionId: childSess.id,
        token: childSess.token,
      })
    ).resolves.toBeUndefined();

    // Manager session
    const mgrSess = sm.createSession({
      name: 'mgr-1',
      harness: 'claude',
      cwd: fixture.root,
      policy: 'manager',
    });
    getDb(fixture.root)
      .prepare('UPDATE argus SET manager_session_id = ?, cap = ? WHERE id = ?')
      .run(mgrSess.id, 'test-cap', argus.id);
    process.env.FLIGHTDECK_ARGUS_CAP = 'test-cap';

    await expect(
      serveMcp({
        projectRoot: fixture.root,
        sessionId: mgrSess.id,
        token: mgrSess.token,
      })
    ).resolves.toBeUndefined();

    delete process.env.FLIGHTDECK_ARGUS_CAP;
  });
});
