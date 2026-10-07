# Protocol (Socket.IO)

Types live in `shared/protocol.ts` and `shared/games.ts`.

## Lifecycle
1. TV emits `tv:create {code?}`. The server returns a 4-letter code. A given code re-creates or re-attaches the room.
2. Phone emits `phone:join {code, name, token?}` (code may be lowercase). The reply holds `token` (save it) and `you.id`.
3. Rejoin uses the token, never the name. After a server restart the phone sends its old token and keeps its seat id.
4. The first phone leads. If the leader drops past the grace time (5 s), the next connected phone leads. `phone:leave` frees the seat at once.
5. The server sends `room:state {code, players[{id,name,connected,leader}], leaderId, game}` to the TV and all phones on every change.

Errors reply `{ok:false, error, message}`: `BAD_CODE`, `ROOM_NOT_FOUND`, `BAD_NAME`, `ROOM_FULL`, `NOT_LEADER`, `BAD_REQUEST`.

## Messages
| Event | From, to | Payload |
|---|---|---|
| `to-tv` | phone, TV | `{type, data}`; the TV gets `msg {from, type, data}` |
| `to-phone` | TV, one phone | `{playerId, type, data}`; phone gets `msg {type, data}` |
| `to-phones` | TV, all phones | `{type, data}` |
| `to-server` | phone or TV, game server part | `{type, data}` |

Names are plain text. Render with `textContent`.

## Game start and end
- Leader emits `leader:pick {gameId}`. The server starts the server part, then `room:state.game = {id}`. TV and phones mount their parts.
- Leader emits `leader:end`. `room:state.game` becomes `null`.

## Adding a game
Make `games/<name>/{host,phone,server}/index.ts`. Each calls `registerHost`, `registerPhone`, `registerServer` (`shared/registry.ts`) with the same `GameInfo`. Add one import line to each of `games/host.registry.ts`, `phone.registry.ts`, `server.registry.ts`. See `games/stub`.

Server part (`ServerGame`): `onStart(ctx)`, `onPhoneMessage(playerId,type,data)`, optional `onTvMessage`, `onPlayerConnected(playerId)` (phone rejoined; resend its state), `onEnd`. `ctx` has `players()`, `toTv`, `toPhone`, `toPhones`. Secrets stay here.

## bots/ helper API (`bots/harness.ts`)
- `setupRoom(n)` gives `{srv, tv, code, bots, send, sendServer, waitFor, start, close}`. Bot 0 is the leader.
- `r.send(i, type, data)`: bot i to TV. `r.sendServer(i, ...)`: bot i to server part.
- `r.waitFor(i, type)`: wait for bot i to get a message.
- `r.tv.waitFor(type, {from})`; `r.tv.msgs` lists all TV messages (assert on it).
- `r.start('gameId')`: leader picks the game. `await r.close()` at the end.
- `srv.wipe()` acts like a server restart.

Tests: `games/<name>/test/*.test.ts`. Run one with `npm test -- <name>`.
