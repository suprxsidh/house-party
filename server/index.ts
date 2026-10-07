import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import '../games/server.registry.ts';
import { serverGames } from '../shared/registry.ts';
import type { ServerGameContext } from '../shared/games.ts';
import type { Fail, ErrorCode, JoinReply, TvCreateReply } from '../shared/protocol.ts';
import { MAX_PLAYERS, Room, cleanName, makeCode, makeToken, normaliseCode } from './rooms.ts';

export interface ServerOptions {
  port?: number;
  mode?: 'dev' | 'prod';
  leaderGraceMs?: number;
  tvGraceMs?: number; // how long an empty-TV room survives
  quiet?: boolean;
}
export interface RunningServer {
  url: string;
  port: number;
  rooms: Map<string, Room>;
  /** Test hook: act like a server restart. Wipe rooms and drop every connection. */
  wipe(): void;
  close(): Promise<void>;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['host', 'play', 'kart'];
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const fail = (error: ErrorCode, message: string): Fail => ({ ok: false, error, message });
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const mode = opts.mode ?? 'prod';
  const leaderGraceMs = opts.leaderGraceMs ?? 5000;
  const tvGraceMs = opts.tvGraceMs ?? 10 * 60_000;
  const log = (...a: unknown[]) => !opts.quiet && console.log('[hp]', ...a);

