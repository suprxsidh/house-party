# STATUS

- Gemini: key in .env (gitignored). Model: models/gemini-3.5-flash (no "3.8 flash" exists). Use for bulk data only (Ten-Yen deck, Pictionary words, styling). Untrusted output: read before commit. Used so far: none.
- Task 1: PASS (15 bot tests, reviewer fixes applied). Next: parallel worktrees for Tasks 2,4,5,6,7,8.
- Task 4 Ten-Yen: PASS, merged. Task 8 Market: PASS, merged (always-on layer; platform edit). Task 6 Tilt: PASS, merged. Task 7 Pictionary: PASS, merged. Task 5 Deploy files: merged; waiting on user Render signup (docs/DEPLOY.md).
- Convention: server-part messages reach the TV with from='server'.
- Gemini used for: Ten-Yen deck draft (pruned 60 to 51), Pictionary words (pruned 100 to 82).
- Running next: Task 2 kart (builder in worktree-wt/kart), then Task 3 camera.
- Fixed merge dup (leaderId). Build clean, 57/57 tests on main. Known flake: 'one socket joining twice' test fails sometimes when other test runs share the CPU.
- Task 2 kart: PASS (reviewer), merged. 66/67 on main: tilt browser test fails while another heavy Chrome run shares the CPU (marble state stalls, software GL); recheck when idle. Task 3 camera: builder running in house-party-wt/camera.
- PAUSED 2026-10-07 by user. Task 3 camera builder stopped mid-build. Its WIP is committed on branch task-camera (worktree ../house-party-wt/camera), NOT reviewed, NOT merged. Tests there not yet confirmed passing.
- RESUME: 1) in the camera worktree run the Task 3 tests (games/kart/test/kart.camera.test.ts, kart.packcam.test.ts), finish what is missing vs spec Kart race section (pack camera, catch-up, reposition with cp/lapIndex, minimap). 2) Opus reviewer. 3) merge to main, re-run all bot tests with the machine idle (tilt browser test is CPU-sensitive). 4) final 10-bot soak against https://house-party-2pdd.onrender.com. 5) PARTY_CHECKLIST real-phone test. Party is 2026-10-09.
- Task 3 camera: Opus review PASS after 2 fixes, merged. Tilt passes 13/13 on idle CPU. Token budget passed 1.6M (about 1.65M): orchestrator stopped. Remote 3-lap race running via HP_REMOTE_URL kart.race.test.ts (log in scratchpad race-remote.log); kart soak scenario still a stub; kart.firstfinish test dropped (stalled). Left: README polish, brain note, final table.
