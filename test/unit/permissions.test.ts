import { describe, it, expect } from 'vitest';
import { ToolRegistry, type McpContext } from '../../src/mcp/tools.js';
import { makeRepo } from '../helpers.js';

function ctx(overrides: Partial<McpContext>): McpContext {
  return {
    projectRoot: '',
    sessionId: null,
    policy: 'default',
    isManager: false,
    riskyTools: false,
    confirm: async () => false,
    ...overrides,
  };
}

describe('ToolRegistry permission gating', () => {
  it('allows read and additive tools for any session', async () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(ctx({ projectRoot: fixture.root }));
      const result = await registry.call('note_create', { title: 't', body: 'b' });
      expect(result).toHaveProperty('id');
      expect(await registry.call('note_list', {})).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it('denies external tools to child sessions by default', async () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(ctx({ projectRoot: fixture.root, policy: 'child' }));
      await expect(registry.call('playbook_run', { name: 'x' })).rejects.toThrow(/denied for Argus children/);
      await expect(registry.call('ssh_run', { name: 'h', command: 'whoami' })).rejects.toThrow(/denied for Argus children/);
    } finally {
      fixture.cleanup();
    }
  });

  it('allows external tools for a manager with risky tools enabled', async () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(
        ctx({ projectRoot: fixture.root, policy: 'child', isManager: true, riskyTools: true })
      );
      // the permission gate passes, so the error is the handler's "not found", not a permission denial
      await expect(registry.call('playbook_run', { name: 'missing' })).rejects.toThrow(/not found/);
    } finally {
      fixture.cleanup();
    }
  });

  it('denies destructive tools to default agent sessions', async () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(ctx({ projectRoot: fixture.root }));
      await expect(registry.call('remove_worktree', { name: 'x' })).rejects.toThrow(/requires confirmation/);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects unknown tools', async () => {
    const fixture = makeRepo();
    try {
      const registry = new ToolRegistry(ctx({ projectRoot: fixture.root }));
      await expect(registry.call('nope', {})).rejects.toThrow(/unknown tool/);
    } finally {
      fixture.cleanup();
    }
  });
});
