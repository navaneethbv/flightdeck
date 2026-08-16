# Argus mission control design

Status: proposed 2026-08-16.
Scope: fix `deck argus stop` when run from a separate process, add pause and resume, and add an event hook an operator can use to alert on stuck or throttled missions.

This is a subsystem spec.
The product contract remains [2026-08-14-flightdeck-design.md](2026-08-14-flightdeck-design.md) revision 2.
The immediate parent is [2026-08-15-orchestrator-brain-design.md](2026-08-15-orchestrator-brain-design.md).
It composes with [2026-08-16-argus-shared-quota-design.md](2026-08-16-argus-shared-quota-design.md): a throttled quota is implemented as the same self-pause mechanism this spec adds for the operator-triggered case.

## Problem

`runForever`'s scheduler loop only exits in response to `SIGINT` or `SIGTERM` delivered to its own process ([src/argus/manager.ts:304-305](../../../src/argus/manager.ts#L304-L305)).
`deck argus start` documents this: the CLI's own success message says "running in foreground; press Ctrl+C to stop" ([src/cli/commands/argus.ts:147](../../../src/cli/commands/argus.ts#L147)).

`deck argus stop <id>`, run as a separate CLI invocation from another terminal, constructs a new `ArgusManager` in a different OS process.
It marks the DB row `stopped` and kills the mission's child worker sessions ([src/argus/manager.ts:921-930](../../../src/argus/manager.ts#L921-L930)), which works because workers are spawned detached with their PIDs persisted, so any process can signal them.
But `this.stopping` is an instance field on that new, throwaway `ArgusManager`.
It has no effect on the original `runForever` loop's own instance, running in the original process.
That loop never re-reads `argus.status` from the database at all; it captured the row once at the top of `runForever` and loops forever on it.

The practical effect: the mission's workers are dead, the DB says `stopped`, and the orchestrator process that was supposed to be gone keeps polling, keeps pulsing, and can keep spending brain tokens against a mission that has no workers left to direct.
The only stop path that actually works today is Ctrl+C in the same terminal that ran `deck argus start`.

Separately, there is no way to suspend a mission without ending it.
The only lever is `stop`, which is terminal: sessions are killed and the row moves to `stopped`.
An operator who wants to hold off spending, without losing the task board or forcing a full restart, has no option.

Finally, nothing pushes state.
Task blocked, brain abandoned after two malformed responses, a question that failed twice, a quota entering `throttled_until` (per the sibling spec): all of these currently sit silently in the `argus_progress` log until an operator happens to run `deck argus status`.

## Goal

Make `stop` actually stop the mission regardless of which process issued it.
Add `pause` and `resume` as a non-terminal, zero-token-cost suspension.
Give an operator a way to run their own script when the orchestrator reaches a state worth knowing about immediately.

## Non-goals

- A notification service, email, Slack, or webhook integration built into flightdeck itself.
  The hook runs a local script; what that script does (curl a webhook, send a Slack message, write a file) is the operator's business, not flightdeck's.
- Pausing an individual task or child session.
  This is mission-level, matching the granularity `stop` already has.
- Automatically resuming a manually paused mission.
  Only a throttled quota's automatic pause clears itself; an operator-initiated pause clears only on an explicit `resume`.

## Status as the single source of truth

