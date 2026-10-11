import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ToolRegistry } from '../../src/mcp/tools.js';
import { NotesStore } from '../../src/notes/store.js';
import { makeRepo } from '../helpers.js';

const content = 'name: safe\nsteps:\n  - id: note\n    type: note\n    operation: create\n    title: Sentinel\n    body: Private\n';

describe('named playbook storage', () => {
  let fixture: ReturnType<typeof makeRepo>;
  let registry: ToolRegistry;

  beforeEach(() => {
    fixture = makeRepo();
    registry = new ToolRegistry({ projectRoot: fixture.root, sessionId: null, policy: 'default', isManager: true, riskyTools: true, confirm: async () => true });
  });

  afterEach(() => { vi.restoreAllMocks(); fixture.cleanup(); });

  it('rejects a save that would write outside the playbook directory', async () => {
    await expect(registry.call('playbook_save', { name: '../outside', content })).rejects.toThrow('Invalid playbook name');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.existsSync(path.join(fixture.root, '.flightdeck', 'outside.yml'))).toBe(false); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  });

  it('does not follow a playbook symlink when reading or overwriting it', async () => {
    const outside = path.join(fixture.root, 'private.yml');
    const dir = path.join(fixture.root, '.flightdeck', 'playbooks');
    // Isolated temporary repository fixture; no external path input.
    fs.mkdirSync(dir, { recursive: true }); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    fs.writeFileSync(outside, content); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    fs.symlinkSync(outside, path.join(dir, 'linked.yml')); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    await expect(registry.call('playbook_run', { name: 'linked' })).rejects.toThrow();
    await expect(registry.call('playbook_save', { name: 'linked', content: content.replace('Private', 'Overwritten') })).rejects.toThrow();
    // Isolated temporary repository fixture; no external path input.
    expect(fs.readFileSync(outside, 'utf8')).toBe(content); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    expect(new NotesStore(fixture.root).list()).toHaveLength(0);
  });

  it('saves and reloads an ordinary named playbook', async () => {
    await registry.call('playbook_save', { name: 'safe', content });
    const result = await registry.call('playbook_run', { name: 'safe' });
    expect(result).toMatchObject({ ok: true });
    expect(new NotesStore(fixture.root).list().map((note) => note.title)).toEqual(['Sentinel']);
  });

  it('preserves the previous file if atomic replacement fails', async () => {
    await registry.call('playbook_save', { name: 'safe', content });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('replacement failed'); });
    await expect(registry.call('playbook_save', { name: 'safe', content: content.replace('Sentinel', 'Changed') })).rejects.toThrow('replacement failed');
    const dir = path.join(fixture.root, '.flightdeck', 'playbooks');
    // Isolated temporary repository fixture; no external path input.
    expect(fs.readFileSync(path.join(dir, 'safe.yml'), 'utf8')).toBe(content); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    expect(fs.readdirSync(dir)).toEqual(['safe.yml']); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  });

  it('preserves existing file permissions after replacement', async () => {
    await registry.call('playbook_save', { name: 'safe', content });
    const file = path.join(fixture.root, '.flightdeck', 'playbooks', 'safe.yml');
    // Isolated temporary repository fixture; no external path input.
    fs.chmodSync(file, 0o640); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    await registry.call('playbook_save', { name: 'safe', content: content.replace('Sentinel', 'Changed') });
    // Isolated temporary repository fixture; no external path input.
    expect(fs.statSync(file).mode & 0o777).toBe(0o640); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
    // Isolated temporary repository fixture; no external path input.
    expect(fs.readFileSync(file, 'utf8')).toContain('Changed'); // nosemgrep: javascript_pathtraversal_rule-non-literal-fs-filename
  });
});
