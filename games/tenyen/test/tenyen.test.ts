import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep, type TestRoom } from '../../../bots/harness.ts';
import { cleanQuestion } from '../server/index.ts';
import { DECK } from '../server/deck.ts';

// Helpers
const lastOf = (msgs: { type: string; data: unknown }[], type: string) => [...msgs].reverse().find((m) => m.type === type)?.data as any;
const phoneState = (r: TestRoom, i: number) => lastOf(r.bots[i].msgs, 'state');
const tvState = (r: TestRoom) => lastOf(r.tv.msgs, 'state');
const vote = (r: TestRoom, i: number, choice: string, guess?: string, round?: number) =>
  r.sendServer(i, 'vote', { choice, guess, round });
const TV_KEYS = new Set(['phase', 'round', 'question', 'config', 'voted', 'total', 'result']);
const TV_RESULT_KEYS = new Set(['yes', 'no', 'minority', 'lone', 'drinkers']);

async function begin(n: number): Promise<TestRoom> {
  const r = await setupRoom(n);
  await r.start('tenyen');
  await until(() => !!phoneState(r, n - 1), 2000, 'phone state');
  await r.tv.socket.emit('to-server', { type: 'tv-ready' });
  r.sendServer(0, 'start');
  await until(() => phoneState(r, 0)?.phase === 'voting', 2000, 'voting');
  return r;
}

/** TV must see only the whitelisted shape: no per-player data, no counts before reveal. */
function assertTvClean(r: TestRoom, ids: string[]) {
  for (const m of r.tv.msgs) {
    assert.equal(m.from, undefined, 'TV got a message from a phone');
    if (m.type !== 'state') continue;
    const d = m.data as any;
    for (const k of Object.keys(d)) assert.ok(TV_KEYS.has(k), `unexpected TV key ${k}`);
    if (d.phase !== 'reveal') assert.equal(d.result, null, 'totals leaked before reveal');
    if (d.result) for (const k of Object.keys(d.result)) assert.ok(TV_RESULT_KEYS.has(k), `unexpected TV result key ${k}`);
    const json = JSON.stringify(d);
    for (const id of ids) assert.ok(!json.includes(id), `player id ${id} on TV`);
    assert.ok(!/"choice"|"guess"|"you"/.test(json), 'per-player vote field on TV');
  }
}

test('deck: 40+ clean unique questions', () => {
  assert.ok(DECK.length >= 40, `deck has ${DECK.length}`);
  assert.equal(new Set(DECK.map((q) => q.toLowerCase())).size, DECK.length);
  for (const q of DECK) assert.ok(q.length >= 10 && q.length <= 100 && /\?$/.test(q), q);
});

test('review 3: ten bots vote in the same instant, exact totals, TV sees totals only', async () => {
  const r = await begin(10);
  try {
    const ids = r.bots.map((b) => b.id!);
    const yesIdx = [0, 1, 2, 3, 4, 5, 6];
    const noIdx = [7, 8, 9];
    // Before anyone votes: TV has no counts.
    assert.equal(tvState(r).voted, 0);
    // All ten emit in the same tick.
    r.bots.forEach((_, i) => vote(r, i, yesIdx.includes(i) ? 'yes' : 'no'));
    await until(() => tvState(r)?.phase === 'reveal', 3000, 'reveal');
    const t = tvState(r);
    assert.equal(t.result.yes, 7);
    assert.equal(t.result.no, 3);
    assert.equal(t.result.minority, 'no');
    assert.equal(t.result.drinkers, 3);
    for (const i of noIdx) await until(() => phoneState(r, i)?.result?.drink === true, 2000, `bot ${i} drinks`);
    for (const i of yesIdx) await until(() => phoneState(r, i)?.phase === 'reveal', 2000, `bot ${i} reveal`);
    for (const i of yesIdx) assert.equal(phoneState(r, i).result.drink, false, `bot ${i} safe`);
    for (const i of noIdx) assert.equal(phoneState(r, i).result.sips, 1);
    // Each phone sees totals and its own result only.
    for (let i = 0; i < 10; i++) assert.ok(!JSON.stringify(r.bots[i].msgs).includes('"you":{"choice":"' + (yesIdx.includes(i) ? 'no' : 'yes')));
    assertTvClean(r, ids);
    // Votes of others never reach any phone: only own choice appears in own state.
    const others = r.bots[1].msgs.filter((m) => m.type === 'state').map((m) => JSON.stringify(m.data)).join('');
    for (const id of ids) assert.ok(!others.includes(id), 'a phone saw another player id');
    console.log('10 bots: totals', t.result, 'TV msgs', r.tv.msgs.length, 'all clean');
  } finally {
    await r.close();
  }
});

