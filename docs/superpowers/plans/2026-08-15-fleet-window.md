# Fleet Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tmux-backed window that shows a running fleet live, lets a human take over one worker, and exposes the human overrides phase 1 deferred.

**Architecture:** tmux owns every pseudo-terminal; flightdeck never emulates a terminal. Panes run the existing `deck session follow`, so watching costs no new machinery. A pure reconciler maps sessions to panes. Claiming a worker respawns its pane interactively in the same worktree with its MCP config and token intact.

**Tech Stack:** TypeScript (strict ESM), tmux 3.0+, React + Ink, `node:sqlite`, vitest, commander.

**Spec:** [docs/superpowers/specs/2026-08-15-fleet-window-design.md](../specs/2026-08-15-fleet-window-design.md)

## Global Constraints

- Node 22.5+. State uses the built-in `node:sqlite`. Add no dependency, and no native module: CI runs `npm ci --ignore-scripts`.
- Strict TypeScript ESM. Every relative import carries a `.js` extension. `import { Tmux } from './tmux.js'`, never `'./tmux'`.
- Schema changes go in `migrate()` in `src/core/state.ts`. Column additions use the `try { db.exec('ALTER TABLE ...') } catch {}` pattern at the bottom of that function.
- Run `npm run build` before any direct `npx vitest` call. Integration and e2e specs spawn `dist/cli/index.js` as a real child process, so a stale `dist/` tests the previous build.
- Every list and detail CLI command supports `--json`.
- Never display a fabricated value. Unknown data renders blank, never zero. A claimed session reports no token usage, so its spend renders blank.
- **Never pass a session token to tmux at all.** Every tmux argument is visible to `ps`, including `-e KEY=VAL` values, so `-e` is not a hiding place. It is not needed either: nothing reads `FLIGHTDECK_SESSION_TOKEN` from the environment, and the generated MCP config already carries the token to the MCP server through its `--token` argument. Pass non-secret environment (profile directories, session id) through `-e`, and pass the token nowhere.
- Every action the console offers must also be a `deck` command calling the same function.
- Never use an em dash (U+2014) in code, comments, strings, or docs. Use a comma, colon, semicolon, hyphen, or parentheses.
- Do not add a co-author trailer to commit messages.
- tmux is NOT installed on the development machine. Every test you write must pass without it. Only the Task 8 e2e test may require tmux, and it must skip cleanly when absent.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/fleet/tmux.ts` | The only code that shells out to `tmux`. One `execFile` per function, runner injected for tests. |
| `src/fleet/reconcile.ts` | `planReconcile`, a pure function from sessions and panes to a list of actions. No side effects. |
| `src/fleet/manager.ts` | `FleetManager`: applies reconcile actions, ensures the tmux session, claim, release, kill, spawn. |
| `src/argus/override.ts` | The five human override actions, shared by the console and the CLI. |
| `src/cli/commands/fleet.tsx` | `deck fleet`, `deck fleet console`, and the claim/release/override subcommands. |

**Modified:**

| File | Change |
| --- | --- |
| `src/core/state.ts` | `sessions.claimed_at`, `tasks.priority`. |
| `src/core/types.ts` | `Session.claimedAt`, `Task.priority`. |
| `src/sessions/manager.ts` | `rowToSession` maps `claimed_at`. |
| `src/argus/board.ts` | `rowToTask` maps `priority`; `dispatchable` orders by priority. |
| `src/cli/commands/doctor.ts` | tmux presence and version check. |
| `src/cli/index.ts` | Register the fleet command. |
| `.github/workflows/ci.yml` | Install tmux in the test job. |

**Dependency order:** Task 1 first. Task 2 and Task 6 are independent of each other and depend only on Task 1. Task 3 depends on 1. Task 4 depends on 2 and 3. Task 5 depends on 4. Task 7 depends on 4, 5, 6. Task 8 depends on 7.

---

### Task 1: Schema, priority ordering, and the doctor check

**Files:**
- Modify: `src/core/state.ts` (the `migrate()` function)
- Modify: `src/core/types.ts`
- Modify: `src/sessions/manager.ts` (`rowToSession`)
- Modify: `src/argus/board.ts` (`rowToTask`, `dispatchable`)
- Modify: `src/cli/commands/doctor.ts` (`runDoctorChecks`)
- Test: `test/unit/fleet-schema.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `sessions.claimed_at` and `tasks.priority` columns; `Session.claimedAt: number | null`; `Task.priority: number`; priority-ordered `TaskBoard.dispatchable`; a `tmux` entry from `runDoctorChecks`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/fleet-schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { getDb } from '../../src/core/state.js';
import { TaskBoard } from '../../src/argus/board.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { makeRepo } from '../helpers.js';

function columns(root: string, table: string): string[] {
  const rows = getDb(root).prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
  return rows.map((r) => String(r.name));
}

