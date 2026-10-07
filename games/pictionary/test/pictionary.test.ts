import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep, type TestRoom } from '../../../bots/harness.ts';
import { WORDS } from '../server/words.ts';
import type { RoundState } from '../common.ts';

process.env.HP_PICTIONARY_REVEAL_MS = '150';

const stateMsgs = (r: TestRoom) => r.tv.msgs.filter((m) => m.type === 'state').map((m) => m.data as RoundState);
const lastState = (r: TestRoom) => stateMsgs(r).at(-1);
const botIndex = (r: TestRoom, id: string | null) => r.bots.findIndex((b) => b.id === id);
const secretOf = (r: TestRoom, i: number) => r.bots[i].msgs.filter((m) => m.type === 'secret').at(-1)?.data as { word: string } | undefined;

async function waitDrawing(r: TestRoom, round: number) {
  await until(() => stateMsgs(r).some((s) => s.round === round && s.phase === 'drawing'), 5000, `round ${round} drawing`);
  const s = stateMsgs(r).find((x) => x.round === round && x.phase === 'drawing')!;
  const d = botIndex(r, s.drawerId);
  await until(() => !!secretOf(r, d), 2000, 'drawer secret');
  return { s, d, word: secretOf(r, d)!.word };
}
const item = (o = {}) => ({ shape: 'cube', color: '#e53935', x: 1, y: 0, z: 1, size: 1, ...o });

test('word list: 60+, unique, family-friendly shape', () => {
  assert.ok(WORDS.length >= 60, `have ${WORDS.length}`);
  assert.equal(new Set(WORDS).size, WORDS.length);
  for (const w of WORDS) assert.match(w, /^[a-z]+( [a-z]+)?$/);
});

test('proof: 3 rounds, drawers rotate, scores match, word never on TV before reveal', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '3';
  process.env.HP_PICTIONARY_ROUND_MS = '1500';
  const r = await setupRoom(5);
  try {
    await r.start('pictionary');
    const owed = new Map<string, number>(); // what the bots expect each seat to hold
    const drawers: string[] = [];
    const words: string[] = [];
    for (let round = 1; round <= 3; round++) {
      const { s, d, word } = await waitDrawing(r, round);
      drawers.push(s.drawerId!);
      words.push(word);
      // non-drawers never got the secret
      r.bots.forEach((b, i) => i !== d && assert.equal(b.msgs.filter((m) => m.type === 'secret').length, drawers.slice(0, -1).filter((x) => x === b.id).length, 'secret only when it was the drawer'));
      // drawer builds
      r.sendServer(d, 'place', item());
      r.sendServer(d, 'place', item({ shape: 'sphere', y: 1, x: 3, color: '#1e88e5', size: 2 }));
      r.sendServer(d, 'place', item({ shape: 'cylinder', x: 7, y: 7, z: 2 }));
      r.sendServer(d, 'undo');
      await until(() => (r.tv.msgs.filter((m) => m.type === 'scene').at(-1)?.data as any)?.items.length === 2, 2000, 'scene of 2');
      // a non-drawer placing is ignored
      r.sendServer((d + 1) % 5, 'place', item({ x: 5 }));
      await sleep(80);
      assert.equal((r.tv.msgs.filter((m) => m.type === 'scene').at(-1)?.data as any).items.length, 2);
      if (round === 2) {
        // wrong guesses only: the round times out with no winner
        const g = (d + 1) % 5;
        r.sendServer(g, 'guess', { text: 'zzz nope' });
        await until(() => stateMsgs(r).some((x) => x.round === 2 && x.phase === 'reveal'), 4000, 'timeout reveal');
        assert.equal(stateMsgs(r).find((x) => x.round === 2 && x.phase === 'reveal')!.winnerId, null);
        continue;
      }
      const g = (d + 2) % 5;
      r.sendServer((d + 1) % 5, 'guess', { text: 'definitely wrong' });
      r.sendServer(d, 'guess', { text: word }); // drawer cannot guess own word
      await sleep(60);
      const mixed = word.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('').replace(/ /g, '  ');
      r.sendServer(g, 'guess', { text: ` ${mixed} ` });
      const c = await r.tv.waitFor('correct', { after: r.tv.msgs.findIndex((m) => m.type === 'state' && (m.data as RoundState).round === round) });
      const cd = c.data as { playerId: string; points: number; drawerId: string; drawerPoints: number };
      assert.equal(cd.playerId, r.bots[g].id);
      assert.ok(cd.points >= 100 && cd.points <= 200);
      owed.set(cd.playerId, (owed.get(cd.playerId) ?? 0) + cd.points);
      owed.set(cd.drawerId, (owed.get(cd.drawerId) ?? 0) + cd.drawerPoints);
      await until(() => stateMsgs(r).some((x) => x.round === round && x.phase === 'reveal'), 2000, 'reveal');
    }
    assert.equal(new Set(drawers).size, 3, 'drawers rotate');
    assert.equal(new Set(words).size, 3, 'no repeated word');
    const fin = (await r.tv.waitFor('final')).data as { scores: { id: string; score: number }[] };
    for (const s of fin.scores) assert.equal(s.score, owed.get(s.id) ?? 0, `score of ${s.id}`);
    assert.equal(fin.scores.reduce((a, s) => a + s.score, 0), [...owed.values()].reduce((a, b) => a + b, 0));
    // every phone got the same final scores
    for (let i = 0; i < 5; i++) assert.deepEqual((await r.waitFor(i, 'final')).data, fin);
    console.log('final scores', JSON.stringify(fin.scores), 'drawers', drawers.join(','), 'words', words.join(','));
    // Secret: the word never appears in a TV message sent before that round's reveal.
    const revealAt = new Map<number, number>();
    r.tv.msgs.forEach((m, i) => {
      const s = m.type === 'state' ? (m.data as RoundState) : null;
      if (s && s.phase !== 'drawing' && !revealAt.has(s.round)) revealAt.set(s.round, i);
    });
    words.forEach((w, k) => {
      const end = revealAt.get(k + 1)!;
      const leaked = r.tv.msgs.slice(0, end).filter((m) => JSON.stringify(m).toLowerCase().includes(w));
      assert.equal(leaked.length, 0, `word "${w}" leaked to TV: ${JSON.stringify(leaked[0])}`);
    });
    // to the end: reveal does show the word
    assert.ok(stateMsgs(r).some((x) => x.phase === 'reveal' && x.word === words[0]));
    // game ends back to the lobby by leader
    assert.equal((await r.bots[0].socket.emitWithAck('leader:end', {})).ok, true);
    await until(() => r.tv.state?.game === null, 2000, 'back to lobby');
  } finally {
    await r.close();
  }
});

