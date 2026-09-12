# Dashboard workspace

Status: approved scope, implementation authorized with "Build it".
This extends the dashboard in the revision 2 product contract.

## Experience

The project navigation opens Notes, Tables, Worktrees, Sessions, Playbooks, or the existing Argus mission view in the center pane.
The session and toolkit sidebar stays available.
Selection is highlighted, keyboard accessible, and maintained across live state refreshes.
The layout adapts to narrow windows without hiding the workspace controls.

Notes supports browsing, creating, editing the title and Markdown source, saving, and discarding edits.
Changing notes or sections with unsaved edits requires an explicit discard decision.
Closing or refreshing the tab with an unsaved draft triggers the browser's unload protection.
Live updates must never replace a dirty editor or move its caret.
Saves carry the original note version, title, and body so an intervening change produces a conflict instead of an overwrite.
Conflicts preserve the draft and offer an explicit reload of the latest saved note.
Save failures are visible inside the editor and retain the draft.
Note content is displayed as text, never executable HTML.

Tables is read-only and displays the schema and row data in pages of 50 rows.
Next and Previous provide access to all rows with stable row-id ordering.
Long values scroll or wrap without breaking the surrounding layout.

Worktrees is read-only and displays branch, clean/dirty status, modified files, untracked files, and a textual diff.
Diff labels must describe what is actually compared.
Git failures must be visible, rather than rendered as a clean worktree or empty successful diff.
Sessions open the existing log viewer and Playbooks use the existing confirmed toolkit runner.

## Contracts and boundaries

All endpoints live under `/api/workspace` and use the existing server's capability-token gate.
The new server module uses the existing stores and Git managers.
Only resource identifiers found inside the served project may be inspected.
No arbitrary filesystem path, SQL expression, shell command, or Git revision is accepted from the browser.
No new dependency or database schema is required.
Node 22.16.0 remains the minimum runtime.

| Request | Response |
| --- | --- |
| `GET /api/workspace/notes/:id` | Existing `Note` object |
| `POST /api/workspace/notes` with `{title, body}` | Created `Note` |
| `PATCH /api/workspace/notes/:id` with `{title, body, expected: {version, title, body}}` | Saved `Note`, or HTTP 409 on conflict |
| `GET /api/workspace/tables/:name?offset=0&limit=50` | `{table, rows, offset, hasMore}` |
| `GET /api/workspace/worktrees/:name` | `{status, diff}` using existing status/diff field names |

Missing resources return 404, invalid requests return 400, oversized bodies return 413, and unexpected operational failures return 500.
Table page sizes are capped at 100 and write bodies at 1 MiB.
Errors use `{error: string}`.
Writes broadcast the existing SSE update event only after success.

## Verification

Exercise authenticated HTTP requests against disposable projects, including missing-token rejection, traversal rejection, pagination, and stale saves.
Run browser checks on populated fixtures for navigation, editing, persistence, discard cancellation, remote conflicts, table pages, worktree diffs, and narrow-screen layout.
Verify that no source string or fixture content is interpreted as HTML.
Run build, lint, typecheck, the full test suite, and the dependency audit.
Keep PR #30 separate and publish this feature as a dependent PR while its base remains unmerged.
