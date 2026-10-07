# Protocol (Socket.IO)

Types: `shared/protocol.ts`, `shared/games.ts`.

## Lifecycle
1. TV emits `tv:create {code?, secret?}`. Reply has `code` and `secret`; the TV keeps both in localStorage. A live room needs its secret (else `TV_AUTH`). A missing room (after a restart) is re-created with the same code. Phones cannot create.
2. Phone emits `phone:join {code, name, token?, seatId?}` (code may be lowercase). Reply has `token` and `you.id`. Rejoin uses the token, not the name. After a restart the phone sends its old `seatId` and keeps it. A second join on one socket frees the first seat.
3. First phone leads. If the leader drops 5 s, the next connected phone leads. `phone:leave` frees the seat.
4. `room:state {code, players[{id,name,connected,leader}], leaderId, game}` goes to TV and phones on every change.

Errors: `{ok:false, error, message}`; `BAD_CODE ROOM_NOT_FOUND BAD_NAME ROOM_FULL NOT_LEADER TV_AUTH BAD_REQUEST`.

## Messages
| Event | Route | Payload |
|---|---|---|
| `to-tv` | phone to TV | `{type,data}`; TV gets `msg {from,type,data}` |
| `to-phone` | TV to one phone | `{playerId,type,data}`; phone gets `msg {type,data}` |
| `to-phones` | TV to all phones | `{type,data}` |
| `to-server` | phone or TV to server part | `{type,data}` |

Names are plain text. Use `textContent`.

## Games
`leader:pick {gameId}` starts a game: `room:state.game = {id}`. `leader:end` sets it to `null`.

Add `games/<name>/{host,phone,server}/index.ts`, plus one import line in each `games/*.registry.ts`. See `games/stub`.

- `registerHost(info, () => TvGame)`. `TvGame`: `mount(ctx)`, `onPhoneMessage(playerId,type,data)`, `destroy()`. `ctx.root` is the `#game` element on the TV. Also `players()`, `toPhone`, `toPhones`, `toServer`.
- `registerPhone(info, () => PhoneGame)`. `PhoneGame`: `mount(ctx)`, `onMessage(type,data)`, `destroy()`. `ctx.root` is `#game-root` on the phone. Also `me`, `toTv`, `toServer`. Pages re-mount after a reload.
- `registerServer(info, () => ServerGame)`. Every game must call it, even with no server part: `registerServer(info)`. `ServerGame`: `onStart(ctx)`, `onPhoneMessage(playerId,type,data)`, optional `onTvMessage`, `onPlayerConnected(playerId)` (resend that phone's state), `onEnd`. `ctx`: `players()`, `toTv`, `toPhone`, `toPhones`. Secrets stay here.
- `to-server` data is untrusted. Validate type, range and sender.

## bots/ helpers (`bots/harness.ts`)
- `setupRoom(n)` gives `{srv, tv, code, bots, send, sendServer, waitFor, start, close}`. Bot 0 leads.
- `send(i,type,data)` bot to TV; `sendServer(i,...)` bot to server part; `waitFor(i,type)` bot receives.
- `tv.waitFor(type,{from})`; `tv.msgs` lists TV messages.
- `start('id')` picks the game. `srv.wipe()` acts like a restart; re-create with `tv.create(code, tv.secret)`.

Run one game: `npm test -- <name>` (`games/<name>/test/*.test.ts`).

## Always-on layers (added by the market task)
A layer is a game with `info.layer = true`. It starts with the room, runs beside any game, and never shows in the picker (`leader:pick` refuses it).
- Message types start with the layer id and a colon, e.g. `market:buy`. The server, TV and phone route those to the layer, not to the current game.
- Server part gets `ctx.leaderId()` and optional `onTvConnected()`. `onPlayerConnected` also fires for layers. Server to TV messages reach the TV layer with `playerId` `"server"`.
- Phone part gets `ctx.isLeader()` and optional `onRoomState()`. It mounts in its own `#layer-<id>` section after join. Ask the server for state on mount (`<id>:sync`).
- TV part mounts in `#layer-<id>` appended to `<body>`.
- Bots keep layer messages in `layerMsgs`, so game tests can still count `msgs`.
- State lives in server memory, so it dies with a server restart (a TV reload or phone rejoin keeps it).
