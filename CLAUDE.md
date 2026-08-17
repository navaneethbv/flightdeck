# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`deck` is a local control plane for AI coding-agent CLIs.
It runs installed harnesses (Claude Code, Codex, OpenCode, Gemini) inside isolated Git worktrees, exposes a per-session MCP server those agents call back into, and adds an Argus orchestrator that drives a fleet of child sessions from a Mission note.

The design contract is [docs/superpowers/specs/2026-08-14-flightdeck-design.md](docs/superpowers/specs/2026-08-14-flightdeck-design.md).
Read it before changing behavior.
It is revision 2, and its `What changed in revision 2` section records where the code drifted from revision 1 and what is being corrected.

## Commands

```bash
npm run build          # tsc + copy web assets into dist/
npm run dev            # tsx src/cli/index.ts (run the CLI without building)
npm run typecheck      # tsc --noEmit
npm run lint           # eslint src test
npm test               # builds first (pretest), then vitest run
```

Running one test file or one test:

```bash
npx vitest run test/unit/playbooks.test.ts
npx vitest run -t "enforces isolation"
```

**Build before running a test subset.**
`npm test` builds via `pretest`, but `npm run test:unit`, `test:integration`, `test:e2e`, and any direct `npx vitest` call do not.
The integration and e2e tests spawn `dist/cli/index.js` as a real child process ([test/helpers.ts:36](test/helpers.ts#L36)), so a stale `dist/` makes them test the previous build.
Run `npm run build` first when invoking vitest directly.

Web assets are copied, not bundled ([scripts/copy-assets.js](scripts/copy-assets.js)).
Editing `src/web/public/` requires a rebuild before `deck ui` serves the change from `dist/`.

Node 22.5+ is required, because state uses the built-in `node:sqlite` rather than a native module.

## Architecture

### Three entry points, one core library

- `deck` CLI ([src/cli/](src/cli/)), commands registered with commander in [index.ts](src/cli/index.ts).
- `deck mcp serve` stdio MCP server ([src/mcp/server.ts](src/mcp/server.ts)), one process per session, spawned by the harness itself.
- `deck ui` web dashboard ([src/server/index.ts](src/server/index.ts)), a `node:http` server over the same core.

None of the three own business logic.
All of them go through the stores and managers in `src/`.
Anything reachable from the dashboard must also be reachable from the CLI.

### State

Per-project SQLite at `<project>/.flightdeck/state.db`, opened through [`getDb()`](src/core/state.ts#L13), which caches one `DatabaseSync` per normalized project root and runs all migrations inline on open.
Schema changes go in the `migrate()` function in that file; there is no migration directory.

Every store (`NotesStore`, `TablesStore`, `MessagingStore`, `SshStore`, `Integrations`, `WatchdogManager`, `SessionManager`, `ArgusManager`) is constructed with a project root and calls `getDb()` itself.
They share the cached connection rather than receiving one.

Path layout is centralized in [src/core/paths.ts](src/core/paths.ts).
`FLIGHTDECK_HOME` overrides the global dir, which is how the test suite isolates itself ([test/setup.ts](test/setup.ts)).

### Session isolation

This is the security model, and it is easy to break by accident.

Each session row carries a secret `token`.
When the CLI spawns a harness, the adapter writes a harness-specific MCP config pointing at `deck mcp serve --session <id> --token <token>` ([src/sessions/harness.ts:28](src/sessions/harness.ts#L28)).
`serveMcp()` refuses to start unless the token matches the stored one ([src/mcp/server.ts:72](src/mcp/server.ts#L72)).

Those generated configs (`.mcp.json`, `mcp.json`, `opencode.json`, `.gemini/settings.json`) contain a live token and absolute paths.
They are gitignored and must stay that way.

### Tool permissions

Every MCP tool declares a `risk` of `read`, `additive`, `destructive`, or `external` ([src/mcp/tools.ts:24](src/mcp/tools.ts#L24)).
`ToolRegistry.permissionError()` ([src/mcp/tools.ts:70](src/mcp/tools.ts#L70)) is the single gate:

- `read` and `additive` always pass.
- Everything else requires `isManager && riskyTools` on the `McpContext`.
- Argus children (`policy: 'child'`) get a distinct denial message for `external` tools.

`isManager` is only granted when the session's policy is `manager` **and** `process.env.FLIGHTDECK_ARGUS_CAP` matches the capability stored on the Argus row ([src/mcp/server.ts:85-93](src/mcp/server.ts#L85-L93)).
That env check is what stops an ordinary session from impersonating the orchestrator.

When adding a tool, set its `risk` deliberately.
When constructing an `McpContext` outside the MCP server, do not hand out `isManager: true, riskyTools: true` with an auto-approving `confirm`; the web server currently does this and the spec's `Web dashboard > Authorization` section describes the fix.

### Harness adapters

[src/sessions/harness.ts](src/sessions/harness.ts) defines one `HarnessAdapter` per supported CLI, exported as the `adapters` record.
Each declares binary name, detection, profile env vars, interactive vs headless argv, and how to write its MCP config.
Adding a harness means adding an adapter plus extending `HarnessKind` in [src/core/types.ts](src/core/types.ts).

Adapters also extract per-session telemetry (model, token usage) from harness output via their `telemetry` and `renderLine` parsers ([telemetry.ts](src/sessions/telemetry.ts)).
Each parser is harness-specific: claude reads `result` events, codex reads `turn.completed`, and opencode reads `step_finish` plus a model id on stderr.
Unknown fields stay null and render blank; they are never defaulted or averaged.

### Argus

[src/argus/manager.ts](src/argus/manager.ts) creates a manager session bound to a Mission note, then loops: plan the mission into task board rows, dispatch children into isolated worktrees, run objective gates on reported work, and invoke a short-lived `policy: 'brain'` session for planning, review, and worker questions.
The brain harness is `claude` or `codex` and worker harnesses are `opencode` or `gemini`, both selectable via `deck argus start` and persisted on the `argus` row.
A rolling token budget tiers review batching and pauses the queue near the ceiling.
A mission may instead attach to a named quota (`deck quota create`, `deck argus start --quota <id>`) so several missions, including ones in a different project, share one ceiling and rolling window through a small global store at `$FLIGHTDECK_HOME/quotas.db`; see [src/argus/quota.ts](src/argus/quota.ts). A real provider rate-limit response, detected heuristically per harness ([src/sessions/harness.ts](src/sessions/harness.ts)), sets a throttle that every mission on the same quota observes before its next brain call, independent of the self-imposed token ceiling.
Failed gates or review rejections return the task to the same worker session in the same worktree for a revision, up to `max_attempts_per_task`.
Review is two-tier: tier 1 sees only summaries and diffstat, while tier 2 may read bounded, non-secret files from the worker worktree via [review-files.ts](src/argus/review-files.ts).
Children run with `policy: 'child'` and never spawn a further generation.
Worker questions and `report_done` wake the scheduler independently of the mission pulse.

### Playbooks

YAML workflows parsed into a validated AST ([parser.ts](src/playbooks/parser.ts)) and run by [engine.ts](src/playbooks/engine.ts).
The engine takes an `EngineServices` bundle, so step types reach tables, notes, messaging, and MCP tools without importing them directly.
Steps reference earlier output via `{{ steps.<id>.output }}` templating; secrets resolve at runtime from Keychain via `{{ secrets.NAME }}` and must never land in outputs or logs.
Three playbooks ship built in, in [templates.ts](src/playbooks/templates.ts).

## Conventions

Strict TypeScript ESM throughout.
Relative imports carry the `.js` extension, because output is native ESM.

Errors surface as thrown `Error` with a human-readable message; the CLI catches at the top level in [src/cli/index.ts](src/cli/index.ts) and MCP tool handlers convert to `isError` responses.

Every list and detail CLI command supports `--json`.

## Known state

The web dashboard in [src/web/public/](src/web/public/) currently renders hardcoded sample data copied from a reference screenshot and mixes it into live session lists.
The spec's `Prohibited: fabricated data` section forbids this and remediation is planned.
Do not add to that pattern, and do not treat the existing mock arrays as a model to follow.
