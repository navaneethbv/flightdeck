import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../../src/server/index.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, makeFakeHarness, spawnCli, sleep } from '../helpers.js';

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
  focus(): void;
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
    focus() {},
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

const OPEN_TAG_RE = /^<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>$/;

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

/** Poll until `predicate` holds, so un-awaited client fetches settle. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for client state');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface LoginHarness {
  overlay: ShimNode;
  tokenInput: ShimNode;
  errorEl: ShimNode;
  fetchCalls: { url: string; headers: Record<string, string>; status: number }[];
  storage: Map<string, string>;
  /** The sandbox's live location.href, so URL rewriting is observable. */
  windowHref(): string;
  getToken(): string;
  /** Functions the served client defines for the login gate. */
  api: {
    submitLogin(token?: string): Promise<void>;
    lockDashboard(): void;
    readCapabilityToken(): void;
    authedHeaders(extra?: Record<string, string>): Record<string, string>;
    eventsUrl(): string;
    /** Live dashboard streams: the poll loop (1) plus the SSE stream (1). */
    activeStreams(): number;
  };
}

/**
 * Loads the real served client into a vm sandbox with the login gate's DOM
 * (overlay, token input, error line), a writable sessionStorage and a fetch
 * shim that records every /api call. Executes the client's real boot path
 * (readCapabilityToken -> startDashboard or showLogin), exactly as a browser
 * would, so the login behavior under test is the shipped code.
 */
