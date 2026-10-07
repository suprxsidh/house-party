import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { boot, FakeTv, until, sleep } from './helpers.ts';
import { Bot, joinBots } from '../bots/Bot.ts';
import type { RunningServer } from '../server/index.ts';

let srv: RunningServer;
before(async () => {
  srv = await boot();
});
after(async () => {
  Bot.closeAll();
  FakeTv.closeAll();
  await srv.close();
});

test('review 1: wrong, malformed and lowercase codes', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  assert.match(made.code, /^[A-Z]{4}$/);

  const bad = new Bot(srv.url, 'Ann');
  const unknown = await bad.join('ZZZZ' === made.code ? 'YYYY' : 'ZZZZ');
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error, 'ROOM_NOT_FOUND');
  assert.match(!unknown.ok ? unknown.message : '', /no room/i);

  for (const junk of ['', 'A', 'ABCDE', '12!4', '<b>', ' ']) {
    const r = await bad.join(junk);
    assert.equal(r.ok, false, `junk ${JSON.stringify(junk)}`);
    assert.equal(!r.ok && r.error, 'BAD_CODE');
  }

  const lower = new Bot(srv.url, 'Lowie');
  const ok = await lower.join(made.code.toLowerCase());
  assert.ok(ok.ok, 'lowercase code joins');
  assert.equal(ok.ok && ok.code, made.code);

  // server still alive after garbage payloads
  bad.socket.emit('phone:join', null);
  bad.socket.emit('phone:join', { code: 42, name: {} });
  bad.socket.emit('tv:create', 'nope');
  const again = await bad.join(made.code);
  assert.ok(again.ok, 'server survives garbage');
  [tv, bad, lower].forEach((x) => x.close());
});

test('review 2: phone drops and rejoins, same seat and state', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const [a, b, c] = await joinBots(srv.url, made.code, 3, 'P');
  const seatB = b.id;
  const tokenB = b.token;
  b.drop();
  await until(() => tv.state?.players.find((p) => p.id === seatB)?.connected === false, 3000, 'b marked offline');
  b.reconnect();
  await until(() => tv.state?.players.find((p) => p.id === seatB)?.connected === true, 3000, 'b back online');
  assert.equal(b.id, seatB);
  assert.equal(b.token, tokenB);
  assert.equal(tv.state?.players.length, 3);
  // A fresh bot with a different name but the same token takes the same seat (rejoin by token, not name).
  b.close(); // stop b auto-rejoining so the clone owns the seat
  const clone = new Bot(srv.url, 'Different name');
  clone.token = tokenB;
  const r = await clone.join(made.code);
  assert.ok(r.ok && r.you.id === seatB);
  await sleep(100);
  assert.equal(tv.state?.players.length, 3);
  // A same-name stranger without the token gets a NEW seat.
  const stranger = new Bot(srv.url, 'P2');
  const r2 = await stranger.join(made.code);
  assert.ok(r2.ok && r2.you.id !== seatB);
  await until(() => tv.state?.players.length === 4, 2000, '4 seats');
  [tv, a, b, c, clone, stranger].forEach((x) => x.close());
});

test('leader: first phone leads; role passes after grace; back within grace keeps it', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const [a, b, c] = await joinBots(srv.url, made.code, 3, 'L');
  assert.equal(tv.state?.leaderId, a.id);
  // quick blip: grace is 300ms in tests
  a.drop();
  await sleep(50);
  a.reconnect();
  await until(() => a.state?.players.find((p) => p.id === a.id)?.connected === true, 2000, 'a back');
  await sleep(500);
  assert.equal(tv.state?.leaderId, a.id, 'blip keeps leader');
  // long drop
  a.drop();
  await until(() => tv.state?.leaderId === b.id, 3000, 'leader moves to b');
  a.reconnect();
  await until(() => a.state?.players.find((p) => p.id === a.id)?.connected === true, 2000, 'a back again');
  assert.equal(tv.state?.leaderId, b.id, 'a returns as a normal player');
  // explicit leave by leader
  const ack = await b.socket.timeout(2000).emitWithAck('phone:leave', {});
  assert.equal(ack.ok, true);
  await until(() => tv.state?.leaderId === a.id || tv.state?.leaderId === c.id, 2000, 'leader after leave');
  await until(() => tv.state?.players.length === 2, 2000, '2 seats');
  // only the leader may pick a game
  const non = tv.state!.leaderId === a.id ? c : a;
  const denied = await non.socket.timeout(2000).emitWithAck('leader:pick', { gameId: 'kart' });
  assert.equal(denied.ok, false);
  [tv, a, b, c].forEach((x) => x.close());
});

test('messages: phone -> TV and TV -> one phone', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const [a, b] = await joinBots(srv.url, made.code, 2, 'M');
  a.sendToTv('hello', { n: 1 });
  await until(() => tv.msgs.length === 1, 2000, 'tv msg');
  assert.deepEqual(tv.msgs[0], { from: a.id, type: 'hello', data: { n: 1 } });
  tv.socket.emit('to-phone', { playerId: b.id, type: 'secret', data: 'x' });
  await until(() => b.msgs.length === 1, 2000, 'b msg');
  assert.equal(a.msgs.length, 0, 'a did not get b message');
  [tv, a, b].forEach((x) => x.close());
});

