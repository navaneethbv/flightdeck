# Orchestrator brain design

Status: approved 2026-08-15.
Scope: the Argus orchestrator gains a real reasoning brain, a task board, objective gates, and an enforced token budget.

This is a subsystem spec.
The product contract remains [2026-08-14-flightdeck-design.md](2026-08-14-flightdeck-design.md) revision 2, which this document amends where noted under `Relationship to the design contract`.

## Problem

`ArgusManager` presents itself as an orchestrator but contains no reasoning.
`pulse()` splits markdown bullets out of a Mission note via `parseTasks` and assigns `tasks[children.length]` to child N.
No model is ever invoked on behalf of the manager.
`runForever` marks the manager session `running` using flightdeck's own pid, which makes the manager session a bookkeeping artifact rather than an agent.
There is no review of completed work, no re-planning, and no way for a child to ask a question.

Both the manager session and every child are hardcoded to `harness: 'claude'`.
A fleet with different harnesses in different roles cannot be expressed.

## Goal

Run a fleet where an expensive, rate-limited harness directs cheap, abundant ones.

The brain (Claude or Codex) plans work, reviews completed work, and answers worker questions.
The workers (OpenCode or Gemini) execute tasks in isolated worktrees.

The binding constraint is that the brain runs against a subscription rate limit while the workers do not.
Every design decision below is subordinate to spending as few brain tokens as possible per unit of useful work.

## Non-goals

- The tmux fleet window.
  That is phase 2 and gets its own spec.
  Until then the fleet is driven from the CLI and observed through `deck tui`.
- Workers directing other workers.
  The topology stays one brain over a flat worker pool.
- Reading the actual remaining allowance of a subscription plan.
  No API exposes it.
  The budget is self-imposed and measured from observed consumption.

## Relationship to the design contract

This spec supersedes these parts of revision 2:

- The Argus section's mission-to-child mapping.
  `parseTasks` and bullet-indexed assignment are deleted.
  Task decomposition becomes a brain call producing task board rows.
- The statement that Argus children are always `claude`.
  Harness per role becomes configuration.

It does not change the session isolation model, the tool permission gate, the worktree model, or the prohibition on fabricated data.

## Roles and configuration

The `argus` table is extended rather than replaced.
The orchestrator concept, the `cap` capability, and the `manager` / `child` policies all survive unchanged.

New columns on `argus`:

| Column | Meaning |
| --- | --- |
| `brain_harness` | `claude` or `codex`. |
| `brain_plan_model` | Model id for planning and tier 2 review. Nullable, meaning harness default. |
| `brain_review_model` | Model id for tier 1 verdicts. Nullable. |
| `worker_harnesses` | JSON array, for example `["opencode","gemini"]`, cycled when spawning workers. |
| `budget_window_sec` | Rolling window length for budget accounting. |
| `budget_max_tokens` | Ceiling on brain spend inside one window. |
| `budget_count_cache_reads` | Whether cache reads count at full weight. Defaults to true. |
| `max_attempts_per_task` | Forced escalation after this many failed attempts. |
| `max_tasks` | Hard ceiling on task rows per mission. |

`SessionPolicy` in [src/core/types.ts](../../../src/core/types.ts) gains a fourth value, `brain`.

Each brain invocation is its own short-lived session row with `policy: 'brain'`.
This is deliberate and load-bearing.
It makes budget accounting a plain sum over session telemetry rows inside the window, it produces an audit trail of every brain call, and it guarantees a brain session can never satisfy the `isManager` check in [src/mcp/server.ts](../../../src/mcp/server.ts), because that check requires `policy === 'manager'`.

Brain sessions never get an MCP config written.
`SessionManager.startSession` skips `adapter.writeMcpConfig` when the session policy is `brain`.

## The brain contract

The brain does not use MCP.

It is invoked headless with a prompt assembled by flightdeck and returns a single JSON object on stdout, parsed and validated with zod.
The rationale is token economy.
An MCP tool surface is re-sent in context on every invocation, and the brain would use each tool at most once per call.
Paying that overhead hundreds of times per mission is the exact waste this design exists to remove.

Two secondary benefits follow.
Every orchestration path becomes testable against a fake brain with zero model calls.
And the brain can only see what flightdeck assembles for it, which is what makes the budget enforceable rather than advisory.

Three call types:

**Plan.** Input is the mission note body, the project conventions note, and the current task board summary.
Output:

```json
{ "tasks": [ { "title": "...", "spec": "...", "depends_on": [0, 2] } ] }
```

