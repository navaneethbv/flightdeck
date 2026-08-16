# Argus shared quota design

Status: proposed 2026-08-16.
Scope: a named budget pool that multiple Argus missions, in the same project or in different projects, can share against one real subscription account.

This is a subsystem spec.
The product contract remains [2026-08-14-flightdeck-design.md](2026-08-14-flightdeck-design.md) revision 2.
The immediate parent is [2026-08-15-orchestrator-brain-design.md](2026-08-15-orchestrator-brain-design.md), which introduced the per-mission budget this spec extends.

## Problem

`budgetState()` sums brain token spend from one project's `session_telemetry`, scoped to one `argus_parent` ([src/argus/budget.ts:100-106](../../../src/argus/budget.ts#L100-L106)).
That is exactly right when one mission owns one subscription window, but flightdeck state is per-project ([src/core/paths.ts](../../../src/core/paths.ts): `stateDbPath` lives under each project's own `.flightdeck/`).
Two different flightdeck-managed repositories on the same machine, both spawning `claude` or `codex` brain sessions under the same login, have zero visibility into each other's spend.
Each mission's rolling window can report itself safely under ceiling while the real, shared subscription is already exhausted.

A second, related gap: the budget ladder only reacts to tokens flightdeck itself counted.
Nothing reacts to an actual rate-limit response from the provider.
A mission can be well under its own ceiling and still be throttled by Claude or Codex, with no special handling beyond the generic malformed-output containment in `brainJson` ([src/argus/manager.ts:350-355](../../../src/argus/manager.ts#L350-L355)), which exists for a different failure mode.

## Goal

Let an operator declare that a set of missions, anywhere on the machine, draw on one real account.
Track their combined spend against one ceiling.
When any one of them observes a real provider throttle, back every sharing mission off immediately, not just the one that got throttled.

## Non-goals

- Reading the actual remaining allowance of a subscription plan from the provider.
  No API exposes it, same limitation the parent spec already accepted.
- Cross-machine sharing.
  The quota store is a local file; two machines do not see each other's spend.
- Automatic discovery of which missions share an account.
  Attachment is explicit, via `--quota <id>`, never inferred from harness or credentials.

## Relationship to the orchestrator brain spec

This does not change `classifyTier`, `tierPolicy`, or `reviewBatchSize`.
Those stay pure functions over a `BudgetState` and never learn where `spent` came from.
It changes only how `budgetState()` sources `spent`, and adds one new field those functions do not yet consult: a shared throttle timestamp.

A mission that never passes `--quota` behaves exactly as specified in the parent spec, with no migration and no behavior change.

## Data model

A quota is a small named resource, stored globally because it must outlive and be visible outside any single project's `state.db`.

New file: `~/.flightdeck/quotas.db` (or `$FLIGHTDECK_HOME/quotas.db`), opened the same way as project state, `DatabaseSync` with `PRAGMA journal_mode = WAL` ([src/core/state.ts:19-21](../../../src/core/state.ts#L19-L21)).
WAL mode is what already makes concurrent multi-process access to one SQLite file safe in this codebase, and two `deck argus start` processes in two different projects are exactly that: two OS processes opening the same file.

```sql
CREATE TABLE quota (
  id TEXT PRIMARY KEY,
  max_tokens INTEGER NOT NULL,
  window_sec INTEGER NOT NULL,
  count_cache_reads INTEGER NOT NULL DEFAULT 1,
  throttled_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE quota_usage (
  quota_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
```

`quota_usage` is an append-only ledger, one row per brain session that finishes under a quota-attached mission.
It is not a copy of `session_telemetry`; it holds only what the shared ledger needs, a token count and a timestamp, so it never becomes a second source of truth for anything project-scoped.

The `argus` table gains two nullable columns:

| Column | Meaning |
| --- | --- |
| `quota_id` | References a row in the global `quota` table. Null means the mission owns a private, per-mission pool exactly as today. |
| `throttled_until` | Mirrors `quota.throttled_until` for a private (unquota'd) mission, since it has no shared row to store the field on. |

`deck argus start` rejects `--quota` combined with `--budget-window` or `--budget-max-tokens`: the quota owns those numbers once attached, so a mission cannot silently disagree with the pool it just joined.

## Runtime enforcement

`budgetState(projectRoot, argusId)` gains one branch at the top: if the Argus row has a `quota_id`, `spent` is summed from `quota_usage` in the global db, windowed by the quota's own `window_sec`, instead of from the project's local `session_telemetry`.
Every downstream consumer, `classifyTier`, `reviewBatchSize`, the CLI and Fleet console renderers, is unchanged, because they only ever see the resulting `BudgetState`.

When a quota-attached mission's brain session finishes and its telemetry is recorded locally (unchanged), the manager also appends one row to the global `quota_usage` ledger.
This is the only write a quota-attached mission makes outside its own project's `state.db`.

## Rate-limit backoff

Add an optional parser to the harness adapter contract ([src/sessions/harness.ts](../../../src/sessions/harness.ts)), alongside the existing `telemetry` and `renderLine` parsers:

```ts
detectRateLimit?(output: string): number | null; // suggested backoff in ms, or null
```

Implemented for `claude` and `codex`, the only harnesses ever used as the brain.
Worker harnesses (`opencode`, `gemini`) never need it, since the brain is the only process spending against the tracked budget.

When a brain invocation's process output matches, the manager writes `now() + backoff` to `throttled_until`, on the mission's quota row if attached, or on its own `argus.throttled_until` if private.
Before every brain call, plan, review, or answer, the manager checks that field on the effective resource first.
If it is still in the future, the call is skipped, the same as an exhausted budget tier: no third retry, no busy-loop against a live rate limit.

Because the field lives on the shared quota row when one is attached, one mission's real throttle immediately backs off every other mission sharing that account.
That is the actual payoff of sharing a quota: today two independent missions on one account can each individually believe they are safely under their own ceiling while jointly exceeding the real one, and neither learns about the other's throttle until it gets throttled itself.

## CLI surface

```bash
deck quota create <id> --max-tokens <count> --window <duration> [--count-cache-reads]
deck quota list [--json]
deck quota show <id> [--json]   # spend, tier, throttled_until, missions currently attached
deck argus start --quota <id> …    # mutually exclusive with --budget-window / --budget-max-tokens
```

`deck argus budget <id>` and `deck argus status` print `quota: <id>` when attached.
When `throttled_until` is set, that replaces the tier and backlog fields in the same way `nextResetAt` already renders blank rather than a fabricated value when it cannot be computed ([src/cli/commands/argus.ts](../../../src/cli/commands/argus.ts), [src/cli/commands/fleet.tsx](../../../src/cli/commands/fleet.tsx)).
The Fleet console budget panel gains the same field.

## Module layout

```text
src/argus/
  budget.ts      modified; budgetState() gains the quota-sourced spend branch
  quota.ts       new; global db access, quota CRUD, quota_usage ledger, throttle read/write
src/sessions/
  harness.ts     modified; optional detectRateLimit per adapter, implemented for claude and codex
src/cli/commands/
  quota.ts       new; deck quota create/list/show
  argus.ts       modified; --quota flag, budget/status rendering
```

`quota.ts` is the only module that opens the global db.
Everything else keeps going through `getDb(projectRoot)` for project-scoped state, unchanged.

## Testing

- Unit: `quota.ts` CRUD, `quota_usage` window summation at each boundary, `detectRateLimit` parsers against captured throttle output from both harnesses.
- Integration: two `ArgusManager` instances against two different project roots, sharing one quota id via a shared `FLIGHTDECK_HOME`, where one mission's spend pushes the shared pool's tier and the other mission observes it on its next `budgetState()` read; one mission's simulated throttle blocking the other's next brain call.
- The `--quota` plus `--budget-window`/`--budget-max-tokens` rejection at the CLI layer.

## Risks

- A quota's ceiling has to be set to the operator's actual best understanding of the subscription's real limit, same self-imposed, observed-consumption caveat the parent spec already accepted for the per-mission case.
- `quota_usage` grows without bound today; a window-based prune (delete rows older than the largest `window_sec` any quota has used) should ship alongside this rather than be deferred, since the ledger is otherwise unbounded for a long-lived shared quota.
- Two missions can still race between `budgetState()` read and the next brain call each makes; the read is a snapshot, not a lock.
  Acceptable because the cost of overshooting by one concurrent call is small relative to the cost of serializing every brain invocation across every project on the machine.
