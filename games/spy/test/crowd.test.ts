import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOUNTAIN_R, WALK_HALF, cleanMove, collide, dist, moveHuman, mulberry32, nearest, newBot, randomPoint, stepBot, type Char } from '../crowd.ts';
import { ARREST_RANGE, BOT_PAUSE_MS, WALK_SPEED } from '../types.ts';

test('bot walk: 40 bots for 10 minutes stay in the plaza, never exceed 2.0 m/s, pause 1 to 4 s, never stuck', () => {
  const rng = mulberry32(7);
  const bots = Array.from({ length: 40 }, () => ({ p: randomPoint(rng), b: newBot(rng), pauses: [] as number[], run: 0 }));
  const dt = 1 / 60;
  let fastest = 0;
  for (let i = 0; i < 600 * 60; i++) {
    for (const o of bots) {
      const ox = o.p.x;
      const oz = o.p.z;
      const wasPaused = o.b.pause > 0;
      stepBot(o.p, o.b, dt, rng);
      fastest = Math.max(fastest, Math.hypot(o.p.x - ox, o.p.z - oz) / dt);
      assert.ok(Math.abs(o.p.x) <= WALK_HALF + 1e-9 && Math.abs(o.p.z) <= WALK_HALF + 1e-9, 'inside plaza');
      assert.ok(Math.hypot(o.p.x, o.p.z) >= FOUNTAIN_R - 1e-3, 'outside fountain');
      if (wasPaused) o.run += dt;
      else if (o.run > 0) {
        o.pauses.push(o.run);
        o.run = 0;
      }
    }
  }
  assert.ok(fastest <= WALK_SPEED + 1e-6, `fastest ${fastest}`);
  const all = bots.flatMap((o) => o.pauses.slice(1)); // the first pause is a shorter random start
  assert.ok(all.length > 400, `pauses seen ${all.length}`);
  assert.ok(Math.min(...all) >= BOT_PAUSE_MS[0] / 1000 - 0.05, `min pause ${Math.min(...all)}`);
  assert.ok(Math.max(...all) <= BOT_PAUSE_MS[1] / 1000 + 0.05, `max pause ${Math.max(...all)}`);
  const worst = Math.max(...bots.map((o) => o.b.maxStillS));
  assert.ok(worst < 5, `longest still time ${worst}`);
});

test('bot stuck detection: a bot pinned by a wall is flagged and gets a new target', () => {
  const rng = mulberry32(3);
  const p = { x: 10, z: 10 };
  const b = newBot(rng);
  b.pause = 0;
  const wall = (q: { x: number; z: number }) => {
    q.x = 10;
    q.z = 10;
    return true;
  };
  const first = { tx: b.tx, tz: b.tz };
  for (let i = 0; i < 90; i++) stepBot(p, b, 1 / 60, rng, wall);
  assert.ok(b.repicks >= 1, 'repicked after 1 s blocked');
  assert.notDeepEqual({ tx: b.tx, tz: b.tz }, first);
  assert.ok(b.maxStillS >= 1, 'stillS counts the blocked time');
});

test('speed clamp: any joystick input moves at most 2.0 m/s', () => {
  const p = { x: -20, z: 20 };
  const dt = 0.05; // 20 Hz
  for (const inp of [{ x: 1, y: 1 }, { x: 5, y: 0 }, { x: -9, y: 9 }, { x: 0.3, y: -0.2 }]) {
    const c = cleanMove(inp)!;
    const q = { x: 0, z: 20 };
    const moved = moveHuman(q, c, dt);
    assert.ok(moved <= WALK_SPEED * dt + 1e-9, `moved ${moved} for ${JSON.stringify(inp)}`);
  }
  // Even a huge raw input to moveHuman is clamped, and a huge dt is capped.
  const q = { x: 0, z: 20 };
  assert.ok(moveHuman(q, { x: 100, y: 100 }, 5) <= WALK_SPEED * 0.1 + 1e-9);
  // Full stick for 1 s = 2.0 m
  const r = { x: 0, z: 20 };
  for (let i = 0; i < 20; i++) moveHuman(r, { x: 1, y: 0 }, dt);
  assert.ok(Math.abs(dist(r, { x: 0, z: 20 }) - 2.0) < 1e-6);
  void p;
});

test('cleanMove rejects bad payloads', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { x: 1 }, { x: '1', y: 0 }, { x: NaN, y: 0 }, { x: 0, y: Infinity }]) assert.equal(cleanMove(bad), null);
  assert.deepEqual(cleanMove({ x: 0.5, y: -0.5 }), { x: 0.5, y: -0.5 });
  const c = cleanMove({ x: 30, y: 40 })!;
  assert.ok(Math.abs(Math.hypot(c.x, c.y) - 1) < 1e-9);
});

test('humans cannot walk into the fountain or off the plaza', () => {
  const p = { x: 10, z: 0 };
  for (let i = 0; i < 400; i++) moveHuman(p, { x: -1, y: 0 }, 0.05);
  assert.ok(Math.hypot(p.x, p.z) >= FOUNTAIN_R - 1e-3);
  for (let i = 0; i < 2000; i++) moveHuman(p, { x: 1, y: 0 }, 0.05);
  assert.ok(p.x <= WALK_HALF + 1e-9);
  const q = { x: 0, z: 0 };
  assert.ok(collide(q));
});

test('nearest picker: nearest in range, not the actor, honours skip, null when out of range', () => {
  const a: Char = { id: 'p1', x: 0, z: 10 };
  const chars: Char[] = [a, { id: 'bot-0', x: 1.9, z: 10 }, { id: 'p2', x: 0, z: 11.2 }, { id: 'bot-1', x: 5, z: 10 }];
  const r = nearest(chars, a, ARREST_RANGE)!;
  assert.equal(r.target.id, 'p2');
  assert.ok(Math.abs(r.dist - 1.2) < 1e-9);
  assert.equal(nearest(chars, a, ARREST_RANGE, (c) => c.id === 'p2')!.target.id, 'bot-0');
  assert.equal(nearest(chars, a, 1.0), null);
  assert.equal(nearest([a], a), null, 'alone: nothing');
  assert.equal(nearest([a, { id: 'x', x: 2.0001, z: 10 }], a, 2.0), null, 'just outside');
  assert.equal(nearest([a, { id: 'x', x: 2.0, z: 10 }], a, 2.0)!.target.id, 'x', 'exactly on range counts');
});
