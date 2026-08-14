# Flightdeck: control plane for coding agents

## Status

Revision 2, 2026-08-14.
Supersedes revision 1 (approved 2026-08-14), which scoped the product to a CLI with a read-only TUI and listed any GUI as a non-goal.

Source material, both third-party and kept out of version control:

- `Scape.work Documentation Deep Research: How the App Works.pdf` for behavior and feature model.
- The Scape macOS app screenshot supplied 2026-08-14 for the target UI layout.

Scape is a separate commercial product.
It is the research subject, not this project, and Flightdeck is not affiliated with it.

Target shape: a local TypeScript control plane with a CLI, a per-session MCP server, and a **web GUI dashboard** that reproduces the layout of the reference screenshot.
Per user decision, the GUI is a web app, not a native macOS app.

### What changed in revision 2

- The web GUI moved from unlisted to a first-class goal.
  Revision 1 named "Native macOS UI" as a non-goal and did not mention a web UI at all, while `src/server` and `src/web` were already built.
- The read-only Ink TUI is demoted to a secondary surface.
  The web dashboard is the primary interactive surface.
- Session telemetry (model, cost, progress) is now a required backend capability.
  The reference screenshot shows it per session, and it had no backend at all.
- Surfaces that were built without spec coverage are now specified: the `gemini` harness, watchdog, session export and log streaming, worktree status/diff/merge, and project repair.
- The stack section is corrected to match reality: `node:sqlite`, not `better-sqlite3`; Node 22.5+, not Node 20+.

## Executive summary

Flightdeck is a local control plane for AI coding-agent CLIs.
It runs installed harnesses (Claude Code, Codex, OpenCode, Gemini) inside isolated Git worktrees, and exposes an MCP server with roughly forty tools covering sessions, worktrees, notes, tables, agent messaging, playbooks, integrations, SSH, watchdog, and repair.
An Argus-style orchestrator manages a fleet of child sessions from a Mission note.

Users drive it three ways: a `deck` CLI, a local web dashboard, and a read-only TUI.

The product is local-first.
Code, sessions, and state live on the Mac.
There is no hosted middle tier.

## Goals

- Run four coding-agent harnesses in isolated Git worktrees from one control plane.
- Provide a per-session MCP server that agents call to manage their own project resources.
- Provide structured notes and tables as agent-accessible project memory.
- Provide a playbooks engine for reusable multi-step workflows.
- Provide read-oriented Jira, GitHub, and Slack integration tools with opt-in credentials.
- Provide SSH session tools.
- Provide an Argus orchestrator driven by a Mission note with a pulse loop.
- Provide a web dashboard matching the reference screenshot: project tree, Mission editor, live fleet panel, and Toolkit grid.
- Track real per-session telemetry (harness, model, token cost, progress) and surface it in the fleet panel.
- Provide a command-driven CLI and a read-only TUI dashboard.

## Non-goals (deferred or out of scope)

- Native macOS UI, including Monaco editor, embedded terminal, and real window chrome.
  The web dashboard imitates the reference layout; it does not reimplement AppKit.
- Embedded browser automation (Browser Companion) and Injected WebMCP.
- Dev servers and port allocation.
  The reference screenshot shows a `V3 Dev Server` Toolkit button; in this product that is an ordinary playbook, not a managed server lifecycle.
- E2E encrypted chat, backchannels, and Rendezvous.
  The reference screenshot shows a `Rendezvous` button; it is out of scope and must not be rendered as a working control.
- iCloud/CloudKit sync and note attachments.
- Enterprise SSO/SCIM/RBAC.
- Cloud or remote orchestration hosting.
- Multi-project management from one dashboard instance.
  The reference screenshot shows a multi-project tree; v1 serves a single project root per server process and renders that project's real sections.

## Prohibited: fabricated data

The dashboard must never display invented values as if they were real.
This rule exists because revision 1's implementation hardcoded eleven fake sessions from the screenshot and merged them into the live session list.

Specifically:

- No mock, sample, or placeholder entities in any list that also contains real entities.
- No fabricated metrics for real entities.
  A metric that is not measured is rendered as an inert dash, never as a plausible number.
