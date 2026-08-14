import { Command } from 'commander';
import { useEffect, useState, useCallback } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { SessionManager } from '../../sessions/manager.js';
import { ArgusManager } from '../../argus/manager.js';
import { MessagingStore } from '../../messaging/store.js';
import { NotesStore } from '../../notes/store.js';
import { TablesStore } from '../../tables/store.js';
import { WatchdogManager } from '../../watchdog/manager.js';
import { projectRootOf, handleError } from '../util.js';

interface Snapshot {
  sessions: ReturnType<SessionManager['list']>;
  argus: ReturnType<ArgusManager['list']>;
  children: Record<string, { session: ReturnType<SessionManager['get']>; worktreeName: string; task: string }[]>;
  messages: ReturnType<MessagingStore['list']>;
  notes: ReturnType<NotesStore['list']>;
  tables: ReturnType<TablesStore['listTables']>;
  hungSessions: ReturnType<WatchdogManager['listHung']>;
  tick: number;
}

function useSnapshot(projectRoot: string): [Snapshot, () => void] {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    sessions: [],
    argus: [],
    children: {},
    messages: [],
    notes: [],
    tables: [],
    hungSessions: [],
    tick: 0,
  });

  const load = useCallback((): void => {
    try {
      const sessions = new SessionManager(projectRoot);
      const argusManager = new ArgusManager(projectRoot);
      const messaging = new MessagingStore(projectRoot);
      const notesStore = new NotesStore(projectRoot);
      const tablesStore = new TablesStore(projectRoot);
      const watchdog = new WatchdogManager(projectRoot);

      const argus = argusManager.list();
      const children: Snapshot['children'] = {};
      for (const a of argus) {
        children[a.id] = argusManager.fleet(a.id).children;
      }
      setSnapshot((prev) => ({
        sessions: sessions.list(),
        argus,
        children,
        messages: messaging.list({ limit: 12 }),
        notes: notesStore.list(),
        tables: tablesStore.listTables(),
        hungSessions: watchdog.listHung(300),
        tick: prev.tick + 1,
      }));
    } catch {
      // transient state lock during pulse
    }
  }, [projectRoot]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);

  return [snapshot, load];
}

