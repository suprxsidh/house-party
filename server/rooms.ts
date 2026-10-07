import { randomBytes } from 'node:crypto';
import type { ServerGame } from '../shared/games.ts';
import { CODE_RE, MAX_NAME, type PlayerView, type RoomState } from '../shared/protocol.ts';

export interface Seat {
  id: string;
  token: string;
  name: string;
  socketId: string | null;
  graceTimer?: NodeJS.Timeout;
}

export const MAX_PLAYERS = 16;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

/** Plain text only. Keeps the characters as typed; renderers must use textContent. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return n.length ? n : null;
}

export class Room {
  tvSocketId: string | null = null;
  tvSecret = '';
  seats: Seat[] = []; // join order
  leaderId: string | null = null;
  game: { id: string } | null = null;
  serverGame?: ServerGame;
  /** Always-on layers (info.layer), keyed by game id. */
  layers = new Map<string, ServerGame>();
  private seq = 0;
  deleteTimer?: NodeJS.Timeout;

  constructor(public code: string) {}

  nextSeatId() {
    return `p${++this.seq}`;
  }
  /** Re-create a seat id a phone remembers (after a restart). Null if bad or taken. */
  claimSeatId(raw: unknown): string | null {
    if (typeof raw !== 'string' || !/^p[1-9]\d{0,3}$/.test(raw) || this.byId(raw)) return null;
    this.seq = Math.max(this.seq, Number(raw.slice(1)));
    return raw;
  }
  /** Keep seats in seat-id order so a restart does not reshuffle the list or leader. */
  sortSeats() {
    this.seats.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }
  byToken(token: string) {
    return this.seats.find((s) => s.token === token);
  }
  byId(id: string) {
    return this.seats.find((s) => s.id === id);
  }
  bySocket(socketId: string) {
    return this.seats.find((s) => s.socketId === socketId);
  }

  /** Give the lead to the first connected seat after `skip` (or the first at all). */
  electLeader(skipId?: string) {
    const next = this.seats.find((s) => s.socketId && s.id !== skipId);
    this.leaderId = next ? next.id : null;
  }

  state(): RoomState {
    const players: PlayerView[] = this.seats.map((s) => ({
      id: s.id,
      name: s.name,
      connected: s.socketId !== null,
      leader: s.id === this.leaderId,
    }));
    return { code: this.code, players, leaderId: this.leaderId, game: this.game };
  }
}

export function makeCode(taken: (c: string) => boolean): string {
  for (let i = 0; i < 1000; i++) {
    const b = randomBytes(4);
    let c = '';
    for (let k = 0; k < 4; k++) c += LETTERS[b[k] % LETTERS.length];
    if (!taken(c)) return c;
  }
  throw new Error('no free room codes');
}

export function makeToken() {
  return randomBytes(16).toString('hex');
}
