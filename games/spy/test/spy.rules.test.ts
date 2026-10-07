import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARRESTS_PER_ROUND, POINTS, STAB_BOT_COOLDOWN_MS, STAB_COOLDOWN_MS, assassinCount, botCount, CROWD_SIZE } from '../types.ts';
import { act, assignRoles, cooldownLeft, endReason, finishRound, newRound, pickAssassins, type Round } from '../rules.ts';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const T0 = 1_000_000;
function mk(n: number, assassins: string[], extra: Partial<Parameters<typeof newRound>[0]> = {}): Round {
  const players = ids(n).map((id) => ({ id, name: id.toUpperCase() }));
  const roles = Object.fromEntries(players.map((p) => [p.id, assassins.includes(p.id) ? 'assassin' : 'civilian'])) as any;
  return newRound({ n: 1, players, history: {}, startsAt: T0, endsAt: T0 + 150_000, roles, ...extra });
}

test('role counts: 1 assassin for 4..6 players, 2 for 7..10; crowd is always 40', () => {
  for (const [n, a] of [[4, 1], [5, 1], [6, 1], [7, 2], [8, 2], [10, 2]] as const) {
    const r = newRound({ n: 1, players: ids(n).map((id) => ({ id, name: id })), history: {}, startsAt: 0, endsAt: 1 });
    assert.equal([...r.players.values()].filter((p) => p.role === 'assassin').length, a, `${n} players`);
    assert.equal(assassinCount(n), a);
    assert.equal(r.botCount, botCount(n));
    assert.equal(n + r.botCount, CROWD_SIZE);
  }
  assert.equal(botCount(4), 36);
  assert.equal(botCount(10), 30);
});