describe('fleet schema', () => {
  it('adds claimed_at to sessions and priority to tasks', () => {
    const fixture = makeRepo();
    try {
      expect(columns(fixture.root, 'sessions')).toContain('claimed_at');
      expect(columns(fixture.root, 'tasks')).toContain('priority');
    } finally {
      fixture.cleanup();
    }
  });

  it('exposes claimedAt as null on a fresh session', () => {
    const fixture = makeRepo();
    try {
      const session = new SessionManager(fixture.root).createSession({
        name: 'w1',
        harness: 'opencode',
        cwd: fixture.root,
      });
      expect(session.claimedAt).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it('dispatches higher priority tasks first, then oldest first', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [a, b, c] = board.create('argus-1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
        { title: 'c', spec: 'c', dependsOn: [] },
      ]);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([a.id, b.id, c.id]);

      getDb(fixture.root).prepare('UPDATE tasks SET priority = 5 WHERE id = ?').run(c.id);
      expect(board.dispatchable('argus-1').map((t) => t.id)).toEqual([c.id, a.id, b.id]);
      expect(board.get(c.id)?.priority).toBe(5);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/fleet-schema.test.ts`
Expected: FAIL. `claimed_at` and `priority` do not exist, and `session.claimedAt` is `undefined`.

- [ ] **Step 3: Add the columns**

In `src/core/state.ts`, at the bottom of `migrate()` alongside the existing `ALTER TABLE` blocks, add:

```typescript
  const lateColumns: [string, string][] = [
    ['sessions', 'claimed_at INTEGER'],
    ['tasks', 'priority INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, col] of lateColumns) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col};`);
    } catch {
      // column already exists
    }
  }
```

- [ ] **Step 4: Add the type fields**

In `src/core/types.ts`, add to the `Session` interface:

```typescript
  /** Set while a human has taken this session over in a fleet pane. */
  claimedAt: number | null;
```

And to the `Task` interface:

```typescript
  /** Higher dispatches first. Set by the human override surface. */
  priority: number;
```

- [ ] **Step 5: Map the new fields**

In `src/sessions/manager.ts`, add to the object returned by `rowToSession`:

```typescript
    claimedAt: row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
```

In `src/argus/board.ts`, add to the object returned by `rowToTask`:

```typescript
    priority: Number(row.priority ?? 0),
```

And change `dispatchable` to order by priority. Replace its final `return` with:

```typescript
    return all
      .filter((t) => t.status === 'pending' && t.dependsOn.every((d) => done.has(d)))
      .sort((x, y) => (y.priority - x.priority) || (x.createdAt - y.createdAt));
```

- [ ] **Step 6: Add the doctor check**

In `src/cli/commands/doctor.ts`, add this near the top of the file:

```typescript
import { spawnSync } from 'node:child_process';

/**
 * tmux 3.0 introduced `respawn-pane -e`, which is how claim passes environment
 * without putting a session token in argv where `ps` would expose it. An older
 * tmux is reported as not usable rather than silently downgraded.
 */
function tmuxCheck(): { name: string; ok: boolean; detail: string } {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) {
    return { name: 'tmux', ok: false, detail: 'not installed (only `deck fleet` needs it)' };
  }
  const version = result.stdout.trim();
  const major = Number(/tmux (\d+)/.exec(version)?.[1] ?? 0);
  if (major < 3) {
    return { name: 'tmux', ok: false, detail: `${version}, but 3.0 or newer is required` };
  }
  return { name: 'tmux', ok: true, detail: version };
}
```

Then add `checks.push(tmuxCheck());` inside `runDoctorChecks`, immediately before the `git-repo` check.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/unit/fleet-schema.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 8: Verify nothing else broke**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. `deck doctor` now exits 1 on this machine because tmux is absent, so if any existing test asserts `doctor` exits 0, update it to assert on the `git` check specifically rather than on the overall exit code. Do not remove the tmux check to make a test pass.

- [ ] **Step 9: Commit**

```bash
git add src/core/state.ts src/core/types.ts src/sessions/manager.ts src/argus/board.ts src/cli/commands/doctor.ts test/unit/fleet-schema.test.ts
git commit -m "feat(fleet): add claim and priority columns plus a tmux doctor check"
```

---

### Task 2: tmux wrapper

**Files:**
- Create: `src/fleet/tmux.ts`
- Test: `test/unit/tmux.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `interface TmuxResult { status: number; stdout: string; stderr: string }`; `type TmuxRunner = (args: string[]) => TmuxResult`; `interface PaneInfo { paneId: string; sessionId: string | null; title: string }`; `class Tmux` with `hasTmux`, `sessionExists`, `newSession`, `splitWindow`, `respawnPane`, `killPane`, `listPanes`, `setPaneSession`, `setPaneTitle`, `selectLayout`, `attachArgs`. Tasks 4 and 5 use these.

- [ ] **Step 1: Write the failing test**

Create `test/unit/tmux.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';

/** Records every argv the wrapper would pass to tmux. */
function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('Tmux', () => {
  it('detects a usable tmux', () => {
    const { run } = fakeRunner([{ status: 0, stdout: 'tmux 3.4\n', stderr: '' }]);
    expect(new Tmux(run).hasTmux()).toBe(true);
  });

  it('reports no tmux when the binary is missing', () => {
    const { run } = fakeRunner([{ status: 127, stdout: '', stderr: 'not found' }]);
    expect(new Tmux(run).hasTmux()).toBe(false);
  });

  it('creates a detached session running the given command', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).newSession('fd-abc', '/repo', ['deck', 'fleet', 'console']);
    expect(calls[0]).toEqual([
      'new-session', '-d', '-s', 'fd-abc', '-c', '/repo', '--', 'deck', 'fleet', 'console',
    ]);
  });

  it('returns the pane id when splitting', () => {
    const { run, calls } = fakeRunner([{ status: 0, stdout: '%7\n', stderr: '' }]);
    const paneId = new Tmux(run).splitWindow('fd-abc', '/repo', ['deck', 'session', 'follow', 's1']);
    expect(paneId).toBe('%7');
    expect(calls[0]).toEqual([
      'split-window', '-t', 'fd-abc:0', '-c', '/repo', '-P', '-F', '#{pane_id}',
      '--', 'deck', 'session', 'follow', 's1',
    ]);
  });

  it('passes environment through -e flags rather than an env prefix', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).respawnPane('%7', '/repo', ['claude'], { CLAUDE_CONFIG_DIR: '/profiles/a' });
    expect(calls[0]).toEqual([
      'respawn-pane', '-k', '-t', '%7', '-c', '/repo',
      '-e', 'CLAUDE_CONFIG_DIR=/profiles/a', '--', 'claude',
    ]);
    // Only non-secret values ever travel this way; see the global constraint
    // on tokens. The command itself stays free of environment noise.
    const commandPart = calls[0].slice(calls[0].indexOf('--') + 1);
    expect(commandPart).toEqual(['claude']);
  });

  it('parses list-panes output including panes with no session tag', () => {
    const { run } = fakeRunner([
      { status: 0, stdout: '%1\t\tconsole\n%2\ts-abc\tworker-1\n', stderr: '' },
    ]);
    expect(new Tmux(run).listPanes('fd-abc')).toEqual([
      { paneId: '%1', sessionId: null, title: 'console' },
      { paneId: '%2', sessionId: 's-abc', title: 'worker-1' },
    ]);
  });

  it('tags a pane with its flightdeck session id', () => {
    const { run, calls } = fakeRunner();
    new Tmux(run).setPaneSession('%2', 's-abc');
    expect(calls[0]).toEqual(['set-option', '-p', '-t', '%2', '@fd_session', 's-abc']);
  });

  it('switches instead of attaching when already inside tmux', () => {
    // `attach-session` from inside tmux errors out rather than nesting, so the
    // caller needs a different argv for that case.
    const { run } = fakeRunner();
    const tmux = new Tmux(run);
    expect(tmux.attachArgs('fd-abc')).toEqual(['attach-session', '-t', 'fd-abc']);
    expect(tmux.switchClientArgs('fd-abc')).toEqual(['switch-client', '-t', 'fd-abc']);
  });

  it('reports session existence from the exit status', () => {
    const present = fakeRunner([{ status: 0, stdout: '', stderr: '' }]);
    expect(new Tmux(present.run).sessionExists('fd-abc')).toBe(true);
    const absent = fakeRunner([{ status: 1, stdout: '', stderr: 'no such session' }]);
    expect(new Tmux(absent.run).sessionExists('fd-abc')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/tmux.test.ts`
Expected: FAIL with "Cannot find module '../../src/fleet/tmux.js'".

- [ ] **Step 3: Implement the wrapper**

Create `src/fleet/tmux.ts`:

```typescript
import { spawnSync } from 'node:child_process';

export interface TmuxResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type TmuxRunner = (args: string[]) => TmuxResult;

export interface PaneInfo {
  paneId: string;
  /** The flightdeck session this pane follows, or null for the console pane. */
  sessionId: string | null;
  title: string;
}

export const defaultRunner: TmuxRunner = (args) => {
  const result = spawnSync('tmux', args, { encoding: 'utf8' });
  return {
    status: result.status ?? 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const WINDOW = ':0';

/**
 * The only code in the repository that shells out to tmux. Every method is a
 * single invocation, and the runner is injected so tests assert argv without
 * tmux installed.
 */
export class Tmux {
  constructor(private readonly run: TmuxRunner = defaultRunner) {}

  hasTmux(): boolean {
    return this.run(['-V']).status === 0;
  }

  sessionExists(name: string): boolean {
    return this.run(['has-session', '-t', name]).status === 0;
  }

  newSession(name: string, cwd: string, command: string[]): void {
    this.run(['new-session', '-d', '-s', name, '-c', cwd, '--', ...command]);
  }

  /** Returns the new pane's id, for example `%7`. */
  splitWindow(name: string, cwd: string, command: string[]): string {
    const result = this.run([
      'split-window', '-t', `${name}${WINDOW}`, '-c', cwd, '-P', '-F', '#{pane_id}',
      '--', ...command,
    ]);
    return result.stdout.trim();
  }

  /**
   * Replaces a pane's process. Environment goes through `-e` flags rather than
   * an `env KEY=VAL` prefix, because argv is visible to `ps` and a session
   * token must never appear there. This is why tmux 3.0 is the floor.
   */
  respawnPane(paneId: string, cwd: string, command: string[], env: Record<string, string> = {}): void {
    const envFlags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
    this.run(['respawn-pane', '-k', '-t', paneId, '-c', cwd, ...envFlags, '--', ...command]);
  }

  killPane(paneId: string): void {
    this.run(['kill-pane', '-t', paneId]);
  }

  listPanes(name: string): PaneInfo[] {
    const result = this.run([
      'list-panes', '-t', `${name}${WINDOW}`, '-F', '#{pane_id}\t#{@fd_session}\t#{pane_title}',
    ]);
    if (result.status !== 0) return [];
    return result.stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [paneId, sessionId, title] = line.split('\t');
        return {
          paneId,
          sessionId: sessionId ? sessionId : null,
          title: title ?? '',
        };
      });
  }

  setPaneSession(paneId: string, sessionId: string): void {
    this.run(['set-option', '-p', '-t', paneId, '@fd_session', sessionId]);
  }

  setPaneTitle(paneId: string, title: string): void {
    this.run(['select-pane', '-t', paneId, '-T', title]);
  }

  selectLayout(name: string, layout = 'tiled'): void {
    this.run(['select-layout', '-t', `${name}${WINDOW}`, layout]);
  }

  /** Argv for attaching from outside tmux. The CLI spawns this with stdio inherited. */
  attachArgs(name: string): string[] {
    return ['attach-session', '-t', name];
  }

  /**
   * Argv for moving an existing client to this session. `attach-session` from
   * inside tmux refuses to nest, so a caller already in tmux must switch.
   */
  switchClientArgs(name: string): string[] {
    return ['switch-client', '-t', name];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/tmux.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/tmux.ts test/unit/tmux.test.ts
git commit -m "feat(fleet): add injectable tmux wrapper"
```

---

### Task 3: Pane reconciler

**Files:**
- Create: `src/fleet/reconcile.ts`
- Test: `test/unit/reconcile.test.ts` (create)

**Interfaces:**
- Consumes: `PaneInfo` from `src/fleet/tmux.js`.
- Produces: `interface FleetSession`; `type ReconcileAction`; `paneTitle(session: FleetSession): string`; `PANE_GRACE_MS`; `planReconcile(sessions: FleetSession[], panes: PaneInfo[], nowMs: number): ReconcileAction[]`. Task 4 applies these actions.

- [ ] **Step 1: Write the failing test**

Create `test/unit/reconcile.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { planReconcile, paneTitle, type FleetSession } from '../../src/fleet/reconcile.js';
import type { PaneInfo } from '../../src/fleet/tmux.js';

const NOW = 1_000_000;

function session(over: Partial<FleetSession> = {}): FleetSession {
  return {
    id: 's1',
    name: 'worker-1',
    harness: 'opencode',
    status: 'running',
    policy: 'child',
    endedAt: null,
    claimedAt: null,
    ...over,
  };
}

const consolePane: PaneInfo = { paneId: '%0', sessionId: null, title: 'console' };

describe('planReconcile', () => {
  it('creates a pane for a running worker that has none', () => {
    const actions = planReconcile([session()], [consolePane], NOW);
    expect(actions).toEqual([{ kind: 'create-pane', sessionId: 's1', title: paneTitle(session()) }]);
  });

  it('never gives a brain session a pane', () => {
    // Brain invocations are their own short-lived sessions. Including them
    // would create and destroy a pane on every brain call.
    const brain = session({ id: 'b1', policy: 'brain', name: 'brain-plan' });
    expect(planReconcile([brain], [consolePane], NOW)).toEqual([]);
  });

  it('leaves the console pane alone', () => {
    expect(planReconcile([], [consolePane], NOW)).toEqual([]);
  });

  it('keeps a just-finished pane during the grace period', () => {
    const finished = session({ status: 'stopped', endedAt: NOW - 10_000 });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: paneTitle(finished) };
    expect(planReconcile([finished], [consolePane, pane], NOW)).toEqual([]);
  });

  it('kills a pane once the grace period has passed', () => {
    const finished = session({ status: 'stopped', endedAt: NOW - 90_000 });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: 'stale' };
    expect(planReconcile([finished], [consolePane, pane], NOW)).toEqual([
      { kind: 'kill-pane', paneId: '%1' },
    ]);
  });

  it('kills a pane whose session no longer exists at all', () => {
    const orphan: PaneInfo = { paneId: '%3', sessionId: 'gone', title: 'gone' };
    expect(planReconcile([], [consolePane, orphan], NOW)).toEqual([
      { kind: 'kill-pane', paneId: '%3' },
    ]);
  });

  it('retitles a pane whose title has drifted', () => {
    const claimed = session({ claimedAt: NOW });
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: 'worker-1 · opencode · running' };
    expect(planReconcile([claimed], [consolePane, pane], NOW)).toEqual([
      { kind: 'retitle-pane', paneId: '%1', title: paneTitle(claimed) },
    ]);
  });

  it('does nothing when the fleet already matches', () => {
    const s = session();
    const pane: PaneInfo = { paneId: '%1', sessionId: 's1', title: paneTitle(s) };
    expect(planReconcile([s], [consolePane, pane], NOW)).toEqual([]);
  });
});

describe('paneTitle', () => {
  it('marks a claimed session', () => {
    expect(paneTitle(session({ claimedAt: NOW }))).toContain('CLAIMED');
    expect(paneTitle(session())).not.toContain('CLAIMED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/reconcile.test.ts`
Expected: FAIL with "Cannot find module '../../src/fleet/reconcile.js'".

- [ ] **Step 3: Implement the reconciler**

Create `src/fleet/reconcile.ts`:

```typescript
import type { PaneInfo } from './tmux.js';

export interface FleetSession {
  id: string;
  name: string;
  harness: string;
  status: string;
  policy: string;
  endedAt: number | null;
  claimedAt: number | null;
}

export type ReconcileAction =
  | { kind: 'create-pane'; sessionId: string; title: string }
  | { kind: 'kill-pane'; paneId: string }
  | { kind: 'retitle-pane'; paneId: string; title: string };

/**
 * How long a finished worker keeps its pane. Without this the pane vanishes
 * the instant the process exits, taking the last of its output with it.
 */
export const PANE_GRACE_MS = 60_000;

export function paneTitle(session: FleetSession): string {
  const claimed = session.claimedAt !== null ? ' · CLAIMED' : '';
  return `${session.name} · ${session.harness}${claimed} · ${session.status}`;
}

/**
 * A session earns a pane when a human could usefully watch it: worker or
 * plain sessions only, and either running or recently finished.
 *
 * Excluding `brain` and `manager` is required rather than cosmetic. A brain
 * invocation is its own short-lived session, so including them would create
 * and destroy a pane on every brain call.
 */
function deservesPane(session: FleetSession, nowMs: number): boolean {
  if (session.policy !== 'child' && session.policy !== 'default') return false;
  if (session.status === 'running') return true;
  return session.endedAt !== null && nowMs - session.endedAt <= PANE_GRACE_MS;
}

/**
 * Pure. Takes the world as it is and returns what to do about it, so the
 * riskiest logic in the fleet window is directly testable.
 *
 * Idempotent by construction: applying the result and re-running yields no
 * actions, which is what makes a race with the dispatcher harmless.
 */
export function planReconcile(
  sessions: FleetSession[],
  panes: PaneInfo[],
  nowMs: number
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const wanted = sessions.filter((s) => deservesPane(s, nowMs));
  const byId = new Map(wanted.map((s) => [s.id, s]));
  const tracked = panes.filter((p) => p.sessionId !== null);

  for (const pane of tracked) {
    const session = byId.get(pane.sessionId!);
    if (!session) {
      actions.push({ kind: 'kill-pane', paneId: pane.paneId });
      continue;
    }
    const title = paneTitle(session);
    if (pane.title !== title) {
      actions.push({ kind: 'retitle-pane', paneId: pane.paneId, title });
    }
  }

  const paneSessions = new Set(tracked.map((p) => p.sessionId));
  for (const session of wanted) {
    if (!paneSessions.has(session.id)) {
      actions.push({ kind: 'create-pane', sessionId: session.id, title: paneTitle(session) });
    }
  }

  return actions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/reconcile.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/reconcile.ts test/unit/reconcile.test.ts
git commit -m "feat(fleet): add pure pane reconciler"
```

---

### Task 4: FleetManager

**Files:**
- Create: `src/fleet/manager.ts`
- Test: `test/unit/fleet-manager.test.ts` (create)

**Interfaces:**
- Consumes: `Tmux`, `PaneInfo` (Task 2); `planReconcile`, `paneTitle`, `FleetSession` (Task 3); `SessionManager`; `cliEntryPath` from `src/core/cliEntry.js`.
- Produces: `class FleetManager` with `tmuxSessionName()`, `fleetSessions()`, `ensureSession()`, `reconcile()`, `attachArgs()`. Tasks 5 and 7 use these.

- [ ] **Step 1: Write the failing test**

Create `test/unit/fleet-manager.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb, now } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('FleetManager', () => {
  it('names the tmux session deterministically from the project root', () => {
    const fixture = makeRepo();
    try {
      const a = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).tmuxSessionName();
      const b = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).tmuxSessionName();
      expect(a).toBe(b);
      expect(a).toMatch(/^flightdeck-[0-9a-f]{8}$/);
    } finally {
      fixture.cleanup();
    }
  });

  it('excludes brain sessions from the fleet', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      sm.createSession({
        name: 'b1', harness: 'claude', cwd: fixture.root, policy: 'brain',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const fleet = new FleetManager(fixture.root, new Tmux(fakeRunner().run)).fleetSessions();
      expect(fleet.map((s) => s.id)).toEqual([worker.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('splits a pane and tags it when a worker has none', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      // list-panes returns only the console pane, then split-window returns %5.
      const { run, calls } = fakeRunner([
        { status: 0, stdout: '%0\t\tconsole\n', stderr: '' },
        { status: 0, stdout: '%5\n', stderr: '' },
      ]);
      new FleetManager(fixture.root, new Tmux(run)).reconcile();

      const split = calls.find((c) => c[0] === 'split-window');
      expect(split).toBeDefined();
      expect(split!.join(' ')).toContain('session follow');
      expect(split!.join(' ')).toContain(worker.id);

      const tag = calls.find((c) => c[0] === 'set-option');
      expect(tag).toEqual(['set-option', '-p', '-t', '%5', '@fd_session', worker.id]);
      expect(calls.some((c) => c[0] === 'select-layout')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('kills a pane whose session has been gone past the grace period', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'stopped', ended_at = ? WHERE id = ?")
        .run(now() - 120_000, worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      new FleetManager(fixture.root, new Tmux(run)).reconcile();

      expect(calls.some((c) => c[0] === 'kill-pane' && c[2] === '%5')).toBe(true);
      expect(calls.some((c) => c[0] === 'split-window')).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it('creates the tmux session only when it is absent', () => {
    const fixture = makeRepo();
    try {
      const present = fakeRunner([{ status: 0, stdout: '', stderr: '' }]);
      new FleetManager(fixture.root, new Tmux(present.run)).ensureSession();
      expect(present.calls.some((c) => c[0] === 'new-session')).toBe(false);

      const absent = fakeRunner([{ status: 1, stdout: '', stderr: '' }]);
      new FleetManager(fixture.root, new Tmux(absent.run)).ensureSession();
      expect(absent.calls.some((c) => c[0] === 'new-session')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/fleet-manager.test.ts`
Expected: FAIL with "Cannot find module '../../src/fleet/manager.js'".

- [ ] **Step 3: Implement the manager**

Create `src/fleet/manager.ts`:

```typescript
import crypto from 'node:crypto';
import { normalizeProjectRoot } from '../core/paths.js';
import { cliEntryPath } from '../core/cliEntry.js';
import { SessionManager } from '../sessions/manager.js';
import { Tmux } from './tmux.js';
import { planReconcile, paneTitle, type FleetSession } from './reconcile.js';

export class FleetManager {
  private readonly projectRoot: string;
  private readonly sessions: SessionManager;

  constructor(projectRoot: string, private readonly tmux: Tmux = new Tmux()) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.sessions = new SessionManager(this.projectRoot);
  }

  /**
   * Hashed rather than derived from the path directly: it avoids collisions
   * between projects and sidesteps tmux name escaping for paths with spaces
   * or colons.
   */
  tmuxSessionName(): string {
    const hash = crypto.createHash('sha256').update(this.projectRoot).digest('hex');
    return `flightdeck-${hash.slice(0, 8)}`;
  }

  private deckCommand(args: string[]): string[] {
    return [process.execPath, cliEntryPath(), ...args, '--project', this.projectRoot];
  }

  fleetSessions(): FleetSession[] {
    return this.sessions.list().map((s) => ({
      id: s.id,
      name: s.name,
      harness: s.harness,
      status: s.status,
      policy: s.policy,
      endedAt: s.endedAt,
      claimedAt: s.claimedAt,
    }));
  }

  ensureSession(): void {
    const name = this.tmuxSessionName();
    if (this.tmux.sessionExists(name)) return;
    this.tmux.newSession(name, this.projectRoot, this.deckCommand(['fleet', 'console']));
  }

  /**
   * Idempotent. A session that finishes between listing and acting simply
   * yields a no-op on the next pass, which is what makes racing the
   * dispatcher harmless.
   */
  reconcile(): void {
    const name = this.tmuxSessionName();
    const panes = this.tmux.listPanes(name);
    const actions = planReconcile(this.fleetSessions(), panes, Date.now());
    if (actions.length === 0) return;

    for (const action of actions) {
      if (action.kind === 'kill-pane') {
        this.tmux.killPane(action.paneId);
        continue;
      }
      if (action.kind === 'retitle-pane') {
        this.tmux.setPaneTitle(action.paneId, action.title);
        continue;
      }
      const session = this.sessions.get(action.sessionId);
      if (!session) continue;
      const paneId = this.tmux.splitWindow(
        name,
        session.cwd,
        this.deckCommand(['session', 'follow', session.id])
      );
      if (!paneId) continue;
      this.tmux.setPaneSession(paneId, session.id);
      this.tmux.setPaneTitle(paneId, action.title);
    }
    this.tmux.selectLayout(name);
  }

  /**
   * `insideTmux` must be true when the caller is already in a tmux client,
   * because `attach-session` refuses to nest and would error instead of
   * moving the client.
   */
  attachArgs(insideTmux: boolean): string[] {
    const name = this.tmuxSessionName();
    return insideTmux ? this.tmux.switchClientArgs(name) : this.tmux.attachArgs(name);
  }

  paneFor(sessionId: string): string | null {
    const pane = this.tmux
      .listPanes(this.tmuxSessionName())
      .find((p) => p.sessionId === sessionId);
    return pane?.paneId ?? null;
  }

  titleFor(session: FleetSession): string {
    return paneTitle(session);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/unit/fleet-manager.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/manager.ts test/unit/fleet-manager.test.ts
git commit -m "feat(fleet): add FleetManager pane reconciliation"
```

---

### Task 5: Claim and release

**Files:**
- Modify: `src/fleet/manager.ts` (append methods)
- Test: `test/integration/fleet-claim.test.ts` (create)

**Interfaces:**
- Consumes: `FleetManager` (Task 4); `adapters` and `getAdapter` from `src/sessions/harness.js`.
- Produces: `FleetManager.claim(sessionId: string): Promise<void>`; `FleetManager.release(sessionId: string, opts?: { resume?: boolean }): Promise<void>`. Task 7 calls both.

- [ ] **Step 1: Write the failing test**

Create `test/integration/fleet-claim.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux, type TmuxRunner, type TmuxResult } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo, makeFakeHarness } from '../helpers.js';

function fakeRunner(responses: TmuxResult[] = []): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  let i = 0;
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return responses[i++] ?? { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('claim and release', () => {
  it('respawns the pane interactively and keeps the MCP config and token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      await sm.startSession(worker.id, {
        headless: true, prompt: 'work', waitForExit: true,
        env: { PATH: `${harness.binDir}:${process.env.PATH ?? ''}` },
      });
      const mcpConfig = path.join(fixture.root, '.mcp.json');
      expect(fs.existsSync(mcpConfig)).toBe(true);
      const before = fs.readFileSync(mcpConfig, 'utf8');

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).claim(worker.id);

      const respawn = calls.find((c) => c[0] === 'respawn-pane');
      expect(respawn).toBeDefined();
      expect(respawn![3]).toBe('%5');
      expect(respawn!.slice(respawn!.indexOf('--') + 1)).toEqual(['claude']);
      // The token must appear nowhere in the tmux invocation, including in a
      // -e value: every tmux argument is visible to `ps`.
      expect(respawn!.join(' ')).not.toContain(worker.token);

      // The MCP config and token survive, so worker tools keep working.
      expect(fs.readFileSync(mcpConfig, 'utf8')).toBe(before);
      expect(sm.get(worker.id)?.token).toBe(worker.token);
      expect(sm.get(worker.id)?.claimedAt).not.toBeNull();
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('passes the session id but never the token', async () => {
    const fixture = makeRepo();
    const harness = makeFakeHarness('claude');
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).claim(worker.id);

      const respawn = calls.find((c) => c[0] === 'respawn-pane')!;
      const envFlags = respawn.filter((_, i) => respawn[i - 1] === '-e');
      expect(envFlags).toContain(`FLIGHTDECK_SESSION_ID=${worker.id}`);
      // Nothing reads FLIGHTDECK_SESSION_TOKEN from the environment, and the
      // generated MCP config already carries the token to the MCP server. So
      // claim passes it nowhere, and no `ps` ever sees it.
      expect(envFlags.some((f) => f.startsWith('FLIGHTDECK_SESSION_TOKEN'))).toBe(false);
      expect(envFlags.join(' ')).not.toContain(worker.token);
    } finally {
      harness.cleanup();
      fixture.cleanup();
    }
  });

  it('clears claimed_at and returns the pane to following on release', async () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running', claimed_at = 123 WHERE id = ?")
        .run(worker.id);

      const { run, calls } = fakeRunner([
        { status: 0, stdout: `%0\t\tconsole\n%5\t${worker.id}\tw1\n`, stderr: '' },
      ]);
      await new FleetManager(fixture.root, new Tmux(run)).release(worker.id);

      expect(sm.get(worker.id)?.claimedAt).toBeNull();
      const respawn = calls.find((c) => c[0] === 'respawn-pane')!;
      expect(respawn.join(' ')).toContain('session follow');
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses to claim a session that has no pane', async () => {
    const fixture = makeRepo();
    try {
      const worker = new SessionManager(fixture.root).createSession({
        name: 'w1', harness: 'claude', cwd: fixture.root, policy: 'child',
      });
      const { run } = fakeRunner([{ status: 0, stdout: '%0\t\tconsole\n', stderr: '' }]);
      await expect(
        new FleetManager(fixture.root, new Tmux(run)).claim(worker.id)
      ).rejects.toThrow(/no fleet pane/);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/integration/fleet-claim.test.ts`
Expected: FAIL. `FleetManager` has no `claim` or `release` method.

- [ ] **Step 3: Implement claim and release**

Add these imports to `src/fleet/manager.ts`:

```typescript
import { getDb, now } from '../core/state.js';
import { getAdapter } from '../sessions/harness.js';
```

Append these methods to `FleetManager`:

```typescript
  /**
   * Hands one worker to the human.
   *
   * The headless process stops, then the same pane is respawned running the
   * harness interactively in the same worktree. The session row, worktree,
   * generated MCP config, and token all survive, so `task_get`,
   * `report_done`, and `ask_manager` keep working while a human drives it.
   *
   * tmux owns the pane's pseudo-terminal, which is why flightdeck never has
   * to emulate one.
   */
  async claim(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);
    if (session.policy === 'brain' || session.policy === 'manager') {
      throw new Error(`session "${sessionId}" is not a worker and cannot be claimed`);
    }
    const paneId = this.paneFor(sessionId);
    if (!paneId) throw new Error(`session "${sessionId}" has no fleet pane to claim`);

    if (session.status === 'running') {
      await this.sessions.stopSession(sessionId);
    }

    const adapter = getAdapter(session.harness);
    // Deliberately no FLIGHTDECK_SESSION_TOKEN. Every tmux argument is visible
    // to `ps`, including a -e value, so there is no safe way to pass a secret
    // here. There is also no need: nothing reads that variable from the
    // environment, and the session's generated MCP config already hands the
    // token to the MCP server through its --token argument.
    const env: Record<string, string> = {
      ...(adapter.profileEnv(session) as Record<string, string>),
      FLIGHTDECK_SESSION_ID: session.id,
    };
    this.tmux.respawnPane(
      paneId,
      session.cwd,
      [adapter.binary, ...adapter.interactiveArgs()],
      env
    );

    getDb(this.projectRoot)
      .prepare("UPDATE sessions SET claimed_at = ?, status = 'running' WHERE id = ?")
      .run(now(), sessionId);
    this.tmux.setPaneTitle(paneId, paneTitle(this.fleetSessionOf(sessionId)));
  }

  /** Ends a claim. Returns the pane to tailing, or restarts the worker headless. */
  async release(sessionId: string, opts: { resume?: boolean } = {}): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`session "${sessionId}" not found`);

    getDb(this.projectRoot)
      .prepare('UPDATE sessions SET claimed_at = NULL WHERE id = ?')
      .run(sessionId);

    const paneId = this.paneFor(sessionId);
    if (paneId) {
      this.tmux.respawnPane(
        paneId,
        session.cwd,
        this.deckCommand(['session', 'follow', sessionId])
      );
      this.tmux.setPaneTitle(paneId, paneTitle(this.fleetSessionOf(sessionId)));
    }

    if (opts.resume) {
      await this.sessions.restartSession(sessionId, { headless: true, waitForExit: false });
    }
  }

  private fleetSessionOf(sessionId: string): FleetSession {
    const found = this.fleetSessions().find((s) => s.id === sessionId);
    if (!found) throw new Error(`session "${sessionId}" not found`);
    return found;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/integration/fleet-claim.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/fleet/manager.ts test/integration/fleet-claim.test.ts
git commit -m "feat(fleet): add claim and release for taking over a worker"
```

---

### Task 6: Human override actions

**Files:**
- Create: `src/argus/override.ts`
- Test: `test/unit/override.test.ts` (create)

**Interfaces:**
- Consumes: `TaskBoard` from `src/argus/board.js`; `ArgusManager` from `src/argus/manager.js`; `budgetState` from `src/argus/budget.js`.
- Produces: `class Override` with `acceptTask`, `rejectTask`, `unblockTask`, `prioritizeTask`, `forceReview`. Task 7 calls all five.

- [ ] **Step 1: Write the failing test**

Create `test/unit/override.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Override } from '../../src/argus/override.js';
import { TaskBoard } from '../../src/argus/board.js';
import { ArgusManager } from '../../src/argus/manager.js';
import { TablesStore } from '../../src/tables/store.js';
import { makeRepo } from '../helpers.js';

describe('Override', () => {
  it('forces a task to done regardless of the brain', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      new Override(fixture.root).acceptTask(task.id);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('forces a task back to revising with a human reason', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      new Override(fixture.root).rejectTask(task.id, 'missing migration');
      const updated = board.get(task.id);
      expect(updated?.status).toBe('revising');
      expect(updated?.verdictReason).toContain('missing migration');
    } finally {
      fixture.cleanup();
    }
  });

  it('unblocks a task and resets its attempts', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [task] = board.create('a1', [{ title: 'a', spec: 'a', dependsOn: [] }]);
      board.toRevising(task.id, 'failed');
      board.toRevising(task.id, 'failed again');
      board.block(task.id, 'exhausted');

      new Override(fixture.root).unblockTask(task.id);
      const updated = board.get(task.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.attempts).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('prioritizes a task above its peers', () => {
    const fixture = makeRepo();
    try {
      const board = new TaskBoard(fixture.root);
      const [a, b] = board.create('a1', [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);
      new Override(fixture.root).prioritizeTask(b.id);
      expect(board.dispatchable('a1').map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      fixture.cleanup();
    }
  });

  it('records every override in the decision log as a human action', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);

      new Override(fixture.root).acceptTask(task.id, argus.id);

      const rows = new TablesStore(fixture.root).query('argus_progress', {
        where: { argus_id: argus.id },
        limit: 20,
      });
      const events = rows.map((r) => String(r.event));
      expect(events).toContain('human_accept');
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/override.test.ts`
Expected: FAIL with "Cannot find module '../../src/argus/override.js'".

- [ ] **Step 3: Implement the overrides**

Create `src/argus/override.ts`:

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { getDb, now } from '../core/state.js';
import { normalizeProjectRoot } from '../core/paths.js';
import { TablesStore } from '../tables/store.js';
import { TaskBoard } from './board.js';
import { budgetState } from './budget.js';
import { log } from '../core/logger.js';

/**
 * Human overrides of the brain's decisions.
 *
 * Lives in its own module so the fleet console and the CLI call identical
 * functions, per the contract's rule that anything reachable from a dashboard
 * is reachable from the CLI.
 */
export class Override {
  private readonly db: DatabaseSync;
  private readonly board: TaskBoard;
  private readonly tables: TablesStore;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = normalizeProjectRoot(projectRoot);
    this.db = getDb(this.projectRoot);
    this.board = new TaskBoard(this.projectRoot);
    this.tables = new TablesStore(this.projectRoot);
  }

  /** Every override is attributed to the human, so the log distinguishes it from a brain verdict. */
  private record(argusId: string | undefined, event: string, detail: string): void {
    if (!argusId) return;
    try {
      this.tables.insertRow('argus_progress', {
        argus_id: argusId,
        session_id: null,
        event,
        detail,
      });
    } catch (err) {
      log.error(`failed to record override: ${(err as Error).message}`);
    }
  }

  acceptTask(taskId: string, argusId?: string): void {
    this.board.recordVerdict(taskId, 'accept', 'accepted by human override');
    this.record(argusId, 'human_accept', taskId);
  }

  rejectTask(taskId: string, reason: string, argusId?: string): void {
    this.board.recordVerdict(taskId, 'revise', `human override: ${reason}`);
    this.record(argusId, 'human_reject', `${taskId}: ${reason}`);
  }

  unblockTask(taskId: string, argusId?: string): void {
    this.db
      .prepare("UPDATE tasks SET status = 'pending', attempts = 0, updated_at = ? WHERE id = ?")
      .run(now(), taskId);
    this.record(argusId, 'human_unblock', taskId);
  }

  prioritizeTask(taskId: string, argusId?: string): void {
    const row = this.db.prepare('SELECT MAX(priority) AS top FROM tasks').get() as { top: number | null };
    const next = Number(row.top ?? 0) + 1;
    this.db
      .prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?')
      .run(next, now(), taskId);
    this.record(argusId, 'human_prioritize', taskId);
  }

  /**
   * Drains the review queue now, ignoring the ladder's batching but NOT the
   * ceiling. A human asking for a review must not be able to silently exceed
   * the budget that protects the rate limit.
   */
  async forceReview(argusId: string, manager: { drainReviews: (id: string) => Promise<void> }): Promise<void> {
    const budget = budgetState(this.projectRoot, argusId);
    if (budget.spent >= budget.ceiling) {
      throw new Error(
        `brain budget exhausted for this window (${budget.spent}/${budget.ceiling} tokens); review cannot be forced`
      );
    }
    this.record(argusId, 'human_force_review', `spend=${budget.spent}/${budget.ceiling}`);
    await manager.drainReviews(argusId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/override.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/argus/override.ts test/unit/override.test.ts
git commit -m "feat(argus): add human override actions shared by CLI and console"
```

---

### Task 7: Fleet CLI and console

**Files:**
- Create: `src/cli/commands/fleet.tsx`
- Modify: `src/cli/index.ts`
- Test: `test/e2e/fleet-cli.test.ts` (create)

**Interfaces:**
- Consumes: `FleetManager` (Tasks 4, 5); `Override` (Task 6); `ArgusManager`, `TaskBoard`, `budgetState`.
- Produces: `registerFleet(program: Command): void`, providing `deck fleet`, `deck fleet console`, `deck fleet claim`, `deck fleet release`, `deck fleet status`, and `deck fleet override`.

- [ ] **Step 1: Write the failing test**

Create `test/e2e/fleet-cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ArgusManager } from '../../src/argus/manager.js';
import { TaskBoard } from '../../src/argus/board.js';
import { runCli, makeRepo } from '../helpers.js';

describe('fleet CLI', () => {
  it('reports fleet status as JSON without needing tmux', () => {
    const fixture = makeRepo();
    try {
      const result = runCli(['fleet', 'status', '--json'], { cwd: fixture.root });
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout) as { tmux: boolean; sessions: unknown[] };
      expect(parsed).toHaveProperty('tmux');
      expect(Array.isArray(parsed.sessions)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails clearly when tmux is missing', () => {
    const fixture = makeRepo();
    try {
      // An empty PATH guarantees tmux cannot be found.
      const result = runCli(['fleet'], { cwd: fixture.root, env: { PATH: '/nonexistent' } });
      expect(result.code).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/tmux/i);
    } finally {
      fixture.cleanup();
    }
  });

  it('accepts a task through the override subcommand', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [task] = board.create(argus.id, [{ title: 'a', spec: 'a', dependsOn: [] }]);

      const result = runCli(['fleet', 'override', 'accept', task.id], { cwd: fixture.root });
      expect(result.code).toBe(0);
      expect(board.get(task.id)?.status).toBe('done');
    } finally {
      fixture.cleanup();
    }
  });

  it('prioritizes a task through the override subcommand', () => {
    const fixture = makeRepo();
    try {
      const manager = new ArgusManager(fixture.root, async () => '{}');
      const argus = manager.start({ name: 'fleet' });
      const board = new TaskBoard(fixture.root);
      const [a, b] = board.create(argus.id, [
        { title: 'a', spec: 'a', dependsOn: [] },
        { title: 'b', spec: 'b', dependsOn: [] },
      ]);

      const result = runCli(['fleet', 'override', 'prioritize', b.id], { cwd: fixture.root });
      expect(result.code).toBe(0);
      expect(board.dispatchable(argus.id).map((t) => t.id)).toEqual([b.id, a.id]);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/e2e/fleet-cli.test.ts`
Expected: FAIL. `fleet` is an unknown command, so every invocation exits non-zero.

- [ ] **Step 3: Implement the command file**

Create `src/cli/commands/fleet.tsx`:

```typescript
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { useEffect, useState, type ReactElement } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { FleetManager } from '../../fleet/manager.js';
import { Tmux } from '../../fleet/tmux.js';
import { Override } from '../../argus/override.js';
import { ArgusManager } from '../../argus/manager.js';
import { TaskBoard } from '../../argus/board.js';
import { budgetState } from '../../argus/budget.js';
import { TablesStore } from '../../tables/store.js';
import { projectRootOf, handleError, printJson } from '../util.js';

interface ConsoleSnapshot {
  sessions: ReturnType<FleetManager['fleetSessions']>;
  argusId: string | null;
  counts: Record<string, number>;
  spent: number;
  ceiling: number;
  tier: string;
  progress: string[];
  tick: number;
}

function useConsoleSnapshot(projectRoot: string): ConsoleSnapshot {
  const [snap, setSnap] = useState<ConsoleSnapshot>({
    sessions: [], argusId: null, counts: {}, spent: 0, ceiling: 0, tier: 'normal', progress: [], tick: 0,
  });

  useEffect(() => {
    const load = (): void => {
      try {
        const fleet = new FleetManager(projectRoot);
        fleet.reconcile();
        const argus = new ArgusManager(projectRoot).list()[0] ?? null;
        const counts: Record<string, number> = {};
        let spent = 0;
        let ceiling = 0;
        let tier = 'normal';
        let progress: string[] = [];
        if (argus) {
          for (const task of new TaskBoard(projectRoot).list(argus.id)) {
            counts[task.status] = (counts[task.status] ?? 0) + 1;
          }
          const budget = budgetState(projectRoot, argus.id);
          spent = budget.spent;
          ceiling = budget.ceiling;
          tier = budget.tier;
          progress = new TablesStore(projectRoot)
            .query('argus_progress', { where: { argus_id: argus.id }, limit: 8 })
            .map((r) => `${String(r.event)} ${String(r.detail ?? '')}`);
        }
        setSnap((prev) => ({
          sessions: fleet.fleetSessions(),
          argusId: argus?.id ?? null,
          counts, spent, ceiling, tier, progress,
          tick: prev.tick + 1,
        }));
      } catch {
        // transient lock or missing tmux session; retry on the next tick
      }
    };
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [projectRoot]);

  return snap;
}

function FleetConsole({ projectRoot }: { readonly projectRoot: string }): ReactElement {
  const snap = useConsoleSnapshot(projectRoot);
  const [message, setMessage] = useState('');

  useInput((input) => {
    if (input === 'q') process.exit(0);
    if (input === 'f' && snap.argusId) {
      const manager = new ArgusManager(projectRoot);
      new Override(projectRoot)
        .forceReview(snap.argusId, manager)
        .then(() => setMessage('review drained'))
        .catch((err: Error) => setMessage(err.message));
    }
  });

  // A claimed session reports no parseable usage, so its spend renders blank
  // rather than zero. Zero would be fabricated data.
  const spendLabel = snap.ceiling > 0
    ? `${snap.spent} / ${snap.ceiling} (${((snap.spent / snap.ceiling) * 100).toFixed(0)}%)`
    : '';

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">{'flightdeck fleet  '}</Text>
        <Text dimColor>{projectRoot}</Text>
      </Box>

      <Text bold underline>Board</Text>
      <Box marginBottom={1}>
        {Object.keys(snap.counts).length === 0
          ? <Text dimColor>{'  (no tasks)'}</Text>
          : <Text>{`  ${Object.entries(snap.counts).map(([k, v]) => `${k}=${v}`).join('  ')}`}</Text>}
      </Box>

      <Text bold underline>Brain budget</Text>
      <Box marginBottom={1}>
        <Text>{`  ${spendLabel}  `}</Text>
        <Text color={snap.tier === 'paused' ? 'red' : 'green'}>{snap.tier}</Text>
      </Box>

      <Text bold underline>Workers</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.sessions.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.sessions.map((s) => (
          <Text key={s.id}>
            <Text color={s.status === 'running' ? 'green' : 'yellow'}>{`  ${s.status.padEnd(8)}`}</Text>
            <Text>{`${s.name.padEnd(20)} ${s.harness.padEnd(9)}`}</Text>
            {s.claimedAt !== null && <Text color="magenta">CLAIMED</Text>}
          </Text>
        ))}
      </Box>

      <Text bold underline>Decisions</Text>
      <Box flexDirection="column" marginBottom={1}>
        {snap.progress.length === 0 && <Text dimColor>{'  (none)'}</Text>}
        {snap.progress.map((line, i) => (
          <Text key={`${line}-${i}`} dimColor>{`  ${line}`}</Text>
        ))}
      </Box>

      {message !== '' && <Text color="yellow">{message}</Text>}
      <Text dimColor>{`refresh #${snap.tick}  [f] force review  [q] quit`}</Text>
    </Box>
  );
}

function requireTmux(): void {
  if (!new Tmux().hasTmux()) {
    throw new Error('tmux is not installed or is older than 3.0; run `deck doctor` for details');
  }
}

export function registerFleet(program: Command): void {
  const fleet = program.command('fleet').description('tmux window onto a running fleet');

  fleet
    .command('console', { isDefault: false })
    .description('Interactive fleet control pane (runs inside a tmux pane)')
    .option('--project <path>', 'project root (default: current directory)')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        render(<FleetConsole projectRoot={projectRoot} />, { exitOnCtrlC: true });
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('status')
    .description('Show fleet panes and sessions')
    .option('--json', 'output JSON')
    .option('--project <path>', 'project root (default: current directory)')
    .action((opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new FleetManager(projectRoot);
        const payload = {
          tmux: new Tmux().hasTmux(),
          tmuxSession: manager.tmuxSessionName(),
          sessions: manager.fleetSessions(),
        };
        if (opts.json) {
          printJson(payload);
          return;
        }
        console.log(`tmux        ${payload.tmux ? 'available' : 'not installed'}`);
        console.log(`session     ${payload.tmuxSession}`);
        for (const s of payload.sessions) {
          const claimed = s.claimedAt !== null ? '  CLAIMED' : '';
          console.log(`${s.status.padEnd(9)} ${s.name.padEnd(20)} ${s.harness}${claimed}`);
        }
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('claim <sessionId>')
    .description('Take over a worker in its pane')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new FleetManager(projectRoot).claim(sessionId);
        console.log(`claimed ${sessionId}`);
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .command('release <sessionId>')
    .description('End a claim and return the pane to following the log')
    .option('--resume', 'restart the worker headless after releasing')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (sessionId: string, opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        await new FleetManager(projectRoot).release(sessionId, { resume: Boolean(opts.resume) });
        console.log(`released ${sessionId}`);
      } catch (err) {
        handleError(err);
      }
    });

  const override = fleet.command('override').description('Human overrides of brain decisions');

  const withOverride = (
    name: string,
    description: string,
    run: (o: Override, taskId: string, argusId: string | undefined, extra: string) => void
  ): void => {
    override
      .command(`${name} <taskId> [reason]`)
      .description(description)
      .option('--project <path>', 'project root (default: current directory)')
      .action((taskId: string, reason: string | undefined, opts: Record<string, string | boolean>) => {
        try {
          const projectRoot = projectRootOf(opts.project as string | undefined);
          const argusId = new ArgusManager(projectRoot).list()[0]?.id;
          run(new Override(projectRoot), taskId, argusId, reason ?? '');
          console.log(`${name} ${taskId}`);
        } catch (err) {
          handleError(err);
        }
      });
  };

  withOverride('accept', 'Force a task to done', (o, id, argusId) => o.acceptTask(id, argusId));
  withOverride('reject', 'Force a task back to the worker', (o, id, argusId, reason) =>
    o.rejectTask(id, reason || 'rejected by human', argusId)
  );
  withOverride('unblock', 'Return a blocked task to pending', (o, id, argusId) => o.unblockTask(id, argusId));
  withOverride('prioritize', 'Dispatch a task first', (o, id, argusId) => o.prioritizeTask(id, argusId));

  // The console's [f] key must have a CLI equivalent: anything reachable from
  // a dashboard is reachable from the CLI.
  override
    .command('force-review')
    .description('Drain the review queue now, ignoring batching but not the budget ceiling')
    .option('--project <path>', 'project root (default: current directory)')
    .action(async (opts: Record<string, string | boolean>) => {
      try {
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new ArgusManager(projectRoot);
        const argus = manager.list()[0];
        if (!argus) throw new Error('no argus fleet exists in this project');
        await new Override(projectRoot).forceReview(argus.id, manager);
        console.log('review queue drained');
      } catch (err) {
        handleError(err);
      }
    });

  fleet
    .action((opts: Record<string, string | boolean>) => {
      try {
        requireTmux();
        const projectRoot = projectRootOf(opts.project as string | undefined);
        const manager = new FleetManager(projectRoot);
        manager.ensureSession();
        manager.reconcile();
        // Hand the terminal to tmux. Nothing is emulated: tmux owns the TTY.
        // Inside an existing tmux client, switch rather than attach; attaching
        // would refuse to nest and error out.
        const insideTmux = Boolean(process.env.TMUX);
        const result = spawnSync('tmux', manager.attachArgs(insideTmux), { stdio: 'inherit' });
        process.exitCode = result.status ?? 0;
      } catch (err) {
        handleError(err);
      }
    })
    .option('--project <path>', 'project root (default: current directory)');
}
```

- [ ] **Step 4: Register the command**

In `src/cli/index.ts`, add the import next to the other command imports:

```typescript
import { registerFleet } from './commands/fleet.js';
```

Note the `.js` extension even though the source file is `.tsx`, matching how `registerTui` imports `tui.tsx`.

Then add `registerFleet(program);` next to the other `register*` calls.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/e2e/fleet-cli.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/fleet.tsx src/cli/index.ts test/e2e/fleet-cli.test.ts
git commit -m "feat(cli): add deck fleet window, console, claim, and overrides"
```

---

### Task 8: Real tmux end-to-end test and CI

**Files:**
- Create: `test/e2e/fleet-tmux.test.ts`
- Modify: `.github/workflows/ci.yml` (the `test` job)

**Interfaces:**
- Consumes: `FleetManager`, `Tmux`.
- Produces: a guarded e2e test that exercises real tmux.

- [ ] **Step 1: Write the test**

This task inverts the usual order: the test is guarded, so on a machine without tmux it skips rather than fails. That is expected and is not a reason to change it.

Create `test/e2e/fleet-tmux.test.ts`:

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { FleetManager } from '../../src/fleet/manager.js';
import { Tmux } from '../../src/fleet/tmux.js';
import { SessionManager } from '../../src/sessions/manager.js';
import { getDb } from '../../src/core/state.js';
import { makeRepo } from '../helpers.js';

const tmux = new Tmux();
const hasTmux = tmux.hasTmux();
const created: string[] = [];

afterAll(() => {
  for (const name of created) {
    tmux.killSessionByName(name);
  }
});

describe.skipIf(!hasTmux)('fleet window against real tmux', () => {
  it('creates a session, reconciles a worker pane, and tags it', () => {
    const fixture = makeRepo();
    try {
      const sm = new SessionManager(fixture.root);
      const worker = sm.createSession({
        name: 'w1', harness: 'opencode', cwd: fixture.root, policy: 'child',
      });
      getDb(fixture.root)
        .prepare("UPDATE sessions SET status = 'running' WHERE id = ?")
        .run(worker.id);

      const fleet = new FleetManager(fixture.root);
      created.push(fleet.tmuxSessionName());

      fleet.ensureSession();
      expect(tmux.sessionExists(fleet.tmuxSessionName())).toBe(true);

      fleet.reconcile();
      const panes = tmux.listPanes(fleet.tmuxSessionName());
      expect(panes.length).toBeGreaterThanOrEqual(2);
      expect(panes.some((p) => p.sessionId === worker.id)).toBe(true);

      // Reconcile is idempotent: a second pass must add nothing.
      fleet.reconcile();
      expect(tmux.listPanes(fleet.tmuxSessionName())).toHaveLength(panes.length);
    } finally {
      fixture.cleanup();
    }
  });
});
```

- [ ] **Step 2: Add the cleanup helper the test needs**

The test calls `tmux.killSessionByName`, which does not exist. Add it to `src/fleet/tmux.ts` as a method on `Tmux`, directly after `killPane`:

```typescript
  killSessionByName(name: string): void {
    this.run(['kill-session', '-t', name]);
  }
```

- [ ] **Step 3: Run the test**

Run: `npm run build && npx vitest run test/e2e/fleet-tmux.test.ts`
Expected on a machine without tmux: the suite reports the describe block as skipped and exits 0. That is correct.
Expected on a machine with tmux: PASS, 1 test.

If it neither passes nor skips, the guard is wrong. Fix the guard, not the assertions.

- [ ] **Step 4: Install tmux in CI**

In `.github/workflows/ci.yml`, in the `test` job only, add this step immediately after `- run: npm ci --ignore-scripts` and before the `npm test` step:

```yaml
      # The fleet window e2e test needs a real tmux; without it the test skips
      # and the fleet surface would go unexercised in CI.
      - name: Install tmux
        run: sudo apt-get update && sudo apt-get install -y tmux
```

Do not add this step to the `lint`, `typecheck`, or `build` jobs.

- [ ] **Step 5: Run every check**

Run: `npm run build && npm run typecheck && npm run lint && npm test`
Expected: all four exit 0, with the tmux e2e block skipped locally.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/fleet-tmux.test.ts src/fleet/tmux.ts .github/workflows/ci.yml
git commit -m "test(fleet): exercise real tmux in a guarded e2e and install it in CI"
```

---

## Deferred to a follow-up

Not in this plan. Do not implement.

- **Broadcast to all workers.** Excluded by the spec: with a brain coordinating the fleet, one instruction sent to every worker has no clear meaning.
- **Spawning a new worker from the console.** The dispatcher already spawns workers against board tasks; a manual spawn needs its own task semantics first.
- **Attaching the fleet window to a remote host** over the existing SSH host store.
