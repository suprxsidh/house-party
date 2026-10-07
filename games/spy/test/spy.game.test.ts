import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep, type TestRoom } from '../../../bots/harness.ts';
import { CROWD_SIZE, POINTS, ROUNDS, STAB_COOLDOWN_MS, assassinCount, botCount, type EndMsg, type RoleMsg, type RoundMsg } from '../types.ts';

process.env.HP_SPY_CARD_MS = '0';
process.env.HP_SPY_GAP_MS = '150';
process.env.HP_SPY_ROUND_MS = '60000';

type M = { type: string; data: any };
const spyMsgs = (b: { layerMsgs: M[] }, type: string) => b.layerMsgs.filter((m) => m.type === type);
const lastRole = (r: TestRoom, i: number) => spyMsgs(r.bots[i], 'spy:role').at(-1)?.data as RoleMsg | undefined;
const tvAll = (r: TestRoom) => [...r.tv.msgs, ...r.tv.layerMsgs] as M[];
const tvOf = (r: TestRoom, type: string) => tvAll(r).filter((m) => m.type === type);

async function play(n: number, roundMs = 60000) {
  process.env.HP_SPY_ROUND_MS = String(roundMs);
  const r = await setupRoom(n);
  await r.start('spy');
  await until(() => r.bots.every((_, i) => lastRole(r, i)), 3000, 'every bot has a role');
  const ids = r.bots.map((b) => b.id!);
  const assassins = ids.filter((_, i) => lastRole(r, i)!.role === 'assassin');
  const civilians = ids.filter((_, i) => lastRole(r, i)!.role === 'civilian');
  const act = (actor: string, target: string, extra: object = {}) => r.tv.toServer('spy:act', { actor, target, ...extra });
  const idx = (id: string) => ids.indexOf(id);
  return { r, ids, assassins, civilians, act, idx };
}

/** Everything the TV got before spy:end must be free of roles. */
function assertNoRoleLeak(r: TestRoom) {
  const msgs = tvAll(r);
  const endAt = msgs.findIndex((m) => m.type === 'spy:end');
  const before = endAt < 0 ? msgs : msgs.slice(0, endAt);
  assert.ok(before.length > 0);
  for (const m of before) {
    assert.notEqual(m.type, 'spy:role', 'spy:role reached the TV');
    const s = JSON.stringify(m.data);
    assert.ok(!/"role"|assassin|civilian/i.test(s.replace(/assassins-caught|civilians-out/g, '')), `role text in ${m.type}: ${s}`);
  }
}

const endMsgs = (r: TestRoom) => tvOf(r, 'spy:end').map((m) => m.data as EndMsg);
const results = (r: TestRoom) => tvOf(r, 'spy:result').map((m) => m.data);

for (const n of [4, 10]) {
  test(`${n} players: assassin count, full crowd of 40, TV learns no role before spy:end`, async () => {
    const { r, ids, assassins, civilians, act } = await play(n);
    try {
      assert.equal(assassins.length, n === 4 ? 1 : 2);
      assert.equal(assassins.length, assassinCount(n));
      const round = tvOf(r, 'spy:round')[0].data as RoundMsg;
      assert.equal(round.botCount, botCount(n));
      assert.equal(round.playerIds.length + round.botCount, CROWD_SIZE);
      assert.deepEqual(round.playerIds, ids);
      assert.ok(spyMsgs(r.bots[0], 'spy:round').length >= 1, 'phones get spy:round');
      // A stab on a bot, a wrong arrest of a bot, a kill: still no role on the TV.
      const want = ['arrest-wrong', 'kill'];
      act(assassins[0], civilians[1]);
      if (assassins.length > 1) {
        act(assassins[1], 'bot-3');
        want.push('miss');
      }
      act(civilians[0], 'bot-4');
      await until(() => results(r).length === want.length, 2000, 'results');
      assert.deepEqual(results(r).map((x) => x.kind).sort(), want.sort());
      assertNoRoleLeak(r);
      // Every remaining civilian arrests an assassin: round ends.
      const rest = civilians.slice(2);
      for (let i = 0; i < assassins.length; i++) act(rest[i], assassins[i]);
      await until(() => endMsgs(r).length === 1, 3000, 'spy:end');
      assertNoRoleLeak(r);
      const end = endMsgs(r)[0];
      assert.equal(end.reason, 'assassins-caught');
      assert.equal(end.scores.filter((s) => s.role === 'assassin').length, assassins.length);
      assert.equal(end.scores.length, n);
      assert.equal(end.final, false);
      // The TV only now has roles: they match what the phones were told.
      for (const s of end.scores) assert.equal(s.role, lastRoleById(r, s.id));
    } finally {
      await r.close();
    }
  });
}

