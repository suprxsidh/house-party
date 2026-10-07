# STATUS

- Gemini: key in .env (gitignored). Model: models/gemini-3.5-flash (no "3.8 flash" exists). Use for bulk data only (Ten-Yen deck, Pictionary words, styling). Untrusted output: read before commit. Used so far: none.
- Task 1: PASS (15 bot tests, reviewer fixes applied). Next: parallel worktrees for Tasks 2,4,5,6,7,8.
- Task 4 Ten-Yen: PASS, merged. Task 8 Market: PASS, merged (always-on layer; platform edit). Task 6 Tilt: PASS, merged. Task 7 Pictionary: PASS, merged. Task 5 Deploy files: merged; waiting on user Render signup (docs/DEPLOY.md).
- Convention: server-part messages reach the TV with from='server'.
- Gemini used for: Ten-Yen deck draft (pruned 60 to 51), Pictionary words (pruned 100 to 82).
- Running next: Task 2 kart (builder in worktree-wt/kart), then Task 3 camera.
- Fixed merge dup (leaderId). Build clean, 57/57 tests on main. Known flake: 'one socket joining twice' test fails sometimes when other test runs share the CPU.
