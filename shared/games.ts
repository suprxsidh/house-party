// Game module interfaces. A game lives in games/<name>/{host,phone,server}.
// See docs/PROTOCOL.md.

export interface GameInfo {
  id: string;
  name: string;
  blurb: string;
  /** Always-on side layer: auto-starts with the room, never picked, never blocks a game. */
  layer?: boolean;
}

export interface Player {
  id: string;
  name: string;
}

/** TV side: runs graphics and physics in the host browser. */
export interface TvGameContext {
  root: HTMLElement;
  players(): Player[];
  toPhone(playerId: string, type: string, data?: unknown): void;
  toPhones(type: string, data?: unknown): void;
  toServer(type: string, data?: unknown): void;
}
export interface TvGame {
  mount(ctx: TvGameContext): void;
  onPhoneMessage(playerId: string, type: string, data: unknown): void;
  destroy(): void;
}

/** Phone side: controller UI. */
export interface PhoneGameContext {
  root: HTMLElement;
  me: Player;
  /** True while this phone holds the room lead. */
  isLeader(): boolean;
  toTv(type: string, data?: unknown): void;
  toServer(type: string, data?: unknown): void;
}
export interface PhoneGame {
  mount(ctx: PhoneGameContext): void;
  onMessage(type: string, data: unknown): void;
  /** Room state changed (leader, players). Optional. */
  onRoomState?(): void;
  destroy(): void;
}

/** Optional server side: for games with secrets (votes, goals, words). */
export interface ServerGameContext {
  /** Seat id of the current leader, or null. */
  leaderId(): string | null;
  players(): Player[];
  /** Current leader seat id, or null. */
  leaderId?(): string | null;
  /** True while that seat has a live socket. */
  isConnected?(playerId: string): boolean;
  toTv(type: string, data?: unknown): void;
  toPhone(playerId: string, type: string, data?: unknown): void;
  toPhones(type: string, data?: unknown): void;
}
export interface ServerGame {
  onStart(ctx: ServerGameContext): void;
  onPhoneMessage(playerId: string, type: string, data: unknown): void;
  onTvMessage?(type: string, data: unknown): void;
  /** A phone (re)joined mid-game: send it the state it needs. */
  onPlayerConnected?(playerId: string): void;
  /** A TV (re)attached to the room: resend its state. */
  onTvConnected?(): void;
  onEnd?(): void;
}
