// Wire protocol between server, TV (host) and phones. Types only.

export type ErrorCode =
  | 'BAD_CODE'
  | 'ROOM_NOT_FOUND'
  | 'BAD_NAME'
  | 'ROOM_FULL'
  | 'NOT_LEADER'
  | 'BAD_REQUEST';

export interface Fail {
  ok: false;
  error: ErrorCode;
  message: string;
}

export interface PlayerView {
  id: string; // stable seat id, e.g. "p3"
  name: string; // plain text, never HTML
  connected: boolean;
  leader: boolean;
}

export interface RoomState {
  code: string;
  players: PlayerView[];
  leaderId: string | null;
  game: { id: string } | null;
}

export type TvCreateReply = { ok: true; code: string; state: RoomState } | Fail;
export type JoinReply =
  | { ok: true; code: string; token: string; you: { id: string; name: string }; state: RoomState }
  | Fail;

// Client -> server events
//   'tv:create'   {code?}                     ack TvCreateReply
//   'phone:join'  {code, name, token?}        ack JoinReply
//   'phone:leave' {}                          ack {ok}
//   'leader:pick' {gameId}                    ack {ok} | Fail   (leader only)
//   'to-tv'       {type, data}                phone -> TV
//   'to-phone'    {playerId, type, data}      TV -> one phone
//   'to-phones'   {type, data}                TV -> all phones
// Server -> client events
//   'room:state'  RoomState                   to TV and all phones
//   'msg'         {from?, type, data}         TV gets {from: playerId}; phone gets no from

export const CODE_RE = /^[A-Z]{4}$/;
export const MAX_NAME = 30;