test('review 3: ten bots guess at once, exactly one winner, no double scoring', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '1';
  process.env.HP_PICTIONARY_ROUND_MS = '5000';
  const r = await setupRoom(10);
  try {
    await r.start('pictionary');
    const { d, word } = await waitDrawing(r, 1);
    for (let i = 0; i < 10; i++) if (i !== d) r.sendServer(i, 'guess', { text: word });
    await until(() => stateMsgs(r).some((s) => s.phase === 'final'), 4000, 'final');
    await sleep(200);
    const correct = r.tv.msgs.filter((m) => m.type === 'correct');
    assert.equal(correct.length, 1, 'one correct event on TV');
    for (let i = 0; i < 10; i++) assert.equal(r.bots[i].msgs.filter((m) => m.type === 'correct').length, 1, `bot ${i} sees one correct`);
    const c = correct[0].data as { playerId: string; points: number };
    const fin = lastState(r)!.scores;
    assert.equal(fin.reduce((a, s) => a + s.score, 0), c.points + 50, 'total = winner + drawer once');
    assert.equal(fin.find((s) => s.id === c.playerId)!.score, c.points);
    assert.equal(fin.find((s) => s.id === r.bots[d].id)!.score, 50);
    assert.equal(fin.filter((s) => s.score > 0).length, 2);
    console.log('10 simultaneous guessers: 1 winner', c.playerId, 'points', c.points, 'scores', JSON.stringify(fin.filter((s) => s.score)));
  } finally {
    await r.close();
  }
});

