import { io } from 'socket.io-client';
import '../common/style.css';
import '../../games/phone.registry.ts';
import { phoneGames } from '../../shared/registry.ts';
import type { PhoneGame } from '../../shared/games.ts';
import type { JoinReply, RoomState } from '../../shared/protocol.ts';
import { enableTilt } from '../common/tilt.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const socket = io({ reconnectionDelay: 300, reconnectionDelayMax: 2000 });

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

let target: string | null = null; // room we want to be in; set once a join worked or a seat exists
let me: { id: string; name: string } | null = null;
let state: RoomState | null = null;
let current: { id: string; game: PhoneGame } | null = null;
const layers = new Map<string, PhoneGame>(); // always-on side layers (info.layer)
let retry: ReturnType<typeof setTimeout> | undefined;

const params = new URLSearchParams(location.search);
$<HTMLInputElement>('room-input').value = (params.get('room') ?? get('hp.room') ?? '').toUpperCase();
$<HTMLInputElement>('name-input').value = get('hp.name') ?? '';

const showError = (m: string) => ($('error').textContent = m);

async function join(code: string, name: string): Promise<JoinReply> {
  const c = code.trim().toUpperCase();
  const token = get(`hp.seat.${c}`) ?? undefined;
  const reply: JoinReply = await socket.timeout(5000).emitWithAck('phone:join', { code: c, name, token, seatId: get(`hp.seatId.${c}`) ?? undefined });
  if (reply.ok) {
    clearTimeout(retry);
    target = reply.code;
    me = reply.you;
    set(`hp.seat.${reply.code}`, reply.token);
    set(`hp.seatId.${reply.code}`, reply.you.id);
    set('hp.room', reply.code);
    set('hp.name', reply.you.name);
    document.body.dataset.seat = reply.you.id;
    showError('');
    $('join-form').hidden = true;
    $('room-view').hidden = false;
    $('you-name').textContent = reply.you.name;
    const st = $('status');
    st.textContent = 'Connected';
    st.className = 'connected';
    apply(reply.state);
  } else if (reply.error === 'ROOM_NOT_FOUND' && token && target === c) {
    // The server restarted. Wait for the TV to bring the room back.
    const st = $('status');
    st.textContent = 'Waiting for the TV';
    st.className = 'waiting';
    clearTimeout(retry);
    retry = setTimeout(() => void rejoin(), 1000);
  } else {
    showError(reply.message);
  }
  return reply;
}

function rejoin() {
  if (!target) return;
  const name = get('hp.name') ?? '';
  return join(target, name).catch(() => { retry = setTimeout(() => void rejoin(), 1000); });
}

function apply(s: RoomState) {
  state = s;
  const mine = s.players.find((p) => p.id === me?.id);
  const leader = !!mine?.leader;
  $('role').textContent = leader ? 'Leader' : 'Player';
  $('players-list').replaceChildren(
    ...s.players.map((p) => {
      const li = document.createElement('li');
      li.textContent = p.name + (p.leader ? ' (leader)' : '') + (p.connected ? '' : ' (offline)');
      return li;
    }),
  );
  $('picker').hidden = !leader || !!s.game;
  $('game-bar').hidden = !leader || !s.game;
  syncGame(s);
  mountLayers();
  for (const l of layers.values()) l.onRoomState?.();
}

function mountLayers() {
  if (layers.size || !me) return;
  for (const [id, reg] of phoneGames) {
    if (!reg.info.layer) continue;
    const root = document.createElement('section');
    root.id = `layer-${id}`;
    $('game-root').after(root);
    const g = reg.create();
    layers.set(id, g);
    g.mount({
      root,
      me: me!,
      isLeader: () => !!state?.players.find((p) => p.id === me?.id)?.leader,
      toTv: (type, data) => socket.emit('to-tv', { type, data }),
      toServer: (type, data) => socket.emit('to-server', { type, data }),
    });
  }
}

function buildPicker() {
  const list = $('picker-list');
  const games = [...phoneGames.values()].filter((g) => !g.info.layer);
  if (!games.length) list.textContent = 'No games installed yet.';
  list.replaceChildren(
    ...games.map(({ info }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.game = info.id;
      b.textContent = `${info.name} - ${info.blurb}`; // textContent: safe
      b.onclick = () => socket.emit('leader:pick', { gameId: info.id });
      return b;
    }),
  );
}

function syncGame(s: RoomState) {
  const want = s.game?.id ?? null;
  if (want === (current?.id ?? null)) return;
  current?.game.destroy();
  current = null;
  const root = $('game-root');
  root.replaceChildren();
  const reg = want ? phoneGames.get(want) : undefined;
  if (!want || !reg || !me) return;
  const game = reg.create();
  current = { id: want, game };
  game.mount({
    root,
    me,
    isLeader: () => !!state?.players.find((p) => p.id === me?.id)?.leader,
    toTv: (type, data) => socket.emit('to-tv', { type, data }),
    toServer: (type, data) => socket.emit('to-server', { type, data }),
  });
}

socket.on('room:state', (s: RoomState) => { if (me) apply(s); });
socket.on('msg', (m: { type: string; data: unknown }) => (layers.get(m.type.split(':')[0]) ?? current?.game)?.onMessage(m.type, m.data));
socket.on('connect', () => { if (target) void rejoin(); });
socket.on('disconnect', () => {
  if (!target) return;
  const st = $('status');
  st.textContent = 'Reconnecting';
  st.className = 'waiting';
});

$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $<HTMLInputElement>('room-input').value;
  const name = $<HTMLInputElement>('name-input').value;
  showError('');
  if (!/^[A-Za-z]{4}$/.test(code.trim())) return showError('Room codes are 4 letters.');
  if (!name.trim()) return showError('Enter a name.');
  void join(code, name).catch(() => showError('Could not reach the server. Try again.'));
});

$('tilt-btn').addEventListener('click', async () => {
  const r = await enableTilt();
  $('tilt-status').textContent = r === 'granted' ? 'Tilt on' : r === 'denied' ? 'Tilt blocked. Allow motion in Settings.' : 'No tilt sensor here.';
});
$('end-game').addEventListener('click', () => socket.emit('leader:end', {}));
$('leave-btn').addEventListener('click', async () => {
  if (target) set(`hp.seat.${target}`, null);
  await socket.emitWithAck('phone:leave', {});
  target = null;
  me = null;
  location.href = '/play';
});

buildPicker();
// Page reload: if we hold a seat for the room in the URL (or the last room), rejoin.
{
  const code = $<HTMLInputElement>('room-input').value;
  const name = get('hp.name');
  if (/^[A-Z]{4}$/.test(code) && name && get(`hp.seat.${code}`)) {
    target = code;
    if (socket.connected) void rejoin();
  }
}
(window as any).__hp = { socket };
