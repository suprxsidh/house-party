# House Party: design spec

## Spec card
1. **What:** a web party platform. A TV laptop shows a QR code. 7-10 friends scan it on their own phones and play games together.
2. **Date:** party is 2026-10-09 in Bangalore. Finish by the night of 2026-10-08.
3. **Network:** phones on 5G, maybe Airbnb wifi. So the server must be public on https.
4. **Cost:** free forever. No trials.
5. **Base code:** `ryancampbell/kart-royale` (MIT, 65k lines TypeScript, three.js). Copy it in. Keep its LICENSE and credit it.
6. **Core idea:** the TV browser runs all graphics and physics. Phones are controllers. The server only relays messages and keeps secrets.
7. **Games in scope:** Kart race, Ten-Yen game, Tilt Table, Block Pictionary, Party Stock Market.
8. **Out of scope:** Spy in the Crowd (later), accounts, saved data, drinking rules in the kart race.
9. **Done means:** a scripted run with 10 bot phones plays each game end to end, with screenshots as proof.
10. **Open questions:** none. Suprasidh approved all of the above.

## Architecture

| Part | Choice |
|---|---|
| Server | Node + Express + Socket.IO. One process. Rooms live in memory. |
| Pages | `/host` for the TV. `/play` for phones. One Vite build, two entry pages. |
| Room | 4-letter code. The TV creates it. Phones join with the code or the QR link. |
| Leader | The first phone to join is the leader. It picks and starts games, so the TV laptop needs no mouse. |
| Game module | A TV part and a phone part. Games with secrets add a server part. |
| Hosting | Render free web service, Singapore region. `render.yaml` in the repo. Also `npm run tunnel` (cloudflared quick tunnel) as backup. |

The server sends two kinds of message: "to the TV" and "to one phone". Phones never talk directly.

## Lobby and join
- The TV shows the room code, QR code, and player list.
- A phone asks for a name. Then it shows a "Tap to enable tilt" button. iPhones need this tap before tilt works.
- A dropped phone rejoins with the same name and keeps its seat.

## Kart race
- Use kart-royale's track, karts, items, race logic and HUD.
- Replace its AI driver with a `RemoteDriver` that reads steer, gas and item from a phone.
- The TV simulates all karts. Kart-vs-kart collisions are off (ghost cars). Walls, scenery and hazards stay solid.
- Phone controls: tilt to steer (touch buttons as fallback), hold to go, tap for item.
- Items are plain Mario Kart style, no drinking.
- One shared camera follows the pack leader. It zooms out to keep every kart within 40 metres of the leader in view.
- Catch-up: a kart behind the leader gets a speed bonus that grows with the gap, up to +25%. The leader gets none.
- A kart off screen for 5 seconds is placed back near the pack, with 2 seconds of protection.
- Edge arrows with names point to off-screen karts. A minimap shows all karts.
- The phone shows position, lap and held item.
- TV quality switch, High or Low. Low drops post effects and shadows.
- Race: 3 laps. Kart-royale AI fills slots only if fewer than 4 humans.

## Ten-Yen game
1. A question shows on the TV and on every phone.
2. Each player secretly taps YES or NO.
3. The server counts the votes. It sends only the totals to the TV. It never tells anyone who voted what.
4. The TV shows 3D coins landing in two piles, then names the minority side.
5. The minority drinks. A tie: nobody drinks.
- Questions: a built-in deck of at least 40 (funny and mildly spicy). Players can add their own from the phone. Added questions are mixed in at random.
- Lobby toggles: "predict mode" (a wrong guess adds a sip) and "lone dissenter drinks double".

## Tilt Table
- The TV shows a 3D board with a marble. All phones tilt the board together (the average tilt moves it).
- Each player has a secret goal hole, sent only to their phone. Reaching it scores a point.
- Physics: `cannon-es`, or kart-royale's own if smaller to add.
- 60-second rounds. Most points wins.

## Block Pictionary
- One drawer gets a secret word on the phone. The drawer builds it from cubes, spheres and cylinders: add, move, scale, color.
- The TV shows the scene turning slowly.
- Other players type guesses on their phones. The first correct guess scores for the guesser and the drawer.
- At least 60 built-in words, easy to medium. Rounds rotate through players, 90 seconds each.

## Party Stock Market
- It runs in the background all night from the lobby. It is not a round.
- Any player proposes a bet ("Rahul finishes his drink in 5 min"). Others buy YES or NO with fake chips.
- The leader phone resolves the bet. Winners split the chips.
- The TV shows a ticker and top traders.

## Testing and proof
- `bots/`: a script that starts N fake phones with Socket.IO. They join, vote, tilt and guess.
- Browser run (Playwright or agent-browser) opens `/host`, runs each game with 10 bots, and saves screenshots.
- Each game needs one passing bot run before the next game starts.
- The final deploy is checked by joining the Render URL with bots and starting a race.
- Only Suprasidh can do the real-phone check. `docs/PARTY_CHECKLIST.md` lists the steps, under 150 words.

## Risks
- A borrowed laptop may be too slow for 10 karts. Mitigation: Low quality switch, tested with 6x CPU slowdown.
- Render sleeps after 15 minutes idle. Open the link 2 minutes before the party.
- kart-royale is large. Do not refactor it. Add one adapter folder and touch few of its files.
- 5G drops sockets. Mitigation: auto-reconnect and seat reservation.