test('review 2: drawer drops and rejoins, keeps word and scene', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '1';
  process.env.HP_PICTIONARY_ROUND_MS = '20000';
  const r = await setupRoom(4);
  try {
    await r.start('pictionary');
    const { d, word } = await waitDrawing(r, 1);
    r.sendServer(d, 'place', item());
    r.sendServer(d, 'place', item({ x: 4, shape: 'cylinder' }));
    await until(() => (r.tv.msgs.filter((m) => m.type === 'scene').at(-1)?.data as any)?.items.length === 2, 2000, 'scene');
    const id = r.bots[d].id;
    r.bots[d].msgs.length = 0;
    r.bots[d].drop();
    await sleep(150);
    r.sendServer((d + 1) % 4, 'guess', { text: 'nothing' }); // game keeps running
    r.bots[d].reconnect();
    await until(() => r.bots[d].msgs.some((m) => m.type === 'secret') && r.bots[d].msgs.some((m) => m.type === 'scene'), 3000, 'resend');
    assert.equal(r.bots[d].id, id, 'same seat');
    assert.equal(secretOf(r, d)!.word, word, 'same word');
    const sc = r.bots[d].msgs.filter((m) => m.type === 'scene').at(-1)!.data as any;
    assert.equal(sc.items.length, 2);
    assert.equal(r.bots[d].msgs.find((m) => m.type === 'state' && (m.data as RoundState).round === 1 && (m.data as RoundState).drawerId === id) !== undefined, true);
    // and the drawer can keep drawing
    r.sendServer(d, 'place', item({ x: 6 }));
    await until(() => (r.tv.msgs.filter((m) => m.type === 'scene').at(-1)?.data as any)?.items.length === 3, 2000, 'third item');
    // a TV reload gets the scene back via tv-ready
    const before = r.tv.msgs.length;
    r.tv.toServer('tv-ready');
    await r.tv.waitFor('scene', { after: before });
    assert.equal((r.tv.msgs.slice(before).find((m) => m.type === 'scene')!.data as any).items.length, 3);
    assert.ok(!JSON.stringify(r.tv.msgs.slice(before)).toLowerCase().includes(word), 'tv-ready reply has no word');
  } finally {
    await r.close();
  }
});

test('input checks: bad shapes, colors, cells and oversize guesses are ignored', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '1';
  process.env.HP_PICTIONARY_ROUND_MS = '5000';
  const r = await setupRoom(3);
  try {
    await r.start('pictionary');
    const { d } = await waitDrawing(r, 1);
    const bad = [item({ shape: 'cone' }), item({ color: 'red' }), item({ x: 8 }), item({ y: -1 }), item({ z: 3 }), item({ size: 3 }), item({ x: 1.5 }), 'x', null, item({ shape: { a: 1 } })];
    for (const b of bad) r.sendServer(d, 'place', b);
    r.sendServer(d, 'place', item());
    await until(() => r.tv.msgs.some((m) => m.type === 'scene' && (m.data as any).items.length === 1), 2000, 'only the good item');
    assert.equal(Math.max(...r.tv.msgs.filter((m) => m.type === 'scene').map((m) => (m.data as any).items.length)), 1);
    r.sendServer((d + 1) % 3, 'clear'); // not the drawer
    r.sendServer((d + 1) % 3, 'guess', { text: 'x'.repeat(500) });
    r.sendServer((d + 1) % 3, 'guess', { text: 42 });
    await until(() => r.tv.msgs.some((m) => m.type === 'guess'), 2000, 'guess');
    const g = r.tv.msgs.filter((m) => m.type === 'guess');
    assert.equal(g.length, 1);
    assert.equal((g[0].data as any).text.length, 40);
    assert.equal((r.tv.msgs.filter((m) => m.type === 'scene').at(-1)!.data as any).items.length, 1);
  } finally {
    await r.close();
  }
});

test('review 5: HTML guesses are relayed as plain text and a near-word guess is masked on TV', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '1';
  process.env.HP_PICTIONARY_ROUND_MS = '5000';
  const r = await setupRoom(3);
  try {
    await r.start('pictionary');
    const { d, word } = await waitDrawing(r, 1);
    const g = (d + 1) % 3;
    r.sendServer(g, 'guess', { text: '<img src=x onerror=alert(1)>' });
    r.sendServer(g, 'guess', { text: `the ${word}s` });
    await until(() => r.tv.msgs.filter((m) => m.type === 'guess').length === 2, 2000, 'two guesses');
    const texts = r.tv.msgs.filter((m) => m.type === 'guess').map((m) => (m.data as any).text);
    assert.equal(texts[0], '<img src=x onerror=alert(1)>', 'kept as a literal string; pages use textContent');
    assert.equal(texts[1], '(too close!)');
  } finally {
    await r.close();
  }
});

test('ready: a phone that mounts late asks for state and gets it (word only for the drawer)', async () => {
  process.env.HP_PICTIONARY_ROUNDS = '1';
  process.env.HP_PICTIONARY_ROUND_MS = '5000';
  const r = await setupRoom(3);
  try {
    await r.start('pictionary');
    const { d, word } = await waitDrawing(r, 1);
    for (const b of r.bots) b.msgs.length = 0;
    for (let i = 0; i < 3; i++) r.sendServer(i, 'ready');
    for (let i = 0; i < 3; i++) await r.waitFor(i, 'state');
    await sleep(100);
    r.bots.forEach((b, i) => {
      const secret = b.msgs.filter((m) => m.type === 'secret');
      assert.equal(secret.length, i === d ? 1 : 0);
      if (i !== d) assert.ok(!JSON.stringify(b.msgs).toLowerCase().includes(word));
    });
  } finally {
    await r.close();
  }
});
