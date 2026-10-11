import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybookEngine, type EngineServices } from '../../src/playbooks/engine.js';
import { parsePlaybookYaml } from '../../src/playbooks/parser.js';
import { NotesStore } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';

afterEach(() => vi.unstubAllGlobals());

describe('playbook caller approval policy', () => {
  it.each([
    { kind: 'http', fields: 'method: POST\n    url: https://example.invalid/\n    body: private' },
    { kind: 'llm', fields: 'prompt: private' },
  ])('does not execute a denied $kind operation', async ({ kind, fields }) => {
    const fixture = makeRepo();
    const http = vi.fn();
    vi.stubGlobal('fetch', http);
    const services: EngineServices = {
      projectRoot: fixture.root,
      tables: new TablesStore(fixture.root),
      notes: new NotesStore(fixture.root),
      messaging: new MessagingStore(fixture.root),
      callMcpTool: vi.fn(),
      runHeadlessPrompt: vi.fn(),
      readPlaybook: () => null,
      confirm: async () => false,
      approveExternal: vi.fn(async () => false),
    };
    try {
      const result = await new PlaybookEngine(services).run(parsePlaybookYaml(`name: denied\nsteps:\n  - id: external\n    type: ${kind}\n    ${fields}\n`));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not approved');
      expect(services.approveExternal).toHaveBeenCalledOnce();
      expect(services.runHeadlessPrompt).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });
});