function lastRoleById(r: TestRoom, id: string) {
  const i = r.bots.findIndex((b) => b.id === id);
  return spyMsgs(r.bots[i], 'spy:role').find((m) => m.data.round === 1)!.data.role;
}

test('scores follow the points table and the totals add up', async () => {
  const { r, assassins, civilians, act } = await play(5);
  try {
    const [a] = assassins;
    const [c1, c2, c3, c4] = civilians;
    act(a, c1); // +100
    act(c2, c3); // wrong arrest of a civilian: c2 -100, c3 out
    act(c4, a); // arrest-ok: c4 +300, a out
    const end = (await until(() => endMsgs(r).length === 1, 3000, 'end'), endMsgs(r)[0]);
    const pts = (id: string) => end.scores.find((s) => s.id === id)!.points;
    assert.equal(pts(a), POINTS.assassinKill); // caught: no alive bonus
    assert.equal(pts(c1), 0);
    assert.equal(pts(c2), POINTS.civilianWrongArrest + POINTS.civilianAlive);
    assert.equal(pts(c3), 0);
    assert.equal(pts(c4), POINTS.civilianArrestAssassin + POINTS.civilianAlive);
  } finally {
    await r.close();
  }
});

test('drop mid-round and rejoin: same role, still out after a kill, cooldown kept', async () => {
  const { r, assassins, civilians, act, idx } = await play(6);
  try {
    const before = r.bots.map((_, i) => lastRole(r, i)!.role);
    act(assassins[0], civilians[0]);
    await until(() => results(r).length === 1, 2000, 'kill');
    const ai = idx(assassins[0]);
    const vi = idx(civilians[0]);
    for (const i of [ai, vi, 3]) {
      r.bots[i].layerMsgs.length = 0;
      r.bots[i].drop();
    }
    await sleep(100);
    for (const i of [ai, vi, 3]) r.bots[i].reconnect();
    await until(() => [ai, vi, 3].every((i) => spyMsgs(r.bots[i], 'spy:role').length > 0 && spyMsgs(r.bots[i], 'spy:round').length > 0), 3000, 'rejoin msgs');
    for (const i of [ai, vi, 3]) assert.equal(lastRole(r, i)!.role, before[i], `bot ${i} same role`);
    assert.equal(lastRole(r, vi)!.out, true);
    assert.equal(lastRole(r, ai)!.points, POINTS.assassinKill);
    const cd = lastRole(r, ai)!.cooldownMs;
    assert.ok(cd > 0 && cd <= STAB_COOLDOWN_MS, `cooldown ${cd}`);
    assertNoRoleLeak(r);
  } finally {
    await r.close();
  }
});