`depends_on` holds zero-based indices into the same `tasks` array, not task ids.
The brain cannot reference ids that do not exist yet.
Flightdeck generates the ids and rewrites the indices into id references when inserting board rows.
An index outside the array, or a dependency cycle, fails validation and is treated as malformed output.

**Review.** Batched over one or more tasks.
Input per task is the task spec, the worker's structured report, `git diff --stat` output, and gate results.
Never the diff itself at tier 1.
Output:

```json
{ "verdicts": [ { "task_id": "...", "verdict": "accept|revise|need_files",
                  "reason": "...", "paths": ["..."] } ] }
```

**Answer.** Input is one worker question plus the mission and conventions context.
Output:

```json
{ "answer": "...", "faq_key": "..." }
```

Malformed output is retried once with the parse error appended, then the call is abandoned and surfaced to the human.
A retry loop on a rate-limited brain is worse than a visible failure.

## Task board

A first-class table created in `migrate()` in [src/core/state.ts](../../../src/core/state.ts), not a `TablesStore` dynamic table.
It needs typed columns, indices, and migration management, none of which the dynamic table store provides.

```text
tasks(
  id TEXT PRIMARY KEY,
  argus_id TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,          -- pending|assigned|reported|gating|revising|in_review|done|blocked
  assignee_session TEXT,
  depends_on TEXT,               -- JSON array of task ids
  attempts INTEGER NOT NULL DEFAULT 0,
  worker_report TEXT,            -- JSON, from report_done
  gate_result TEXT,              -- JSON: exit codes and failure tail
  diffstat TEXT,
  verdict TEXT,
  verdict_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

`argus_progress` remains as the human-readable event log.

## Lifecycle

```text
  pending ──dispatch──> assigned ──worker works──> reported
                            ▲                          │
                            │                          ▼
                            │                    ┌───────────┐
                            │                    │   GATES   │  free, no brain
                            │                    │ test+lint │
                            │                    └─────┬─────┘
                            │             fail         │        pass
                            └──── revising <───────────┴────────> in_review
                                     ▲                                │
                                     │                                ▼
                                     │                         ┌────────────┐
                                     │           revise        │   REVIEW   │  brain, batched
                                     └─────────────────────────│   queue    │
                                                               └─────┬──────┘
                                                                 accept │
                                                                        ▼
                                                                      done
