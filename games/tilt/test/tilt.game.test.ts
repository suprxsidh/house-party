import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupRoom, until, sleep } from '../../../bots/harness.ts';

process.env.HP_TILT_COUNTDOWN_MS = '0';
process.env.HP_TILT_STALE_MS = '10000';

type Layout = { holes: { x: number; z: number }[]; startsAt: number; endsAt: number };
const lastOf = (msgs: { type: string; data: unknown }[], type: string) => [...msgs].reverse().find((m) => m.type === type)?.data as any;

async function startTilt(n: number, roundMs = 60000) {
  process.env.HP_TILT_ROUND_MS = String(roundMs);
  const r = await setupRoom(n);
  await r.start('tilt');
  const layout = (await r.tv.waitFor('layout')).data as Layout;
  const goals: number[] = [];
  for (let i = 0; i < n; i++) goals.push(((await r.waitFor(i, 'goal')).data as any).hole);
  return { r, layout, goals };
}

test('goals are private, TV never sees owners, scoring follows the reported hole', async () => {
  const { r, layout, goals } = await startTilt(4);
  try {
    assert.ok(layout.holes.length >= 8);
    assert.equal(new Set(goals).size, 4, 'distinct goals');
    await sleep(50);
    // Bot 1 goal hole: TV reports it. Only bot 1 scores.
    r.tv.toServer('fell', { hole: goals[1] });
    const sc = (await r.waitFor(1, 'score')).data as any;
    assert.equal(sc.points, 10);
    await sleep(100);
    for (const i of [0, 2, 3]) assert.equal(r.bots[i].msgs.filter((m) => m.type === 'score').length, 0);
    // Bad reports are ignored.
    await sleep(350);
    for (const bad of [-1, 99, 1.5, '2', null, undefined, NaN]) r.tv.toServer('fell', { hole: bad as any });
    r.tv.toServer('fell', null);
    // A hole nobody owns scores nobody.
    const free = layout.holes.findIndex((_, i) => !goals.includes(i));
    r.tv.toServer('fell', { hole: free });
    await sleep(150);
    assert.equal(r.bots.reduce((a, b) => a + b.msgs.filter((m) => m.type === 'score').length, 0), 1);
    // A phone cannot report a fall.
    await sleep(350);
    r.sendServer(0, 'fell', { hole: goals[0] });
    await sleep(100);
    assert.equal(r.bots[0].msgs.filter((m) => m.type === 'score').length, 0);
    // Two players sharing a hole is not possible here; second hit on own hole adds up.
    r.tv.toServer('fell', { hole: goals[1] });
    await until(() => r.bots[1].msgs.filter((m) => m.type === 'score').length === 2, 2000, 'second score');
    assert.equal(lastOf(r.bots[1].msgs, 'score').points, 20);

    // Secrets: nothing TV-bound names a goal or an owner.
    for (const m of r.tv.msgs) {
      const s = JSON.stringify(m);
      assert.ok(!/goal|owner/i.test(s), `leak in ${s}`);
      if (m.type !== 'results') for (const b of r.bots) assert.ok(!s.includes(b.id!), `player id in ${m.type}`);
    }
    assert.deepEqual(Object.keys(lastOf(r.tv.msgs, 'scored')), ['hole']);
  } finally {
    await r.close();
  }
});

test('round ends: results go to TV and phones, tilts stop', async () => {
  const { r, goals } = await startTilt(3, 1200);
  try {
    r.tv.toServer('fell', { hole: goals[2] });
    await r.waitFor(2, 'score');
    const res = (await r.tv.waitFor('results', { ms: 4000 })).data as any;
    assert.equal(res.scores[0].points, 10);
    assert.equal(res.scores[0].name, 'Bot3');
    assert.equal(res.scores.length, 3);
    assert.deepEqual((await r.waitFor(0, 'results')).data, res);
    // After the end, falls and tilts change nothing.
    const n = r.tv.msgs.length;
    r.tv.toServer('fell', { hole: goals[0] });
    r.sendServer(0, 'tilt', { x: 1, z: 1 });
    await sleep(200);
    assert.equal(r.tv.msgs.length, n);
  } finally {
    await r.close();
  }
});

