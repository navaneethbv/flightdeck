import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo, cliDistPath } from '../helpers.js';

const repos: string[] = [];

beforeAll(() => {
  if (!fs.existsSync(cliDistPath())) {
    execFileSync('npm', ['run', 'build'], { cwd: path.resolve(path.dirname(cliDistPath()), '..', '..'), stdio: 'inherit' });
  }
});

afterAll(() => {
  for (const root of repos) fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP server over stdio', () => {
  it('serves tools for a valid session token and enforces isolation on a wrong token', async () => {
    const fixture = makeRepo();
    repos.push(fixture.root);
    const manager = new SessionManager(fixture.root);
    const session = manager.createSession({ name: 'mcp-test', harness: 'claude', worktree: null, cwd: fixture.root });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cliDistPath(),
        'mcp',
        'serve',
        '--session',
        session.id,
        '--token',
        session.token,
        '--project',
        fixture.root,
      ],
      stderr: 'pipe',
      env: { ...process.env },
    });
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('note_create');
    expect(names).toContain('note_delete');
    expect(names).toContain('table_query');
    expect(names).toContain('table_list');
    expect(names).toContain('table_drop');
    expect(names).toContain('message_send');
    expect(names).toContain('message_poll');
    expect(names).toContain('playbook_run');
    expect(names).toContain('list_jira_issues');
    expect(names).toContain('list_github_prs');
    expect(names).toContain('list_slack_messages');
    expect(names).toContain('ssh_host_remove');

    const created = await client.callTool({ name: 'note_create', arguments: { title: 'FromMCP', body: 'body' } });
    const content = created.content;
    const text = Array.isArray(content) ? content[0]?.text ?? '' : '';
    expect(text).toContain('FromMCP');

    const createdTbl = await client.callTool({
      name: 'table_create',
      arguments: { name: 'items', columns: [{ name: 'val', type: 'text' }] },
    });
    const tblText = Array.isArray(createdTbl.content) ? createdTbl.content[0]?.text ?? '' : '';
    expect(tblText).toContain('items');

    const listed = await client.callTool({ name: 'table_list', arguments: {} });
    const listText = Array.isArray(listed.content) ? listed.content[0]?.text ?? '' : '';
    expect(listText).toContain('items');

    const dropped = await client.callTool({ name: 'table_drop', arguments: { name: 'items' } });
    const dropText = Array.isArray(dropped.content) ? dropped.content[0]?.text ?? '' : '';
    expect(dropText).toContain('requires confirmation');

    await client.close();

    const wrong = new StdioClientTransport({
      command: process.execPath,
      args: [
        cliDistPath(),
        'mcp',
        'serve',
        '--session',
        session.id,
        '--token',
        'wrong-token',
        '--project',
        fixture.root,
      ],
      stderr: 'pipe',
      env: { ...process.env },
    });
    const badClient = new Client({ name: 'bad-client', version: '0.0.1' });
    await expect(badClient.connect(wrong)).rejects.toThrow();
    await badClient.close().catch(() => undefined);
  });

  it('denies risky tools for a child session over MCP', async () => {
    const fixture = makeRepo();
    repos.push(fixture.root);
    const manager = new SessionManager(fixture.root);
    const child = manager.createSession({
      name: 'child',
      harness: 'claude',
      worktree: null,
      cwd: fixture.root,
      policy: 'child',
      argusParent: 'some-argus',
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        cliDistPath(),
        'mcp',
        'serve',
        '--session',
        child.id,
        '--token',
        child.token,
        '--project',
        fixture.root,
      ],
      stderr: 'pipe',
      env: { ...process.env },
    });
    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(transport);
    const result = await client.callTool({ name: 'playbook_run', arguments: { name: 'x' } });
    const text = Array.isArray(result.content) ? result.content[0]?.text ?? '' : '';
    expect(text).toMatch(/denied for Argus children/);
    await client.close();
  });
});
