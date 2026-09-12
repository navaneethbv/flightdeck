# Dashboard Workspace Implementation Plan

> **For agentic workers:** Use subagent-driven-development or inline execution task-by-task.

**Goal:** Turn dashboard resource counts into an interactive project workspace.

**Architecture:** A focused server module exposes authenticated resource operations through the existing stores.
A separate browser controller owns workspace navigation and note drafts, with a small integration into the existing dashboard client.
The existing mission, log, and toolkit flows remain the entry points for those resources.

**Tech Stack:** TypeScript, built-in SQLite, vanilla browser JavaScript and CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-12-dashboard-workspace-design.md`.

## Global constraints

Node 22.16.0 remains the minimum runtime.
No new dependency or database schema is required.
All resource operations must use the served project and existing capability-token gate.
Use literal text for untrusted content.
Preserve unrelated untracked files and the existing PR branch.

## Task 1: Resource API and store guarantees

Files: `src/server/workspace.ts`, `src/server/index.ts`, `src/notes/store.ts`, `src/tables/store.ts`, and focused integration tests.
If Git inspection requires a correction, reproduce it through the CLI before changing `src/worktrees/manager.ts`.

- [x] Test each endpoint in the spec against a disposable real server.
- [x] Assert a stale save returns 409 and retains the newer saved note.
- [x] Implement request validation, bounded pagination, resource membership checks, and truthful failures.
- [x] Add optional expected note state to `NotesStore.updateNote` and serialize its comparison and write in a SQLite transaction.
- [x] Build and run the focused regression tests.

The browser consumes exactly the request and response table in the spec.
The existing note methods remain compatible for callers that do not provide an expected state.

## Task 2: Workspace UI

Files: `src/web/public/workspace.js`, `src/web/public/workspace.css`, `src/web/public/index.html`, `src/web/public/app.js`, and browser regression tests.

- [x] Add `createWorkspace({root, request, refresh, onLogs, onPlaybook})`, returning `{section, navigate, update, canLeave}`.
- [x] Wire navigation buttons to `navigate(section)` and feed each dashboard state update to `update(state)`.
- [x] Keep draft title/body separately from refreshed server state and send the original note as `expected` on save.
- [x] Preserve drafts after failures and block destructive navigation or reload until the user decides to discard.
- [x] Implement schema-aware table cells, page controls, resource loading states, and text-only Git diff rendering.
- [x] Keep async responses tied to the selection that initiated them so slower old requests cannot overwrite a newer view.
- [x] Verify these interactions in a real browser using a populated disposable project.

## Task 3: Delivery

- [x] Document the user-facing workspace controls in README.
- [x] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm audit`.
- [x] Run `graphify update .` and inspect the final diff.
- [ ] Push `feat/dashboard-workspace` explicitly and verify the remote SHA.
- [ ] Open a PR based on `fix/repository-health` while PR #30 is open, then check its remote validation results.
