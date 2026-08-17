# Flightdeck (`deck`)

> **Terminal & Web Control-Plane for AI Coding Agents** — Run, isolate, supervise, and orchestrate fleets of coding-agent harnesses (Google Gemini, Claude Code, OpenAI Codex, OpenCode) across Git worktrees with MCP tools, structured project memory, and autonomous Argus orchestration.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.5.0-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Protocol%20v1.12-purple.svg)](https://modelcontextprotocol.io/)

---

## ⚡ Overview

**Flightdeck** (`deck`) provides a local, terminal-first and browser-ready control plane for AI coding agents. It runs coding-agent CLI binaries inside isolated Git worktrees, exposes a rich Model Context Protocol (MCP) server over stdio for agents to interact with project state, and orchestrates multi-agent fleets driven by structured Mission notes.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           Flightdeck Control Plane                          │
├──────────────────────────┬──────────────────────────┬───────────────────────────┤
│  CLI & TUI Interfaces    │  Web GUI Dashboard       │  Argus Multi-Agent Fleet  │
│  • deck session / work  │  • 3-Column Dark UI      │  • Mission Note Driven    │
│  • deck tui (Ink/React) │  • Real-time SSE Sync    │  • Pulse Execution Loop   │
│  • deck doctor / repair │  • Action Toolkit        │  • Task Auto-Staffing     │
├──────────────────────────┴──────────────────────────┴───────────────────────────┤
│                             MCP Server & Engine Core                            │
│  • Per-Session Token Auth • Policy Matrices (child / default / manager)         │
│  • Watchdog Health Monitor • Structured Notes & SQLite Tables • Playbook Engine │
├─────────────────────────────────────────────────────────────────────────────────┤
│                              Harness Adapters Layer                             │
│       Google Gemini    │   Anthropic Claude   │   OpenAI Codex   │   OpenCode   │
└────────────────────────┴──────────────────────┴──────────────────┴──────────────┘
```

---

## 🚀 Key Capabilities

- **Multi-Harness Support**: First-class adapters for **Google Gemini** (`gemini`), **Claude Code** (`claude`), **Codex** (`codex`), and **OpenCode** (`opencode`) with auto-detection, custom config profiles, and dual MCP configuration writing (`.mcp.json` and `.gemini/settings.json`).
- **Isolated Worktrees**: Branch-isolated Git worktrees preventing file-edit collisions between parallel agents, with post-create lifecycle hooks, status inspection, diff generation, and clean merge checks.
- **Per-Session MCP Server**: 40 agent tools covering worktrees, notes, tables, messaging, playbooks, integrations, and SSH execution, protected by cryptographic session tokens and security policy matrices.
- **Argus Multi-Agent Orchestration**: Autonomous fleet manager driven by Markdown Mission notes, staffing child subagents in dedicated worktrees with pulse cadence loops and completion deduplication.
- **Watchdog Supervision**: Proactively detects hung/stuck sessions, loops, and interactive permission prompts (`[y/N]`), with auto-kill and inspection capabilities.
- **Structured Project Memory**:
  - **Markdown Notes**: Versioned notes with FTS5 full-text search, snippet extraction, and disk persistence.
  - **Typed Tables**: Dynamic SQLite tables with schema definition, idempotency keys, SQL-like queries, and aggregations (`count`, `sum`, `avg`, `min`, `max`).
- **Playbook Engine**: Declarative YAML workflows with sequential, condition, parallel branches, and built-in templates (`ci-check`, `code-review`, `sync-tasks`).
- **Integrations**: Read-oriented Jira, GitHub, and Slack integrations with untrusted content framing (`<<<UNTRUSTED_CONTENT>>>`) for prompt-injection mitigation and direct SQLite table syncing.
- **Dual Interfaces**:
  - **Interactive Web Dashboard (`deck ui`)**: Three-column dark-mode dashboard with real-time SSE streaming, mission editing, live logs, and a Toolkit generated from the playbooks that resolve on the project. Values the backend does not measure render as an inert dash rather than a placeholder number.
  - **Terminal TUI Dashboard (`deck tui`)**: Multi-tab Ink/React dashboard for terminal monitoring.

---

## 📦 Installation & Requirements

### Requirements
- **Node.js**: `v22.5.0` or higher
- **Git**: `2.30+` installed on system `PATH`
- **Agent Harnesses** *(optional, at least one recommended)*:
  - Google Gemini CLI (`gemini`)
  - Claude Code (`claude`)
  - OpenAI Codex (`codex`)
  - OpenCode (`opencode`)

### Install from Source
```bash
# Clone the repository
git clone https://github.com/navaneethbv/flightdeck.git
cd flightdeck

# Install dependencies
npm install

# Build TypeScript and static assets
npm run build

# Link globally for the `deck` CLI command
npm link
```

---

## 🏁 Quickstart

### 1. Check Environment & Self-Heal
```bash
# Run diagnostics to check git and detected agent harnesses
deck doctor --fix
```

### 2. Launch an Agent Session
```bash
# Start an interactive session with Gemini (or Claude / Codex / OpenCode)
deck session start my-feature --harness gemini

# Start a headless background session in a new isolated worktree
deck session start bugfix-123 --harness gemini --worktree-new bugfix-branch --headless --task "Fix memory leak in parser"
```

### 3. Launch the web dashboard
```bash
# Opens the real-time 3-column dashboard in your default browser.
# deck ui prints the URL with a per-process capability token embedded in the
# fragment, e.g. http://127.0.0.1:4173/#token=..., and the dashboard stays
# behind a login screen until the token is presented. Every /api/* request
# must carry it; static assets load without it so the page can show the gate.
deck ui
```

### 4. Initialize an Autonomous Argus Mission
```bash
# Scaffold a structured Mission note using a template
deck argus init vector-search --template feature --title "Implement Vector Search"

# Start the Argus fleet manager loop in the foreground
deck argus start --name vector-search --mission vector-search-mission --pulse 30s --children 4

# Select a Codex brain with an OpenCode worker, budget, and models
deck argus start \
  --name codex-opencode \
  --mission <note-id> \
  --brain-harness codex \
  --brain-plan-model gpt-5.6-sol \
  --brain-review-model gpt-5.6-terra \
  --worker-harness opencode \
  --budget-window 2h \
  --budget-max-tokens 250000
```

---

## 📖 CLI Command Reference

### Sessions & Worktrees
| Command | Description |
| :--- | :--- |
| `deck session start [name] [options]` | Start interactive or headless agent session (`--harness <gemini\|claude\|codex\|opencode>`, `--worktree <name>`, `--worktree-new <name>`, `--headless`, `--task <prompt>`) |
| `deck session list [--json]` | List all tracked sessions with statuses and worktree bindings |
| `deck session stop <id>` | Gracefully terminate a session process tree |
| `deck session restart <id>` | Restart an existing session |
| `deck session logs <id> [--tail <n>]` | View output logs from a session |
| `deck session follow <id>` | Stream logs in real-time (*Spectator Mode*) |
| `deck session export <id> [--out <file>]` | Export complete session bundle (status, logs, diffs, notes, messages) |
| `deck worktree create <name>` | Create an isolated Git worktree and run post-create hooks |
| `deck worktree list [--json]` | List all active worktrees and branches |
| `deck worktree status <name>` | Inspect modified files, untracked files, and commits ahead/behind |
| `deck worktree diff <name> [--base <branch>]` | Compute full git diff against base branch |
| `deck worktree merge <name> [--dry-run]` | Merge completed worktree branch back into main |
| `deck worktree remove <name>` | Remove a Git worktree |

### Argus Multi-Agent Orchestrator
| Command | Description |
| :--- | :--- |
| `deck argus init <name> [options]` | Scaffold a Mission note (`--template <feature\|refactor\|audit\|bugfix>`, `--title <title>`) |
| `deck argus start [options]` | Start the Argus fleet loop (`--mission <note-id>`, `--pulse <duration>`, `--children <n>`, `--risky-tools`, `--brain-harness <claude\|codex>`, `--brain-plan-model <model>`, `--brain-review-model <model>`, `--worker-harness <opencode\|gemini>`, `--budget-window <duration>`, `--budget-max-tokens <count>`, `--conventions <note-id>`, `--quota <id>`) |
| `deck argus status [id] [--json]` | View fleet hierarchy, active children, and pulse progress |
| `deck argus stop <id>` | Stop an Argus fleet and terminate all child subagents |
| `deck argus pause <id>` | Pause a running mission without ending it |
| `deck argus resume <id>` | Resume a paused mission |
| `deck quota create <id> --max-tokens <count> --window <duration>` | Create a named token budget pool that multiple missions, in this project or others, can attach to with `--quota` |
| `deck quota list` / `deck quota show <id>` | List or inspect quotas |
| `deck argus budget <id> [--json]` | Show brain token spend, review queue depth, and the next rolling reset |

### Argus behavior notes

- `--conventions <note-id>` binds a project conventions note into every plan, answer, and `task_get` call.
- Reported work runs objective gates first (tier 0); a failure returns the task to the same worker session in the same worktree for a revision, up to `--max-attempts`.
- Review is two-tier: tier 1 (tier `brain-review-model`) sees only summaries and diffstat, and tier 2 (tier `brain-plan-model`) may read bounded, non-secret files from the worker worktree only when `need_files` is returned.
- The token budget degrades by spend: below 60% reviews one task at a time, 60-80% batches four, 80-95% batches everything once four tasks queue or a task ages 30 minutes, and at or above 95% reviews pause. `force-review` may ignore the pause and batching below 100% but never the ceiling.
- Worker questions are answered independently of the mission pulse, so `ask_manager` is not delayed by a long `--pulse`.
- `--quota <id>` attaches a mission to a named, shared token budget pool created with `deck quota create`, instead of the mission owning its own `--budget-window`/`--budget-max-tokens`; the two are mutually exclusive. Every mission attached to the same quota, in this project or a different one, shares one ceiling and one rolling window.
- A real rate-limit response from the brain harness sets a throttle on the mission's quota (or the mission itself, if unattached) that every attached mission observes immediately, skipping brain calls until it clears, distinct from and in addition to the self-imposed token ceiling.
- `deck argus pause`/`resume` suspends and resumes a mission without ending it; workers already dispatched keep running, but no new dispatch, gate draining, review, or brain call happens while paused.
- A `.flightdeck/hooks/on-event/*.sh` script, run the same way as an existing post-create hook, fires on every mission progress event (`task_blocked`, `brain_abandoned`, `argus_paused`, a quota entering `throttled`, and others) with `FLIGHTDECK_EVENT`, `FLIGHTDECK_ARGUS_ID`, `FLIGHTDECK_SESSION`, and `FLIGHTDECK_MESSAGE` set.

### Fleet Window & Controls
| Command | Description |
| :--- | :--- |
| `deck fleet` | Create the tmux window, reconcile worker panes, and attach |
| `deck fleet console` | Interactive control pane with selectable workers and tasks |
| `deck fleet claim <session-id> [--json]` | Take over a worker in its pane |
| `deck fleet release <session-id> [--resume] [--json]` | End a claim and return the pane to the log |
| `deck fleet kill <session-id> [--yes] [--json]` | Stop a worker and block its active task while preserving the worktree |
| `deck fleet worker start --argus <id> [--json]` | Spawn one worker for the highest-priority dispatchable task |
| `deck fleet override accept\|reject\|unblock\|prioritize <task-id> [reason] --argus <id> [--json]` | Human overrides of brain decisions |
| `deck fleet override force-review --argus <id> [--json]` | Drain the review queue now, below the budget ceiling |

Every console action calls the same `FleetActions` service as its CLI equivalent.

Console keys (Tab switches between the Workers and Tasks lists, arrows move the selection):

| Key | Action |
| --- | --- |
| `Tab` | Switch worker/task focus |
| Up/Down | Move the current selection |
| `c` | Claim selected worker |
| `r` | Release selected worker without headless resume |
| `R` | Release selected worker and resume headless |
| `k` | Confirm, then kill selected worker and block its task |
| `n` | Spawn a worker for the next dispatchable task |
| `a` | Accept selected task |
| `x` | Enter a reject reason, then reject selected task |
| `u` | Unblock selected task |
| `p` | Prioritize selected task |
| `f` | Force review for the selected fleet |
| `q` | Quit only when no confirmation or text input is active |

The console drives a single fleet.
With zero or more than one Argus row it shows an error and directs the operator to the CLI with `--argus <id>`.
Pressing `n` spawns a worker for the highest-priority dispatchable task whether or not a worker is currently selected.
`deck fleet kill <session-id>` prompts for confirmation on a terminal and requires `--yes` in a non-interactive process.
Kill preserves the worktree and blocks the active task so a human can inspect it before unblocking.
Task overrides require an explicit `--argus <id>` when more than one fleet exists; the newest fleet is never guessed.

### Watchdog Supervisor
| Command | Description |
| :--- | :--- |
| `deck watchdog list [--timeout <sec>]` | List hung or inactive sessions exceeding threshold |
| `deck watchdog inspect <id>` | Inspect session health, recent logs, and waiting interactive prompts (`[y/N]`) |
| `deck watchdog kill-hung [--timeout <sec>]` | Stop all frozen/hung agent sessions |

### Structured Memory (Notes & Tables)
| Command | Description |
| :--- | :--- |
| `deck note create <title> <body>` | Create a versioned Markdown note |
| `deck note read <id>` | Read latest note content |
| `deck note update <id> [options]` | Update note title or body (increments version) |
| `deck note search <query>` | Full-text search with context snippet extraction |
| `deck note list` / `deck note delete <id>` | List or delete notes |
| `deck table create <name> --cols <def> [--key <col>]` | Create typed SQLite table |
| `deck table insert <name> --data <json>` | Insert row into table |
| `deck table query <name> [--where <expr>]` | Query table rows with filters |
| `deck table aggregate <name> --fn <count\|sum\|avg\|min\|max>` | Perform aggregate calculations |
| `deck table list` / `deck table drop <name>` | List or drop project tables |

### Playbooks & Automation
| Command | Description |
| :--- | :--- |
| `deck playbook list` | List available project and built-in playbooks (`ci-check`, `code-review`, `sync-tasks`) |
| `deck playbook run <name> [--input <json>]` | Execute a playbook workflow |
| `deck playbook save <name> <file.yml>` | Save a playbook from a YAML file |

### Integrations & Tools
| Command | Description |
| :--- | :--- |
| `deck integration auth <jira\|github\|slack>` | Securely store integration credentials in Keychain |
| `deck integration sync <jira\|github\|slack>` | Sync external issues/PRs/messages into typed tables |
| `deck integration status` / `deck integration deauth <kind>` | Inspect or revoke integration credentials |
| `deck ssh add <name> --host <host>` / `deck ssh run <name> <cmd>` | Manage saved SSH hosts and remote commands |
| `deck message send --to <id> <body>` / `deck message poll` | Inter-agent mailbox messaging |

### User Interfaces & Diagnostics
| Command | Description |
| :--- | :--- |
| `deck ui` / `deck web [--port <port>]` | Launch the interactive Flightdeck Web Control Plane (protected by a capability token printed with the URL) |
| `deck tui` | Open the interactive 3-tab terminal dashboard |
| `deck login [harness...]` | Authenticate your coding-agent harnesses (`claude`, `codex`, `opencode`, `gemini`); `--check` reports auth status without running a login flow |
| `deck doctor [--fix]` | Run environment diagnostics and repair state issues |
| `deck repair` | Self-heal project directories, dead sessions, and worktree references |
| `deck config set-default-harness <harness>` | Set global default harness (`gemini`, `claude`, `codex`, `opencode`) |
| `deck config set-profile-dir <harness> <dir>` | Set custom profile/config directory |

---

## 🛠 MCP Server Tools Reference

When spawned by `deck`, each coding agent harness connects to `deck mcp serve --session <id> --token <token>` over stdio.

### Available MCP Tool Families:
- **Sessions & Worktrees**: `create_session`, `list_sessions`, `get_session`, `list_worktrees`, `create_worktree`, `remove_worktree`, `worktree_status`, `worktree_diff`, `worktree_merge`, `session_status`, `session_logs`, `session_export`.
- **Project Notes**: `note_create`, `note_read`, `note_update`, `note_search`, `note_list`, `note_delete`.
- **Structured Tables**: `table_create`, `table_insert`, `table_query`, `table_update`, `table_aggregate`, `table_list`, `table_drop`.
- **Inter-Agent Mailbox**: `message_send`, `message_poll`, `message_list`.
- **Argus & Watchdog**: `argus_init_mission`, `watchdog_status`, `watchdog_inspect`, `project_repair`.
- **Playbooks & Execution**: `playbook_list`, `playbook_run`, `playbook_save`, `ssh_host_add`, `ssh_list_hosts`, `ssh_host_remove`, `ssh_run`.
- **Integrations**: `list_jira_issues`, `search_jira_issues`, `list_github_prs`, `get_github_pr`, `list_slack_messages`, `refresh_integration`, `sync_integration_to_table`.

---

## 🧪 Testing & Validation

Flightdeck maintains a comprehensive test suite across unit, integration, and end-to-end tiers:

```bash
# Run TypeScript compilation check
npm run typecheck

# Run ESLint validation
npm run lint

# Run all Vitest suites (14 suites, 50 tests)
npm test
```

---

## 📄 License

Not yet licensed. Add a `LICENSE` file before distributing.