function loadLoginClient(
  appJs: string,
  opts: {
    href: string;
    storage?: Record<string, string>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  }
): LoginHarness {
  const overlay = makeShimNode('div');
  overlay.classList.add('login-overlay');
  overlay.classList.add('hidden');
  const tokenInput = makeShimNode('input');
  const errorEl = makeShimNode('p');
  errorEl.classList.add('login-error');
  errorEl.classList.add('hidden');
  const fixed: Record<string, ShimNode> = {
    'login-overlay': overlay,
    'login-token': tokenInput,
    'login-error': errorEl,
  };
  const elements = new Map<string, ShimNode>();
  const byId = (id: string): ShimNode => {
    let node = elements.get(id);
    if (!node) {
      node = fixed[id] ?? makeShimNode('div');
      elements.set(id, node);
    }
    return node;
  };

  const storage = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const fetchCalls: LoginHarness['fetchCalls'] = [];
  let currentHref = opts.href;
  let domContentLoaded: (() => void) | null = null;

  const sandbox: Record<string, unknown> = {
    window: {
      location: {
        get href() {
          return currentHref;
        },
        set href(value: string) {
          currentHref = String(value);
        },
      },
      history: {
        replaceState: (_state: unknown, _title: unknown, url: string) => {
          currentHref = url;
        },
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    document: {
      getElementById: (id: string) => byId(id),
      createElement: (tag: string) => makeShimNode(tag),
      body: { appendChild: () => {} },
      querySelectorAll: () => [],
      addEventListener: (type: string, cb: () => void) => {
        if (type === 'DOMContentLoaded') domContentLoaded = cb;
      },
    },
    fetch: async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const res = opts.fetchImpl
        ? await opts.fetchImpl(String(url), init)
        : new Response('{}', { status: 200 });
      fetchCalls.push({ url: String(url), headers, status: res.status });
      return res;
    },
    EventSource: function EventSource(_url: string) {
      this.onmessage = null;
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => {},
    clearTimeout: () => {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;

  const expose = `
    ;globalThis.__flightdeckTest = {
      submitLogin: (t) => submitLogin(t),
      lockDashboard,
      readCapabilityToken,
      authedHeaders,
      eventsUrl,
      getToken: () => capabilityToken,
      activeStreams: () => (pollTimer !== null ? 1 : 0) + (eventSource !== null ? 1 : 0),
    };
  `;
  vm.createContext(sandbox);
  vm.runInContext(appJs + expose, sandbox);
  const api = sandbox.__flightdeckTest as {
    submitLogin(token?: string): Promise<void>;
    lockDashboard(): void;
    readCapabilityToken(): void;
    authedHeaders(extra?: Record<string, string>): Record<string, string>;
    eventsUrl(): string;
    getToken(): string;
    activeStreams(): number;
  };
  const harness: LoginHarness = {
    overlay,
    tokenInput,
    errorEl,
    fetchCalls,
    storage,
    windowHref: () => currentHref,
    getToken: () => api.getToken(),
    api,
  };
  domContentLoaded?.();
  return harness;
}

describe('Dashboard data integrity (E2E)', () => {
  it('serves a fixture project and renders exactly its real sessions', async () => {
    const fixture = makeRepo();
    const fake = makeFakeHarness('claude');
    fs.writeFileSync(path.join(fake.binDir, 'opencode'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${oldPath ?? ''}`;
    const server = createWebServer({ port: 0, projectRoot: fixture.root });

    try {
      // A real fleet with real children and recorded progress, so the
      // dashboard has genuine entities to render.
      const notes = new NotesStore(fixture.root);
      const mission = notes.createNote('e2e mission', '- implement the login endpoint\n- write the tests');
      const brain = async (_r: string, _a: string, opts: { label: string }): Promise<string> =>
        opts.label === 'plan'
          ? '{"tasks":[{"title":"login","spec":"add login","depends_on":[]},{"title":"tests","spec":"test login","depends_on":[]}]}'
          : '{}';
      const manager = new ArgusManager(fixture.root, brain);
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

describe('Dashboard login gate (E2E)', () => {
  const STORAGE_KEY = 'flightdeck.capabilityToken';

  it('boots unlocked when the capability token rides the URL fragment', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/#token=SECRET-TOKEN',
    });

    // The token moved from the fragment into sessionStorage and the fragment
    // was stripped from the URL so it cannot linger in history or a bookmark.
    expect(client.getToken()).toBe('SECRET-TOKEN');
    expect(client.windowHref()).toBe('http://127.0.0.1:4173/');
    expect(client.windowHref()).not.toContain('token=');
    expect(client.storage.get(STORAGE_KEY)).toBe('SECRET-TOKEN');
    expect(client.api.eventsUrl()).toBe('/api/events?token=SECRET-TOKEN');

    // Unlocked means the login overlay never appeared and the first /api
    // request went out presenting the token in the header.
    expect(client.overlay.classList.contains('hidden')).toBe(true);
    expect(client.fetchCalls.length).toBeGreaterThan(0);
    expect(client.fetchCalls[0].url).toBe('/api/state');
    expect(client.fetchCalls[0].headers['X-Flightdeck-Token']).toBe('SECRET-TOKEN');
  });

  it('strips the capability token from the URL fragment after boot', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/#token=SECRET-TOKEN',
    });

    // The token must not linger in the URL where history, a referrer, or a
    // bookmark could leak it; sessionStorage is the only place it stays.
    expect(client.getToken()).toBe('SECRET-TOKEN');
    expect(client.windowHref()).toBe('http://127.0.0.1:4173/');
    expect(client.windowHref()).not.toContain('SECRET-TOKEN');
  });

  it('strips only the token param and preserves the rest of the fragment', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/#theme=dark&token=SECRET-TOKEN&tab=fleet',
    });

    expect(client.getToken()).toBe('SECRET-TOKEN');
    expect(client.windowHref()).toBe('http://127.0.0.1:4173/#theme=dark&tab=fleet');
  });

  it('boots unlocked from a stored token on refresh, with no token in the URL', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      storage: { [STORAGE_KEY]: 'PERSISTED-TOKEN' },
    });

    expect(client.getToken()).toBe('PERSISTED-TOKEN');
    expect(client.overlay.classList.contains('hidden')).toBe(true);
    expect(client.fetchCalls[0].url).toBe('/api/state');
    expect(client.fetchCalls[0].headers['X-Flightdeck-Token']).toBe('PERSISTED-TOKEN');
  });

  it('stays locked when the URL token is malformed percent-encoding', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/#token=%ZZ',
    });

    // decodeURIComponent throws on an invalid escape; the client must fall
    // back to the locked state rather than crash the boot path.
    expect(client.getToken()).toBe('');
    expect(client.overlay.classList.contains('hidden')).toBe(false);
    expect(client.fetchCalls).toHaveLength(0);
  });

  it('stays locked and makes no /api call when no token is present', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
    });

    expect(client.getToken()).toBe('');
    expect(client.overlay.classList.contains('hidden')).toBe(false);
    expect(client.fetchCalls).toHaveLength(0);
  });

  it('logs in with the right token and stores it for the next refresh', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    client.tokenInput.value = 'RIGHT-TOKEN';
    await client.api.submitLogin();
    await waitFor(() => client.fetchCalls.length >= 2);

    expect(client.getToken()).toBe('RIGHT-TOKEN');
    expect(client.storage.get(STORAGE_KEY)).toBe('RIGHT-TOKEN');
    expect(client.overlay.classList.contains('hidden')).toBe(true);

    // The validating call and the post-login state fetch both present it.
    expect(client.fetchCalls[0].headers['X-Flightdeck-Token']).toBe('RIGHT-TOKEN');
    expect(client.fetchCalls[1].headers['X-Flightdeck-Token']).toBe('RIGHT-TOKEN');
  });

  it('rejects a wrong token on the login screen and never unlocks', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () =>
        new Response('{"error":"missing or invalid capability token"}', { status: 401 }),
    });
    client.tokenInput.value = 'WRONG-TOKEN';
    await client.api.submitLogin();

    expect(client.getToken()).toBe('');
    expect(client.storage.has(STORAGE_KEY)).toBe(false);
    expect(client.overlay.classList.contains('hidden')).toBe(false);
    expect(client.errorEl.textContent).toContain('rejected');
    expect(client.errorEl.classList.contains('hidden')).toBe(false);
  });

  it('requires the token to be non-empty', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    client.tokenInput.value = '   ';
    await client.api.submitLogin();

    expect(client.fetchCalls).toHaveLength(0);
    expect(client.errorEl.textContent).toContain('printed by deck ui');
    expect(client.overlay.classList.contains('hidden')).toBe(false);
  });

  it('shows a login error when the control plane is unreachable', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    client.tokenInput.value = 'TOKEN';
    await client.api.submitLogin();

    // The server being down must not reject silently or leave a stored token
    // behind: the login screen stays up with an actionable error.
    expect(client.getToken()).toBe('');
    expect(client.storage.has(STORAGE_KEY)).toBe(false);
    expect(client.overlay.classList.contains('hidden')).toBe(false);
    expect(client.errorEl.textContent).toContain('Could not reach the control plane');
    expect(client.errorEl.classList.contains('hidden')).toBe(false);
  });

  it('stays locked and starts no streams when login validation fails with a server error', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () => new Response('{"error":"boom"}', { status: 500 }),
    });
    client.tokenInput.value = 'TOKEN';
    await client.api.submitLogin();

    // A 500 is still a rejection: no token is accepted, nothing is stored, and
    // the dashboard must not start its poll loop or SSE stream.
    expect(client.getToken()).toBe('');
    expect(client.storage.has(STORAGE_KEY)).toBe(false);
    expect(client.overlay.classList.contains('hidden')).toBe(false);
    expect(client.errorEl.textContent).toContain('rejected');
    expect(client.api.activeStreams()).toBe(0);
  });

  it('boots unlocked from a token stored in sessionStorage', async () => {
    const appJs = readAppJs();
    // No URL fragment: this is a refresh, not a fresh `deck ui` open. The token
    // that survived in sessionStorage must unlock the dashboard on its own.
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      storage: { [STORAGE_KEY]: 'STORED-TOKEN' },
    });

    expect(client.getToken()).toBe('STORED-TOKEN');
    expect(client.overlay.classList.contains('hidden')).toBe(true);
    expect(client.fetchCalls.length).toBeGreaterThan(0);
    expect(client.fetchCalls[0].url).toBe('/api/state');
    expect(client.fetchCalls[0].headers['X-Flightdeck-Token']).toBe('STORED-TOKEN');
  });

  it('lock clears the token and returns to the login screen', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/#token=SECRET-TOKEN',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });
    expect(client.getToken()).toBe('SECRET-TOKEN');

    client.api.lockDashboard();

    expect(client.getToken()).toBe('');
    expect(client.storage.has(STORAGE_KEY)).toBe(false);
    expect(client.overlay.classList.contains('hidden')).toBe(false);
  });

  it('authenticates against the real server with the token from the URL', async () => {
    const fixture = makeRepo();
    const server = createWebServer({ port: 0, projectRoot: fixture.root });
    const appJs = readAppJs();

    try {
      const port = await server.start();

      // The dashboard is handed the token exactly the way deck ui prints it.
      const loggedIn = loadLoginClient(appJs, {
        href: `http://127.0.0.1:${port}/#token=${server.capabilityToken}`,
        fetchImpl: async (url, init) =>
          fetch(`http://127.0.0.1:${port}${url}`, init),
      });
      expect(loggedIn.getToken()).toBe(server.capabilityToken);
      await waitFor(() => loggedIn.fetchCalls.length >= 1);
      expect(loggedIn.fetchCalls[0].status).toBe(200);

      // The same server, reached without a token, refuses the state fetch, so
      // the login gate is what the token actually gates.
      const locked = loadLoginClient(appJs, {
        href: `http://127.0.0.1:${port}/`,
        fetchImpl: async (url, init) => fetch(`http://127.0.0.1:${port}${url}`, init),
      });
      await locked.api.submitLogin('nope');
      expect(locked.fetchCalls[0].status).toBe(401);
      expect(locked.overlay.classList.contains('hidden')).toBe(false);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  });

  it('re-locks to the login screen when the stored token is rejected', async () => {
    const appJs = readAppJs();
    // A tab unlocked before the server restarted still holds the old capability
    // token in sessionStorage; the restart minted a fresh one, so the stored
    // token is stale. The client must return to the login screen, not sit
    // behind a permanent error banner.
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      storage: { [STORAGE_KEY]: 'STALE-TOKEN' },
      fetchImpl: async () =>
        new Response('{"error":"missing or invalid capability token"}', { status: 401 }),
    });
    expect(client.getToken()).toBe('STALE-TOKEN');

    // The first state fetch is rejected and the dashboard re-locks.
    await waitFor(() => !client.overlay.classList.contains('hidden'));
    expect(client.getToken()).toBe('');
    expect(client.storage.has(STORAGE_KEY)).toBe(false);
    expect(client.errorEl.textContent).toContain('no longer valid');
  });

  it('lock tears the dashboard down and a re-login restarts one stream pair', async () => {
    const appJs = readAppJs();
    const client = loadLoginClient(appJs, {
      href: 'http://127.0.0.1:4173/',
      fetchImpl: async () => new Response('{}', { status: 200 }),
    });

    await client.api.submitLogin('TOKEN');
    await waitFor(() => client.fetchCalls.length >= 2);
    // One unlocked dashboard runs exactly one poll loop and one SSE stream.
    expect(client.api.activeStreams()).toBe(2);

    // Locking stops the poll loop and closes the stream, not just the token.
    client.api.lockDashboard();
    expect(client.api.activeStreams()).toBe(0);

    // A fresh login restarts exactly one pair; a second login never stacks a
    // second interval or EventSource on top of a live one.
    await client.api.submitLogin('TOKEN');
    await waitFor(() => client.fetchCalls.length >= 4);
    expect(client.api.activeStreams()).toBe(2);
  });
});

describe('deck ui login entry (E2E)', () => {
  /** The CLI coerces `--port 0` to its default 4173, so probe a free port first. */
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
  }

  it('prints a URL whose capability token unlocks the real server', async () => {
    const fixture = makeRepo();
    const port = await freePort();
    const child = spawnCli(['ui', '--port', String(port), '--no-open', '--project', fixture.root], {
      cwd: fixture.root,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    try {
      // The printed URL carries the session-scoped capability token in the
      // fragment, exactly the string the user is told to open.
      let url = '';
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !url) {
        const m = /URL:\s+(http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+)/.exec(stdout);
        if (m) url = m[1];
        else await sleep(50);
      }
      expect(url, `deck ui stdout: ${stdout} stderr: ${stderr}`).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+$/
      );
      const token = url.slice(url.indexOf('#token=') + '#token='.length);
      // url.split('#')[0] ends in '/', so strip it before appending a path.
      const base = url.split('#')[0].replace(/\/+$/, '');

      // The page itself loads unauthenticated, but the API stays gated behind
      // the token that was just printed.
      expect((await fetch(`${base}/`)).status).toBe(200);
      expect((await fetch(`${base}/api/state`)).status).toBe(401);
      const ok = await fetch(`${base}/api/state`, {
        headers: { 'X-Flightdeck-Token': token },
      });
      expect(ok.status).toBe(200);

      child.kill('SIGTERM');
      const code = await new Promise<number | null>((resolve) => {
        if (child.exitCode !== null) resolve(child.exitCode);
        else child.on('close', (c) => resolve(c));
      });
      expect(code).toBe(0);
    } finally {
      // Never leak the spawned control plane. A failed assertion above must
      // not leave a `deck ui` process holding the port for a later run; the
      // graceful-SIGTERM path was already asserted, so a hard kill here is
      // cleanup only.
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      fixture.cleanup();
    }
  });
});
