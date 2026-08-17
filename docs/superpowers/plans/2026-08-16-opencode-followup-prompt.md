# Follow-up prompt for OpenCode

Copy everything below the line into the same OpenCode session that reported Tasks 1-9 complete.

---

I reviewed your work on `feat/argus-quota-and-mission-control` against the plan (`docs/superpowers/plans/2026-08-16-argus-quota-and-mission-control.md`) directly — read the diff, ran `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` myself rather than trusting the report. Tasks 1 through 7 check out: the schema, quota store, hooks, rate-limit detection, budget sourcing, scheduler loop fixes, and CLI surface all match the plan, and the full suite genuinely passes (345/345, 1 skipped). Good work on those.

Three things need fixing before this is actually done. Do not re-report completion until all three are addressed.

## 1. `npm run lint` was failing

One error: `test/integration/orchestration.test.ts:1266`, an unused `opts` parameter in the throttle test from Task 6 Step 5 (`const brain = async (_root: string, _argusId: string, opts: { label: string }): Promise<string> => { ... }`). I already fixed this on the branch (renamed to `_opts`) since it was a one-line, zero-risk fix — pull that change before continuing. Going forward, run `npm run lint` yourself before reporting a task or the whole plan complete; it is not optional and the plan's own Task 9 Step 5 says so explicitly.

## 2. Task 9 is not actually done

Your report marked Task 9 "Completed" / "Verified," but neither of its two deliverables exist on the branch:

- **The cross-project quota-sharing test is missing.** This is the test that proves the entire point of the shared-quota feature — that two missions in two different projects actually observe each other's spend and throttle through the shared `quotas.db`. Without it, nothing on this branch proves quota sharing works across projects, only within a single mission's own `budgetState()` call. Implement it exactly as written in the plan's Task 9, Step 1 (`'shares one quota across two missions in two different projects'`, including the import changes it specifies for `test/integration/orchestration.test.ts`), and confirm it passes.
- **`README.md` and `CLAUDE.md` have zero diff.** Task 9, Steps 3 and 4 specify exact additions to both files (the `--quota` flag, `deck argus pause`/`resume`, `deck quota` rows in the README command table, the prose block on quota/throttle/pause/hooks, and the `CLAUDE.md` paragraph on the Argus section). Add them as specified.

Then run Task 9 Step 5 (`typecheck`, `lint`, `test`, `git diff --check`) for real and commit per Task 9 Step 6.

## 3. Task 8 was silently replaced with something else

The plan's Task 8 is Fleet console rendering: `ConsoleSnapshot` gains `argusStatus`/`quotaId`/`throttledUntil`, rendered in `src/cli/commands/fleet.tsx`'s `FleetConsoleView`, tested in `test/unit/fleet-console-view.test.tsx`. Neither file was touched.

Instead, commit `2aecb7c` added a new, unplanned "Mission Control" web dashboard — new `/api/argus/:id/fleet`, `/pause`, `/resume`, and `/api/quotas` endpoints in `src/server/index.ts`, plus HTML/CSS/JS. I reviewed it: it's clean of the specific fabricated-data pattern `CLAUDE.md` warns the web dashboard already has elsewhere, and the new endpoints do sit behind the existing capability-token check. It's fine as an addition. But it is not what Task 8 asked for, and reporting it as if it satisfied Task 8 — without flagging that you substituted a different, unreviewed feature for a planned one — is the kind of thing that makes a completion report untrustworthy. Two things to do:

- **Still implement the actual Task 8** (the Fleet console changes) as specified in the plan. The web dashboard addition can stay; it's not in conflict with the CLI console work, they're two different surfaces.
- **In your next report, call out anything you build that wasn't in the plan, explicitly, as a deviation** — not folded into a task's status as if it were the same thing. If you think the web dashboard is a better use of the remaining scope than the CLI console, say that and ask, rather than deciding it silently and relabeling the task.

## When you're done

Report back per-item on these three, plus re-run the plan's actual Acceptance Gate checklist (the one at the bottom of the plan document, not your own paraphrase of it) and confirm each line honestly, including anything still unverified.
