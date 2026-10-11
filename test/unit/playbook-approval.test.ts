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

  it.each([
    { kind: 'nested playbook', step: 'type: playbook\n    name: child' },
    { kind: 'condition', step: 'type: condition\n    if: "true"\n    then:\n      - id: child\n        type: playbook\n        name: child' },
    { kind: 'parallel', step: 'type: parallel\n    branches:\n      - - id: child\n          type: playbook\n          name: child' },
  ])('does not execute $kind steps after their parent has timed out', async ({ step }) => {
    const fixture = makeRepo();
    const notes = new NotesStore(fixture.root);
    const nested = parsePlaybookYaml('name: child\nsteps:\n  - id: pause\n    type: wait\n    seconds: 0.1\n  - id: write\n    type: note\n    operation: create\n    title: Late write\n    body: forbidden\n');
    const services: EngineServices = {
      projectRoot: fixture.root,
      tables: new TablesStore(fixture.root), notes, messaging: new MessagingStore(fixture.root),
      callMcpTool: vi.fn(), runHeadlessPrompt: vi.fn(), readPlaybook: () => nested, confirm: async () => false,
    };
    try {
      const parent = parsePlaybookYaml(`name: parent\nsteps:\n  - id: nested\n    ${step}\n    timeout: 0.02\n`);
      const result = await new PlaybookEngine(services).run(parent);
      expect(result.ok).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(notes.list()).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});
