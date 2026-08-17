import { describe, it, expect } from 'vitest';
import { renderToString } from 'ink';
import React from 'react';
import { Dashboard, renderLogContent, getSessionStatusColor } from '../../src/cli/commands/tui.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { NotesStore } from '../../src/notes/store.js';
import { TablesStore } from '../../src/tables/store.js';
import { MessagingStore } from '../../src/messaging/store.js';
import { makeRepo } from '../helpers.js';

describe('TUI Dashboard Component', () => {
  it('renders empty dashboard cleanly', () => {
    const fixture = makeRepo();
    try {
      const output = renderToString(<Dashboard projectRoot={fixture.root} />);
      expect(output).toContain('flightdeck');
      expect(output).toContain('Sessions');
    } finally {
      fixture.cleanup();
    }
  });

  it('renders sessions and tabs in dashboard', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      sm.createSession({ name: 'sess-alpha', harness: 'opencode', cwd: fixture.root });
      const ns = new NotesStore(fixture.root);
      ns.createNote('My Note', 'Note content');
      const ts = new TablesStore(fixture.root);
      ts.createTable('metrics', [{ name: 'val', type: 'number' }]);
      const ms = new MessagingStore(fixture.root);
      ms.send('sess-1', null, 'Broadcast test');
      const am = new ArgusManager(fixture.root);
      am.start({ name: 'fleet-test' });

      const output = renderToString(<Dashboard projectRoot={fixture.root} />);
      expect(output).toContain('flightdeck');
      expect(output).toContain('Sessions');
    } finally {
      fixture.cleanup();
    }
  });

  it('tests renderLogContent and getSessionStatusColor', () => {
    expect(getSessionStatusColor('running')).toBe('green');
    expect(getSessionStatusColor('failed')).toBe('red');
    expect(getSessionStatusColor('stopped')).toBe('yellow');

    const errOut = renderToString(
      renderLogContent({
        sessions: [],
        argus: [],
        children: {},
        messages: [],
        notes: [],
        tables: [],
        hungSessions: [],
        logTarget: null,
        logTail: '',
        logError: 'file missing',
        tick: 0,
      })
    );
    expect(errOut).toContain('file missing');

    const tailOut = renderToString(
      renderLogContent({
        sessions: [],
        argus: [],
        children: {},
        messages: [],
        notes: [],
        tables: [],
        hungSessions: [],
        logTarget: null,
        logTail: 'session log line 1',
        logError: null,
        tick: 0,
      })
    );
    expect(tailOut).toContain('session log line 1');

    const emptyOut = renderToString(
      renderLogContent({
        sessions: [],
        argus: [],
        children: {},
        messages: [],
        notes: [],
        tables: [],
        hungSessions: [],
        logTarget: null,
        logTail: '',
        logError: null,
        tick: 0,
      })
    );
    expect(emptyOut).toContain('no log output recorded');
  });
});
