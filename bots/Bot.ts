import { io, type Socket } from 'socket.io-client';
import type { JoinReply, RoomState } from '../shared/protocol.ts';

/** A fake phone. Joins a room, keeps its seat token, rejoins by token. */
export class Bot {
  static all = new Set<Bot>();
  static closeAll() {
    for (const b of [...Bot.all]) b.close();
  }
  socket: Socket;
  token?: string;
  id?: string;
  state?: RoomState;
  msgs: { type: string; data: unknown }[] = [];
  /** Messages from always-on layers (type like "market:state"). Kept apart so game tests can count `msgs`. */
  layerMsgs: { type: string; data: unknown }[] = [];
  lastReply?: JoinReply;
  private wantRoom?: string;
  private retry?: NodeJS.Timeout;

  constructor(
    public url: string,
    public name: string,
  ) {
    Bot.all.add(this);
    this.socket = io(url, { transports: ['websocket'], reconnectionDelay: 100, reconnectionDelayMax: 300 });
    this.socket.on('room:state', (s: RoomState) => (this.state = s));
    this.socket.on('msg', (m: { type: string; data: unknown }) => (/^[a-z]+:/.test(m.type) ? this.layerMsgs : this.msgs).push(m));
    // On every (re)connect, rejoin by token.
    this.socket.on('connect', () => {
      if (this.wantRoom) void this.join(this.wantRoom);
    });
  }

  ready(): Promise<void> {
    return this.socket.connected
      ? Promise.resolve()
      : new Promise((res) => this.socket.once('connect', () => res()));
  }

  async join(code: string): Promise<JoinReply> {
    await this.ready();
    this.wantRoom = code;
    const reply: JoinReply = await this.socket.timeout(3000).emitWithAck('phone:join', {
      code,
      name: this.name,
      token: this.token,
      seatId: this.id,
    });
    this.lastReply = reply;
    if (reply.ok) {
      this.token = reply.token;
      this.id = reply.you.id;
      this.state = reply.state;
      clearTimeout(this.retry);
    } else if (reply.error === 'ROOM_NOT_FOUND' && this.token) {
      // Server may have restarted. Keep trying until the TV re-creates the room.
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.join(code).catch(() => {}), 300);
    }
    return reply;
  }

  sendToTv(type: string, data?: unknown) {
    this.socket.emit('to-tv', { type, data });
  }

  drop() {
    this.socket.disconnect();
  }
  reconnect() {
    this.socket.connect();
  }
  close() {
    this.wantRoom = undefined;
    clearTimeout(this.retry);
    this.socket.close();
  }
}

export async function joinBots(url: string, code: string, n: number, prefix = 'Bot'): Promise<Bot[]> {
  const bots = Array.from({ length: n }, (_, i) => new Bot(url, `${prefix}${i + 1}`));
  // Join in order so the first bot is the leader.
  for (const b of bots) await b.join(code);
  return bots;
}
