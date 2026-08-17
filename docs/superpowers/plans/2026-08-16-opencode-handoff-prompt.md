# Prompt for OpenCode

Copy everything below the line into OpenCode.

---

You are implementing a plan in the `flightdeck` repo (`deck`, a local control plane for AI coding-agent CLIs). Read the plan in full before touching any code:

**`docs/superpowers/plans/2026-08-16-argus-quota-and-mission-control.md`**

It covers two approved subsystem specs, linked at the top of the plan itself — read those too if anything in a task is unclear:

- `docs/superpowers/specs/2026-08-16-argus-shared-quota-design.md`
- `docs/superpowers/specs/2026-08-16-argus-mission-control-design.md`

Also read `CLAUDE.md` at the repo root before starting; it documents this codebase's architecture and conventions and takes precedence over your own defaults.

## Hard rule: never spawn a real coding-agent harness

**This is the single most important constraint in this task. Read it twice.**

`deck` orchestrates real Claude Code, Codex, OpenCode, and Gemini CLI processes. This plan's own code spawns them. **You must never let a test, a fixture, a manual check, or a CLI invocation you run while implementing this plan spawn a real `claude`, `codex`, `opencode`, or `gemini` binary against a real account.** Not once, not "just to check something works," not in a scratch script, not outside the test suite either.

Concretely:

- The repository already sets `process.env.FLIGHTDECK_FORBID_REAL_HARNESS = '1'` globally in `test/setup.ts`. **Never unset it, never comment it out, never work around it, never run a test file that bypasses `test/setup.ts`.**
- Every test in this plan that needs a harness process to run puts a **fake executable** on disk first — a `#!/bin/bash` script that echoes canned output and exits — in a temp directory that gets prepended to `PATH` for that one spawn. This pattern already exists in the repo: `makeFakeHarness()` and `makeWakingBrain()` in `test/helpers.ts` and `test/integration/orchestration.test.ts`. The plan's own tasks use this pattern throughout (Tasks 6, 7, 9 in particular) — copy it exactly, do not invent a different mechanism, and do not skip it because "it's just a quick check."
- If you want to manually exercise something outside the test suite (e.g. running `deck argus start` by hand to look at output), you must still put a fake `claude`/`codex`/`opencode`/`gemini` script on `PATH` first, exactly like the tests do. **Never point it at a real installed harness**, even one you have installed and authenticated locally for other work. This orchestrator can spend real subscription tokens and hit real rate limits within seconds of being pointed at a real binary — that is the entire failure mode Task 6 of this plan exists to guard against, and testing it with a real harness would be testing it against the exact thing it's supposed to protect.
- If you are ever unsure whether an action would spawn something real, don't do it — use a fake binary or ask instead.

## How to execute the plan

- The plan's own header names two valid execution modes: `superpowers:subagent-driven-development` or `superpowers:executing-plans`. If neither is available to you as a skill, execute task-by-task manually in the same spirit: one task at a time, in the stated dependency order (given near the top of the plan, under "Dependency order"), TDD within each task (write the failing test, confirm it fails, implement, confirm it passes), committing after each task exactly as its own "Commit" step specifies.
- Do not reorder or parallelize tasks beyond what "Dependency order" allows.
- Do not skip a task's "Run the tests and confirm they pass" step. If a test doesn't pass, fix the implementation, not the test, unless the test itself is factually wrong about this codebase (in which case say so before changing it).
- Every step's code is written out in full in the plan — there are no placeholders. If you hit a spot that seems to need judgment the plan didn't specify, stop and ask rather than guessing, especially if the guess would touch session isolation, tool permissions, or anything that could spawn a process.
- Run `npm run build` before any direct `vitest` invocation, as the plan and `CLAUDE.md` both say — the integration and e2e tests spawn the built `dist/cli/index.js`, so a stale build silently tests old code.
- Follow this repo's existing commit convention: no AI co-author trailer on any commit.
- When you finish all nine tasks, run the plan's final "Acceptance Gate" checklist against what you built and report back honestly on each line — including anything you could not fully verify.

## What to report back when done

For each task: what you changed, whether its tests pass, and anything you deviated from and why. If you got stuck on anything — including if you were ever tempted to spawn a real harness to unblock yourself and didn't — say so explicitly rather than silently working around it.
