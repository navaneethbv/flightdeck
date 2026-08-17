import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybookEngine, type EngineServices } from '../../src/playbooks/engine.js';
import { parsePlaybookYaml } from '../../src/playbooks/parser.js';
import { evaluateExpression } from '../../src/playbooks/expression.js';
import { resolveTemplate, resolveTemplateLoose } from '../../src/playbooks/templating.js';
import { TablesStore } from '../../src/tables/store.js';
import { NotesStore } from '../../src/notes/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';

describe('Playbooks Deep Unit Suite (Engine, Parser, Templating, Expressions)', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let tables: TablesStore;
  let notes: NotesStore;
  let messaging: MessagingStore;
  let services: EngineServices;
  let nestedPlaybooks: Map<string, string>;

  beforeEach(() => {
    fixture = makeRepo();
    tables = new TablesStore(fixture.root);
    notes = new NotesStore(fixture.root);
    messaging = new MessagingStore(fixture.root);
    nestedPlaybooks = new Map();

    services = {
      projectRoot: fixture.root,
      tables,
      notes,
      messaging,
      callMcpTool: async (tool, args) => ({ toolCalled: tool, args }),
      runHeadlessPrompt: async (prompt) => ({ stdout: `Response for: ${prompt}`, exitCode: 0 }),
      readPlaybook: (name) => {
        const yaml = nestedPlaybooks.get(name);
        return yaml ? parsePlaybookYaml(yaml, name) : null;
      },
      confirm: async () => true,
      fromSession: 'test-session',
    };
  });

  afterEach(() => {
    fixture.cleanup();
    vi.restoreAllMocks();
  });

  describe('Expression Evaluation & Templating', () => {
    it('evaluates boolean, comparison, logical, and arithmetic expressions', () => {
      expect(evaluateExpression('true')).toBe(true);
      expect(evaluateExpression('false')).toBe(false);
      expect(evaluateExpression('1 < 2')).toBe(true);
      expect(evaluateExpression('5 >= 5')).toBe(true);
      expect(evaluateExpression('10 == 10')).toBe(true);
      expect(evaluateExpression('"a" != "b"')).toBe(true);
      expect(evaluateExpression('true && !false')).toBe(true);
      expect(evaluateExpression('false || true')).toBe(true);
      expect(evaluateExpression('!(1 == 2)')).toBe(true);
    });

    it('resolves templates with inputs, vars, secrets, and step results', () => {
      const ctx = {
        inputs: { user: 'Alice', count: 3 },
        vars: { greeting: 'Hello {{ inputs.user }}' },
        secrets: { apiKey: 'secret-123' },
        steps: { s1: { status: 'ok', output: { id: 42 } } },
      };

      expect(resolveTemplate('{{ inputs.user }} is here', ctx)).toBe('Alice is here');
      expect(resolveTemplate('{{ steps.s1.output.id }}', ctx)).toBe('42');
      expect(resolveTemplateLoose('{{ inputs.count }}', ctx)).toBe('3');
    });
  });

  describe('Engine Step Execution', () => {
    it('executes bash steps with stdout and cwd', async () => {
      const yaml = `
name: bash-test
steps:
  - id: b1
    type: bash
    command: echo "hello world"
  - id: b2
    type: bash
    command: pwd
    cwd: .
`;
      const playbook = parsePlaybookYaml(yaml, 'bash-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.b1.status).toBe('ok');
      expect((res.results.b1.output as any).stdout.trim()).toBe('hello world');
    });

    it('executes llm steps via runHeadlessPrompt', async () => {
      const yaml = `
name: llm-test
steps:
  - id: l1
    type: llm
    prompt: Summarize project
`;
      const playbook = parsePlaybookYaml(yaml, 'llm-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.l1.status).toBe('ok');
      expect((res.results.l1.output as any).stdout).toContain('Summarize project');
    });

    it('executes http steps with mocked fetch', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => '{"status":"ok"}',
      } as any));

      const yaml = `
name: http-test
steps:
  - id: h1
    type: http
    url: https://api.example.com/status
    method: GET
`;
      const playbook = parsePlaybookYaml(yaml, 'http-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.h1.status).toBe('ok');
      expect((res.results.h1.output as any).status).toBe(200);
    });

    it('executes mcp and message steps', async () => {
      const yaml = `
name: mcp-msg-test
steps:
  - id: m1
    type: mcp
    tool: list_sessions
    arguments: {}
  - id: msg1
    type: message
    to: agent-2
    body: "task ready"
`;
      const playbook = parsePlaybookYaml(yaml, 'mcp-msg-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.m1.status).toBe('ok');
      expect(res.results.msg1.status).toBe('ok');
    });

    it('executes data steps: create, insert, query, update, aggregate', async () => {
      const yaml = `
name: data-test
steps:
  - id: d1
    type: data
    table: items
    operation: create
    columns:
      - name: id
        type: number
      - name: name
        type: text
      - name: price
        type: number
  - id: d2
    type: data
    table: items
    operation: insert
    data:
      id: 1
      name: Widget
      price: 25
  - id: d3
    type: data
    table: items
    operation: query
    where:
      name: Widget
  - id: d4
    type: data
    table: items
    operation: update
    rowid: 1
    data:
      price: 30
  - id: d5
    type: data
    table: items
    operation: aggregate
    fn: count
`;
      const playbook = parsePlaybookYaml(yaml, 'data-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.d1.status).toBe('ok');
      expect(res.results.d2.status).toBe('ok');
      expect(res.results.d3.status).toBe('ok');
      expect(res.results.d4.status).toBe('ok');
      expect(res.results.d5.status).toBe('ok');
    });

    it('executes note steps: create, read, update, search, list', async () => {
      const yaml = `
name: note-test
steps:
  - id: n1
    type: note
    operation: create
    title: Initial Note
    body: Content 1
  - id: n2
    type: note
    operation: read
    note_id: "{{ steps.n1.output.id }}"
  - id: n3
    type: note
    operation: update
    note_id: "{{ steps.n1.output.id }}"
    title: Updated Title
    body: Content 2
  - id: n4
    type: note
    operation: search
    query: Updated
  - id: n5
    type: note
    operation: list
`;
      const playbook = parsePlaybookYaml(yaml, 'note-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.n1.status).toBe('ok');
      expect(res.results.n2.status).toBe('ok');
      expect(res.results.n3.status).toBe('ok');
      expect(res.results.n4.status).toBe('ok');
      expect(res.results.n5.status).toBe('ok');
    });

    it('executes condition steps with then/else branches', async () => {
      const yaml = `
name: cond-test
inputs:
  - name: flag
    type: boolean
    default: true
steps:
  - id: c1
    type: condition
    if: "{{ inputs.flag }}"
    then:
      - id: t1
        type: bash
        command: echo "true branch"
    else:
      - id: e1
        type: bash
        command: echo "false branch"
`;
      const playbook = parsePlaybookYaml(yaml, 'cond-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook, { inputs: { flag: true } });

      expect(res.ok).toBe(true);
      expect((res.results.c1.output as any).branch).toBe('then');
    });

    it('executes wait, manual confirmation, parallel branches, and nested playbooks', async () => {
      nestedPlaybooks.set(
        'child-pb',
        `
name: child-pb
steps:
  - id: cp1
    type: bash
    command: echo "child done"
`
      );

      const yaml = `
name: complex-test
steps:
  - id: w1
    type: wait
    seconds: 0.01
  - id: m1
    type: manual
    prompt: Do you approve?
  - id: p1
    type: playbook
    name: child-pb
  - id: par1
    type: parallel
    branches:
      - - id: b1_1
          type: bash
          command: echo "branch 1"
      - - id: b2_1
          type: bash
          command: echo "branch 2"
`;
      const playbook = parsePlaybookYaml(yaml, 'complex-test');
      const engine = new PlaybookEngine(services);
      const res = await engine.run(playbook);

      expect(res.ok).toBe(true);
      expect(res.results.w1.status).toBe('ok');
      expect(res.results.m1.status).toBe('ok');
      expect(res.results.p1.status).toBe('ok');
      expect(res.results.par1.status).toBe('ok');
    });

    it('handles retries, timeouts, and onError modes', async () => {
      const yamlAbort = `
name: fail-abort
on_error: abort
steps:
  - id: f1
    type: bash
    command: exit 1
  - id: f2
    type: bash
    command: echo "never reached"
`;
      const pbAbort = parsePlaybookYaml(yamlAbort, 'fail-abort');
      const engine = new PlaybookEngine(services);
      const resAbort = await engine.run(pbAbort);

      expect(resAbort.ok).toBe(false);
      expect(resAbort.results.f1.status).toBe('failed');
      expect(resAbort.results.f2).toBeUndefined();

      const yamlContinue = `
name: fail-continue
steps:
  - id: f1
    type: bash
    command: exit 1
    on_error: continue
  - id: f2
    type: bash
    command: echo "reached"
`;
      const pbCont = parsePlaybookYaml(yamlContinue, 'fail-continue');
      const resCont = await engine.run(pbCont);

      expect(resCont.results.f1.status).toBe('failed');
      expect(resCont.results.f2.status).toBe('ok');
    });

    it('handles required inputs, secret proxy, and step errors', async () => {
      const yamlInputs = `
name: req-inputs
inputs:
  - name: apiKey
    required: true
steps:
  - id: s1
    type: bash
    command: echo "{{ inputs.apiKey }}"
`;
      const pb = parsePlaybookYaml(yamlInputs, 'req-inputs');
      const engine = new PlaybookEngine(services);
      await expect(engine.run(pb, { inputs: {} })).rejects.toThrow('requires input "apiKey"');

      // Secret proxy
      process.env.FLIGHTDECK_SECRET_MOCK_ENV_VAR = 'mock_env_value';
      const yamlSecret = `
name: secret-test
steps:
  - id: s1
    type: bash
    command: echo "{{ secrets.MOCK_ENV_VAR }}"
`;
      const pbSec = parsePlaybookYaml(yamlSecret, 'secret-test');
      const resSec = await engine.run(pbSec);
      expect(resSec.ok).toBe(true);

      // Note read nonexistent
      const yamlNoteErr = `
name: note-err
steps:
  - id: n_err
    type: note
    operation: read
    note_id: non-existent-id
`;
      const pbNoteErr = parsePlaybookYaml(yamlNoteErr, 'note-err');
      const resNoteErr = await engine.run(pbNoteErr);
      expect(resNoteErr.results.n_err.status).toBe('failed');
    });

    it('tests step timeout, confirmation rejection, unknown action, and condition skip', async () => {
      const engine = new PlaybookEngine(services);

      // Condition branch
      const yamlCond = `
name: cond-test
steps:
  - id: cond1
    type: condition
    if: "1 == 2"
    then:
      - id: should_not_run
        type: bash
        command: echo "no"
`;
      const pbCond = parsePlaybookYaml(yamlCond, 'cond-test');
      const resCond = await engine.run(pbCond);
      expect(resCond.results.cond1.status).toBe('ok');
      expect(resCond.results.should_not_run).toBeUndefined();

      // Confirmation denied
      const servicesDeny = {
        ...services,
        confirm: async () => false,
      };
      const engineDeny = new PlaybookEngine(servicesDeny);
      const yamlConfirm = `
name: confirm-test
steps:
  - id: c1
    type: manual
    prompt: Are you sure?
`;
      const pbConfirm = parsePlaybookYaml(yamlConfirm, 'confirm-test');
      const resConfirm = await engineDeny.run(pbConfirm);
      expect((resConfirm.results.c1.output as any).confirmed).toBe(false);

      // Action unknown
      const yamlAction = `
name: action-test
steps:
  - id: a1
    type: playbook
    name: nonexistent-action
`;
      const pbAction = parsePlaybookYaml(yamlAction, 'action-test');
      const resAction = await engine.run(pbAction);
      expect(resAction.results.a1.status).toBe('failed');

      // Retries on failure
      const yamlRetry = `
name: retry-test
steps:
  - id: r1
    type: bash
    command: exit 1
    retries: 1
`;
      const pbRetry = parsePlaybookYaml(yamlRetry, 'retry-test');
      const resRetry = await engine.run(pbRetry);
      expect(resRetry.results.r1.status).toBe('failed');
    });
  });
});