test('tie: nobody drinks; lone dissenter doubles; predict adds a sip', async () => {
  const r = await begin(4);
  try {
    // Tie 2-2
    vote(r, 0, 'yes'); vote(r, 1, 'yes'); vote(r, 2, 'no'); vote(r, 3, 'no');
    await until(() => tvState(r)?.phase === 'reveal', 2000, 'tie reveal');
    assert.equal(tvState(r).result.minority, null);
    assert.equal(tvState(r).result.drinkers, 0);
    assert.ok(r.bots.every((_, i) => phoneState(r, i).result.drink === false));
    // Toggles by non-leader refused, by leader accepted.
    r.sendServer(1, 'toggle', { double: true });
    await sleep(100);
    assert.equal(tvState(r).config.double, false);
    r.sendServer(0, 'toggle', { double: true, predict: true });
    await until(() => tvState(r).config.double && tvState(r).config.predict, 2000, 'toggles');
    r.sendServer(0, 'next');
    await until(() => tvState(r).phase === 'voting' && tvState(r).round === 2, 2000, 'round 2');
    // Predict mode: vote without guess is refused and does not lock.
    vote(r, 0, 'yes');
    await r.waitFor(0, 'vote-rejected');
    assert.equal(r.bots[0].msgs.find((m) => m.type === 'vote-rejected')!.data && (r.bots[0].msgs.find((m) => m.type === 'vote-rejected')!.data as any).reason, 'need-guess');
    // 3 yes, 1 no (lone). Bot 1 guesses wrong (says no wins).
    vote(r, 0, 'yes', 'yes'); vote(r, 1, 'yes', 'no'); vote(r, 2, 'yes', 'yes'); vote(r, 3, 'no', 'no');
    await until(() => tvState(r).phase === 'reveal' && tvState(r).round === 2, 2000, 'round 2 reveal');
    await until(() => phoneState(r, 3)?.result, 2000, 'bot3 result');
    await until(() => phoneState(r, 1)?.round === 2 && phoneState(r, 1)?.result, 2000, 'bot1 result');
    assert.equal(phoneState(r, 3).result.sips, 3, 'lone dissenter: double (2) plus wrong guess (+1)');
    assert.equal(phoneState(r, 1).result.sips, 1, 'wrong guess only');
    assert.equal(phoneState(r, 0).result.sips, 0);
    assert.equal(tvState(r).result.lone, true);
    assertTvClean(r, r.bots.map((b) => b.id!));
  } finally {
    await r.close();
  }
});