function Dashboard({ projectRoot }: { projectRoot: string }): JSX.Element {
  const [snap, refresh] = useSnapshot(projectRoot);
  const [tab, setTab] = useState<'sessions' | 'memory' | 'watchdog'>('sessions');

  useInput((input, key) => {
    if (input === 'q' || key.escape) process.exit(0);
    if (input === '1') setTab('sessions');
    if (input === '2') setTab('memory');
    if (input === '3') setTab('watchdog');
    if (key.tab) {
      setTab((prev) =>
        prev === 'sessions' ? 'memory' : prev === 'memory' ? 'watchdog' : 'sessions'
      );
    }
    if (input === 'r') refresh();
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            {'flightdeck control-plane  '}
          </Text>
          <Text dimColor>{projectRoot}</Text>
        </Box>
        <Box>
          <Text dimColor>{`refresh #${snap.tick} (press 1,2,3,tab to switch; r=refresh, q=quit)`}</Text>
        </Box>
      </Box>

      {/* Tabs Header */}
      <Box marginBottom={1}>
        <Text bold color={tab === 'sessions' ? 'green' : 'dim'}>
          {tab === 'sessions' ? '[1: Sessions & Argus]' : ' 1: Sessions & Argus '}
        </Text>
        <Text>  </Text>
        <Text bold color={tab === 'memory' ? 'green' : 'dim'}>
          {tab === 'memory' ? '[2: Memory (Notes & Tables)]' : ' 2: Memory (Notes & Tables) '}
        </Text>
        <Text>  </Text>
        <Text bold color={tab === 'watchdog' ? 'green' : 'dim'}>
          {tab === 'watchdog'
            ? `[3: Watchdog (${snap.hungSessions.length} alerts)]`
            : ` 3: Watchdog (${snap.hungSessions.length}) `}
        </Text>
      </Box>

      {tab === 'sessions' && (
        <Box flexDirection="column">
          <Text bold underline color="white">
            Sessions
          </Text>
          <Box flexDirection="column" marginBottom={1}>
            {snap.sessions.length === 0 && <Text dimColor>{'  (none)'}</Text>}
            {snap.sessions.map((s) => (
              <Text key={s.id}>
                <Text
                  color={
                    s.status === 'running'
                      ? 'green'
                      : s.status === 'failed'
                      ? 'red'
                      : 'yellow'
                  }
                >
                  {'  '}
                  {s.status.padEnd(8)}
                </Text>
                <Text dimColor>
                  {s.harness.padEnd(8)} {s.id.slice(0, 8)} {s.name.padEnd(24)}
                </Text>
                <Text>{s.worktree ?? '(root)'}</Text>
              </Text>
            ))}
          </Box>

          <Text bold underline color="white">
            Argus Fleets
          </Text>
          <Box flexDirection="column" marginBottom={1}>
            {snap.argus.length === 0 && <Text dimColor>{'  (none)'}</Text>}
            {snap.argus.map((a) => (
              <Box key={a.id} flexDirection="column">
                <Text>
                  <Text color={a.status === 'running' ? 'green' : 'dim'}>
                    {'  '}
                    {a.status.padEnd(8)}
                  </Text>
                  <Text bold>{a.name}</Text>
                  <Text dimColor>{`  children ${(snap.children[a.id] ?? []).length}/${a.childLimit}  pulse ${a.pulseSec}s`}</Text>
                </Text>
                {(snap.children[a.id] ?? []).map((child) => {
                  const s = child.session;
                  return (
                    <Text key={s?.id ?? child.worktreeName}>
                      <Text
                        color={
                          s?.status === 'running'
                            ? 'green'
                            : s?.status === 'failed'
                            ? 'red'
                            : 'yellow'
                        }
                      >
                        {'    '}
                        {s?.status.padEnd(8) ?? 'stopped '}
                      </Text>
                      <Text dimColor>
                        {s ? `${s.name} (${s.harness})` : child.worktreeName}
                      </Text>
                    </Text>
                  );
                })}
              </Box>
            ))}
          </Box>

          <Text bold underline color="white">
            Recent Inter-Agent Messages
          </Text>
          <Box flexDirection="column">
            {snap.messages.length === 0 && <Text dimColor>{'  (none)'}</Text>}
            {snap.messages.slice(-6).map((m) => (
              <Text key={m.id}>
                <Text dimColor>{`  ${m.fromSession.slice(0, 8)} → ${m.toSession?.slice(0, 8) ?? '*'} `}</Text>
                <Text>{m.body}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {tab === 'memory' && (
        <Box flexDirection="column">
          <Text bold underline color="white">
            Project Notes ({snap.notes.length})
          </Text>
          <Box flexDirection="column" marginBottom={1}>
            {snap.notes.length === 0 && <Text dimColor>{'  (none)'}</Text>}
            {snap.notes.slice(0, 8).map((n) => (
              <Text key={n.id}>
                <Text color="cyan">{`  ${n.id.slice(0, 8)} `}</Text>
                <Text bold>{n.title}</Text>
                <Text dimColor>{` (v${n.version})`}</Text>
              </Text>
            ))}
          </Box>

          <Text bold underline color="white">
            Structured Project Tables ({snap.tables.length})
          </Text>
          <Box flexDirection="column">
            {snap.tables.length === 0 && <Text dimColor>{'  (none)'}</Text>}
            {snap.tables.map((t) => (
              <Text key={t.name}>
                <Text color="magenta">{`  ${t.name.padEnd(20)} `}</Text>
                <Text dimColor>{`${t.columns.map((c) => `${c.name}:${c.type}`).join(', ')}`}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      )}

      {tab === 'watchdog' && (
        <Box flexDirection="column">
          <Text bold underline color="white">
            Watchdog Supervisor & Health Alerts
          </Text>
          <Box flexDirection="column">
            {snap.hungSessions.length === 0 ? (
              <Text color="green">{'  ✓ All active sessions healthy (0 hung or stuck sessions)'}</Text>
            ) : (
              snap.hungSessions.map((s) => (
                <Text key={s.id} color="red">
                  {`  [ALERT: HUNG] Session ${s.id.slice(0, 8)} (${s.name}) inactive > 300s`}
                </Text>
              ))
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

export function registerTui(program: Command): void {
  program
    .command('tui')
    .description('Interactive dashboard (read-only)')
    .option('--project <path>', 'project root (default: current directory)')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        render(<Dashboard projectRoot={projectRoot} />, { exitOnCtrlC: true });
      } catch (err) {
        handleError(err);
      }
    });
}