  const app = express();
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, { pingInterval: 5000, pingTimeout: 8000 });
  const rooms = new Map<string, Room>();

  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
  app.get('/', (_req, res) => res.redirect('/host'));

  let vite: import('vite').ViteDevServer | undefined;
  if (mode === 'dev') {
    const { createServer } = await import('vite');
    vite = await createServer({
      root: ROOT,
      appType: 'mpa',
      server: { middlewareMode: { server: httpServer }, hmr: { server: httpServer } },
    });
    for (const p of PAGES) {
      app.get([`/${p}`, `/${p}/`], async (req, res, next) => {
        try {
          const html = fs.readFileSync(path.join(ROOT, p, 'index.html'), 'utf8');
          res.type('html').send(await vite!.transformIndexHtml(req.originalUrl, html));
        } catch (e) {
          next(e);
        }
      });
    }
    app.use(vite.middlewares);
  } else {
    const dist = path.join(ROOT, 'dist');
    for (const p of PAGES) {
      app.get([`/${p}`, `/${p}/`], (_req, res) => res.sendFile(path.join(dist, p, 'index.html')));
    }
    app.use(express.static(dist, { index: false }));
  }

  // ---- room logic ----
  const broadcast = (room: Room) => {
    const s = room.state();
    if (room.tvSocketId) io.to(room.tvSocketId).emit('room:state', s);
    for (const seat of room.seats) if (seat.socketId) io.to(seat.socketId).emit('room:state', s);
  };

  const scheduleRoomDelete = (room: Room) => {
    clearTimeout(room.deleteTimer);
    room.deleteTimer = setTimeout(() => {
      if (!room.tvSocketId) {
        rooms.delete(room.code);
        log('room expired', room.code);
      }
    }, tvGraceMs);
    room.deleteTimer.unref?.();
  };

  const dropSeat = (room: Room, seatId: string) => {
    const seat = room.byId(seatId);
    if (!seat) return;
    clearTimeout(seat.graceTimer);
    room.seats = room.seats.filter((s) => s.id !== seatId);
    if (room.leaderId === seatId) room.electLeader();
    broadcast(room);
  };

  const gameCtx = (room: Room): ServerGameContext => ({
    players: () => room.seats.map((s) => ({ id: s.id, name: s.name })),
    leaderId: () => room.leaderId ?? null,
    isConnected: (id) => !!room.byId(id)?.socketId,
    toTv: (type, data) => room.tvSocketId && io.to(room.tvSocketId).emit('msg', { type, data }),
    toPhone: (id, type, data) => {
      const sid = room.byId(id)?.socketId;
      if (sid) io.to(sid).emit('msg', { type, data });
    },
    toPhones: (type, data) => {
      for (const s of room.seats) if (s.socketId) io.to(s.socketId).emit('msg', { type, data });
    },
  });
  const endGame = (room: Room) => {
    try {
      room.serverGame?.onEnd?.();
    } catch (e) {
      console.error('[hp] game onEnd failed', e);
    }
    room.serverGame = undefined;
    room.game = null;
  };
  const startGame = (room: Room, id: string) => {
    endGame(room);
    room.game = { id };
    const make = serverGames.get(id)?.create;
    if (make) {
      room.serverGame = make();
      room.serverGame.onStart(gameCtx(room));
    }
  };

  io.on('connection', (socket: Socket) => {
    let roomCode: string | null = null;
    let role: 'tv' | 'phone' | null = null;
    let seatId: string | null = null;

    const safe = <T>(name: string, fn: (payload: unknown, ack: (r: T) => void) => void) =>
      socket.on(name, (payload: unknown, ack?: unknown) => {
        const reply = (r: T) => typeof ack === 'function' && (ack as (r: T) => void)(r);
        try {
          fn(payload, reply);
        } catch (e) {
          console.error(`[hp] handler ${name} failed`, e);
          reply(fail('BAD_REQUEST', 'Something went wrong.') as T);
        }
      });

    safe<TvCreateReply>('tv:create', (payload, ack) => {
      if (!isObj(payload)) return ack(fail('BAD_REQUEST', 'Bad create request.'));
      const wanted = payload.code;
      let code: string;
      if (wanted === undefined || wanted === null || wanted === '') {
        code = makeCode((c) => rooms.has(c));
      } else {
        const c = normaliseCode(wanted);
        if (!c) return ack(fail('BAD_CODE', 'Room codes are 4 letters.'));
        code = c;
      }
      if (role === 'phone') return ack(fail('TV_AUTH', 'A phone cannot act as the TV.'));
      const secretIn = typeof payload.secret === 'string' && TOKEN_RE.test(payload.secret) ? payload.secret : undefined;
      let room = rooms.get(code);
      if (!room) {
        // New room, or re-created after a restart. The TV's secret (if valid) is kept.
        room = new Room(code);
        room.tvSecret = secretIn ?? makeToken();
        rooms.set(code, room);
        log('room created', code);
      } else if (secretIn !== room.tvSecret) {
        return ack(fail('TV_AUTH', `Room ${code} is already running on another screen.`));
      }
      // A reload: the newest TV (with the secret) takes over the room.
      if (room.tvSocketId && room.tvSocketId !== socket.id) io.sockets.sockets.get(room.tvSocketId)?.disconnect(true);
      clearTimeout(room.deleteTimer);
      room.tvSocketId = socket.id;
      roomCode = code;
      role = 'tv';
      socket.join(code);
      ack({ ok: true, code, secret: room.tvSecret, state: room.state() });
      broadcast(room);
    });

    safe<JoinReply>('phone:join', (payload, ack) => {
      if (!isObj(payload) || role === 'tv') return ack(fail('BAD_REQUEST', 'Bad join request.'));
      const code = normaliseCode(payload.code);
      if (!code) return ack(fail('BAD_CODE', 'Room codes are 4 letters.'));
      const room = rooms.get(code);
      if (!room) return ack(fail('ROOM_NOT_FOUND', `No room with code ${code}. Check the code on the TV.`));
      const name = cleanName(payload.name);
      const tokenIn = typeof payload.token === 'string' && TOKEN_RE.test(payload.token) ? payload.token : undefined;

      let seat = tokenIn ? room.byToken(tokenIn) : undefined;
      if (seat) {
        // Rejoin: same seat. A new connection replaces the old one.
        if (seat.socketId && seat.socketId !== socket.id) io.sockets.sockets.get(seat.socketId)?.disconnect(true);
        clearTimeout(seat.graceTimer);
        if (name) seat.name = name;
      } else {
        if (!name) return ack(fail('BAD_NAME', 'Enter a name.'));
        if (room.seats.length >= MAX_PLAYERS) return ack(fail('ROOM_FULL', 'This room is full.'));
        // After a server restart the phone brings its old token back. Keep it.
        // After a restart the phone brings back its old seat id too. Keep it.
        const id = (tokenIn && room.claimSeatId(payload.seatId)) || room.nextSeatId();
        seat = { id, token: tokenIn ?? makeToken(), name, socketId: null };
        room.seats.push(seat);
        room.sortSeats();
      }
      // This socket already held a different seat: release it.
      if (role === 'phone' && seatId && seatId !== seat.id && roomCode) {
        const oldRoom = rooms.get(roomCode);
        const old = oldRoom?.byId(seatId);
        if (oldRoom && old?.socketId === socket.id) {
          old.socketId = null;
          dropSeat(oldRoom, seatId);
        }
      }
      seat.socketId = socket.id;
      roomCode = code;
      role = 'phone';
      seatId = seat.id;
      socket.join(code);
      if (!room.leaderId || !room.byId(room.leaderId)) room.electLeader();
      ack({ ok: true, code, token: seat.token, you: { id: seat.id, name: seat.name }, state: room.state() });
      broadcast(room);
      room.serverGame?.onPlayerConnected?.(seat.id);
    });

    const currentRoom = () => (roomCode ? rooms.get(roomCode) : undefined);

    safe<{ ok: boolean }>('phone:leave', (_p, ack) => {
      const room = currentRoom();
      if (room && role === 'phone' && seatId) {
        const id = seatId;
        seatId = null;
        roomCode = null;
        dropSeat(room, id);
      }
      ack({ ok: true });
    });

    safe<{ ok: true } | Fail>('leader:pick', (payload, ack) => {
      const room = currentRoom();
      if (!room || role !== 'phone' || seatId !== room.leaderId) return ack(fail('NOT_LEADER', 'Only the leader can pick.'));
      const gameId = isObj(payload) ? payload.gameId : undefined;
      if (typeof gameId !== 'string' || !serverGames.has(gameId)) return ack(fail('BAD_REQUEST', 'Unknown game.'));
      startGame(room, gameId);
      ack({ ok: true });
      broadcast(room);
    });

    safe<{ ok: true } | Fail>('leader:end', (_payload, ack) => {
      const room = currentRoom();
      if (!room || role !== 'phone' || seatId !== room.leaderId) return ack(fail('NOT_LEADER', 'Only the leader can end the game.'));
      endGame(room);
      ack({ ok: true });
      broadcast(room);
    });

    // Phone or TV -> the game's server part
    safe<void>('to-server', (payload) => {
      const room = currentRoom();
      if (!room?.serverGame || !isObj(payload) || typeof payload.type !== 'string') return;
      if (role === 'phone' && seatId) room.serverGame.onPhoneMessage(seatId, payload.type, payload.data);
      else if (role === 'tv') room.serverGame.onTvMessage?.(payload.type, payload.data);
    });
    // Phone -> TV
    safe<void>('to-tv', (payload) => {
      const room = currentRoom();
      if (!room || role !== 'phone' || !seatId || !room.tvSocketId || !isObj(payload) || typeof payload.type !== 'string') return;
      io.to(room.tvSocketId).emit('msg', { from: seatId, type: payload.type, data: payload.data });
    });
    // TV -> one phone
    safe<void>('to-phone', (payload) => {
      const room = currentRoom();
      if (!room || role !== 'tv' || !isObj(payload) || typeof payload.type !== 'string') return;
      const seat = typeof payload.playerId === 'string' ? room.byId(payload.playerId) : undefined;
      if (seat?.socketId) io.to(seat.socketId).emit('msg', { type: payload.type, data: payload.data });
    });
    // TV -> all phones
    safe<void>('to-phones', (payload) => {
      const room = currentRoom();
      if (!room || role !== 'tv' || !isObj(payload) || typeof payload.type !== 'string') return;
      for (const s of room.seats) if (s.socketId) io.to(s.socketId).emit('msg', { type: payload.type, data: payload.data });
    });

    socket.on('disconnect', () => {
      const room = currentRoom();
      if (!room) return;
      if (role === 'tv' && room.tvSocketId === socket.id) {
        room.tvSocketId = null;
        scheduleRoomDelete(room);
      } else if (role === 'phone' && seatId) {
        const seat = room.byId(seatId);
        if (!seat || seat.socketId !== socket.id) return; // replaced by a newer connection
        seat.socketId = null;
        const id = seat.id;
        clearTimeout(seat.graceTimer);
        if (room.leaderId === id) {
          seat.graceTimer = setTimeout(() => {
            if (room.leaderId === id && !room.byId(id)?.socketId) {
              room.electLeader(id);
              broadcast(room);
            }
          }, leaderGraceMs);
          seat.graceTimer.unref?.();
        }
        broadcast(room);
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 3000, resolve));
  const port = (httpServer.address() as { port: number }).port;
  log(`listening on http://localhost:${port} (${mode})`);
  return {
    url: `http://localhost:${port}`,
    port,
    rooms,
    wipe: () => {
      for (const r of rooms.values()) {
        clearTimeout(r.deleteTimer);
        r.seats.forEach((s) => clearTimeout(s.graceTimer));
      }
      rooms.clear();
      for (const s of io.sockets.sockets.values()) s.conn.close(); // transport close: clients reconnect
    },
    close: async () => {
      for (const r of rooms.values()) {
        clearTimeout(r.deleteTimer);
        r.seats.forEach((s) => clearTimeout(s.graceTimer));
      }
      await io.close();
      await vite?.close();
      if (httpServer.listening) await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
