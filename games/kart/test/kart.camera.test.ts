// Fast unit tests for the pack camera framing maths and the catch-up curve (no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FRAME, framePack, project, packMembers, catchUpBonus, CATCHUP_MAX, angleDelta, type V3,
} from '../../../kart/src/party/framing.ts';

const O = DEFAULT_FRAME;
const inside = (pose: ReturnType<typeof framePack>, p: V3, lim = 1) => {
  const q = project(pose.eye, pose.target, p, O.fovDeg, O.aspect);
  return q.depth > 0 && Math.abs(q.x) <= lim && Math.abs(q.y) <= lim;
};
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test('one kart: camera sits at minimum distance, looking at that kart', () => {
  const leader = { x: 100, y: 3, z: -50 };
  const pose = framePack(leader, 0.7, [leader]);
  assert.equal(pose.dist, O.minDist);
  assert.deepEqual(pose.target, leader);
  assert.ok(inside(pose, leader, 0.01));
});

test('a tight pack: every kart within 40 m of the leader is in frame, at any heading', () => {
  for (let trial = 0; trial < 300; trial++) {
    const yaw = rnd() * Math.PI * 2;
    const leader = { x: rnd() * 400 - 200, y: rnd() * 20, z: rnd() * 400 - 200 };
    const others: V3[] = [];
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 40;
      others.push({ x: leader.x + Math.cos(a) * r, y: leader.y + rnd() * 2, z: leader.z + Math.sin(a) * r });
    }
    const pose = framePack(leader, yaw, others);
    for (const p of packMembers(leader, others, O.radius)) {
      assert.ok(inside(pose, p, 1 - O.margin + 1e-9), `trial ${trial}: kart in frame (dist ${pose.dist.toFixed(1)})`);
    }
    assert.ok(pose.dist >= O.minDist && pose.dist <= O.maxDist);
  }
});

test('the worst case (karts on a 40 m circle round the leader) fits inside the zoom limit', () => {
  const leader = { x: 0, y: 0, z: 0 };
  const others = Array.from({ length: 9 }, (_, i) => ({ x: Math.cos(i * 0.7) * 40, y: 0, z: Math.sin(i * 0.7) * 40 }));
  for (const aspect of [16 / 9, 4 / 3]) {
    const o = { ...O, aspect };
    const pose = framePack(leader, 0.3, others, o);
    assert.ok(pose.dist < o.maxDist, `aspect ${aspect.toFixed(2)}: dist ${pose.dist.toFixed(1)} < max ${o.maxDist}`);
  }
});

test('stragglers: a kart 300 m behind is ignored, zoom stays clamped', () => {
  const leader = { x: 0, y: 0, z: 0 };
  const near = { x: 5, y: 0, z: -12 };
  const far = { x: 0, y: 0, z: -300 };
  const a = framePack(leader, 0, [near]);
  const b = framePack(leader, 0, [near, far]);
  assert.equal(b.dist, a.dist, 'far kart changes nothing');
  assert.equal(packMembers(leader, [near, far], 40).length, 2);
  // a kart 60 m back is outside the hard 40 m rule but inside the soft zone: shown when it costs little zoom
  const mid = { x: 0, y: 0, z: -60 };
  const c = framePack(leader, 0, [near, mid]);
  assert.ok(inside(c, mid, 1 - O.margin + 1e-9), 'soft zone kart shown');
  assert.ok(c.dist <= O.softMaxDist);
  // even a pack stretched to the 40 m edge never zooms past the clamp
  const edge = { x: 0, y: 0, z: -39 };
  assert.ok(framePack(leader, 0, [near, edge, far]).dist <= O.maxDist);
  // with a tiny maximum the zoom is clamped, not unbounded
  assert.equal(framePack(leader, 0, [edge], { ...O, maxDist: 30 }).dist, 30);
});

test('angleDelta takes the short way round', () => {
  assert.ok(Math.abs(angleDelta(3.0, -3.0) - (2 * Math.PI - 6.0)) < 1e-9);
  assert.ok(Math.abs(angleDelta(-3.0, 3.0) + (2 * Math.PI - 6.0)) < 1e-9);
});

test('catch-up curve: none for the leader or a close kart, grows with the gap, caps at +25%', () => {
  assert.equal(catchUpBonus(0), 0, 'leader gets none');
  assert.equal(catchUpBonus(-50), 0, 'ahead of the lead line gets none');
  assert.equal(catchUpBonus(NaN), 0);
  assert.equal(catchUpBonus(10), 0, 'inside the free gap');
  let prev = 0;
  for (let g = 21; g <= 400; g += 3) {
    const b = catchUpBonus(g);
    assert.ok(b >= prev, `monotone at ${g} m`);
    assert.ok(b <= CATCHUP_MAX + 1e-12, 'never above +25%');
    prev = b;
  }
  assert.ok(catchUpBonus(90) > 0 && catchUpBonus(90) < CATCHUP_MAX);
  assert.equal(catchUpBonus(130), CATCHUP_MAX);
  assert.equal(catchUpBonus(5000), CATCHUP_MAX);
  console.log('catch-up curve (gap m -> bonus):', [0, 10, 30, 60, 90, 130, 300].map((g) => `${g}->${(catchUpBonus(g) * 100).toFixed(1)}%`).join(' '));
});