- No success indication for an operation that failed or errored.
- No synthesized log text when a log fetch fails.
  Failure is rendered as a visible error.
- No hardcoded project, account, or session names copied from the reference screenshot.
  The screenshot is a layout reference, not a data fixture.

## Architecture

### Stack

- TypeScript (ESM), Node 22.5+.
  Node 22.5 is the floor because state uses the built-in `node:sqlite`.
- Single npm package.
- `node:sqlite` (`DatabaseSync`) for structured state, with no native-module dependency.
- `commander` for CLI parsing.
- React + Ink for the TUI dashboard.
- Plain HTML, CSS, and ES modules for the web dashboard, served by a `node:http` server.
  No frontend build step and no framework dependency.
- Official `@modelcontextprotocol/sdk` for the MCP server.
- Child agent processes via `child_process`.
  Interactive sessions inherit the user's terminal.
  Argus children run headless and non-interactive.
- Secrets in macOS Keychain via the `security` CLI, with env-var fallback.
- `vitest` for tests.
- `eslint` for lint.
- `tsc --noEmit` for typecheck.

### Process model

Three entry points over one shared core library:

- `deck` CLI.
- `deck mcp serve` MCP server.
- `deck ui` web dashboard server.

The CLI spawns each harness with a per-session token and a harness-specific MCP configuration that points the harness at its own `deck mcp serve --session <id> --token <token>` process.

The web dashboard server is a thin HTTP and SSE layer over the same core library.
It holds no state of its own and duplicates no business logic.
Any behavior reachable from the dashboard must also be reachable from the CLI.

### Directory layout

Global:

- `~/.flightdeck/config.json`: default harness, per-harness profile dirs, Argus defaults.
- `~/.flightdeck/logs/`: log files.
- `~/.flightdeck/playbooks/`: optional global playbooks.

Per project (primary repo root):

- `<project>/.flightdeck/state.db`: sessions, tables, messages, Argus state, playbooks, notes index, integration cache.
- `<project>/.flightdeck/notes/`: markdown notes plus gitignored version snapshots.
- `<project>/.flightdeck/worktrees/<name>/`: Git worktrees.
- `<project>/.flightdeck/playbooks/<name>.yml`: project playbooks.
- `<project>/.flightdeck/hooks/post-create/*.sh`: post-create worktree hooks.

### Isolation model

Every session has a secret token.
When the CLI spawns a harness, it sets `FLIGHTDECK_SESSION_TOKEN` and configures the harness's MCP to call `deck mcp serve --session <id> --token <token>`.
The MCP server rejects any request that does not present the matching token.
A session can only touch its own worktree, its own notes, and its own tables.
PID-lineage verification is optional hardening, not a v1 requirement.

## Sessions and worktrees

### Sessions

Commands:

- `deck session start [--harness claude|codex|opencode|gemini] [--worktree <name>] [--worktree-new]`
- `deck session list`
- `deck session stop <id>`
- `deck session restart <id>`
- `deck session logs <id>`
- `deck session follow <id>`
- `deck session export <id>`

Behavior:

- Interactive mode spawns the harness with stdio inherited into the user's terminal, in the session's worktree or project root.
- A session row in `state.db` records id, name, harness, worktree path, cwd, pid, status (running/stopped/failed), started, ended, and last activity.
- Stopped sessions keep state and can be restarted.
- `deck session stop` terminates the tracked process tree.
- `deck session follow` streams the session log (spectator mode).
- `deck session export` writes a transcript of the session.

### Session telemetry

The fleet panel in the reference screenshot shows, per session, a model label, a spend figure, and a percentage.
None of that is derivable from the session row above, so it is specified here as its own capability.

A `session_telemetry` table in `state.db` records, per session:

- `model`: the model id reported by the harness, not guessed from the harness name.
- `input_tokens`, `output_tokens`, `cached_tokens`.
- `cost_usd`: computed from token counts and a per-model rate table.
- `turns`: completed assistant turns.
- `progress`: Argus-derived completion estimate for child sessions, null for sessions with no mission.
- `updated_at`.

Rules:

