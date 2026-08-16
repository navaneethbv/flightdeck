# Fleet window design

Status: approved 2026-08-15.
Scope: a tmux-backed window that shows a running fleet, lets a human take over one worker, and exposes the human overrides phase 1 deferred.

This is phase 2 of the orchestrator work.
Phase 1 is [2026-08-15-orchestrator-brain-design.md](2026-08-15-orchestrator-brain-design.md), which this builds on and does not change.
The product contract remains [2026-08-14-flightdeck-design.md](2026-08-14-flightdeck-design.md) revision 2, amended where noted below.

## Problem

After phase 1 the fleet is autonomous.
A brain plans tasks, a dispatcher spawns headless workers against them, objective gates screen the results, and the brain reviews what survives.

None of it is visible while it runs.
`deck tui` polls SQLite every two seconds and shows tables, and `deck session follow` tails one session at a time.
Watching four workers means four terminals, and there is no way to step in when one of them goes wrong.

## What changed since the phase 2 sketch

An earlier revision of this design assumed four peer agents running interactively in their own pseudo-terminals, with the human typing at any of them.
That was correct for the product as it stood before phase 1, and it is wrong now.

Workers are headless and spawned automatically.
The brain is headless by necessity, because that is the only way its token spend is measurable.
In the normal flow nobody types at an agent.

This removes the expensive part.
PTY ownership and terminal emulation existed to let a human type into a running agent's native interface.
If the normal state is watching, watching is tailing a log, and every session already writes one through `followSessionLogs`.
Flightdeck therefore never emulates a terminal, at any point in this design.

## Goal

One window that shows the whole fleet live, and lets a human take over exactly one worker without disturbing the rest.

## Non-goals

- Broadcast to all workers.
  With a brain coordinating the fleet, sending one instruction to every worker has no clear meaning.
  Excluded rather than built with vague semantics.
- Terminal emulation, PTY ownership, or any native dependency.
  tmux owns every pseudo-terminal in this design.
- Driving the brain interactively.
  The brain runs per-invocation and headless so its spend stays measurable.
  Human input to the brain's decisions goes through the override surface instead.

## Relationship to the design contract

This amends revision 2's `TUI dashboard` section, which describes the Ink TUI as read-only and secondary to the web dashboard.
`deck fleet console` is an interactive terminal surface.
`deck tui` is unchanged and stays read-only.

Every action the console offers is also a `deck` command, per the contract's rule that anything reachable from a dashboard is reachable from the CLI.

## Architecture

Two new modules with a hard boundary between them.

**`src/fleet/tmux.ts`** is the only code in the repository that shells out to `tmux`.
Every function is one `execFile` invocation: `hasTmux`, `sessionExists`, `newSession`, `splitWindow`, `respawnPane`, `killPane`, `listPanes`, `setPaneTitle`, `selectLayout`, `attach`.
It takes its command runner by injection, so unit tests assert the exact argv against a fake and never need tmux installed.

**`src/fleet/manager.ts`** is `FleetManager(projectRoot)`, constructed with a project root like every other store.
It implements reconcile, claim, release, kill, and spawn.
It contains no tmux argv.

The reconciler is a pure function, `planReconcile(sessions, panes): Action[]`, separated from the code that performs the actions.
This is deliberate: pane reconciliation is the part most likely to be wrong, and a pure function over two arrays is directly testable.

## Layout

One tmux session per project, named `flightdeck-<first 8 hex of sha256 of the normalized project root>`.
Hashing avoids both collisions between projects and tmux name escaping problems with paths.

Window 0 holds every pane.
Pane 0 runs `deck fleet console`.
Panes 1 through N each run `deck session follow <session-id>`.

A session earns a pane when its policy is `child` or `default`, and it is either running or ended within the last 60 seconds.

Both halves of that rule matter.
Excluding `brain` and `manager` policies is required, not cosmetic: a brain invocation is its own short-lived session, so including them would create and destroy a pane on every single brain call.
The 60 second grace period keeps a finished worker's pane on screen long enough to read how it ended, instead of the pane vanishing at the instant the process exits.