test('two ACT presses on one target in the same tick: one kill, no double points', async () => {
  const { r, assassins, civilians, act } = await play(8);
  try {
    assert.equal(assassins.length, 2);
    const [a1, a2] = assassins;
    // Same actor twice, then a second assassin on the same target, all in one burst.
    act(a1, civilians[0]);
    act(a1, civilians[0]);
    act(a2, civilians[0]);
    act(a1, civilians[1]); // a1 is cooling down
    await sleep(300);
    const res = results(r);
    assert.equal(res.length, 2, `got ${JSON.stringify(res.map((x) => x.kind))}`);
    assert.deepEqual(res.map((x) => x.kind), ['kill', 'miss']);
    assert.deepEqual(res[0].out, [civilians[0]]);
    assert.deepEqual(res[1].out, []);
    assert.equal(lastRole(r, r.bots.findIndex((b) => b.id === a1))!.points, POINTS.assassinKill);
    assert.equal(lastRole(r, r.bots.findIndex((b) => b.id === a2))!.points, 0);
    assert.equal(res[1].seq, res[0].seq + 1);
  } finally {
    await r.close();
  }
});

test('out players cannot act; dist over range is a miss', async () => {
  const { r, assassins, civilians, act } = await play(5);
  try {
    act(assassins[0], civilians[0]); // civilians[0] is out
    await until(() => results(r).length === 1, 2000, 'kill');
    act(civilians[0], assassins[0]); // out civilian tries to arrest the assassin
    act(civilians[1], assassins[0], { dist: 5 }); // too far: miss, arrest not used
    await until(() => results(r).length === 2, 2000, 'range miss');
    assert.equal(results(r)[1].kind, 'miss');
    assert.equal(lastRole(r, r.bots.findIndex((b) => b.id === civilians[1]))!.arrestsLeft, 1);
    act(civilians[1], assassins[0], { dist: 1.9 }); // in range: arrest works
    await until(() => endMsgs(r).length === 1, 3000, 'assassins caught');
    assert.equal(results(r).length, 3);
    assert.equal(endMsgs(r)[0].scores.find((s) => s.id === civilians[0])!.points, 0, 'out civilian got nothing');
  } finally {
    await r.close();
  }
});

test('cheats: phones cannot send spy:act, spy:role, spy:result, spy:end, spy:round, spy:me or spy:next', async () => {
  const { r, assassins, civilians, ids } = await play(5);
  try {
    const mark = tvAll(r).length;
    const phoneMark = r.bots.map((b) => b.layerMsgs.length);
    for (let i = 0; i < r.bots.length; i++) {
      r.sendServer(i, 'spy:act', { actor: assassins[0], target: civilians[0] });
      r.sendServer(i, 'spy:act', { actor: ids[i], target: civilians[1] });
      r.sendServer(i, 'spy:role', { role: 'assassin' });
      r.sendServer(i, 'spy:result', { kind: 'kill', actor: ids[i], target: civilians[0], out: [civilians[0]] });
      r.sendServer(i, 'spy:end', { scores: [] });
      r.sendServer(i, 'spy:round', { round: 3 });
      r.sendServer(i, 'spy:me', { x: 0, z: 0 });
      r.sendServer(i, 'spy:next', {});
      r.sendServer(i, 'spy:move', { x: 1, y: 1 });
      if (i !== 0) r.sendServer(i, 'spy:drinks', { on: true }); // only the leader (bot 0) may toggle
    }
    await sleep(300);
    assert.equal(tvAll(r).length, mark, 'TV got nothing from the cheats');
    r.bots.forEach((b, i) => assert.equal(b.layerMsgs.length, phoneMark[i], 'no phone got anything'));
    // The game state is untouched: a real TV act still gives the first kill, fresh actor, full points.
    r.tv.toServer('spy:act', { actor: assassins[0], target: civilians[0] });
    await until(() => results(r).length === 1, 2000, 'real kill');
    assert.equal(results(r)[0].kind, 'kill');
    assert.equal(lastRole(r, r.bots.findIndex((b) => b.id === assassins[0]))!.points, POINTS.assassinKill);
    // Bad TV payloads are ignored too.
    const n = results(r).length;
    for (const bad of [null, 5, 'x', {}, { actor: 1, target: 2 }, { actor: assassins[0] }, { actor: assassins[0], target: civilians[1], dist: 'near' }, { actor: 'p99', target: civilians[1] }]) r.tv.toServer('spy:act', bad);
    r.tv.toServer('spy:next', { round: 1 }); // round still running: ignored
    await sleep(200);
    assert.equal(results(r).length, n);
    assert.equal(tvOf(r, 'spy:round').length, 1, 'no extra round started');
    // Leader may toggle drinks.
    r.sendServer(0, 'spy:drinks', { on: true });
    await until(() => tvOf(r, 'spy:round').some((m) => m.data.drinks === true), 2000, 'drinks on');
  } finally {
    await r.close();
  }
});

