import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../../src/server/index.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

// Names, accounts and paths traced from the reference screenshot. The
// screenshot is a layout reference, never a data fixture.
const GHOSTS = [
  'Lloyd',
  'Randy Marsh',
  'caffeine-604',
  'Bendar',
  'Morty',
  'slidefade',
  'nturemedias',
  'Internal Tickets',
  'SwiftTerm',
  'TiltRun',
];

// Single seam into the fleet panel. Child B owns that panel (model, spend and
// progress rendering); if the client function is renamed, this constant is the
// only line in the test that needs to change.
const FLEET_RENDER_FN = 'renderFleet';
// DOM id of the container the client fills with one card per session. Counting
// its queryable .session-card children is the rendered-output assertion; nothing
// else is coupled to the card markup.
const FLEET_CONTAINER_ID = 'sessions-container';
const SESSION_CARD_SELECTOR = '.session-card';

interface ShimNode {
  tagName: string;
  attributes: Record<string, string>;
  children: ShimNode[];
  className: string;
  dataset: Record<string, string>;
  textContent: string;
  innerHTML: string;
  hidden: boolean;
  value: string;
  classList: {
    values: Set<string>;
    add(...classes: string[]): void;
    remove(...classes: string[]): void;
    contains(className: string): boolean;
    toggle(className: string, force?: boolean): boolean;
  };
  addEventListener(): void;
  appendChild(child: ShimNode): ShimNode;
  setAttribute(key: string, value: string): void;
  querySelectorAll(selector: string): ShimNode[];
}

function makeShimNode(tag = 'div'): ShimNode {
  return {
    tagName: tag,
    attributes: {},
    children: [],
    className: '',
    dataset: {},
    textContent: '',
    innerHTML: '',
    hidden: false,
    value: '',
    classList: {
      values: new Set<string>(),
      add(...classes) {
        for (const c of classes) this.values.add(c);
      },
      remove(...classes) {
        for (const c of classes) this.values.delete(c);
      },
      contains(className) {
        return this.values.has(className);
      },
      toggle(className, force) {
        if (force === undefined) {
          if (this.values.has(className)) this.values.delete(className);
          else this.values.add(className);
        } else if (force) {
          this.values.add(className);
        } else {
          this.values.delete(className);
        }
        return this.values.has(className);
      },
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(key, value) {
      if (key.startsWith('data-')) this.dataset[key.slice('data-'.length)] = String(value);
      else this.attributes[key] = String(value);
    },
    querySelectorAll(selector) {
      const { tag, className } = parseSelector(selector);
      const out: ShimNode[] = [];
      for (const child of this.children) {
        if (matches(child, tag, className)) out.push(child);
        out.push(...child.querySelectorAll(selector));
      }
      return out;
    },
  };
}

function parseSelector(selector: string): { tag?: string; className?: string } {
  const dot = selector.indexOf('.');
  if (dot === -1) return { tag: selector || undefined };
  return {
    tag: dot === 0 ? undefined : selector.slice(0, dot),
    className: selector.slice(dot + 1),
  };
}

function matches(node: ShimNode, tag?: string, className?: string): boolean {
  if (tag && node.tagName !== tag) return false;
  if (className) {
    const inClassList = node.classList.contains(className);
    const inClassName = node.className.split(/\s+/).includes(className);
    if (!inClassList && !inClassName) return false;
  }
  return true;
}

const ATTR_RE = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function applyAttrs(node: ShimNode, part: string): void {
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(part)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (key === 'class') {
      node.className = value;
      node.classList.values = new Set(value.split(/\s+/).filter(Boolean));
    } else if (key.startsWith('data-')) {
      node.dataset[key.slice('data-'.length)] = value;
    } else {
      node.attributes[key] = value;
    }
  }
}

const OPEN_TAG_RE = /^<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*(\/?)>$/;

/**
 * Index of the close tag matching the open tag that begins at `start`, or -1.
 * Nested elements of the same tag are accounted for, so a `<div>` whose body
 * contains further `<div>`s closes at the correct `</div>`.
 */
