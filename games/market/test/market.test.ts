import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep, FakeTv, Bot, type TestRoom } from '../../../bots/harness.ts';

type St = {
  leaderId: string | null;
  bets: { id: string; text: string; open: boolean; outcome: string | null; yesPool: number; noPool: number; yesPct: number }[];
  traders: { id: string; name: string; worth: number }[];
  me?: { balance: number; locked: number; positions: Record<string, { yes: number; no: number; payout?: number }> };
};
const last = (i: number, r: TestRoom): St | undefined => {
  const m = [...r.bots[i].layerMsgs].reverse().find((x) => x.type === 'market:state');
  return m?.data as St | undefined;
};
const tvLast = (tv: FakeTv): St | undefined => [...tv.layerMsgs].reverse().find((x) => x.type === 'market:state')?.data as St | undefined;
const errs = (r: TestRoom, i: number) => r.bots[i].layerMsgs.filter((m) => m.type === 'market:error').map((m) => (m.data as { code: string }).code);

/** Sum of balances across all phones + chips staked in open bets (from the TV pools). */
const allChips = (r: TestRoom, n: number) => {
  let t = 0;
  for (let i = 0; i < n; i++) t += last(i, r)!.me!.balance + last(i, r)!.me!.locked;
  return t;
};

test('layer starts with the room (no pick), runs beside a game, is not pickable', async () => {
  const r = await setupRoom(4);
  try {
    await until(() => !!tvLast(r.tv), 2000, 'TV gets market state without a game');
    assert.equal(r.tv.state?.game, null);
    assert.equal((await r.bots[0].socket.emitWithAck('leader:pick', { gameId: 'market' })).ok, false);
    await r.start('stub');
    r.sendServer(1, 'market:propose', { text: 'Will it rain?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet on TV while stub runs');
    assert.equal((r.tv.state as { game: { id: string } | null }).game?.id, 'stub');
    r.sendServer(2, 'ping');
    assert.deepEqual((await r.waitFor(2, 'pong')).data, { n: 1 }, 'stub still works beside market');
  } finally {
    await r.close();
  }
});

test('proof: 10 bots trade, leader resolves, chips balance to zero-sum', async () => {
  const r = await setupRoom(10);
  try {
    r.sendServer(3, 'market:propose', { text: 'Will Raj sing karaoke?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet');
    const id = tvLast(r.tv)!.bets[0].id;
    const buys: [number, string, number][] = [[0, 'yes', 100], [1, 'yes', 250], [2, 'yes', 333], [3, 'no', 400], [4, 'no', 77], [5, 'no', 1], [6, 'yes', 1000]];
    for (const [i, side, amount] of buys) r.sendServer(i, 'market:buy', { betId: id, side, amount });
    r.sendServer(7, 'market:buy', { betId: id, side: 'yes', amount: 1001 }); // over stake
    await until(() => tvLast(r.tv)?.bets[0].yesPool === 1683 && tvLast(r.tv)?.bets[0].noPool === 478, 3000, 'pools');
    await until(() => errs(r, 7).includes('NO_CHIPS'), 2000, 'overspend rejected');
    assert.equal(allChips(r, 10), 10000, 'before resolve');
    // non-leader cannot resolve
    r.sendServer(4, 'market:resolve', { betId: id, outcome: 'no' });
    await until(() => errs(r, 4).includes('NOT_LEADER'), 2000, 'non-leader rejected');
    assert.equal(tvLast(r.tv)!.bets[0].open, true);
    r.sendServer(0, 'market:resolve', { betId: id, outcome: 'yes' });
    await until(() => tvLast(r.tv)?.bets[0].open === false, 2000, 'resolved');
    await until(() => last(9, r)?.bets[0].open === false && last(0, r)?.bets[0].open === false, 2000, 'phones updated');
    const bal = Array.from({ length: 10 }, (_, i) => last(i, r)!.me!.balance);
    console.log('balances after YES:', bal.join(','), 'sum', bal.reduce((a, b) => a + b, 0));
    assert.equal(bal.reduce((a, b) => a + b, 0), 10000, 'zero-sum: total chips unchanged');
    // winners gained, losers lost exactly their stake
    assert.equal(bal[3], 600);
    assert.equal(bal[4], 923);
    assert.equal(bal[5], 999);
    assert.ok(bal[0] > 1000 && bal[1] > 1000 && bal[2] > 1000 && bal[6] > 1000);
    assert.equal(last(6, r)!.me!.positions[id].payout, bal[6] - 1000 + 1000, 'payout reported');
    // TV ticker data never carries anyone's positions
    for (const m of r.tv.layerMsgs) assert.equal(JSON.stringify(m).includes('positions'), false, 'no private positions on TV');
  } finally {
    await r.close();
  }
});

test('review (3): ten bots buy at the same instant, no lost or double-spent chips', async () => {
  const r = await setupRoom(10);
  try {
    r.sendServer(0, 'market:propose', { text: 'Race?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet');
    const id = tvLast(r.tv)!.bets[0].id;
    // each bot fires 3 buys of 400 (only 2 fit in 1000) in one burst: 30 requests together
    for (let i = 0; i < 10; i++) for (let k = 0; k < 3; k++) r.sendServer(i, 'market:buy', { betId: id, side: i % 2 ? 'yes' : 'no', amount: 400 });
    await until(() => tvLast(r.tv)?.bets[0].yesPool === 4000 && tvLast(r.tv)?.bets[0].noPool === 4000, 4000, 'pools hold exactly 2 buys per bot');
    for (let i = 0; i < 10; i++) await until(() => errs(r, i).length === 1, 2000, `bot ${i} got exactly one NO_CHIPS`);
    for (let i = 0; i < 10; i++) {
      const me = last(i, r)!.me!;
      assert.equal(me.balance, 200);
      assert.equal(me.locked, 800);
      assert.ok(me.balance >= 0);
    }
    assert.equal(allChips(r, 10), 10000);
    r.sendServer(0, 'market:resolve', { betId: id, outcome: 'no' });
    await until(() => last(9, r)?.bets[0].open === false, 2000, 'resolved');
    assert.equal(allChips(r, 10), 10000);
    assert.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].reduce((a, i) => a + last(i, r)!.me!.balance, 0), 10000);
  } finally {
    await r.close();
  }
});

test('review (5): HTML in bet text stays plain; non-leader cannot resolve; handoff moves the right', async () => {
  const r = await setupRoom(3, { leaderGraceMs: 200 });
  try {
    const html = '<img src=x onerror="window.pwned=1"><b>hi</b>';
    r.sendServer(1, 'market:propose', { text: html });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet');
    assert.equal(tvLast(r.tv)!.bets[0].text, html, 'kept as typed; renderers use textContent');
    const id = tvLast(r.tv)!.bets[0].id;
    r.sendServer(1, 'market:buy', { betId: id, side: 'yes', amount: 10 });
    r.sendServer(2, 'market:buy', { betId: id, side: 'no', amount: 10 });
    r.sendServer(2, 'market:resolve', { betId: id, outcome: 'no' });
    await until(() => errs(r, 2).includes('NOT_LEADER'), 2000, 'non-leader refused');
    // leader (bot 0) drops; bot 1 takes over
    r.bots[0].drop();
    await until(() => r.bots[1].state?.leaderId === r.bots[1].id, 3000, 'handoff');
    r.sendServer(0, 'market:resolve', { betId: id, outcome: 'yes' }); // old leader (offline socket): ignored
    r.sendServer(2, 'market:resolve', { betId: id, outcome: 'no' });
    await until(() => errs(r, 2).length === 2, 2000, 'bot 2 refused again');
    r.sendServer(1, 'market:resolve', { betId: id, outcome: 'yes' });
    await until(() => tvLast(r.tv)?.bets[0].outcome === 'yes', 2000, 'new leader resolves');
    // old leader comes back as a plain player: refused
    r.bots[0].reconnect();
    await until(() => r.bots[0].state?.leaderId === r.bots[1].id, 3000, 'rejoined');
    r.sendServer(0, 'market:propose', { text: 'second?' });
    await until(() => tvLast(r.tv)?.bets.some((b) => b.text === 'second?') === true, 2000, 'second bet');
    const id2 = tvLast(r.tv)!.bets.find((b) => b.text === 'second?')!.id;
    r.sendServer(0, 'market:resolve', { betId: id2, outcome: 'yes' });
    await until(() => errs(r, 0).includes('NOT_LEADER'), 2000, 'ex-leader refused');
  } finally {
    await r.close();
  }
});

test('bad input is rejected, server stays up', async () => {
  const r = await setupRoom(2);
  try {
    r.sendServer(0, 'market:propose', { text: 42 });
    r.sendServer(0, 'market:propose', null);
    r.sendServer(0, 'market:buy', 'junk');
    r.sendServer(0, 'market:nonsense', {});
    r.sendServer(0, 'market:propose', { text: 'ok?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'one valid bet');
    assert.ok(errs(r, 0).length >= 3);
  } finally {
    await r.close();
  }
});

test('review (2): phone rejoin keeps chips and positions; TV reload gets the ticker back', async () => {
  const r = await setupRoom(3);
  try {
    r.sendServer(0, 'market:propose', { text: 'Cake by 11?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet');
    const id = tvLast(r.tv)!.bets[0].id;
    r.sendServer(1, 'market:buy', { betId: id, side: 'yes', amount: 300 });
    r.sendServer(2, 'market:buy', { betId: id, side: 'no', amount: 100 });
    await until(() => last(1, r)?.me?.balance === 700, 2000, 'bought');
    // phone 1 drops and rejoins
    r.bots[1].drop();
    await sleep(100);
    r.bots[1].layerMsgs.length = 0;
    r.bots[1].reconnect();
    await until(() => last(1, r)?.me?.balance === 700, 3000, 'state after rejoin');
    assert.deepEqual(last(1, r)!.me!.positions[id], { yes: 300, no: 0 });
    // TV reloads: a new TV with the secret gets the same room and a fresh ticker
    const tv2 = new FakeTv(r.srv.url);
    const re = await tv2.create(r.code, r.tv.secret);
    assert.equal(re.ok && re.code, r.code);
    await until(() => !!tvLast(tv2), 2000, 'ticker after TV reload');
    assert.equal(tvLast(tv2)!.bets[0].yesPool, 300);
    assert.equal(tvLast(tv2)!.bets[0].noPool, 100);
    tv2.close();
  } finally {
    await r.close();
  }
});

test('ticker: top traders sorted by net worth, odds from pools', async () => {
  const r = await setupRoom(3);
  try {
    r.sendServer(0, 'market:propose', { text: 'q?' });
    await until(() => tvLast(r.tv)?.bets.length === 1, 2000, 'bet');
    const id = tvLast(r.tv)!.bets[0].id;
    assert.equal(tvLast(r.tv)!.bets[0].yesPct, 50, 'empty pool shows 50');
    r.sendServer(1, 'market:buy', { betId: id, side: 'yes', amount: 300 });
    r.sendServer(2, 'market:buy', { betId: id, side: 'no', amount: 100 });
    await until(() => tvLast(r.tv)?.bets[0].yesPool === 300 && tvLast(r.tv)?.bets[0].noPool === 100, 2000, 'pools');
    assert.equal(tvLast(r.tv)!.bets[0].yesPct, 75);
    r.sendServer(0, 'market:resolve', { betId: id, outcome: 'yes' });
    await until(() => tvLast(r.tv)?.bets[0].open === false, 2000, 'resolved');
    const t = tvLast(r.tv)!.traders;
    assert.equal(t[0].name, 'Bot2');
    assert.equal(t[0].worth, 1100);
    assert.equal(t[2].worth, 900);
    assert.equal(t.reduce((a, x) => a + x.worth, 0), 3000);
  } finally {
    await r.close();
  }
});
