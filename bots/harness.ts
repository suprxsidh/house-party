// Helpers for game tests. See docs/PROTOCOL.md "bots/ helper API".
import { io, type Socket } from 'socket.io-client';
import { startServer, type RunningServer } from '../server/index.ts';
import type { RoomState, TvCreateReply } from '../shared/protocol.ts';
import { Bot, joinBots } from './Bot.ts';

export { Bot, joinBots };
export type { RunningServer };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until(fn: () => boolean | Promise<boolean>, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
}

export async function boot(opts: { leaderGraceMs?: number } = {}): Promise<RunningServer> {
  const mode = process.env.HP_MODE === 'prod' ? 'prod' : 'dev';
  return startServer({ port: 0, mode, leaderGraceMs: opts.leaderGraceMs ?? 300, quiet: true });
}

export interface Msg { from?: string; type: string; data: unknown }

/** A fake TV (no browser). Use the real /host page via Playwright for DOM checks. */
export class FakeTv {
  static all = new Set<FakeTv>();
  static closeAll() {
    for (const t of FakeTv.all) t.close();
  }
  socket: Socket;
  state?: RoomState;
  msgs: Msg[] = [];
  secret?: string;
  constructor(url: string) {
    FakeTv.all.add(this);
    this.socket = io(url, { transports: ['websocket'] });
    this.socket.on('room:state', (s: RoomState) => (this.state = s));
    this.socket.on('msg', (m: Msg) => this.msgs.push(m));
  }
  /** Pass `secret` to re-attach to a live room (a TV reload keeps it in localStorage). */
  async create(code?: string, secret?: string): Promise<TvCreateReply> {
    if (!this.socket.connected) await new Promise((r) => this.socket.once('connect', () => r(null)));
    const r: TvCreateReply = await this.socket.timeout(3000).emitWithAck('tv:create', { code, secret });
    if (r.ok) this.secret = r.secret;
    return r;
  }
  toPhone(playerId: string, type: string, data?: unknown) {
    this.socket.emit('to-phone', { playerId, type, data });
  }
  toPhones(type: string, data?: unknown) {
    this.socket.emit('to-phones', { type, data });
  }
  toServer(type: string, data?: unknown) {
    this.socket.emit('to-server', { type, data });
  }
  /** Wait for a TV message of this type (optionally from one player). Returns it. */
  async waitFor(type: string, opts: { from?: string; ms?: number; after?: number } = {}): Promise<Msg> {
    let found: Msg | undefined;
    await until(
      () => !!(found = this.msgs.slice(opts.after ?? 0).find((m) => m.type === type && (!opts.from || m.from === opts.from))),
      opts.ms ?? 3000,
      `TV msg ${type}`,
    );
    return found!;
  }
  close() {
    this.socket.close();
  }
}

export interface TestRoom {
  srv: RunningServer;
  tv: FakeTv;
  code: string;
  bots: Bot[];
  /** Bot i (0-based) sends a message to the TV. */
  send(i: number, type: string, data?: unknown): void;
  /** Bot i sends a message to the game's server part. */
  sendServer(i: number, type: string, data?: unknown): void;
  /** Bot i waits for a message of this type. */
  waitFor(i: number, type: string, ms?: number): Promise<{ type: string; data: unknown }>;
  /** Start a game as the leader (bot 0). */
  start(gameId: string): Promise<void>;
  close(): Promise<void>;
}

/** One call: server + fake TV + N bots joined in order (bot 0 is the leader). */
export async function setupRoom(n: number, opts: { srv?: RunningServer; leaderGraceMs?: number } = {}): Promise<TestRoom> {
  const srv = opts.srv ?? (await boot({ leaderGraceMs: opts.leaderGraceMs }));
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  if (!made.ok) throw new Error(made.message);
  const bots = await joinBots(srv.url, made.code, n);
  return {
    srv,
    tv,
    code: made.code,
    bots,
    send: (i, type, data) => bots[i].sendToTv(type, data),
    sendServer: (i, type, data) => bots[i].socket.emit('to-server', { type, data }),
    async waitFor(i, type, ms = 3000) {
      let found: { type: string; data: unknown } | undefined;
      await until(() => !!(found = bots[i].msgs.find((m) => m.type === type)), ms, `bot ${i} msg ${type}`);
      return found!;
    },
    async start(gameId) {
      const r = await bots[0].socket.timeout(3000).emitWithAck('leader:pick', { gameId });
      if (!r.ok) throw new Error(`start ${gameId}: ${r.message}`);
    },
    async close() {
      Bot.closeAll();
      FakeTv.closeAll();
      if (!opts.srv) await srv.close();
    },
  };
}