test('review 2: phone drops and rejoins mid-round; vote kept; double and late votes rejected', async () => {
  const r = await begin(3);
  try {
    const q = phoneState(r, 1).question;
    assert.ok(q.length > 5);
    vote(r, 1, 'no');
    await until(() => phoneState(r, 1)?.you?.choice === 'no', 2000, 'vote recorded');
    const idBefore = r.bots[1].id;
    r.bots[1].drop();
    await sleep(150);
    r.bots[1].msgs.length = 0;
    r.bots[1].reconnect();
    await until(() => phoneState(r, 1)?.you, 3000, 'state after rejoin');
    assert.equal(r.bots[1].id, idBefore, 'same seat');
    assert.equal(phoneState(r, 1).question, q, 'still sees the question');
    assert.equal(phoneState(r, 1).you.choice, 'no', 'vote kept');
    // Double vote: first wins, second refused.
    vote(r, 1, 'yes');
    const rej = await r.waitFor(1, 'vote-rejected');
    assert.equal((rej.data as any).reason, 'locked');
    assert.equal(phoneState(r, 1).you.choice, 'no');
    // Bot 2 drops before voting, rejoins, then votes: counts.
    r.bots[2].drop();
    await sleep(150);
    r.bots[2].msgs.length = 0;
    r.bots[2].reconnect();
    await until(() => phoneState(r, 2)?.phase === 'voting', 3000, 'bot2 back');
    vote(r, 2, 'yes');
    vote(r, 0, 'yes');
    await until(() => tvState(r).phase === 'reveal', 3000, 'reveal');
    assert.deepEqual([tvState(r).result.yes, tvState(r).result.no], [2, 1]);
    // Late vote after reveal: refused, totals unchanged.
    r.bots[1].msgs.length = 0;
    vote(r, 1, 'yes');
    assert.equal(((await r.waitFor(1, 'vote-rejected')).data as any).reason, 'closed');
    await sleep(100);
    assert.deepEqual([tvState(r).result.yes, tvState(r).result.no], [2, 1]);
    // Rejoin after reveal: still sees result.
    r.bots[1].drop();
    await sleep(150);
    r.bots[1].msgs.length = 0;
    r.bots[1].reconnect();
    await until(() => phoneState(r, 1)?.result, 3000, 'result after rejoin');
    assert.equal(phoneState(r, 1).result.drink, true);
    // A bogus choice and a stale round are refused.
    r.sendServer(0, 'next');
    await until(() => tvState(r).round === 2, 2000, 'round 2');
    vote(r, 0, 'maybe');
    assert.equal(((await r.waitFor(0, 'vote-rejected')).data as any).reason, 'bad');
    r.bots[0].msgs.length = 0;
    vote(r, 0, 'yes', undefined, 1);
    assert.equal(((await r.waitFor(0, 'vote-rejected')).data as any).reason, 'closed');
    assertTvClean(r, r.bots.map((b) => b.id!));
  } finally {
    await r.close();
  }
});

test('TV reload gets current state; non-leader cannot start or reveal', async () => {
  const r = await begin(3);
  try {
    vote(r, 0, 'yes');
    await until(() => tvState(r).voted === 1, 2000, 'count');
    r.tv.msgs.length = 0;
    r.tv.socket.emit('to-server', { type: 'tv-ready' });
    await until(() => tvState(r), 2000, 'tv state');
    assert.equal(tvState(r).voted, 1);
    assert.equal(tvState(r).phase, 'voting');
    r.sendServer(2, 'reveal');
    r.sendServer(2, 'next');
    await sleep(150);
    assert.equal(tvState(r).phase, 'voting');
    assert.equal(tvState(r).round, 1);
    r.sendServer(0, 'reveal'); // leader forces reveal with one vote: 1-0, nobody in minority
    await until(() => tvState(r).phase === 'reveal', 2000, 'forced reveal');
    assert.equal(tvState(r).result.minority, null);
    assert.equal(tvState(r).result.drinkers, 0);
  } finally {
    await r.close();
  }
});

test('player-added questions: validated, mixed in, HTML kept as plain text data', async () => {
  assert.equal(cleanQuestion('hi'), null);
  assert.equal(cleanQuestion(42), null);
  assert.equal(cleanQuestion('x'.repeat(200)), null);
  assert.equal(cleanQuestion('  Do   you\n like\tchai?  '), 'Do you like chai?');
  const r = await begin(3);
  try {
    const html = '<img src=x onerror=alert(1)> do you like it?';
    r.sendServer(1, 'addq', { text: html });
    await until(() => phoneState(r, 1)?.mine === 1, 2000, 'added');
    r.sendServer(1, 'addq', { text: html.toUpperCase() });
    await sleep(100);
    assert.equal(phoneState(r, 1).mine, 1, 'duplicate refused');
    for (let k = 0; k < 6; k++) r.sendServer(2, 'addq', { text: `Custom question number ${k} here?` });
    await until(() => phoneState(r, 2)?.mine === 5, 2000, 'capped at 5');
    await sleep(100);
    assert.equal(phoneState(r, 2).mine, 5);
    // Draw rounds until a custom question appears (deck holds 51, custom has 6).
    let seen = 0;
    for (let i = 0; i < 40 && !seen; i++) {
      r.sendServer(0, 'reveal');
      r.sendServer(0, 'next');
      await until(() => tvState(r)?.round === i + 2, 2000, 'next round');
      if (/Custom question|<img/.test(tvState(r).question)) seen++;
    }
    assert.ok(seen, 'a player question was drawn');
    console.log('custom question drawn on TV:', JSON.stringify(tvState(r).question));
  } finally {
    await r.close();
  }
});