- Telemetry is populated by parsing harness output as it streams, per adapter.
  Each adapter declares how to extract model and usage from its own output format.
- A field the harness does not report stays null.
  Nulls render as an inert dash in every surface.
  No surface substitutes a default, an average, or an illustrative value.
- `progress` is only non-null when Argus owns the session and has recorded pulse state for it.
- The rate table lives in config so a model price change does not require a code change.
  An unknown model yields a null cost, not a zero.

### Harness adapters

Uniform interface with auto-detection of installed binaries:

- Claude Code: `claude`, profile dir via `CLAUDE_CONFIG_DIR`.
- Codex: `codex`, profile dir via `CODEX_HOME`.
- OpenCode: `opencode`, profile dir via `XDG_DATA_HOME`.
- Gemini: `gemini`, profile dir via its own config dir.

Commands:

- `deck config set-default-harness <h>`

Default harness is `claude`.

Each adapter defines:

- Binary name.
- Env vars for profile dir and MCP configuration.
- How to spawn interactive versus headless.
  Headless modes: `claude -p`, `codex exec`, `opencode run`, `gemini` headless invocation.
- How to extract telemetry from its output stream.

MCP wiring per harness:

- Claude via `.mcp.json`.
- Codex via `mcp.json`.
- OpenCode via its config file.
- Gemini via `.gemini/settings.json`.

### Worktrees

Commands:

- `deck worktree create <name>`
- `deck worktree list`
- `deck worktree status <name>`
- `deck worktree diff <name>`
- `deck worktree merge <name>`
- `deck worktree remove <name>`

Behavior:

- `deck worktree create` adds `<project>/.flightdeck/worktrees/<name>` via `git worktree add`.
- Post-create hooks run after creation.
- Hooks are shell scripts at `<project>/.flightdeck/hooks/post-create/*.sh`, run with `$FLIGHTDECK_WORKTREE` and `$FLIGHTDECK_SESSION` set.
- A non-zero hook exit fails the session start.
- `deck worktree status` reports branch, ahead/behind, and dirty state.
- `deck worktree diff` computes the diff against the base branch.
- `deck worktree merge` merges a clean worktree back and refuses on conflict or dirty state.
- `deck worktree remove` runs `git worktree remove`.

## Watchdog

Supervises running sessions and detects hung ones.

- `deck watchdog list`
- `deck watchdog inspect <id>`
- `deck watchdog kill-hung`

A session is hung when its process is alive but it has produced no log output for longer than the configured threshold.
The web dashboard surfaces hung sessions as a distinct state, not as a fabricated stall percentage.

## Repair

Recovers a project whose `state.db` has drifted from what is on disk.

- `deck doctor` checks harness detection, git version, and git repo state.
- `deck doctor repair` reconciles session rows against live PIDs and worktree rows against `git worktree list`.
- MCP `project_repair` exposes the same reconciliation.

## MCP server

### Server

- `deck mcp serve --session <id> --token <token>` runs a stdio MCP server.
- One server process per session, spawned by the harness's MCP config.
- Every request validates the token, then resolves the session's project and worktree scope.
- Read and additive tools auto-approve.
- Destructive or externally executing tools require explicit gating: CLI confirm, or Argus child policy.

### Tool families

1. Sessions: `create_session`, `list_sessions`, `get_session`, `session_status`, `session_logs`, `session_export`.
2. Worktrees: `create_worktree`, `list_worktrees`, `remove_worktree`, `worktree_status`, `worktree_diff`, `worktree_merge`.
3. Notes: `note_create`, `note_read`, `note_update`, `note_search`, `note_list`, `note_delete`.
4. Tables: `table_create`, `table_insert`, `table_query`, `table_update`, `table_aggregate`, `table_list`, `table_drop`.
5. Agent messaging: `message_send`, `message_list`, `message_poll`.
6. Integrations: `list_jira_issues`, `search_jira_issues`, `list_github_prs`, `get_github_pr`, `list_slack_messages`, `refresh_integration`, `sync_integration_to_table`.
7. SSH: `ssh_host_add`, `ssh_list_hosts`, `ssh_host_remove`, `ssh_run`.
8. Playbooks: `playbook_list`, `playbook_run`, `playbook_save`.
9. Argus: `argus_init_mission`.
10. Supervision and maintenance: `watchdog_status`, `watchdog_inspect`, `project_repair`.

