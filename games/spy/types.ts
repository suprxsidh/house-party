// Shared contract for Spy in the Crowd. Spec: docs/specs/2026-10-07-spy-in-crowd-design.md
// The spec wins over this file. Server, TV and phone all import from here.

// ---- Constants (spec tables) ----
export const CROWD_SIZE = 40; // players + bots
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const ROUNDS = 3;
export const ROUND_MS = 150_000;
export const ROLE_CARD_MS = 6_000;
export const PLAZA_SIZE = 60; // metres, square, centred on 0,0
export const WALK_SPEED = 2.0; // m/s, players (max) and bots
export const BOT_PAUSE_MS: [number, number] = [1000, 4000];

export const STAB_RANGE = 1.5; // m
export const ARREST_RANGE = 2.0; // m
export const STAB_COOLDOWN_MS = 4_000;
export const STAB_BOT_COOLDOWN_MS = 8_000; // a stab on a bot costs this instead
export const ARRESTS_PER_ROUND = 1;

export const POINTS = {
  assassinKill: 100,
  assassinAlive: 200,
  civilianArrestAssassin: 300,
  civilianAlive: 100,
  civilianWrongArrest: -100,
} as const;

export const MOVE_HZ = 20; // spy:move, phone to TV
export const ME_HZ = 5; // spy:me, TV to phone

/** 1 assassin for 4..6 players, 2 for 7..10. */
export function assassinCount(players: number): number {
  return players >= 7 ? 2 : 1;
}
/** Bots needed to fill the crowd. */
export function botCount(players: number): number {
  return Math.max(0, CROWD_SIZE - players);
}

// ---- Message names ----
export const MSG = {
  move: 'spy:move', // phone -> TV
  act: 'spy:act', // phone -> TV (press) and TV -> server (resolved target)
  result: 'spy:result', // server -> TV
  role: 'spy:role', // server -> one phone
  me: 'spy:me', // TV -> one phone
  end: 'spy:end', // server -> TV (end of each round)
  round: 'spy:round', // server -> TV and phones (round start, no roles)
  drinks: 'spy:drinks', // leader phone -> server: drinks toggle
  next: 'spy:next', // TV -> server: TV finished showing the round-end screen
} as const;

// ---- Payloads ----
export type Role = 'assassin' | 'civilian';

/** phone -> TV. Each axis in -1..1. */
export interface MoveMsg { x: number; y: number }
/** phone -> TV. Empty: the press only. */
export type ActPress = Record<string, never>;
/** TV -> server. actor is a player id. target is a player id or a bot id ("bot-N"). */
export interface ActMsg { actor: string; target: string }

export type ResultKind = 'kill' | 'arrest-ok' | 'arrest-wrong' | 'miss';
/** server -> TV. `out` lists ids that are out because of this event (kill: target. arrest-ok: target. arrest-wrong: actor). */
export interface ResultMsg {
  kind: ResultKind;
  actor: string;
  target: string;
  actorName: string;
  targetName: string; // empty string for a bot
  out: string[];
  aliveCivilians: number;
  aliveAssassins: number; // the TV may show this only if the spec allows; the server sends it at round end only (0 mid-round)
  seq: number; // increasing per round, TV drops duplicates
}

/** server -> one phone. Sent at round start, on rejoin, and after any change. */
export interface RoleMsg {
  role: Role;
  round: number; // 1..ROUNDS
  rounds: number;
  cooldownMs: number; // ms until ACT works again (0 = ready)
  arrestsLeft: number;
  out: boolean;
  points: number;
}

/** server -> TV and phones. No roles. */
export interface RoundMsg {
  round: number;
  rounds: number;
  startsAt: number; // epoch ms, server clock
  endsAt: number;
  now: number;
  playerIds: string[]; // human walkers; the TV adds bots up to CROWD_SIZE
  botCount: number;
  drinks: boolean;
  over: boolean;
}

/** TV -> one phone. Own walker only. Plaza coordinates in metres. */
export interface MeMsg { x: number; z: number }

export interface PlayerScore {
  id: string;
  name: string;
  role: Role;
  points: number;
  total: number; // sum over rounds so far
  out: boolean;
}
/** server -> TV. First time roles leave the server. */
export interface EndMsg {
  round: number;
  rounds: number;
  reason: 'assassins-caught' | 'civilians-out' | 'timer';
  scores: PlayerScore[];
  drinkers: string[]; // names; empty unless the drinks toggle is on
  final: boolean; // true after the last round
}
