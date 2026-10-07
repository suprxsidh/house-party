# Spy in the Crowd: design spec

## Spec card
1. **What:** game number 6. The TV shows a plaza with about 40 identical walkers. Every player steers one. Secret assassins hide among them. Civilians must find them.
2. **Players:** 4 to 10. Bots fill the crowd to 40.
3. **Round:** 150 seconds. 3 rounds. Roles rotate.
4. **Phone:** a joystick and one ACT button. The role is hidden until you hold a "Role" button.
5. **Secrets:** the TV never learns roles until the round ends. The server resolves all kills and arrests.
6. **Base:** the existing platform and game registry (`docs/PROTOCOL.md`). No change to other games.
7. **Out of scope:** accounts, saved data, voting phase, power-ups, new art files. Use primitive shapes.
8. **Done means:** 10 bots play 3 rounds locally and on the Render URL, with logs.
9. **Freeze:** the last push to `main` is 2026-10-08 18:00 IST. A push restarts Render and wipes rooms.
10. **Open questions:** none. Defaults are set below.

## Roles
- 1 assassin for 4 to 6 players. 2 assassins for 7 to 10.
- Everyone else is a civilian.

## ACT button (same button for everyone)
| Role | ACT does | Limits |
|---|---|---|
| Assassin | Stabs the nearest character within 1.5 m. A human target is out. A bot target is unharmed. | 4 s cooldown. A stab on a bot costs 8 s. |
| Civilian | Arrests the nearest character within 2 m. | One arrest per round. |

- Arresting an assassin: that assassin is out.
- Arresting a bot or a civilian: the arrest is wasted. A civilian arrested by mistake is also out.
- Out players watch from their phones. Their walker falls over on the TV.

## Round end and scores
A round ends when all assassins are arrested, all civilians are out, or the 150 s timer ends.

| Event | Points |
|---|---|
| Assassin: each kill | +100 |
| Assassin: alive at the end | +200 |
| Civilian: arrests an assassin | +300 |
| Civilian: alive at the end | +100 |
| Civilian: wrong arrest | -100 |

The TV shows roles and scores at the end of each round.

**Drinks toggle** (lobby, default off): when on, the TV names the caught assassins and the wrong arresters as the drinkers.

## Crowd
- About 40 walkers: players plus bots, identical shape. Colors are random, so color does not give a player away.
- Bots walk between random points at 2.0 m/s and pause 1 to 4 s at random.
- Players walk at up to 2.0 m/s. Same top speed as bots.
- The TV shows no names during the round. A victim's name appears in the feed after a kill.

## Architecture
The TV browser moves the walkers and runs the bots. The server holds the roles.

| Message | From and to | Content |
|---|---|---|
| `spy:move` | phone to TV | joystick vector, 20 per second |
| `spy:act` | phone to TV | the press. The TV picks the nearest character in range. |
| `spy:act` | TV to server | actor id, target id |
| `spy:result` | server to TV | `kill`, `arrest-ok`, `arrest-wrong` or `miss`, plus the target |
| `spy:role` | server to one phone | role, cooldown, arrests left |
| `spy:me` | TV to one phone | that phone's own walker position, 5 per second |
| `spy:end` | server to TV | roles and scores |

The server part owns the rules, cooldowns, timers and scores. The rules engine is pure TypeScript with unit tests.

## Phone screen
- A 6-second role card at the round start.
- A joystick on the left, ACT on the right with a cooldown ring.
- A small plaza map with a dot for your own walker only. You need it to find yourself on the TV.
- A rejoining phone gets its role back from the server.

## TV scene
- A plaza about 60 by 60 m: low buildings and a fountain, all primitive shapes.
- Instanced meshes for the crowd. Slow orbiting camera that frames the whole plaza.
- A timer, alive counts, and a feed of kills and arrests.
- `?quality=low` removes shadows.

## Tests and proof
- Unit tests: role counts, the points table, cooldowns, out players cannot act, wrong arrests.
- 10-bot run for 3 rounds. Asserts:
  - The TV receives no roles before `spy:end`.
  - Scores match the rules engine.
  - A joystick moves the bot's walker.
  - A reconnecting bot keeps its role.
  - No bot walker is stuck for more than 10 s.
- Performance: 30 fps with 40 walkers on the build Mac.
- After deploy: a 10-bot run against the Render URL.