Unauthenticated integration tools return a clear "integration not configured" error.
`ssh_run` is gated and streams output back.

## Web dashboard

`deck ui [--port <n>] [--project <path>] [--no-open]`, aliased `deck web`.

### Layout

Three panes, reproducing the reference screenshot:

- Left: project tree.
  Renders the real sections of the served project (notes, tables, playbooks, worktrees, sessions) plus a filter box.
  It does not render invented sibling projects.
- Center: Mission detail.
  Renders the Argus mission note for the selected manager: title, mission body, heartbeat interval, max children, child harness, and the pulse-action and permissions sections read from the note.
  Editing a control writes back to the mission note through the same path the CLI uses.
- Right: fleet panel over sessions, plus the Toolkit grid.
  Each session card shows name, status, harness, model, spend, and progress, sourced from `session_telemetry`.
  Unmeasured fields render as a dash.

### Toolkit

The Toolkit grid renders one button per playbook actually resolvable on this project: built-in playbooks plus files under `<project>/.flightdeck/playbooks/` and `~/.flightdeck/playbooks/`.
The grid is generated from that list.
It is not a fixed set of buttons copied from the screenshot.

A Toolkit run reports its true outcome.
A failed or missing playbook renders as an error with the message, never as a success state.

### Transport

- `GET /api/state` returns the full dashboard projection.
- `GET /api/events` is an SSE stream that pushes on state change.
  Polling is a fallback, not the primary path.
- Action endpoints for session start and stop, Argus start, stop, and pulse, note create and update, message send, and toolkit run.

### Authorization

The dashboard server binds to `127.0.0.1` only.

Beyond that, it is subject to the same gating as any other caller.
Revision 1's implementation constructed its tool context with `isManager: true`, `riskyTools: true`, and an auto-approving confirm, which granted full privilege to anything that could reach the port. That is corrected here:

- The server mints a session-scoped capability token at startup and prints it with the URL.
  Every `/api/*` request must present it.
- Destructive and externally-executing tools invoked from the dashboard require an explicit confirmation round trip in the UI.
  The server does not auto-confirm.
- The dashboard never receives a broader tool policy than an Argus manager session would.

## Notes

- Markdown files under `<project>/.flightdeck/notes/`.
- Version snapshots stored as `note_versions` records.
- FTS5 full-text index in `state.db`.
- MCP tools: create, read, update, search.
- Titles, bodies, and metadata returned by the tools.

## Tables

- Per-project SQLite tables in `state.db`.
- Typed columns: text, number, boolean, date.
- Optional idempotency keys.
- Relations via simple foreign-key-typed columns.
- MCP tools: create, insert, query, update, aggregate.
- Argus writes progress into the `argus_progress` table.

## Agent messaging

- Messages stored in `state.db` within the sender's project scope.
- MCP tools: `message_send`, `message_list`, `message_poll`.
- Argus uses messaging to report progress alongside the progress table.

## Playbooks

### Model

YAML DSL for reusable workflows.
Files live at `<project>/.flightdeck/playbooks/<name>.yml` or `~/.flightdeck/playbooks/`.

Step types:

- `bash`
- `llm`: one-shot prompt to a configured provider.
- `http`: GET/POST and other methods.
- `mcp`: call any flightdeck MCP tool.
- `data`: read and write tables.
- `message`: agent messaging.
- `note`: read and write notes.
- `playbook`: nested playbook, capped at depth 10.
- `wait`
- `condition`
- `manual`: human input gate.

Secrets:

- Referenced as `{{ secrets.NAME }}`.
- Resolved at runtime from Keychain.
- Never persisted into outputs or logs.

### Runner

- Parses YAML into a validated AST.
- Each step produces named outputs.
- Later steps reference earlier outputs via `{{ steps.<id>.output }}` templating.
- Sequential by default.
- Supports retries with count and backoff, condition gates, and a parallel fan-out branch construct with capped concurrency.
- Per-step timeouts.
- Failures abort by default unless `on_error: continue`.

