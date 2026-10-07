// Pure crowd logic for the TV: bot walker, nearest-in-range picker, move with speed clamp.
// No three.js, no DOM. Unit tests: games/spy/test/crowd.test.ts
import { ARREST_RANGE, BOT_PAUSE_MS, PLAZA_SIZE, WALK_SPEED } from './types.ts';

export type Rng = () => number;

/** Small seeded generator, so tests are repeatable. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const WALK_HALF = PLAZA_SIZE / 2 - 1; // walkers stay inside this square
export const FOUNTAIN_R = 3.4; // blocked disc at 0,0

export interface Pos { x: number; z: number }
export interface Char extends Pos { id: string }

/** Push a position out of the fountain and back inside the plaza. Returns true if it changed. */
export function collide(p: Pos): boolean {
  const ox = p.x;
  const oz = p.z;
  p.x = Math.max(-WALK_HALF, Math.min(WALK_HALF, p.x));
  p.z = Math.max(-WALK_HALF, Math.min(WALK_HALF, p.z));
  const d = Math.hypot(p.x, p.z);
  if (d < FOUNTAIN_R) {
    if (d < 1e-6) {
      p.x = FOUNTAIN_R;
    } else {
      p.x = (p.x / d) * FOUNTAIN_R;
      p.z = (p.z / d) * FOUNTAIN_R;
    }
  }
  return p.x !== ox || p.z !== oz;
}

/** Keep the displacement from (ox,oz) to p at or below `max` metres (the push-out can add a hair). */
function capStep(p: Pos, ox: number, oz: number, max: number) {
  const m = Math.hypot(p.x - ox, p.z - oz);
  if (m > max) {
    p.x = ox + ((p.x - ox) / m) * max;
    p.z = oz + ((p.z - oz) / m) * max;
  }
}

export function randomPoint(rng: Rng): Pos {
  for (;;) {
    const p = { x: (rng() * 2 - 1) * WALK_HALF, z: (rng() * 2 - 1) * WALK_HALF };
    if (Math.hypot(p.x, p.z) > FOUNTAIN_R + 1) return p;
  }
}

export const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.z - b.z);

// ---- Bots ----
export interface BotState {
  tx: number;
  tz: number;
  pause: number; // seconds left to stand still
  /** Seconds the bot has failed to make progress while it should walk. 1 s of this picks a new target. */
  blockedS: number;
  /** Seconds without real movement, pauses included. */
  stillS: number;
  maxStillS: number;
  repicks: number;
}

export function newBot(rng: Rng): BotState {
  const t = randomPoint(rng);
  return { tx: t.x, tz: t.z, pause: rng() * 2, blockedS: 0, stillS: 0, maxStillS: 0, repicks: 0 };
}

const BLOCKED_REPICK_S = 1.0;
const pauseSeconds = (rng: Rng) => (BOT_PAUSE_MS[0] + rng() * (BOT_PAUSE_MS[1] - BOT_PAUSE_MS[0])) / 1000;

/** Move one bot by dt seconds. `wall` can be swapped in tests to force a stuck bot. */
export function stepBot(p: Pos, b: BotState, dt: number, rng: Rng, wall: (p: Pos) => boolean = collide): number {
  let moved = 0;
  const expected = WALK_SPEED * dt;
  if (b.pause > 0) {
    b.pause -= dt;
  } else {
    const dx = b.tx - p.x;
    const dz = b.tz - p.z;
    const d = Math.hypot(dx, dz);
    if (d <= expected) {
      p.x = b.tx;
      p.z = b.tz;
      moved = d;
      b.pause = pauseSeconds(rng);
      const t = randomPoint(rng);
      b.tx = t.x;
      b.tz = t.z;
      b.blockedS = 0;
    } else {
      const ox = p.x;
      const oz = p.z;
      p.x += (dx / d) * expected;
      p.z += (dz / d) * expected;
      wall(p);
      capStep(p, ox, oz, expected);
      moved = Math.hypot(p.x - ox, p.z - oz);
      if (moved < expected * 0.3) {
        b.blockedS += dt;
        if (b.blockedS >= BLOCKED_REPICK_S) {
          const t = randomPoint(rng);
          b.tx = t.x;
          b.tz = t.z;
          b.blockedS = 0;
          b.repicks++;
        }
      } else b.blockedS = 0;
    }
  }
  if (moved < expected * 0.3) b.stillS += dt;
  else b.stillS = 0;
  if (b.stillS > b.maxStillS) b.maxStillS = b.stillS;
  return moved;
}

// ---- Humans ----
export interface MoveInput { x: number; y: number }

/** Validate a phone's spy:move payload. Null = reject. Magnitude is clamped to 1. */
export function cleanMove(data: unknown): MoveInput | null {
  if (typeof data !== 'object' || data === null) return null;
  const { x, y } = data as Record<string, unknown>;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const m = Math.hypot(x, y);
  if (m > 1) return { x: x / m, y: y / m };
  return { x, y };
}

/** Walk a human by dt seconds. Phone stick: x right, y DOWN on screen (up = -1), so y maps straight to plaza z (up = -z). Speed never exceeds WALK_SPEED. Returns metres moved. */
export function moveHuman(p: Pos, input: MoveInput, dt: number, wall: (p: Pos) => boolean = collide): number {
  const m = Math.hypot(input.x, input.y);
  const k = m > 1 ? 1 / m : 1;
  const step = WALK_SPEED * Math.min(dt, 0.1);
  const ox = p.x;
  const oz = p.z;
  p.x += input.x * k * step;
  p.z += input.y * k * step;
  wall(p);
  capStep(p, ox, oz, step);
  return Math.hypot(p.x - ox, p.z - oz);
}

// ---- Picker ----
/** Nearest character to the actor within `range` metres. The actor and anything `skip` rejects never count. */
export function nearest<T extends Char>(chars: Iterable<T>, actor: Char, range: number = ARREST_RANGE, skip: (c: T) => boolean = () => false): { target: T; dist: number } | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const c of chars) {
    if (c.id === actor.id || skip(c)) continue;
    const d = dist(c, actor);
    if (d <= range && d < bd) {
      best = c;
      bd = d;
    }
  }
  return best ? { target: best, dist: bd } : null;
}
