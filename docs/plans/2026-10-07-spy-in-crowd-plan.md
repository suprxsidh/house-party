# Spy in the Crowd Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. A builder, then a reviewer, per task. Up to 3 builders at once, each in its own git worktree.

**Goal:** add game 6 to the house-party platform, deployed before the freeze.
**Spec:** `docs/specs/2026-10-07-spy-in-crowd-design.md`. Read it first. It wins over this plan.
**Platform guide:** `docs/PROTOCOL.md` and `games/stub`. Follow the same game layout as `games/tilt` (it has a server part with secrets).
**Stack:** TypeScript, three.js, Socket.IO, the existing bot harness.

## Spec card
1. Folder: `games/spy/{host,phone,server,test}`. Register with one line in each `games/*.registry.ts`.
2. Do not change other games. Touch shared platform files only if unavoidable, and then add tests.
3. Token budget: about 800k total. Alert at 650k.
4. FREEZE: the last push to `main` is 2026-10-08 18:00 IST (check with `TZ=Asia/Kolkata date`). After that, no pushes, because each push restarts Render and wipes rooms.
5. Each task ends with a commit and a line in `docs/STATUS.md`.

## Global constraints
- Free hosting only. No new paid services. No new runtime dependencies without a reason in STATUS.md.
- No secrets in the repo. `.env` is never committed.
- Phone names and any user text go through `textContent`.
- Use primitive shapes. No art files.
- Keep docs short: report 400 words, README section 150 words.

## Review focus (add a test for each in the owning task)
1. A player drops mid-round and rejoins. Expect the same role and walker.
2. Two ACT presses in the same tick on one target. Expect one result, no double points.
3. An out player sends ACT or move. Expect it ignored.
4. A phone sends `spy:act` or `spy:role` pretending to be the TV or server. Expect it ignored.
5. Only 4 players, only 10 players. Expect correct assassin counts and a full crowd of 40.

## Step 0 (the orchestrator does this itself, under 10 minutes)
Write `games/spy/types.ts`: message names, payload types, constants (crowd 40, round 150 s, ranges, cooldowns, points). Copy values from the spec table. Commit to `main`. Builders import it.

## Tasks

| # | Task | Done when (proof) |
|---|---|---|
| S1 | **Rules and server part.** Pure rules engine (roles, ACT resolution, cooldowns, scoring, round end), server part, rotation over 3 rounds, rejoin returns the role. | Unit tests pass. Bot test: the TV never gets roles before `spy:end`. Cheat attempts (review focus 3, 4) are ignored. |
| S2 | **TV scene and crowd.** Plaza, instanced walkers, bot walkers, human walkers driven by `spy:move`, nearest-in-range picker for `spy:act`, kill and arrest effects, feed, timer, roles and scores screen, camera, `?quality=low`. | A screenshot with 40 walkers. 30 fps in a 40-walker run on this Mac. No bot stuck for 10 s. |
| S3 | **Phone part.** Role card, hold-to-peek role button, joystick, ACT with cooldown ring, own-dot minimap, out screen, rejoin. | A browser test on a phone-size viewport: the joystick sends `spy:move`, ACT sends `spy:act`, the role is hidden until held. |
| S4 | **Integrate and ship.** Merge S1 to S3. 10-bot run for 3 rounds. Re-run the full local suite. Push before the freeze. Wait for Render. Run `npm run soak` for all games, and the 10-bot spy run, on the Render URL. | A pass/fail table with evidence paths. If any older game regresses, revert the merge and push the revert before the freeze. |

S1, S2 and S3 run in parallel. S4 starts when all three have passed review.

## Task rules
- A builder writes a failing test first, then the code, then shows real output.
- A reviewer reads the diff, the spec and the test output. It checks the review-focus items of that task. It reports under 300 words.
- Use the default model for builders and reviewers. Use Opus only for S2's reviewer if it finds a perf problem.
- Gemini (`models/gemini-3.5-flash`, key in `.env`) is optional, for bulk copy only. Read its output before committing.
- Two failed fixes on one problem: alert.

## Alerts (return to the caller with a report under 150 words)
1. Spend passes 650k tokens.
2. A task fails twice. Include the exact error.
3. The freeze is under 2 hours away and S4 has not started. Say what to cut.
4. An older game regressed after the merge.
5. Done.

## Handoff
Keep `docs/STATUS.md` current. Update `CLAUDE.md`, `future_plans.md` and `PARTY_CHECKLIST.md` (add one line for Spy), and `~/brain/projects/house-party.md`.
