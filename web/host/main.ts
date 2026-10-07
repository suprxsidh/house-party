import QRCode from 'qrcode';
import { io } from 'socket.io-client';
import '../common/style.css';
import '../../games/host.registry.ts';
import { hostGames } from '../../shared/registry.ts';
import type { TvGame } from '../../shared/games.ts';
import type { RoomState, TvCreateReply } from '../../shared/protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const socket = io({ reconnectionDelay: 300, reconnectionDelayMax: 2000 });

const KEY = 'hp.tvRoom';
const safeGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } };

let state: RoomState | null = null;
let code: string | null = new URLSearchParams(location.search).get('room')?.toUpperCase() || safeGet(KEY);
let qrFor = '';
let current: { id: string; game: TvGame } | null = null;

async function showQr(c: string) {
  if (qrFor === c) return;
  qrFor = c;
  const link = `${location.origin}/play?room=${c}`;
  const url = await QRCode.toDataURL(link, { margin: 1, width: 400, errorCorrectionLevel: 'M' });
  const img = document.createElement('img');
  img.alt = `QR code for ${link}`;
  img.src = url;
  $('qr').replaceChildren(img);
  $('join-link').textContent = link;
}

function renderPlayers(s: RoomState) {
  const ul = $('players');
  ul.replaceChildren(
    ...s.players.map((p) => {
      const li = document.createElement('li');
      li.dataset.playerId = p.id;
      if (p.leader) li.classList.add('leader');
      if (!p.connected) li.classList.add('offline');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name; // plain text, never HTML
      li.append(name);
      if (p.leader) {
        const m = document.createElement('span');
        m.className = 'mark';
        m.textContent = '★ Leader';
        li.append(m);
      }
      return li;
    }),
  );
}

function syncGame(s: RoomState) {
  const want = s.game?.id ?? null;
  if (want === (current?.id ?? null)) return;
  current?.game.destroy();
  current = null;
  const root = $('game');
  root.replaceChildren();
  document.body.classList.toggle('in-game', !!want);
  root.hidden = !want;
  if (!want) return;
  const reg = hostGames.get(want);
  if (!reg) {
    root.textContent = `Game "${want}" has no TV part yet.`;
    return;
  }
  const game = reg.create();
  current = { id: want, game };
  game.mount({
    root,
    players: () => (state?.players ?? []).map((p) => ({ id: p.id, name: p.name })),
    toPhone: (playerId, type, data) => socket.emit('to-phone', { playerId, type, data }),
    toPhones: (type, data) => socket.emit('to-phones', { type, data }),
    toServer: (type, data) => socket.emit('to-server', { type, data }),
  });
}

socket.on('room:state', (s: RoomState) => {
  state = s;
  renderPlayers(s);
  syncGame(s);
});
socket.on('msg', (m: { from?: string; type: string; data: unknown }) => {
  if (m.from) current?.game.onPhoneMessage(m.from, m.type, m.data);
});

async function create() {
  const secret = code ? safeGet(`hp.tvSecret.${code}`) ?? undefined : undefined;
  let reply: TvCreateReply = await socket.emitWithAck('tv:create', { code: code ?? undefined, secret });
  // Bad stored code, or the room belongs to another screen: start a fresh room.
  if (!reply.ok && (reply.error === 'BAD_CODE' || reply.error === 'TV_AUTH')) reply = await socket.emitWithAck('tv:create', {});
  if (!reply.ok) {
    $('room-code').textContent = '';
    $('join-link').textContent = reply.message;
    return;
  }
  code = reply.code;
  safeSet(KEY, code);
  safeSet(`hp.tvSecret.${code}`, reply.secret);
  history.replaceState(null, '', `?room=${code}`);
  $('room-code').textContent = code;
  state = reply.state;
  renderPlayers(reply.state);
  syncGame(reply.state);
  await showQr(code);
}

// Runs on first connect and after every reconnect (server restart wipes rooms).
socket.on('connect', () => void create());
(window as any).__hp = { socket };