```

The dispatcher is free TypeScript running on the existing pulse.
It assigns `pending` tasks whose dependencies are `done` to idle workers, spawning a worktree and headless session per worker exactly as `spawnChild` does today.

The brain is event-driven and never polled.
It wakes on exactly three events: a task entered `in_review`, a worker asked an uncached question, or the human intervened.
An idle fleet costs zero brain tokens.
This replaces the current model where the pulse loop itself was the scheduler.

### Gates are tier 0 and cost nothing

When a worker calls `report_done`, the task moves to `gating` and flightdeck runs the project's gate commands inside that worker's worktree.
Exit codes and the tail of any failure output are recorded on the task row.

The commands come from two new keys in [src/core/config.ts](../../../src/core/config.ts), `gateTestCommand` and `gateLintCommand`, defaulting to `npm test` and `npm run lint`.
Either may be empty, which skips that gate.
A project with no gates configured degrades to brain-only review, which is expensive and is warned about at mission start.

On failure the task returns to `revising` and the worker is re-prompted with the failure output attached.
No brain tokens are spent.
Attempts increments.
Past `max_attempts_per_task` the task moves to `blocked` and is surfaced to the human.

This is the highest-leverage rule in the design.
Most rejection traffic is objectively wrong code, and objectively wrong code should never reach a rate-limited reviewer.

### Review is tiered

Tier 1 sees the worker report, the diffstat, and the gate results.
Roughly hundreds of tokens per task rather than tens of thousands.

Tier 2 is entered only when tier 1 returns `need_files`.
Flightdeck attaches the contents of the specific paths the brain named and re-queues the task.
Tier 2 is disabled entirely above 60 percent budget consumption.

## Worker MCP surface

Three new tools on the existing registry in [src/mcp/tools.ts](../../../src/mcp/tools.ts).

| Tool | Risk | Purpose |
| --- | --- | --- |
| `task_get` | `read` | Fetch the caller's current assignment and project conventions. |
| `report_done` | `additive` | Structured completion: summary, files changed, tests run, uncertainties. Triggers gates. |
| `ask_manager` | `additive` | Ask the brain a question, FAQ-cached. |

All three are `read` or `additive`, so `ToolRegistry.permissionError` admits them for `policy: 'child'` sessions with no change to the permission gate and no risky-tools grant.

### The question path never blocks the fleet

`ask_manager` first checks the FAQ note for a matching prior question.
A hit returns immediately at zero brain cost.

On a miss the question is written to the questions queue, the dispatcher wakes the brain, and the tool call blocks up to `question_timeout_sec`, a new `argus` column defaulting to 120.
If an answer lands in time it is returned.
If the brain is throttled and no answer arrives, the tool returns a directive to proceed on best judgment and record the assumption in the completion report.

A throttled brain must slow review throughput without ever stalling a worker.

When the brain does answer, the answer is appended to the FAQ note under `faq_key`, so the next worker to ask gets it free.

FAQ matching is normalized-string equality plus keyword overlap.
It will miss paraphrases.
This is an accepted trade: a miss costs one brain call, whereas embeddings would add a dependency and an index to maintain.

## Budget

### Accounting

Both candidate brains report usage today.
Claude emits it on the `result` event and Codex on `turn.completed`, both already parsed in [src/sessions/telemetry.ts](../../../src/sessions/telemetry.ts).
Because each brain invocation is its own session, consumption inside a window is one query:

```sql
SELECT SUM(input_tokens + output_tokens)
FROM session_telemetry t JOIN sessions s ON s.id = t.session_id
WHERE s.policy = 'brain' AND s.argus_parent = :argus_id AND s.started_at > :window_start
```

Gemini emits no usage at all: `parseGeminiLine` returns null by design.
Gemini worker spend is therefore unknown and must render as blank, never as zero.
Displaying zero would be fabricated data, which the design contract prohibits.

How cache reads count against a subscription limit is not reliably known.
`budget_count_cache_reads` defaults to true, counting them at full weight.
That can only cause early throttling, never an overrun.
Revisit once real consumption has been measured.

### Degradation ladder

| Spend | Behavior |
| --- | --- |
| under 60% | Tier 2 allowed. Reviews drain one task at a time for fast feedback. |
| 60 to 80% | Tier 2 disabled. Batch size 4. |
| 80 to 95% | Batch all pending. Drain only at 4 or more queued, or a task aged past 30 minutes. |
| over 95% | Review draining pauses. Workers continue. Backlog depth and window reset time are surfaced. |

Twenty percent of the ceiling is reserved for the question path so a heavy review batch cannot starve `ask_manager`.
Reviews can wait.
A worker about to build on a wrong assumption cannot.

The accepted consequence of the over-95 rule is that a human may return to many finished, unreviewed tasks.
That is preferred over idling the cheap capacity.

### Model tiering

`HarnessAdapter.sessionArgs(prompt, opts)` gains `model?: string` on its options, and all four adapters pass it to their respective CLI flags.
Planning and tier 2 use `brain_plan_model`.
Tier 1 verdicts use `brain_review_model`.

## Module layout

```text
src/argus/
  manager.ts     existing; pulse becomes dispatch-only, parseTasks deleted
  brain.ts       new; prompt assembly, invocation, zod validation of the 3 contracts
  budget.ts      new; window accounting and ladder state, pure functions over state.db
  gates.ts       new; runs test and lint in a worktree, records results
  board.ts       new; task board CRUD and the lifecycle transitions
  questions.ts   new; FAQ lookup, queue, answer writeback
```

`brain.ts` is the only module that invokes a model.
`budget.ts`, `gates.ts`, and `board.ts` contain no model calls and are pure functions over the database, which is what makes them directly testable.

## Testing

The JSON brain contract means orchestration is testable without a model.
A fake brain returning canned JSON exercises planning, every lifecycle transition, tier 1 and tier 2 review, and the full degradation ladder.

- Unit: `parseTasks` replacement, board transitions, gate result recording, budget window math, each ladder threshold, FAQ hit and miss.
- Integration: dispatcher assigning against dependencies, gate failure returning a task to `revising` without a brain call, question timeout returning the proceed-anyway directive.
- E2E behind a skip guard: one real brain invocation asserting the JSON contract parses against the live harness.

The budget ladder in particular must be tested at each boundary, since silently exceeding a subscription limit is the failure mode the whole design exists to prevent.

## Risks

- FAQ matching is naive and will re-ask paraphrased questions, costing brain calls.
  Mitigated by the question reserve; revisit if miss rate is high in practice.
- Worker self-reports can be inaccurate or over-confident.
  The gates are the defense: objective test and lint results are trusted over any worker claim.
- A worker harness that reports no usage, currently Gemini, leaves part of fleet cost unobservable.
  Acceptable because workers are the abundant side, but it should be surfaced honestly in the UI.
- Cache read weighting against subscription limits is unverified and may make the budget conservative.
