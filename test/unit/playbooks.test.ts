import { describe, it, expect } from 'vitest';
import { parsePlaybookYaml } from '../../src/playbooks/parser.js';
import { PlaybookEngine, MAX_PLAYBOOK_DEPTH } from '../../src/playbooks/engine.js';
import { NotesStore } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { playbooksDir } from '../../src/core/paths.js';

function buildEngine(root: string) {
  const services = {
    projectRoot: root,
    tables: new TablesStore(root),
    notes: new NotesStore(root),
    messaging: new MessagingStore(root),
    callMcpTool: async () => ({ called: true }),
    runHeadlessPrompt: async (prompt: string) => ({ stdout: `llm(${prompt})`, exitCode: 0 }),
    readPlaybook: () => null as never,
    confirm: async () => true,
  };
  return new PlaybookEngine(services);
}

describe('playbook parser', () => {
  it('parses a valid playbook', () => {
    const playbook = parsePlaybookYaml(`
name: demo
inputs:
  - name: who
    required: true
steps:
  - id: greet
    type: bash
    command: "echo hello"
  - id: check
    type: condition
    if: "{{ steps.greet.exitCode }} == 0"
    then:
      - id: ok
        type: bash
        command: "echo ok"
    else:
      - id: no
        type: bash
        command: "echo no"
`);
    expect(playbook.name).toBe('demo');
    expect(playbook.steps).toHaveLength(2);
  });

  it('rejects unknown step types and duplicate ids', () => {
    expect(() =>
      parsePlaybookYaml('name: x\nsteps:\n  - id: a\n    type: nope\n')
    ).toThrow(/unknown type/);
    expect(() =>
      parsePlaybookYaml('name: x\nsteps:\n  - id: a\n    type: bash\n    command: "echo"\n  - id: a\n    type: bash\n    command: "echo"\n')
    ).toThrow(/duplicate step id/);
  });
});

describe('playbook engine', () => {
  it('runs bash, condition, parallel, and wait steps', async () => {
    const fixture = makeRepo();
    try {
      const engine = buildEngine(fixture.root);
      const playbook = parsePlaybookYaml(`
name: flow
steps:
  - id: a
    type: bash
    command: "echo 123"
  - id: cond
    type: condition
    if: "{{ steps.a.stdout }} == 123"
    then:
      - id: b
        type: bash
        command: "echo matched"
  - id: fan
    type: parallel
    branches:
      - - id: p1
          type: bash
          command: "echo p1"
      - - id: p2
          type: bash
          command: "echo p2"
  - id: pause
    type: wait
    seconds: 0
`);
      const result = await engine.run(playbook);
      expect(result.ok).toBe(true);
      expect(result.results.a.status).toBe('ok');
      expect(result.results.a.output.stdout.trim()).toBe('123');
      expect(result.results.b.status).toBe('ok');
      expect(result.results.p1.status).toBe('ok');
      expect(result.results.p2.status).toBe('ok');
    } finally {
      fixture.cleanup();
    }
  });

  it('templates step outputs and inputs', async () => {
    const fixture = makeRepo();
    try {
      const engine = buildEngine(fixture.root);
      const playbook = parsePlaybookYaml(`
name: tpl
inputs:
  - name: suffix
    required: true
steps:
  - id: first
    type: bash
    command: "echo value-{{ inputs.suffix }}"
  - id: second
    type: bash
    command: 'echo "saw {{ steps.first.output.stdout }}"'
  - id: third
    type: bash
    command: 'echo "status {{ steps.first.status }}"'
`);
      const result = await engine.run(playbook, { inputs: { suffix: 'xyz' } });
      expect(result.results.first.output.stdout.trim()).toBe('value-xyz');
      expect(result.results.second.output.stdout.trim()).toBe('saw value-xyz');
      expect(result.results.third.output.stdout.trim()).toBe('status ok');
    } finally {
      fixture.cleanup();
    }
  });

  it('fails on a failing bash step and aborts by default', async () => {
    const fixture = makeRepo();
    try {
      const engine = buildEngine(fixture.root);
      const playbook = parsePlaybookYaml(`
name: fail
steps:
  - id: boom
    type: bash
    command: "exit 3"
  - id: never
    type: bash
    command: "echo nope"
`);
      const result = await engine.run(playbook);
      expect(result.ok).toBe(false);
      expect(result.results.boom.status).toBe('failed');
      expect(result.results.never).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  it('honors on_error continue', async () => {
    const fixture = makeRepo();
    try {
      const engine = buildEngine(fixture.root);
      const playbook = parsePlaybookYaml(`
name: cont
on_error: continue
steps:
  - id: boom
    type: bash
    command: "exit 1"
  - id: after
    type: bash
    command: "echo done"
`);
      const result = await engine.run(playbook, { inputs: {} });
      expect(result.ok).toBe(false);
      expect(result.results.after.status).toBe('ok');
    } finally {
      fixture.cleanup();
    }
  });

  it('resolves nested playbooks up to the depth cap', async () => {
    const fixture = makeRepo();
    try {
      fs.mkdirSync(playbooksDir(fixture.root), { recursive: true });
      fs.writeFileSync(
        path.join(playbooksDir(fixture.root), 'inner.yml'),
        `name: inner\nsteps:\n  - id: inner1\n    type: bash\n    command: "echo inner"\n`
      );
      const engine = new PlaybookEngine({
        projectRoot: fixture.root,
        tables: new TablesStore(fixture.root),
        notes: new NotesStore(fixture.root),
        messaging: new MessagingStore(fixture.root),
        callMcpTool: async () => ({}),
        runHeadlessPrompt: async () => ({ stdout: '', exitCode: 0 }),
        readPlaybook: (name) => {
          const file = path.join(playbooksDir(fixture.root), `${name}.yml`);
          return fs.existsSync(file) ? parsePlaybookYaml(fs.readFileSync(file, 'utf8'), name) : null;
        },
        confirm: async () => true,
      });
      const outer = parsePlaybookYaml(`
name: outer
steps:
  - id: nest
    type: playbook
    name: inner
`);
      const result = await engine.run(outer);
      expect(result.ok).toBe(true);
      expect(result.results.nest.output.ok).toBe(true);
      expect(MAX_PLAYBOOK_DEPTH).toBe(10);
    } finally {
      fixture.cleanup();
    }
  });
});
