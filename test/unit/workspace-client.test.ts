import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';

class Element {
  children: Element[] = [];
  className = '';
  id = '';
  value = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  events: Record<string, (event?: any) => any> = {};
  private text = '';
  constructor(readonly tagName = 'div') {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...children: Element[]): void { this.children.push(...children); }
  replaceChildren(...children: Element[]): void { this.text = ''; this.children = children; }
  addEventListener(event: string, callback: (event?: any) => any): void { this.events[event] = callback; }
  setAttribute(key: string, value: string): void { this.attrs[key] = value; }
  focus(): void {}
  contains(element: Element): boolean { return this === element || this.all().includes(element); }
  classList = {
    add: (name: string) => { this.classList.toggle(name, true); },
    remove: (name: string) => { this.classList.toggle(name, false); },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, force?: boolean) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      const add = force ?? !classes.has(name);
      if (add) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
      return add;
    },
  };
  all(): Element[] { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector: string): Element[] {
    return this.all().filter((child) => selector.split(',').some((part) => part.trim().startsWith('#') ? child.id === part.trim().slice(1) : child.tagName === part.trim()));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}

const original = { id: 'mission', title: 'Mission', body: 'Original body', version: 1 };

function fixture() {
  const root = new Element();
  const missionRoot = new Element();
  const request = vi.fn(async (_url: string, _options?: any): Promise<any> => ({ ...original }));
  const refresh = vi.fn();
  const confirm = vi.fn(() => false);
  const events: Record<string, (event: any) => void> = {};
  const document = {
    activeElement: null as Element | null,
    createElement(tag: string) {
      const element = new Element(tag);
      element.focus = () => { document.activeElement = element; };
      return element;
    },
  };
  const sandbox: any = {
    document,
    window: { confirm, addEventListener: (name: string, callback: any) => { events[name] = callback; } },
  };
  vm.runInNewContext(fs.readFileSync('src/web/public/workspace.js', 'utf8'), sandbox);
  const workspace = sandbox.createWorkspace({ root, missionRoot, request, refresh, onLogs: vi.fn(), onPlaybook: vi.fn() });
  workspace.update({ notes: [original], tables: [], worktrees: [], sessions: [], playbooks: [] });
  const button = (name: string) => {
    const found = root.all().find((element) => element.tagName === 'button' && element.textContent === name);
    if (!found) throw new Error(`Button not found: ${name}`);
    return found;
  };
  const edit = (id: string, text: string) => {
    const field = root.querySelector(`#${id}`)!;
    field.value = text;
    field.events.input();
  };
  const open = async () => { workspace.navigate('notes'); await button('MissionVersion 1').events.click(); };
  return { root, workspace, request, refresh, confirm, events, button, edit, open, document };
}

describe('workspace browser controller', () => {
  it('preserves dirty drafts, caret-bearing elements, and selection during remote updates', async () => {
    const f = fixture();
    await f.open();
    const field = f.root.querySelector('#workspace-note-body');
    f.edit('workspace-note-body', 'My unsaved draft');
    f.workspace.update({ notes: [{ ...original, body: 'Remote edit', version: 2 }] });
    expect(f.root.querySelector('#workspace-note-body')).toBe(field);
    expect(field!.value).toBe('My unsaved draft');
    expect(f.root.textContent).toContain('changed elsewhere');
    expect(f.workspace.navigate('tables')).toBe(false);
    expect(f.workspace.section).toBe('notes');
    const event = { preventDefault: vi.fn(), returnValue: undefined };
    f.events.beforeunload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    f.confirm.mockReturnValue(true);
    expect(f.workspace.navigate('tables')).toBe(true);
  });

  it('keeps the focused resource keyboard-accessible after a poll', () => {
    const f = fixture();
    f.workspace.navigate('notes');
    f.button('MissionVersion 1').focus();
    f.workspace.update({ notes: [{ ...original, version: 2 }] });
    expect(f.document.activeElement).toBe(f.button('MissionVersion 2'));
    expect(f.document.activeElement!.dataset.resource).toBe(original.id);
  });

  it('saves an expected snapshot and keeps a conflicting draft editable', async () => {
    const f = fixture();
    await f.open();
    f.edit('workspace-note-body', 'My edit');
    f.request.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    await f.button('Save note').events.click();
    const [url, options] = f.request.mock.calls.at(-1)!;
    expect(url).toBe('/api/workspace/notes/mission');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ title: original.title, body: 'My edit', expected: { version: 1, title: original.title, body: original.body } });
    expect(f.root.querySelector('#workspace-note-body')!.value).toBe('My edit');
    expect(f.root.querySelector('#workspace-note-body')!.disabled).toBe(false);
    expect(f.root.textContent).toContain('Your draft is preserved');
    expect(f.refresh).not.toHaveBeenCalled();
  });

  it('creates a note and clears the unsaved state only after a successful save', async () => {
    const f = fixture();
    f.workspace.navigate('notes');
    f.button('New note').events.click();
    f.edit('workspace-note-title', 'New title');
    f.edit('workspace-note-body', '<script>alert(1)</script>');
    f.request.mockResolvedValueOnce({ id: 'new-title', title: 'New title', body: '<script>alert(1)</script>', version: 1 });
    await f.button('Save note').events.click();
    expect(f.request.mock.calls[0][0]).toBe('/api/workspace/notes');
    expect(f.request.mock.calls[0][1].method).toBe('POST');
    expect(f.root.querySelectorAll('script')).toHaveLength(0);
    expect(f.button('Save note').disabled).toBe(true);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.workspace.navigate('tables')).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('does not replace a saved note with an older polling snapshot', async () => {
    const f = fixture();
    await f.open();
    f.edit('workspace-note-body', 'Saved new body');
    f.request.mockResolvedValueOnce({ ...original, body: 'Saved new body', version: 2 });
    await f.button('Save note').events.click();
    f.workspace.update({ notes: [original] });
    expect(f.root.querySelector('#workspace-note-body')!.value).toBe('Saved new body');
    expect(f.root.textContent).toContain('Saved · Version 2');
  });

  it('ignores an old note response after navigating to another section', async () => {
    const f = fixture();
    let resolve!: (value: any) => void;
    f.request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    f.workspace.navigate('notes');
    const pending = f.button('MissionVersion 1').events.click();
    f.workspace.navigate('tables');
    resolve(original);
    await pending;
    expect(f.workspace.section).toBe('tables');
    expect(f.root.querySelector('#workspace-note-body')).toBeNull();
  });

  it('browses table pages and renders hostile cell text without creating elements', async () => {
    const f = fixture();
    const table = { name: 'tasks', columns: [{ name: 'title', type: 'text' }] };
    f.workspace.update({ tables: [table] });
    f.workspace.navigate('tables');
    f.request.mockResolvedValueOnce({ table, rows: [{ rowid: 1, title: '<img src=x onerror=alert(1)>' }], offset: 0, hasMore: true });
    await f.button('tasks1 columns').events.click();
    expect(f.root.querySelectorAll('img')).toHaveLength(0);
    expect(f.root.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(f.button('Previous').disabled).toBe(true);
    f.request.mockResolvedValueOnce({ table, rows: [], offset: 50, hasMore: false });
    await f.button('Next').events.click();
    // Page actions start an async request; flush its resolved continuation.
    await Promise.resolve();
    expect(f.request.mock.calls.at(-1)![0]).toContain('offset=50&limit=50');
    expect(f.button('Next').disabled).toBe(true);
    expect(f.button('Previous').disabled).toBe(false);
  });
});