Reconciliation runs on a timer inside the console.
As the dispatcher spawns workers and as workers finish, panes appear and close to match.
Pane titles carry the session name, harness, and status.

`deck fleet` creates the tmux session if absent, reconciles, then attaches.
Running it while already inside tmux attaches to the existing session rather than nesting.

## Claim

Claim is the only genuinely new runtime behavior.

`deck fleet claim <session-id>` stops the headless process for that session, then respawns that session's pane through `tmux respawn-pane`, launching the harness with `interactiveArgs()` in the same worktree.

The session row, worktree, generated MCP config, and token all survive the transition.
The MCP server therefore still serves that session, so `task_get`, `report_done`, and `ask_manager` keep working while a human drives the agent by hand.

tmux owns the pane's pseudo-terminal, which is what makes this possible without flightdeck emulating anything.

Two consequences follow, and both must be honored.

A claimed session stops emitting parseable token usage, because interactive harnesses do not produce the structured output the telemetry parsers read.
Its spend must render blank, never zero.
Rendering zero would be fabricated data, which the design contract prohibits.

The claimed task stays `assigned` to that session, so the dispatcher will not hand it to another worker.

`deck fleet release <session-id>` ends the interactive process.
It then either returns the pane to following the log, or restarts the session headless, according to a `--resume` flag.

A `claimed_at` column on `sessions` records the transition, so the console can mark the pane and the telemetry layer knows to suppress spend.

## Override surface

The human overrides deferred in phase 1 land here, in `src/argus/override.ts`, so the console and the CLI call identical functions.

| Action | Effect |
| --- | --- |
| `acceptTask(taskId)` | Force a task to `done` regardless of the brain's verdict. |
| `rejectTask(taskId, reason)` | Force a task to `revising` with a human-written reason. |
| `unblockTask(taskId)` | Return a `blocked` task to `pending` and reset its attempt count. |
| `prioritizeTask(taskId)` | Move a pending task to the front of the dispatch order. |
| `forceReview(argusId)` | Drain the review queue now, ignoring the budget ladder's batching. |

`forceReview` deliberately ignores batching but not the ceiling.
A human asking for a review should not be able to silently exceed the budget that protects the rate limit.

Dispatch order becomes explicit rather than implicit.
`tasks` gains a `priority INTEGER NOT NULL DEFAULT 0` column, and `dispatchable` orders by priority descending, then `created_at` ascending.

Each override writes an `argus_progress` row naming the human as the actor, so the decision log distinguishes brain verdicts from human ones.

## Console

`deck fleet console` is an Ink app reusing the snapshot polling pattern already in `src/cli/commands/tui.tsx`.

It shows the board summarized by status, review queue depth, budget spend with its ladder tier, blocked tasks, and the recent `argus_progress` decision log.

Keys: claim, release, kill, new worker, and the five override actions.
Every one of them calls the same function the corresponding `deck` command calls.

## Doctor

`deck doctor` gains a `tmux` check, in the same `{ name, ok, detail }` shape as the existing checks.
It reports not installed rather than failing hard, because every other part of flightdeck works without tmux.
Only `deck fleet` requires it.

## Testing

- Unit: `planReconcile` over crafted session and pane arrays, covering a new session, a finished session, an unchanged fleet, and a claimed pane. The tmux wrapper against a fake runner, asserting argv. Each override function against the task board.
- Integration: claim and release transitions over a real session row with a fake harness binary, asserting the MCP config and token survive and that `claimed_at` is set and cleared.
- E2E behind a skip guard: create a real tmux session, reconcile two panes, and kill it. Skipped when `hasTmux()` is false.

CI installs tmux so the guarded test actually runs there.
It will skip on a developer machine without tmux, which is the current state of the author's machine.

## Risks

- tmux is a hard runtime dependency for `deck fleet` and is not currently installed on the development machine. Mitigated by the doctor check and by every other surface working without it.
- A claimed session is unobservable in token terms. Accepted, and surfaced as blank rather than hidden.
- Pane reconciliation races the dispatcher: a session can finish between listing sessions and acting on panes. Mitigated by making reconcile idempotent, so a stale action is a no-op on the next pass rather than an error.
