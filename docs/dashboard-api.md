# Dashboard request and approval contract

The dashboard binds to `127.0.0.1` and every `/api/*` request requires the startup capability token in `X-Flightdeck-Token`.
Only the SSE endpoint accepts that token in its query string.
Session tokens and Argus manager capabilities never appear in dashboard responses, including creation responses.

JSON request bodies must be objects and may contain at most 1 MiB of UTF-8 bytes.
Malformed JSON and non-object values return `400`; oversized bodies return `413` before any state mutation.
Errors are JSON objects with an `error` string.
Unknown API routes return `404` JSON instead of the dashboard HTML.

Toolkit actions select a playbook by name from the built-in, project, or global playbook directory.
Paths and links outside those directories are rejected.
Nested project and global playbooks follow the same resolution and approval rules.

`POST /api/toolkit/run` returns `202` with a `runId`.
Poll `GET /api/toolkit/run/<runId>` for `running`, `awaiting_confirmation`, `succeeded`, or `failed`.
Destructive or external MCP tools and direct shell, HTTP, and model steps suspend for a human decision before executing.
The approval describes the step and binds a single-use challenge to its resolved arguments without sending those arguments or embedded secrets to the browser.
Parallel steps queue their prompts so each decision can be made separately.

Submit `{ confirmId, operation, ok }` to `POST /api/toolkit/confirm`.
Only `ok: true` approves; mismatched operations return `400` and consumed or expired challenges return `404`.
Unanswered prompts expire after five minutes.
Server shutdown denies outstanding and queued prompts.

The session panel provides named buttons to inspect logs and stop running sessions after confirmation.
Stopping uses the existing `POST /api/sessions/<id>/stop` operation and the same session manager as `deck session stop`.
CLI health and repair commands use the same success status and exit code in text and JSON modes.
