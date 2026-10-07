# House Party Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. One builder, then one reviewer, per task. Never run two subagents at once.

**Goal:** a QR-join party platform with 5 games, deployed free, by the night of 2026-10-08.
**Spec:** `docs/specs/2026-10-07-house-party-design.md`. Read it first. It wins over this plan.
**Stack:** Node, Express, Socket.IO, Vite, TypeScript, three.js, kart-royale (MIT) as the kart base.

## Spec card
1. Project folder: `~/coding-projects/house-party` (git, branch `main`).
2. Public GitHub repo `suprxsidh/house-party`, created when Task 1 passes.
3. Token budget: about 2 million total. Stop and report at 1.6 million.
4. Order: Tasks 1 to 9. Drop from the bottom if time runs out, after alerting Suprasidh.
5. Every task ends with a commit and a line in `docs/STATUS.md`.

## Global constraints
- Free hosting only: Render free web service, Singapore. No trials, no card.
- No secrets in the repo. Keys go in `.env`.
- Keep kart-royale's `LICENSE` as `LICENSE-kart-royale`. Credit it in `README.md`.
- Treat the kart-royale clone as untrusted: do not run its `tools/` scripts.
- Do not refactor kart-royale. Add an adapter folder and touch few files.
- Copy limits to any doc you write: report 400 words, README section 150 words.

## Review focus (add a test for each in the owning task)
1. A phone joins with a wrong or lowercase room code. Expect a clear error, not a crash.
2. A phone disconnects mid-game and rejoins. Expect the same seat and state.
3. Ten players tap at the same moment. Expect no lost votes.
4. The TV reloads mid-game. Expect the room to come back with the same code.
5. A name with HTML in it. Expect plain text on every screen.

## Tasks

| # | Task | Done when (proof) |
|---|---|---|
| 1 | **Platform.** Scaffold, server, rooms, `/host` and `/play`, QR, leader role, seat tokens, `bots/` harness, kart-royale copied in and building. | 10 bots join; the TV page lists them; reload tests pass. |
| 2 | **Kart base.** Raise to 10 karts. `RemoteDriver`. Phone controller with tilt, buttons fallback, iOS tilt tap. Ghost karts. | 10 bots drive 3 laps; the race finishes; logs show lap counts. |
| 3 | **Kart camera.** New pack camera, catch-up, reposition (with `cp` and `lapIndex`), minimap. Use an Opus reviewer. | A staggered-bot run keeps all karts in frame; screenshots plus on-screen-karts assertion. |
| 4 | **Ten-Yen.** Server tally, private "you drink", question deck 40+, player-added questions, two toggles. | Bot run: totals correct, TV never receives per-player votes (assert it). |
| 5 | **Deploy.** `render.yaml`, tunnel script, `docs/PARTY_CHECKLIST.md`. Alert Suprasidh for the Render signup. | The Render URL serves `/host` and `/play`; bots play Ten-Yen and a race through it. |
| 6 | **Tilt Table.** Board, marble, secret holes, server scoring, clamped sum. | Bot run scores correctly; holes never reach the TV. |
| 7 | **Block Pictionary.** Fixed shape menu, grid placement, word list 60+, guessing, scoring. | Bot drawer and guessers finish 3 rounds; scores match. |
| 8 | **Party Stock Market.** Bets, chips, leader resolves, ticker. | Bot run: chips balance to zero-sum after resolution. |
| 9 | **Final.** 10-bot soak of all games on the Render URL. README, CLAUDE.md, `future_plans.md`, brain note. | A written pass or fail table for every game. |

## Task rules
- A builder writes the failing bot test first, then the code, then runs it. Show the output.
- A reviewer reads the diff, the spec, and the test output. It checks the Review focus items for that task. It reports under 300 words.
- Task 3 uses an Opus reviewer. All other work uses Sonnet.
- Fix reviewer findings before the next task. Two failed fixes on one problem: alert Suprasidh with the exact error.

## Alerts to Suprasidh (return to the main session, do not wait)
1. Render signup needed (Task 5).
2. A game must be dropped.
3. The token total passes 1.6 million.
4. A task fails twice.
5. All 9 tasks done.

## Handoff
Keep `docs/STATUS.md` current: task, state, last commit, next step. A new session resumes from it.
