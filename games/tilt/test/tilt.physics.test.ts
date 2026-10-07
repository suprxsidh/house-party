import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_HALF, FALL_DIST, MARBLE_R, STEP, cleanTilt, layoutHoles, newMarble, step, sumTilts, type Hole } from '../physics.ts';

function run(tilt: (m: ReturnType<typeof newMarble>) => { x: number; z: number }, holes: Hole[], secs: number) {
  const m = newMarble();
  for (let i = 0; i < secs / STEP; i++) {
    const f = step(m, tilt(m), holes);
    if (f >= 0) return { fell: f, m, t: i * STEP };
  }
  return { fell: -1, m, t: secs };
}

test('sum is clamped, not averaged', () => {
  assert.deepEqual(sumTilts([{ x: 0.2, z: 0 }, { x: 0.2, z: -0.1 }]), { x: 0.4, z: -0.1 });
  assert.deepEqual(sumTilts(Array.from({ length: 10 }, () => ({ x: 0.5, z: -0.5 }))), { x: 1, z: -1 });
  assert.deepEqual(sumTilts([{ x: 1, z: 0 }, { x: -1, z: 0 }]), { x: 0, z: 0 });
});

test('cleanTilt rejects junk and clamps', () => {
  assert.equal(cleanTilt(null), null);
  assert.equal(cleanTilt({ x: NaN, z: 0 }), null);
  assert.equal(cleanTilt({ x: '1', z: 0 }), null);
  assert.deepEqual(cleanTilt({ x: 9, z: -9 }), { x: 1, z: -1 });
});

test('layout is deterministic and spaced', () => {
  const a = layoutHoles(42, 10);
  assert.deepEqual(a, layoutHoles(42, 10));
  assert.notDeepEqual(a, layoutHoles(43, 10));
  for (const h of a) assert.ok(Math.hypot(h.x, h.z) >= 2 && Math.abs(h.x) < BOARD_HALF && Math.abs(h.z) < BOARD_HALF);
});

test('marble with no tilt stays put', () => {
  const r = run(() => ({ x: 0, z: 0 }), [{ x: 3, z: 3 }], 5);
  assert.equal(r.fell, -1);
  assert.equal(r.m.x, 0);
});

test('headless fall detection: marble rolls into the hole it is steered at', () => {
  const holes: Hole[] = [{ x: -3, z: -3 }, { x: 3, z: 0 }, { x: 0, z: 3.5 }];
  for (let target = 0; target < holes.length; target++) {
    // Simple PD controller: aim tilt at the hole.
    const r = run(
      (m) => {
        const h = holes[target];
        return { x: (h.x - m.x) * 0.5 - m.vx * 0.3, z: (h.z - m.z) * 0.5 - m.vz * 0.3 };
      },
      holes,
      20,
    );
    assert.equal(r.fell, target, `fell into ${target}`);
    assert.ok(Math.hypot(holes[target].x - r.m.x, holes[target].z - r.m.z) < FALL_DIST);
  }
});

test('walls hold the marble', () => {
  const r = run(() => ({ x: 1, z: 1 }), [], 10);
  assert.ok(r.m.x <= BOARD_HALF - MARBLE_R + 1e-9 && r.m.z <= BOARD_HALF - MARBLE_R + 1e-9);
});

test('physics is deterministic', () => {
  const holes = layoutHoles(7, 8);
  const go = () => run((m) => ({ x: Math.sin(m.vz), z: 0.3 }), holes, 4).m;
  assert.deepEqual(go(), go());
});
