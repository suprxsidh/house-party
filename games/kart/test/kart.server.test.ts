import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep } from '../../../bots/harness.ts';
import { cleanResults } from '../server/index.ts';

test('kart server part: results come from the TV only, are cleaned, and survive a rejoin', async () => {
  const r = await setupRoom(3);
  try {
    await r.start('kart');
    // a phone cannot fake results
    r.sendServer(1, 'results', { order: [{ place: 1, name: 'cheat' }] });
    await sleep(150);
    assert.equal(r.bots[2].msgs.filter((m) => m.type === 'results').length, 0);
    // the TV reports; every phone gets them, text kept as text
    r.tv.toServer('results', { order: [
      { place: 1, seat: 'p2', name: '<img src=x onerror=alert(1)>', human: true, finished: true, time: 61.5 },
      { place: 2, seat: null, name: 'Koa', human: false, finished: false, time: null },
    ] });
    const m = await r.waitFor(2, 'results');
    const order = (m.data as { order: { name: string; time: number | null }[] }).order;
    assert.equal(order[0].name, '<img src=x onerror=alert(1)>');
    assert.equal(order[1].time, null);
    // second report ignored
    r.tv.toServer('results', { order: [{ place: 1, name: 'late' }] });
    await sleep(150);
    assert.equal(r.bots[2].msgs.filter((x) => x.type === 'results').length, 1);
    // review 2: phone drops and rejoins, same seat, gets results again
    const id = r.bots[2].id;
    r.bots[2].msgs.length = 0;
    r.bots[2].drop();
    await sleep(100);
    r.bots[2].reconnect();
    await until(() => r.bots[2].msgs.some((x) => x.type === 'results'), 3000, 'results resent');
    assert.equal(r.bots[2].id, id);
  } finally {
    await r.close();
  }
});

test('cleanResults bounds and sanitises', () => {
  assert.equal(cleanResults('x'), null);
  assert.equal(cleanResults({ order: 5 }), null);
  const big = cleanResults({ order: Array.from({ length: 40 }, (_, i) => ({ place: i + 1, name: 'n'.repeat(99), time: 'NaN' })) })!;
  assert.equal(big.length, 16);
  assert.equal(big[0].name.length, 30);
  assert.equal(big[0].time, null);
});