test('rotation: over 3 rounds nobody is assassin twice while others have not had a turn', () => {
  for (const n of [4, 5, 6, 7, 10]) {
    const history: Record<string, number> = {};
    const seen = new Map<string, number>();
    for (let round = 0; round < 3; round++) {
      const picked = pickAssassins(ids(n), history, assassinCount(n));
      assert.equal(picked.length, assassinCount(n));
      assert.equal(new Set(picked).size, picked.length);
      for (const id of picked) {
        history[id] = (history[id] ?? 0) + 1;
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    const max = Math.max(...seen.values());
    const want = Math.ceil((3 * assassinCount(n)) / n);
    assert.ok(max <= want, `n=${n}: max turns ${max} > ${want}`);
    if (3 * assassinCount(n) <= n) assert.equal(max, 1, `n=${n}: all assassins distinct`);
  }
});

test('assignRoles keeps one civilian at least when players are few', () => {
  assert.equal([...assignRoles(['a', 'b'], {}).values()].filter((r) => r === 'assassin').length, 1);
  assert.equal([...assignRoles(['a'], {}).values()].filter((r) => r === 'assassin').length, 1);
});

test('stab: kills a human, +100, 4 s cooldown; cannot act during cooldown', () => {
  const r = mk(5, ['p1']);
  const o = act(r, 'p1', 'p2', T0 + 10)!;
  assert.equal(o.result.kind, 'kill');
  assert.deepEqual(o.result.out, ['p2']);
  assert.equal(o.result.alive, 4);
  assert.equal(r.players.get('p1')!.points, POINTS.assassinKill);
  assert.equal(cooldownLeft(r.players.get('p1')!, T0 + 10), STAB_COOLDOWN_MS);
  assert.equal(act(r, 'p1', 'p3', T0 + 10 + STAB_COOLDOWN_MS - 1), null, 'still cooling down');
  assert.equal(act(r, 'p1', 'p3', T0 + 10 + STAB_COOLDOWN_MS)!.result.kind, 'kill');
});

test('stab on a bot: unharmed, miss, 8 s cooldown, no points', () => {
  const r = mk(5, ['p1']);
  const o = act(r, 'p1', 'bot-7', T0 + 10)!;
  assert.equal(o.result.kind, 'miss');
  assert.equal(o.result.targetName, '');
  assert.deepEqual(o.result.out, []);
  assert.equal(r.players.get('p1')!.points, 0);
  assert.equal(cooldownLeft(r.players.get('p1')!, T0 + 10), STAB_BOT_COOLDOWN_MS);
  assert.equal(act(r, 'p1', 'p2', T0 + 10 + STAB_COOLDOWN_MS), null, '4 s is not enough after a bot stab');
  assert.equal(act(r, 'p1', 'p2', T0 + 10 + STAB_BOT_COOLDOWN_MS)!.result.kind, 'kill');
});

test('arrest an assassin: +300, target out, arrest used up', () => {
  const r = mk(5, ['p1']);
  const o = act(r, 'p2', 'p1', T0 + 10)!;
  assert.equal(o.result.kind, 'arrest-ok');
  assert.deepEqual(o.result.out, ['p1']);
  assert.equal(r.players.get('p2')!.points, POINTS.civilianArrestAssassin);
  assert.equal(r.players.get('p2')!.arrestsLeft, ARRESTS_PER_ROUND - 1);
  assert.equal(act(r, 'p2', 'p3', T0 + 20), null, 'no arrests left');
  assert.equal(endReason(r, T0 + 20), 'assassins-caught');
});

test('wrong arrests: bot is wasted, civilian is wasted and out; arrester gets -100', () => {
  let r = mk(5, ['p1']);
  let o = act(r, 'p2', 'bot-3', T0 + 10)!;
  assert.equal(o.result.kind, 'arrest-wrong');
  assert.deepEqual(o.result.out, []);
  assert.equal(r.players.get('p2')!.points, POINTS.civilianWrongArrest);
  assert.equal(r.players.get('p2')!.out, false);
  assert.equal(r.players.get('p2')!.arrestsLeft, 0);
  r = mk(5, ['p1']);
  o = act(r, 'p2', 'p3', T0 + 10)!;
  assert.equal(o.result.kind, 'arrest-wrong');
  assert.deepEqual(o.result.out, ['p3']);
  assert.equal(r.players.get('p3')!.out, true);
  assert.equal(r.players.get('p2')!.out, false);
  assert.equal(r.players.get('p2')!.points, -100);
  assert.equal(r.players.get('p3')!.points, 0);
});

test('out players cannot act; out targets are a miss with no points', () => {
  const r = mk(5, ['p1', 'p2']);
  act(r, 'p1', 'p3', T0 + 10); // p3 out
  assert.equal(act(r, 'p3', 'p1', T0 + 20), null, 'out civilian arrest ignored');
  const o = act(r, 'p2', 'p3', T0 + 30)!; // second kill on an out target
  assert.equal(o.result.kind, 'miss');
  assert.equal(r.players.get('p2')!.points, 0);
  assert.equal(r.players.get('p1')!.points, 100);
  act(r, 'p4', 'p1', T0 + 40); // p1 arrested, out
  assert.equal(act(r, 'p1', 'p5', T0 + 10_000), null, 'out assassin cannot stab');
});

test('same tick, same target: two assassins give one kill and one zero-point miss; one actor twice gives one result', () => {
  const r = mk(6, ['p1', 'p2']);
  const a = act(r, 'p1', 'p3', T0 + 5)!;
  const b = act(r, 'p2', 'p3', T0 + 5)!;
  assert.equal(a.result.kind, 'kill');
  assert.equal(b.result.kind, 'miss');
  assert.equal(r.players.get('p2')!.points, 0);
  assert.equal(act(r, 'p1', 'p4', T0 + 5), null, 'same actor, same tick');
  const c = mk(6, ['p1']);
  assert.equal(act(c, 'p2', 'p1', T0 + 5)!.result.kind, 'arrest-ok');
  assert.equal(act(c, 'p3', 'p1', T0 + 5)!.result.kind, 'miss', 'second arrest of an out assassin');
  assert.equal(c.players.get('p3')!.points, 0, 'no wrong-arrest penalty, no bonus');
  assert.equal(c.players.get('p3')!.arrestsLeft, 1, 'arrest not used');
});

test('range: dist over the range is a miss; bad dist is ignored; unknown ids and self are ignored', () => {
  const r = mk(5, ['p1']);
  assert.equal(act(r, 'p1', 'p2', T0 + 5, 1.6)!.result.kind, 'miss');
  assert.equal(r.players.get('p2')!.out, false);
  assert.equal(act(r, 'p2', 'p1', T0 + 5, 2.1)!.result.kind, 'miss');
  assert.equal(r.players.get('p2')!.arrestsLeft, 1);
  assert.equal(act(r, 'p1', 'p2', T0 + 5, -1), null);
  assert.equal(act(r, 'p1', 'p2', T0 + 5, NaN), null);
  assert.equal(act(r, 'p1', 'p1', T0 + 5), null);
  assert.equal(act(r, 'p1', 'p99', T0 + 5), null);
  assert.equal(act(r, 'p1', 'bot-x', T0 + 5), null);
  assert.equal(act(r, 'p1', 'bot-999', T0 + 5), null);
  assert.equal(act(r, 'zz', 'p2', T0 + 5), null);
  assert.equal(act(r, 'p1', 'p2', T0 + 5, 1.5)!.result.kind, 'kill', 'exactly at range');
});

test('no actions before the round starts or after it ends', () => {
  const r = mk(5, ['p1']);
  assert.equal(act(r, 'p1', 'p2', T0 - 1), null);
  assert.equal(act(r, 'p1', 'p2', T0 + 150_000), null);
});

test('round end: all civilians out, timer, and scoring at the end', () => {
  const r = mk(4, ['p1']);
  assert.equal(endReason(r, T0 + 1), null);
  act(r, 'p1', 'p2', T0 + 1);
  act(r, 'p1', 'p3', T0 + 1 + STAB_COOLDOWN_MS);
  assert.equal(endReason(r, T0 + 9000), null);
  act(r, 'p1', 'p4', T0 + 1 + 2 * STAB_COOLDOWN_MS);
  assert.equal(endReason(r, T0 + 20_000), 'civilians-out');
  const { scores } = finishRound(r, 'civilians-out', { drinks: false, totals: {} });
  const p1 = scores.find((s) => s.id === 'p1')!;
  assert.equal(p1.points, 3 * POINTS.assassinKill + POINTS.assassinAlive);
  assert.equal(p1.role, 'assassin');
  assert.equal(scores.find((s) => s.id === 'p2')!.points, 0);

  const t = mk(4, ['p1']);
  assert.equal(endReason(t, T0 + 150_000), 'timer');
  act(t, 'p2', 'p1', T0 + 100); // arrest-ok
  const f = finishRound(t, 'assassins-caught', { drinks: true, totals: { p2: 50 } });
  assert.equal(f.scores.find((s) => s.id === 'p2')!.points, POINTS.civilianArrestAssassin + POINTS.civilianAlive);
  assert.equal(f.scores.find((s) => s.id === 'p2')!.total, 50 + 400);
  assert.equal(f.scores.find((s) => s.id === 'p3')!.points, POINTS.civilianAlive);
  assert.equal(f.scores.find((s) => s.id === 'p1')!.points, 0, 'caught assassin gets no alive bonus');
  assert.deepEqual(f.drinkers, ['P1'], 'drinks on: caught assassin drinks');
});

test('drinks: wrong arresters drink only when the toggle is on', () => {
  const r = mk(5, ['p1']);
  act(r, 'p2', 'bot-1', T0 + 1);
  assert.deepEqual(finishRound(r, 'timer', { drinks: true, totals: {} }).drinkers, ['P2']);
  const q = mk(5, ['p1']);
  act(q, 'p2', 'bot-1', T0 + 1);
  assert.deepEqual(finishRound(q, 'timer', { drinks: false, totals: {} }).drinkers, []);
});
