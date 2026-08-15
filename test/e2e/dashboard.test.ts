import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
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

interface ShimNode {
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
}

function makeShimNode(): ShimNode {
  return {
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
      this.dataset[key] = String(value);
    },
  };
}

/**
 * Runs the real served client's renderFleet against a given /api/state payload
 * with a minimal DOM shim, and reports how many session cards it produced.
 * This is the exact code path revision 1 abused to pad the fleet with invented
 * sessions, so executing it is how we lock the rule in.
 */
function runFleetRender(appJs: string, state: unknown): number {
  const container = makeShimNode();
  const documentShim = {
    getElementById: (id: string) => (id === 'sessions-container' ? container : null),
    createElement: () => makeShimNode(),
    addEventListener: () => {},
  };

  const expose = `
    ;globalThis.__flightdeckTest = {
      setState: (s) => { state = s; },
      renderFleet,
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
  const api = sandbox.__flightdeckTest as { setState(s: unknown): void; renderFleet(): void };
  api.setState(state);
  api.renderFleet();
  return container.children.length;
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

      const stateRes = await fetch(`http://127.0.0.1:${port}/api/state`);
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
      for (const ghost of GHOSTS) {
        expect(html).not.toContain(ghost);
        expect(appJs).not.toContain(ghost);
      }

      // The rendered session list length equals the real session count.
      const renderedCards = runFleetRender(appJs, state);
      expect(renderedCards).toBe(state.sessions.length);
      expect(renderedCards).toBe(realSessions.length);
    } finally {
      await server.stop();
      process.env.PATH = oldPath ?? '';
      fake.cleanup();
      fixture.cleanup();
    }
  });
});