Invocation:

- `deck playbook run <name>`.
- MCP `playbook_run`, gated.
- Nested inside another playbook.

## Integrations

- Read-oriented adapters for Jira, GitHub, Slack.
- Opt-in credentials via `deck integrations auth jira|github|slack`.
- Credentials stored in macOS Keychain, with env-var fallback.
- Jira: domain, email, API token, verified against Jira REST.
- Tools: `list_jira_issues`, `search_jira_issues`, `list_github_prs`, `get_github_pr`, `list_slack_messages`, `refresh_integration`.
- `refresh_integration` refreshes cached data in the integration cache.

## SSH

- Saved hosts.
- Authentication via SSH agent, key file, or password.
- `~/.ssh/config` is recognized.
- MCP tools: `ssh_host_add`, `ssh_list_hosts`, `ssh_run`.
- `ssh_run` streams output back and is gated.

## Argus orchestrator

Commands:

- `deck argus start [--name <n>] [--mission <note-id>] [--pulse 30s|1m|...|4h]`
- `deck argus stop <id>`
- `deck argus status`

Behavior:

- Creates a manager session bound to a Mission note.
- Pulse loop rereads the Mission note, evaluates child sessions, creates missing child worktrees and headless harness sessions up to the configured limit (2, 4, 8, or 16), and writes structured progress rows to the `argus_progress` table.
- Children auto-approve ordinary edit, write, and bash tools.
- Children deny playbooks, SSH, non-read integrations, and HTTP-executing tools by default.
- The Argus config can grant risky tools explicitly.
- Children never spawn another generation.
- `FLIGHTDECK_ARGUS_CAP` gates Argus-only MCP tools so a random session cannot impersonate the manager.

## CLI

Subcommands:

- `session`: start, list, stop, restart, logs, follow, export.
- `worktree`: create, list, status, diff, merge, remove.
- `note`: create, read, list, search, update, delete.
- `table`: create, list, insert, query, update, aggregate, drop.
- `message`: send, list, poll.
- `playbook`: list, run, save.
- `integration`: auth, refresh, status, sync, deauth.
- `ssh`: add, list, remove, run.
- `argus`: init, start, stop, status.
- `watchdog`: list, inspect, kill-hung.
- `mcp serve`
- `ui` (alias `web`): the web dashboard.
- `tui`: the read-only Ink dashboard.
- `config`: get, set-default-harness, set-profile-dir, path.
- `doctor`: checks harness detection, git version, and git repo state; `doctor repair` reconciles state.

Every list and detail command supports `--json`.

## TUI dashboard

- `deck tui`.
- React + Ink.
- Read-only.
- Secondary to the web dashboard, kept for terminal-only contexts.
- Shows the sessions table, the live Argus fleet tree, recent messages, and a log tail.
- Actions go through the CLI.

## Repository hygiene

- `.mcp.json` at the project root is generated per session and contains a live session token and machine-specific absolute paths.
  It is gitignored and never committed.
- The same applies to any generated harness config: `mcp.json`, `opencode.json`, `.gemini/settings.json`.

## Testing

Unit tests (`vitest`):

- Harness adapter spawn logic.
- Worktree hooks.
- Playbooks parser and engine.
- Tables and notes APIs.
- Token isolation: a request with a wrong token is rejected.
- Telemetry extraction per adapter, including the case where the harness reports no usage and the fields stay null.
- Cost computation, including an unknown model yielding null rather than zero.

Integration tests (scripted):

- Create worktree, run post-create hook, spawn a real harness headless with MCP configured, call an MCP tool.
- Assert isolation between two sessions.
- Skippable when harness binaries are not installed.
- Dashboard API rejects a request with no capability token.
- Dashboard toolkit run of a missing playbook returns an error status, and the client renders an error.

E2E test:

- Disposable git repo fixture.
- Argus spawns two children and records progress.
- Dashboard served against a fixture project renders only that project's real entities.
  The rendered session list length equals the real session count.

Gates:

- `npm run lint`.
- `npm run typecheck`.
- `npm test`.
