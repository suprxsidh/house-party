# House Party: design spec

## Spec card
1. **What:** a web party platform. A TV laptop shows a QR code. 7-10 friends scan it on their phones and play together.
2. **Date:** party is 2026-10-09 in Bangalore. Finish by the night of 2026-10-08.
3. **Network:** phones on 5G, maybe Airbnb wifi. The server is public on https.
4. **Cost:** free forever. No trials.
5. **Base code:** `ryancampbell/kart-royale` (MIT, three.js, TypeScript). Copy it in, keep its LICENSE, credit it.
6. **Core idea:** the TV browser runs all graphics and physics. Phones are controllers. The server relays messages and keeps secrets.
7. **Games, in build order:** Kart race, Ten-Yen, Tilt Table, Block Pictionary, Party Stock Market.
8. **Out of scope:** Spy in the Crowd, accounts, saved data, drinking in the kart race.
9. **Done means:** each game passes a scripted 10-bot run, with logs and screenshots.
10. **Open questions:** none. Suprasidh approved this list.

If time runs short, build in the order above and drop from the bottom. The orchestrator alerts Suprasidh before dropping a game.

## Architecture

| Part | Choice |
|---|---|
| Server | Node, Express, Socket.IO. One process. Rooms in memory. |
| Pages | `/host` (TV) and `/play` (phones). One Vite build, two entry pages. |
| Room | 4-letter code. The TV creates it. The QR link carries it. |
| Leader | The first phone is the leader. It picks and starts games. If it drops, the role passes to the next phone. |
| Game module | A TV part and a phone part. Games with secrets add a server part. |
| Hosting | Render free web service, Singapore. `render.yaml`. Backup: `npm run tunnel` (cloudflared). |

Messages go "to the TV" or "to one phone".

## Lobby, join, reconnect
- The TV shows room code, QR code and players.
- A phone enters a name, then taps "Enable tilt". iPhones need this tap, and need it again after any reload.
- A phone gets a seat token in `localStorage`. Rejoin uses the token, not the name.
- Render may restart and wipe rooms. The TV re-creates its room with the same code, and phones rejoin on their own.

## Kart race
- Raise the 8-kart cap to 10: `RACER_COUNT` in `src/types.ts`, `ROSTER` in `src/game/Race.ts`, the loop in `Track.buildStartGrid`, and `Liveries.ts`. Test a 10-kart grid first.
- Driver swap in `Race.update`: add a remote-command check before the `ai.drive()` branch. Each frame, point `race.player` at the leader so the HUD, shake and results keep working.
- Ghost karts: remove `collideKarts` in `src/kart/Kart.ts`. Walls and hazards stay solid.
- Camera: write a new high pack camera. It follows the leader and zooms to fit karts within 40 m. Turn `ChaseCamera` off in race mode. The hard part: 4-6 hours.
- Catch-up: reuse the assist-launch code in `Race.ts` for all karts. Bonus grows with the gap, up to +25%. The leader gets none.
- Reposition: a kart off screen for 5 s moves near the pack. Also set its `cp` and `lapIndex`, or lap counting breaks. If this is hard, drop it and keep only catch-up.
- The minimap shows all karts. Edge arrows are a stretch goal.
- Phone: tilt to steer (buttons as fallback), hold for gas, tap for item. It shows position, lap and item. Steering is not negated.
- 3 laps. Plain Mario Kart items. AI fills slots only if fewer than 4 humans.
- Quality: use the existing `?quality=low` and `?scale=`.

## Ten-Yen game
1. A question shows on the TV and every phone.
2. Each player secretly taps YES or NO.
3. The server counts. The TV gets totals only.
4. The server tells each minority phone "you drink", privately. The TV shows coins landing in two piles and names the minority side. Drinking reveals the vote. That is part of the game.
5. A tie: nobody drinks.
- Built-in deck of 40+ questions. Players add their own on the phone, mixed in at random.
- Toggles: "predict mode" (a wrong guess adds a sip) and "lone dissenter drinks double".

## Tilt Table
- The TV shows a 3D board and a marble. Phones tilt the board together. The board uses a clamped sum of tilts, not an average, so it does not cancel out.
- Each player has a secret goal hole, known only to the server and that phone. The TV reports which hole the marble fell in, and the server scores it.
- Simple custom physics. No new library.
- 60-second rounds. Most points wins.

## Block Pictionary
- The drawer gets a secret word. The drawer places cubes, spheres and cylinders from a fixed menu, picks a color, and taps a coarse grid to position them. No free scaling.
- The TV shows the scene turning. Others type guesses. The first correct guess scores for guesser and drawer.
- 60+ built-in words. Rounds rotate, 90 seconds each.

## Party Stock Market
- It runs in the background all night. Any player proposes a bet. Others buy YES or NO with fake chips. The leader resolves it.
- The TV shows a ticker and top traders.

## Testing and proof
- `bots/` starts N fake phones with Socket.IO.
- A browser run opens `/host`, plays each game with 10 bots, and saves logs and screenshots. Also assert on game state.
- One passing bot run per game before the next game starts.
- Targets: 30 fps with 10 karts on the build Mac. Tilt-to-kart delay under 150 ms on the local network. Headless timings are not real.
- The final deploy is checked by joining the Render URL with bots.
- `docs/PARTY_CHECKLIST.md` (under 150 words): the real-phone check only Suprasidh can do.

## Risks
- A slow laptop: use `?quality=low`.
- Render sleeps after 15 min idle: open the link 2 min early.
- kart-royale is large: add one adapter folder and touch few of its files.