test('review 4: TV reload keeps room code; wiped server re-creates it; phones rejoin', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const bots = await joinBots(srv.url, made.code, 4, 'R');
  const ids = bots.map((b) => b.id);
  tv.close(); // TV reload
  const tv2 = new FakeTv(srv.url);
  const again = await tv2.create(made.code, tv.secret);
  assert.ok(again.ok && again.code === made.code);
  assert.deepEqual(again.ok && again.state.players.map((p) => p.id), ids, 'players kept on reload');
  // server restart: rooms wiped
  srv.wipe(); // phones and TV are dropped; they reconnect by themselves
  tv2.close();
  const tv3 = new FakeTv(srv.url);
  const re = await tv3.create(made.code.toLowerCase(), tv.secret);
  assert.ok(re.ok && re.code === made.code, 'same code re-created');
  assert.equal(re.ok && re.state.players.length, 0);
  // phones that notice a reconnect rejoin on their own
  await until(() => tv3.state?.players.length === 4, 5000, 'all 4 phones back');
  assert.deepEqual(tv3.state!.players.map((p) => p.id).length, 4);
  // an invalid requested code is refused
  const badTv = new FakeTv(srv.url);
  const bad = await badTv.create('12');
  assert.equal(bad.ok, false);
  [tv3, badTv, ...bots].forEach((x) => x.close());
});

test('review 5: HTML names stay plain text on the wire', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const evil = '<img src=x onerror=alert(1)>';
  const a = new Bot(srv.url, evil);
  const r = await a.join(made.code);
  assert.ok(r.ok);
  assert.equal(r.ok && r.you.name, evil, 'text kept as typed, escaped at render time');
  const empty = await new Bot(srv.url, '   ').join(made.code);
  assert.equal(!empty.ok && empty.error, 'BAD_NAME');
  const long = await new Bot(srv.url, 'x'.repeat(200)).join(made.code);
  assert.ok(long.ok && long.you.name.length <= 30);
  [tv, a].forEach((x) => x.close());
});

test('security: a phone cannot kick or hijack the TV', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok && made.secret);
  const [a] = await joinBots(srv.url, made.code, 1, 'S');
  // phone socket tries tv:create for the live room
  const r1 = await a.socket.timeout(2000).emitWithAck('tv:create', { code: made.code });
  assert.equal(r1.ok, false);
  // a stranger socket with no or wrong secret
  const evil = new FakeTv(srv.url);
  assert.equal((await evil.create(made.code)).ok, false);
  assert.equal((await evil.create(made.code, 'x'.repeat(32))).ok, false);
  await sleep(200);
  assert.equal(tv.socket.connected, true, 'TV was not kicked');
  a.sendToTv('still', 1);
  await tv.waitFor('still');
  // right secret still re-attaches (TV reload)
  const tv2 = new FakeTv(srv.url);
  assert.equal((await tv2.create(made.code, made.secret)).ok, true);
  // a TV socket cannot join as a phone
  const r2 = await tv2.socket.timeout(2000).emitWithAck('phone:join', { code: made.code, name: 'x' });
  assert.equal(r2.ok, false);
});

test('seat ids survive a wipe, even when phones rejoin in reverse order', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const bots = await joinBots(srv.url, made.code, 3, 'W');
  const ids = bots.map((b) => b.id);
  bots.forEach((b) => b.socket.disconnect()); // hold them offline, then wipe
  srv.wipe();
  tv.close();
  const tv2 = new FakeTv(srv.url);
  assert.ok((await tv2.create(made.code, made.secret)).ok);
  for (const b of [...bots].reverse()) {
    b.socket.connect();
    await until(() => tv2.state?.players.some((p) => p.id === b.id) ?? false, 3000, `${b.name} back`);
  }
  assert.deepEqual(tv2.state!.players.map((p) => p.id), ids, 'ids and order unchanged');
  assert.deepEqual(bots.map((b) => b.id), ids);
});

test('one socket joining twice releases its old seat', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const a = new Bot(srv.url, 'Twice');
  await a.join(made.code);
  const first = a.id;
  const r = await a.socket.timeout(2000).emitWithAck('phone:join', { code: made.code, name: 'Other' });
  assert.ok(r.ok && r.you.id !== first);
  await until(() => tv.state?.players.length === 1 && tv.state.players[0].name === 'Other', 5000, 'old seat gone');
  assert.equal(tv.state!.players[0].name, 'Other');
});

test('TV drops mid-game and reconnects with its secret: the game id survives', async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  const bots = await joinBots(srv.url, made.code, 2, 'D');
  assert.equal((await bots[0].socket.timeout(2000).emitWithAck('leader:pick', { gameId: 'stub' })).ok, true);
  await until(() => tv.state?.game?.id === 'stub', 3000, 'game on TV');
  tv.socket.io.engine.close(); // network drop; the client reconnects by itself
  await until(() => !tv.socket.connected, 3000, 'TV dropped');
  await until(() => tv.socket.connected, 5000, 'TV reconnected');
  const again = await tv.create(made.code, tv.secret);
  assert.ok(again.ok);
  assert.equal(again.ok && again.state.game?.id, 'stub', 'game kept after TV reconnect');
  [tv, ...bots].forEach((x) => x.close());
});

test('a TV tab that misses pongs for 16 s stays connected (CPU starvation while the kart bundle boots)', { timeout: 60_000 }, async () => {
  const tv = new FakeTv(srv.url);
  const made = await tv.create();
  assert.ok(made.ok);
  let disconnects = 0;
  tv.socket.on('disconnect', () => disconnects++);
  const eng = tv.socket.io.engine as unknown as { _sendPacket: (t: string, ...a: unknown[]) => void };
  const send = eng._sendPacket.bind(eng);
  let mute = true;
  eng._sendPacket = (t, ...a) => (t === 'pong' && mute ? undefined : send(t, ...a));
  await sleep(16_000);
  mute = false;
  assert.equal(disconnects, 0, 'server did not drop a TV that was silent for 16 s');
  tv.close();
});
