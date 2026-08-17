# Security Policy

## Supported versions

Flightdeck is pre-1.0 (currently `0.1.0`).
There is no long-term support branch; only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability.

Instead, use [GitHub's private vulnerability reporting](https://github.com/navaneethbv/flightdeck/security/advisories/new) for this repository ("Security" tab → "Report a vulnerability").
Include the affected file(s) or command, the impact, and steps to reproduce.

There is no fixed SLA at this stage of the project, but reports will be acknowledged and triaged as soon as possible.

## Scope

Flightdeck runs coding-agent CLI processes locally and exposes a per-session MCP server and an optional local web dashboard.
Security-relevant areas most worth scrutiny:

- Session token isolation between concurrent agent sessions ([src/mcp/server.ts](src/mcp/server.ts)).
- MCP tool permission gating by risk level ([src/mcp/tools.ts](src/mcp/tools.ts)).
- The web dashboard's capability-token authorization ([src/server/index.ts](src/server/index.ts)), which binds to `127.0.0.1` only.
- Secret handling for integrations and playbooks ([src/secrets/keychain.ts](src/secrets/keychain.ts)).

See [CLAUDE.md](CLAUDE.md) for the fuller architecture and security-model notes.