test('three rounds: roles rotate, spy:next and the gap timer both advance, final round stops', async () => {
  const { r, ids, act, idx } = await play(5, 60000);
  try {
    const assassinOf = (round: number) => ids.filter((id) => spyMsgs(r.bots[idx(id)], 'spy:role').find((m) => m.data.round === round)?.data.role === 'assassin');
    const seen: string[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      await until(() => ids.every((id) => spyMsgs(r.bots[idx(id)], 'spy:role').some((m) => m.data.round === round)), 3000, `round ${round} roles`);
      const a = assassinOf(round);
      assert.equal(a.length, 1);
      seen.push(a[0]);
      const civ = ids.filter((id) => id !== a[0]);
      act(civ[0], a[0]); // arrest ends the round
      await until(() => endMsgs(r).length === round, 3000, `end ${round}`);
      assert.equal(endMsgs(r)[round - 1].final, round === ROUNDS);
      if (round === 1) r.tv.toServer('spy:next', {}); // TV skips the pause
      // round 2: no spy:next, the gap timer (150 ms) must advance
      if (round === ROUNDS) break;
    }
    assert.equal(new Set(seen).size, ROUNDS, `assassins rotate: ${seen}`);
    assert.equal(tvOf(r, 'spy:round').filter((m) => !m.data.over).length, ROUNDS);
    assert.ok(tvOf(r, 'spy:round').some((m) => m.data.over), 'final spy:round has over=true');
    // Totals add up over the rounds.
    const last = endMsgs(r)[ROUNDS - 1];
    const sum = (id: string) => endMsgs(r).reduce((a, e) => a + e.scores.find((s) => s.id === id)!.points, 0);
    for (const s of last.scores) assert.equal(s.total, sum(s.id));
    // After the match nothing starts again.
    r.tv.toServer('spy:next', {});
    await sleep(400);
    assert.equal(endMsgs(r).length, ROUNDS);
    assert.equal(tvOf(r, 'spy:round').filter((m) => !m.data.over).length, ROUNDS);
  } finally {
    await r.close();
  }
});

test('timer ends the round with alive bonuses; TV reload gets round and end again', async () => {
  const { r, assassins } = await play(4, 700);
  try {
    await until(() => endMsgs(r).length === 1, 3000, 'timer end');
    const end = endMsgs(r)[0];
    assert.equal(end.reason, 'timer');
    for (const s of end.scores) assert.equal(s.points, s.role === 'assassin' ? POINTS.assassinAlive : POINTS.civilianAlive);
    assert.equal(end.scores.find((s) => s.id === assassins[0])!.role, 'assassin');
    // TV reload: same secret re-attaches.
    const n = tvAll(r).length;
    await r.tv.create(r.code, r.tv.secret);
    await until(() => tvAll(r).slice(n).some((m) => m.type === 'spy:end'), 2000, 'end resent');
    assert.ok(tvAll(r).slice(n).some((m) => m.type === 'spy:round'));
  } finally {
    await r.close();
  }
});

test('spy:ready from the TV resends the round (TV mounted after leader:pick)', async () => {
  const { r } = await play(4);
  try {
    const before = tvOf(r, 'spy:round').length;
    r.tv.toServer('spy:ready', {});
    await until(() => tvOf(r, 'spy:round').length === before + 1, 2000, 'round resent');
    for (const i of [0, 1]) r.sendServer(i, 'spy:ready', {}); // phones may not trigger it
    await sleep(200);
    assert.equal(tvOf(r, 'spy:round').length, before + 1);
  } finally {
    await r.close();
  }
});
