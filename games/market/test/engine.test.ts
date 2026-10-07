import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Market, MarketError, payouts, START_CHIPS, cleanText } from '../server/engine.ts';

const m = (lead = 'p1') => {
  const mk = new Market(() => lead);
  for (const id of ['p1', 'p2', 'p3', 'p4']) mk.ensure(id);
  return mk;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as MarketError).code;
  }
  return 'none';
};

test('parimutuel: losers pool split by stake, remainder deterministic, chips conserved', () => {
  const yes = new Map([['p1', 100], ['p2', 200], ['p3', 300]]);
  const no = new Map([['p4', 100]]); // L=100, W=600
  const out = payouts(yes, no, 'yes');
  // shares: 16.67, 33.33, 50 -> floors 16,33,50 = 99; leftover 1 goes to biggest remainder (p1, rem 400)
  assert.equal(out.get('p1'), 100 + 17);
  assert.equal(out.get('p2'), 200 + 33);
  assert.equal(out.get('p3'), 300 + 50);
  assert.equal([...out.values()].reduce((a, b) => a + b, 0), 700);
});

test('one side empty: everybody is refunded', () => {
  const out = payouts(new Map([['p1', 50], ['p2', 70]]), new Map(), 'yes');
  assert.equal(out.get('p1'), 50);
  assert.equal(out.get('p2'), 70);
  const out2 = payouts(new Map(), new Map([['p3', 9]]), 'yes'); // YES wins but nobody bought YES
  assert.equal(out2.get('p3'), 9);
});

test('rules: no negative chips, cannot overspend, whole numbers only', () => {
  const mk = m();
  const b = mk.propose('p2', 'Will Raj sing?');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', START_CHIPS + 1)), 'NO_CHIPS');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', -5)), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', 0)), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', 1.5)), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', NaN)), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', '5')), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', b.id, 'maybe', 5)), 'BAD_REQUEST');
  assert.equal(code(() => mk.buy('p1', 'nope', 'yes', 5)), 'NO_BET');
  mk.buy('p1', b.id, 'yes', START_CHIPS); // all in
  assert.equal(mk.balance('p1'), 0);
  assert.equal(code(() => mk.buy('p1', b.id, 'no', 1)), 'NO_CHIPS');
  assert.equal(mk.totalChips(), 4 * START_CHIPS);
});

test('only the leader resolves; resolved bets are closed', () => {
  let lead = 'p1';
  const mk = new Market(() => lead);
  for (const id of ['p1', 'p2']) mk.ensure(id);
  const b = mk.propose('p2', 'q?');
  mk.buy('p2', b.id, 'yes', 10);
  assert.equal(code(() => mk.resolve('p2', b.id, 'yes')), 'NOT_LEADER');
  assert.equal(b.open, true);
  lead = 'p2'; // handoff
  assert.equal(code(() => mk.resolve('p1', b.id, 'yes')), 'NOT_LEADER');
  assert.equal(code(() => mk.resolve('p2', b.id, 'banana')), 'BAD_REQUEST');
  mk.resolve('p2', b.id, 'yes');
  assert.equal(code(() => mk.resolve('p2', b.id, 'no')), 'CLOSED');
  assert.equal(code(() => mk.buy('p1', b.id, 'yes', 1)), 'CLOSED');
  lead = null as unknown as string;
  const c = mk.propose('p1', 'x');
  assert.equal(code(() => mk.resolve('p1', c.id, 'yes')), 'NOT_LEADER');
});

test('random games: total chips conserved exactly', () => {
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 200; round++) {
    const mk = new Market(() => 'p1');
    const ids = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
    ids.forEach((i) => mk.ensure(i));
    const bets = Array.from({ length: 3 }, (_, i) => mk.propose(ids[i], `q${i}`));
    for (let k = 0; k < 40; k++) {
      try {
        mk.buy(ids[rnd(10)], bets[rnd(3)].id, rnd(2) ? 'yes' : 'no', 1 + rnd(400));
      } catch {
        /* overspend is rejected */
      }
      assert.equal(mk.totalChips(), 10 * START_CHIPS);
    }
    for (const b of bets) {
      mk.resolve('p1', b.id, rnd(2) ? 'yes' : 'no');
      assert.equal(mk.totalChips(), 10 * START_CHIPS);
    }
    for (const id of ids) assert.ok(mk.balance(id) >= 0 && Number.isInteger(mk.balance(id)));
    let sum = 0;
    for (const v of mk.balances.values()) sum += v;
    assert.equal(sum, 10 * START_CHIPS, 'after all resolve, balances alone hold every chip');
  }
});

test('bet text is plain text: control chars cut, length capped, empty rejected', () => {
  assert.equal(cleanText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'); // kept as typed
  assert.equal(cleanText('a\u0000b\n\nc'), 'a b c');
  assert.equal(cleanText('x'.repeat(500))!.length, 120);
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText(42), null);
});