test('ten bots tilt at once: the board gets the exact clamped sum, no input lost', async () => {
  const { r } = await startTilt(10);
  try {
    const mark = r.tv.msgs.length;
    // All ten fire in the same tick: small tilts that add up to (0.4, -0.3).
    for (let i = 0; i < 10; i++) r.sendServer(i, 'tilt', { x: 0.04, z: -0.03 });
    await until(() => {
      const b = lastOf(r.tv.msgs.slice(mark), 'board');
      return b && Math.abs(b.x - 0.4) < 1e-9 && Math.abs(b.z + 0.3) < 1e-9;
    }, 3000, 'board = exact sum');
    // Big tilts clamp to 1, not 10.
    for (let i = 0; i < 10; i++) r.sendServer(i, 'tilt', { x: 0.5, z: 0.5 });
    await until(() => {
      const b = lastOf(r.tv.msgs, 'board');
      return b && b.x === 1 && b.z === 1;
    }, 3000, 'clamped');
    // One bot reverses: sum shrinks. Proves one input is not hidden behind others.
    for (let i = 0; i < 10; i++) r.sendServer(i, 'tilt', { x: i === 9 ? -0.5 : 0.05, z: 0 });
    await until(() => {
      const b = lastOf(r.tv.msgs, 'board');
      return b && Math.abs(b.x - (-0.5 + 0.45)) < 1e-9 && b.z === 0;
    }, 3000, 'mixed sum');
    // Junk is ignored, not applied.
    r.sendServer(0, 'tilt', { x: 'NaN', z: 1 });
    r.sendServer(0, 'tilt', { x: Infinity, z: 1 });
    await sleep(150);
    assert.ok(Math.abs(lastOf(r.tv.msgs, 'board').x - -0.05) < 1e-9);
  } finally {
    await r.close();
  }
});

test('rejoin keeps the secret hole and the score; TV reload gets the layout again', async () => {
  const { r, layout, goals } = await startTilt(4);
  try {
    await sleep(50);
    r.tv.toServer('fell', { hole: goals[3] });
    await r.waitFor(3, 'score');
    r.bots[3].msgs.length = 0;
    r.bots[3].drop();
    await sleep(100);
    r.bots[3].reconnect();
    const g = (await r.waitFor(3, 'goal')).data as any;
    assert.equal(g.hole, goals[3], 'same hole after rejoin');
    assert.equal(g.points, 10, 'same score after rejoin');
    assert.deepEqual(g.holes, layout.holes);
    // TV reload: asks again, gets layout, still no owner info.
    const n = r.tv.msgs.length;
    r.tv.toServer('ready');
    const l2 = (await r.tv.waitFor('layout', { after: n })).data as Layout;
    assert.deepEqual(l2.holes, layout.holes);
    assert.ok(!/goal|owner/i.test(JSON.stringify(r.tv.msgs)));
  } finally {
    await r.close();
  }
});

test('a frozen or dropped phone stops tilting the board', async () => {
  const { r } = await startTilt(2);
  try {
    process.env.HP_TILT_STALE_MS = '300';
    await r.start('tilt'); // restart game so the new setting applies
    await r.tv.waitFor('layout', { after: r.tv.msgs.length - 1 }).catch(() => {});
    const mark = r.tv.msgs.length;
    r.sendServer(0, 'tilt', { x: 0.5, z: 0 });
    await until(() => lastOf(r.tv.msgs.slice(mark), 'board')?.x === 0.5, 2000, 'tilt applied');
    await until(() => lastOf(r.tv.msgs.slice(mark), 'board')?.x === 0, 2000, 'stale tilt dropped');
  } finally {
    process.env.HP_TILT_STALE_MS = '10000';
    await r.close();
  }
});
