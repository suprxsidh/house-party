// Pure, deterministic Tilt Table physics. No DOM, no Date, no Math.random.
// Used by the TV (render loop), by the server (hole layout) and by tests.

export const BOARD_HALF = 5; // board spans -5..5 on x and z
export const MARBLE_R = 0.25;
export const HOLE_R = 0.55;
export const MAX_TILT_RAD = 0.4; // board angle at tilt = 1
export const G = 9.8;
export const DAMPING = 0.7; // per second
export const RESTITUTION = 0.4;
export const STEP = 1 / 120; // fixed step in seconds
export const FALL_DIST = HOLE_R - 0.1; // marble center this close to a hole center falls

export interface Vec2 { x: number; z: number }
export interface Marble { x: number; z: number; vx: number; vz: number }
export interface Hole { x: number; z: number }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Clean one player's tilt: finite numbers only, each axis in -1..1. */
export function cleanTilt(t: unknown): Vec2 | null {
  if (!t || typeof t !== 'object') return null;
  const { x, z } = t as Record<string, unknown>;
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x: clamp(x, -1, 1), z: clamp(z, -1, 1) };
}

/** Board tilt = clamped SUM of all player tilts (not an average). */
export function sumTilts(tilts: Iterable<Vec2>): Vec2 {
  let x = 0;
  let z = 0;
  for (const t of tilts) {
    x += t.x;
    z += t.z;
  }
  return { x: clamp(x, -1, 1), z: clamp(z, -1, 1) };
}

export const newMarble = (): Marble => ({ x: 0, z: 0, vx: 0, vz: 0 });

/** Seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hole layout: `count` holes, at least 2 apart, at least 2 from the center spawn. */
export function layoutHoles(seed: number, count: number): Hole[] {
  const r = rng(seed);
  const lim = BOARD_HALF - HOLE_R - 0.4;
  const holes: Hole[] = [];
  let tries = 0;
  while (holes.length < count) {
    const h = { x: (r() * 2 - 1) * lim, z: (r() * 2 - 1) * lim };
    tries++;
    const ok =
      Math.hypot(h.x, h.z) >= 2 && holes.every((o) => Math.hypot(o.x - h.x, o.z - h.z) >= (tries > 2000 ? 1.4 : 2));
    if (ok) holes.push({ x: Math.round(h.x * 100) / 100, z: Math.round(h.z * 100) / 100 });
    if (tries > 20000) throw new Error('layout failed');
  }
  return holes;
}

/** Advance one fixed step. Returns the index of the hole the marble fell into, or -1. */
export function step(m: Marble, tilt: Vec2, holes: Hole[], dt = STEP): number {
  const ax = G * Math.sin(MAX_TILT_RAD * clamp(tilt.x, -1, 1));
  const az = G * Math.sin(MAX_TILT_RAD * clamp(tilt.z, -1, 1));
  m.vx += ax * dt;
  m.vz += az * dt;
  const d = Math.exp(-DAMPING * dt);
  m.vx *= d;
  m.vz *= d;
  m.x += m.vx * dt;
  m.z += m.vz * dt;
  const lim = BOARD_HALF - MARBLE_R;
  if (m.x > lim) { m.x = lim; m.vx = -m.vx * RESTITUTION; }
  else if (m.x < -lim) { m.x = -lim; m.vx = -m.vx * RESTITUTION; }
  if (m.z > lim) { m.z = lim; m.vz = -m.vz * RESTITUTION; }
  else if (m.z < -lim) { m.z = -lim; m.vz = -m.vz * RESTITUTION; }
  for (let i = 0; i < holes.length; i++) {
    if (Math.hypot(holes[i].x - m.x, holes[i].z - m.z) < FALL_DIST) return i;
  }
  return -1;
}