`Argus.status` is a plain `TEXT NOT NULL DEFAULT 'stopped'` column with no `CHECK` constraint ([src/core/state.ts:53](../../../src/core/state.ts#L53)), typed today as `'running' | 'stopped'` ([src/core/types.ts:107](../../../src/core/types.ts#L107)).
It gains one new value, `'paused'`.
No migration is needed beyond the type change; the column already accepts any string.

The scheduler loop already does a cheap, local, model-free SQLite read every tick, at worst every 250ms ([src/argus/manager.ts:309-317](../../../src/argus/manager.ts#L309-L317)).
That tick gains one more read: the mission's own current `status`, fetched fresh, not the value captured when `runForever` started.

- `stopped`, observed from any process's write, including this loop's own SIGINT handler: the loop runs its existing shutdown path and exits.
  Because children are already killed by whichever process wrote `stopped` (the detached-PID kill already works cross-process today), the loop's own shutdown becomes idempotent: it stops sessions that are, in the common case, already stopped, which `SessionManager.stopSession` already tolerates.
- `paused`: the loop skips `pulse()` and `processPendingEvents()` for this tick.
  No dispatch, no gate draining, no review draining, no brain call of any kind.
  It keeps sleeping and re-checking status every tick, so a `resume` is picked up within the same ≤250ms bound `hasPendingEvents` already gives worker events.
- `running`, observed after a `paused` mission's `resume`: `nextPulseAt` is reset to now, so the mission does not wait out whatever fraction of its last interval remained before the pause.

`deck argus pause <id>` and `deck argus resume <id>` are both a single DB write, matching the existing shape of `deck argus stop`.
Existing worker sessions are left running while paused; pausing stops the orchestrator from directing new work, it does not freeze work already in flight, since a worker mid-task has no way to be safely frozen without losing state.

## Interaction with the shared quota spec

A quota's `throttled_until` (or `argus.throttled_until` for a private budget) is a second, narrower reason to skip brain calls, checked at the same point `pulse()` and `processPendingEvents()` already gate on `status`.
It is deliberately not implemented as another `Argus.status` value: a throttle is automatic, temporary, and self-clearing once `throttled_until` passes, where `paused` is operator-set and stays set until `resume`.
Collapsing them into one enum would make it impossible to tell, from status alone, which kind of stop an operator is looking at.

## Alerting

There is an existing, working precedent for exactly this shape: `.flightdeck/hooks/post-create/*.sh`, discovered by filename, run in sorted order via `spawnSync('/bin/bash', ...)`, with `FLIGHTDECK_*` environment variables ([src/worktrees/manager.ts:106-131](../../../src/worktrees/manager.ts#L106-L131)).

A second hook directory, `.flightdeck/hooks/on-event/*.sh`, is discovered and run the same way, from inside `writeProgress` ([src/argus/manager.ts:958](../../../src/argus/manager.ts#L958)), which is already the one function every state transition worth alerting on already flows through: `task_blocked`, `brain_abandoned`, `question_failed`, `review_failed`, `review_files_failed`, `argus_stopped`, and the new `argus_paused` / `argus_resumed` / `quota_throttled` this spec and the sibling quota spec add.
No new instrumentation is needed anywhere else in the codebase; every trigger point already calls `writeProgress`.

Scripts receive:

| Env var | Value |
| --- | --- |
| `FLIGHTDECK_EVENT` | The progress event kind, for example `task_blocked`. |
| `FLIGHTDECK_ARGUS_ID` | The mission id. |
| `FLIGHTDECK_SESSION` | The related session id, when the event has one; unset otherwise. |
| `FLIGHTDECK_MESSAGE` | The human-readable detail string already passed to `writeProgress`. |

Unlike a post-create hook, whose failure legitimately blocks worktree creation, an on-event hook's failure must never take the orchestrator down with it: a broken alert script is an operator problem, not a reason to stop directing work.
Its exit code and stderr are logged as a warning and otherwise ignored.

Hooks run synchronously today, matching the post-create precedent, and a slow script therefore delays the scheduler tick that triggered it.
Documented as a constraint on hook scripts (keep them fast; `curl` with a short timeout, not a long-running process) rather than solved with async dispatch, since the existing hook mechanism makes the same trade and this spec should not invent a second concurrency model for one new directory.

## CLI surface

```bash
deck argus pause <id>
deck argus resume <id>
```

`deck argus status` and the Fleet console render `paused` as a distinct state from `running` and `stopped`, not folded into either.

## Module layout

```text
src/argus/
  manager.ts     modified; status re-read each tick, paused skip branch, on-event hook dispatch from writeProgress
src/cli/commands/
  argus.ts       modified; pause and resume commands
```

No new files.
This is entirely a modification of the existing scheduler loop and the existing progress-writing path.

## Testing

- Integration: a `deck argus stop` issued from a second `ArgusManager` instance against the same project root while a first instance's `runForever` is live in-process (via a fake clock or a short poll interval in the test), asserting the first instance's loop actually exits rather than continuing to pulse.
- Integration: `pause` during an in-flight mission asserts zero brain calls occur until `resume`, and that `resume` triggers the next pulse within the loop's normal tick bound rather than waiting out the paused-over interval.
- Unit: `on-event` hook discovery and env var contents, using a fixture script that writes its received env to a file.
- Unit: a failing hook script is caught, logged, and does not raise out of `writeProgress`.

## Risks

- Running hook scripts synchronously inside `writeProgress` means a pathological script (for example, an unbounded `sleep`) stalls the scheduler tick that fired it.
  Accepted per the post-create precedent; worth revisiting only if it proves to matter in practice.
- Re-reading `status` every tick is one more local SQLite read at 250ms cadence, negligible next to the reads `hasPendingEvents` already does on the same cadence.