function findMatchingClose(html: string, start: number, tag: string): number {
  const openRe = new RegExp(`<${tag}[\\s/>]`, 'i');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'i');
  let depth = 1;
  let pos = start;
  while (pos < html.length) {
    const slice = html.slice(pos);
    const open = openRe.exec(slice);
    const close = closeRe.exec(slice);
    if (open && close) {
      if (open.index < close.index) {
        depth += 1;
        pos += open.index + open[0].length;
      } else {
        depth -= 1;
        pos += close.index + close[0].length;
        if (depth === 0) return pos - close[0].length;
      }
    } else if (open) {
      depth += 1;
      pos += open.index + open[0].length;
    } else if (close) {
      depth -= 1;
      pos += close.index + close[0].length;
      if (depth === 0) return pos - close[0].length;
    } else {
      break;
    }
  }
  return -1;
}

/** Parses a fragment of well-formed top-level elements into child nodes. */
function parseFragment(html: string): ShimNode[] {
  const nodes: ShimNode[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt);
    if (gt === -1) break;
    const raw = html.slice(lt, gt + 1);
    if (raw.startsWith('</')) {
      i = gt + 1;
      continue;
    }
    const open = OPEN_TAG_RE.exec(raw);
    if (!open) {
      i = gt + 1;
      continue;
    }
    const [, rawTag, attrsPart, selfClose] = open;
    const tag = rawTag.toLowerCase();
    const node = makeShimNode(tag);
    applyAttrs(node, attrsPart);
    if (selfClose === '/') {
      nodes.push(node);
      i = gt + 1;
      continue;
    }
    const close = findMatchingClose(html, gt + 1, rawTag);
    if (close === -1) {
      nodes.push(node);
      break;
    }
    node.innerHTML = html.slice(gt + 1, close);
    nodes.push(node);
    i = close + rawTag.length + 3;
  }
  return nodes;
}

function serializeNode(node: ShimNode): string {
  const attrs: string[] = [];
  if (node.className) attrs.push(`class="${node.className}"`);
  for (const [key, value] of Object.entries(node.dataset)) attrs.push(`data-${key}="${value}"`);
  for (const [key, value] of Object.entries(node.attributes)) attrs.push(`${key}="${value}"`);
  const open = `<${node.tagName}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`;
  return `${open}${node.innerHTML ?? ''}</${node.tagName}>`;
}

/**
 * A container whose innerHTML reads and writes its queryable children, like a
 * real DOM element. Assigning innerHTML clears and repopulates children, so a
 * card injected via `container.innerHTML += ...` is genuinely rendered and
 * counted, exactly the regression the integrity assertion must catch.
 */
function makeContainerNode(): ShimNode {
  const container = makeShimNode();
  Object.defineProperty(container, 'innerHTML', {
    configurable: true,
    get() {
      return container.children.map(serializeNode).join('');
    },
    set(value: string) {
      container.children.length = 0;
      container.children.push(...parseFragment(value));
    },
  });
  return container;
}

interface FleetClient {
  setState(s: unknown): void;
  render(): void;
  container: ShimNode;
  countCards(): number;
}

/**
 * Loads the real served client into a vm sandbox with the DOM shim and exposes
 * its fleet renderer. The renderer and container are reached only through
 * FLEET_RENDER_FN and FLEET_CONTAINER_ID, so a rename in the client is a
 * one-line fix here. This is the exact code path revision 1 abused to pad the
 * fleet with invented sessions, so executing it is how we lock the rule in.
 */
function loadFleetClient(appJs: string): FleetClient {
  const container = makeContainerNode();
  const documentShim = {
    getElementById: (id: string) => (id === FLEET_CONTAINER_ID ? container : null),
    createElement: (tag: string) => makeShimNode(tag),
    addEventListener: () => {},
  };

  const expose = `
    ;globalThis.__flightdeckTest = {
      setState: (s) => { state = s; },
      ${FLEET_RENDER_FN},
    };
  `;
  const sandbox: Record<string, unknown> = {
    document: documentShim,
    EventSource: function EventSource() {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appJs + expose, sandbox);
  const api = sandbox.__flightdeckTest as { setState(s: unknown): void };
  const render = (api as unknown as Record<string, unknown>)[FLEET_RENDER_FN] as () => void;
  return {
    setState: api.setState,
    render,
    container,
    countCards: () => container.querySelectorAll(SESSION_CARD_SELECTOR).length,
  };
}

/** The client asset as served (dist build first, source fallback). */
function readAppJs(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(here, '..', '..', 'dist', 'web', 'public', 'app.js');
  const srcPath = path.resolve(here, '..', '..', 'src', 'web', 'public', 'app.js');
  return fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : fs.readFileSync(srcPath, 'utf8');
}

describe('Dashboard data integrity (E2E)', () => {
  it('serves a fixture project and renders exactly its real sessions', async () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('claude');
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    const server = createWebServer({ port: 0, projectRoot: fixture.root });

    try {
      // A real fleet with real children and recorded progress, so the
      // dashboard has genuine entities to render.
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('e2e mission', '- implement the login endpoint\n- write the tests');
      const manager = new ArgusManager(fixture.root);
      const argus = manager.start({ name: 'e2e-dashboard', missionNoteId: mission.id, childLimit: 2, pulseSec: 1 });
      await manager.pulse(argus.id);
      const fleet = manager.fleet(argus.id);
      expect(fleet.children.length).toBeGreaterThanOrEqual(1);
      expect(fleet.recentProgress.length).toBeGreaterThan(0);

      // The real session count, read from state, not from the dashboard.
      const realSessions = new SessionManager(fixture.root).list();
      expect(realSessions.length).toBeGreaterThan(0);

      const port = await server.start();

      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`, {
        headers: { 'X-Flightdeck-Token': server.capabilityToken },
      });
      expect(stateRes.ok).toBe(true);
      const state = (await stateRes.json()) as {
        sessions: { id: string }[];
        argus: unknown[];
        notes: unknown[];
      };

      // The payload carries exactly the real entities, nothing invented.
      expect(state.sessions).toHaveLength(realSessions.length);
      const realIds = new Set(realSessions.map((s) => s.id));
      for (const s of state.sessions) expect(realIds.has(s.id)).toBe(true);
      expect(state.argus).toHaveLength(1);
      expect(state.notes).toContainEqual(expect.objectContaining({ id: mission.id }));

      // No screenshot-derived names anywhere in the served assets.
      const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      const appJs = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
      const css = await (await fetch(`http://127.0.0.1:${port}/styles.css`)).text();
      for (const ghost of GHOSTS) {
        expect(html).not.toContain(ghost);
        expect(appJs).not.toContain(ghost);
        expect(css).not.toContain(ghost);
      }

      // The rendered session list length equals the real session count.
      const client = loadFleetClient(appJs);
      client.setState(state);
      client.render();
      const renderedCards = client.countCards();
      expect(renderedCards).toBe(state.sessions.length);
      expect(renderedCards).toBe(realSessions.length);
    } finally {
      await server.stop();
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });

  it('counts a fabricated card, so the integrity assertion can fail', async () => {
    const now = Date.now();
    const state = {
      sessions: [
        { id: 'real-1', name: 'real-1', harness: 'claude', status: 'running', worktree: null, lastActivityAt: now },
        { id: 'real-2', name: 'real-2', harness: 'codex', status: 'stopped', worktree: 'wt', lastActivityAt: now },
      ],
      watchdog: { hungSessions: [] },
    };

    const client = loadFleetClient(readAppJs());
    client.setState(state);
    client.render();
    expect(client.countCards()).toBe(state.sessions.length);

    // A regressed client could append a fabricated card through innerHTML,
    // which a real browser renders. The count the integrity assertion relies
    // on must see it, or the E2E would pass vacuously.
    client.container.innerHTML += `<div class="session-card" data-id="fabricated"></div>`;
    expect(client.countCards()).toBe(state.sessions.length + 1);
    expect(() => expect(client.countCards()).toBe(state.sessions.length)).toThrow();
  });
});
