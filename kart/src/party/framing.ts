// House Party: pure maths for the high pack camera and the catch-up curve.
// No three.js, no DOM, so node tests can run it.
//
// Conventions match three.js: world Y is up, a kart heading `yaw` faces (sin yaw, 0, cos yaw),
// and the screen-right of a camera facing +Z is -X.

export interface V3 { x: number; y: number; z: number }

export interface FrameOpts {
  /** vertical field of view, degrees */
  fovDeg: number;
  /** viewport width / height */
  aspect: number;
  /** camera pitch below the horizon, degrees */
  pitchDeg: number;
  /** karts within this horizontal distance of the leader must fit, metres */
  radius: number;
  /** fraction of the half-viewport kept free at each edge */
  margin: number;
  minDist: number;
  maxDist: number;
  /** best effort: also show karts out to this horizontal distance from the leader, if the zoom stays under softMaxDist */
  softRadius: number;
  softMaxDist: number;
}

export const DEFAULT_FRAME: FrameOpts = {
  fovDeg: 55, aspect: 16 / 9, pitchDeg: 58, radius: 40, margin: 0.1, minDist: 24, maxDist: 150, softRadius: 75, softMaxDist: 75,
};

export interface Pose { target: V3; yaw: number; dist: number; eye: V3 }

const RAD = Math.PI / 180;

export function eyeOf(target: V3, yaw: number, pitchDeg: number, dist: number, out: V3 = { x: 0, y: 0, z: 0 }): V3 {
  const p = pitchDeg * RAD;
  out.x = target.x - Math.sin(yaw) * Math.cos(p) * dist;
  out.y = target.y + Math.sin(p) * dist;
  out.z = target.z - Math.cos(yaw) * Math.cos(p) * dist;
  return out;
}

/** Normalised device coords of `p` for a camera at `eye` looking at `target`. depth <= 0 means behind the lens. */
export function project(eye: V3, target: V3, p: V3, fovDeg: number, aspect: number) {
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // right = forward x up(0,1,0) = (-fz, 0, fx), normalised
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  // true up = right x forward
  const ux = -fy * rz, uy = rz * fx - rx * fz, uz = rx * fy;
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  const depth = dx * fx + dy * fy + dz * fz;
  const t = Math.tan((fovDeg * RAD) / 2);
  const d = Math.max(depth, 1e-6);
  return {
    x: (dx * rx + dz * rz) / (d * t * aspect),
    y: (dx * ux + dy * uy + dz * uz) / (d * t),
    depth,
  };
}

/** Karts within `radius` (horizontal) of the leader. The leader itself is always first. */
export function packMembers(leader: V3, others: V3[], radius: number): V3[] {
  const out: V3[] = [leader];
  for (const k of others) {
    if (k === leader) continue;
    if (Math.hypot(k.x - leader.x, k.z - leader.z) <= radius) out.push(k);
  }
  return out;
}

/** Smallest camera distance (stepwise, 4%) at which every point is inside the viewport minus margin. */
export function fitDistance(pts: V3[], target: V3, yaw: number, o: FrameOpts): number {
  const lim = 1 - o.margin;
  const eye: V3 = { x: 0, y: 0, z: 0 };
  let d = o.minDist;
  while (d < o.maxDist) {
    eyeOf(target, yaw, o.pitchDeg, d, eye);
    let ok = true;
    for (const p of pts) {
      const q = project(eye, target, p, o.fovDeg, o.aspect);
      if (q.depth <= 0 || Math.abs(q.x) > lim || Math.abs(q.y) > lim) { ok = false; break; }
    }
    if (ok) return d;
    d *= 1.04;
  }
  return o.maxDist;
}

/** Centre of the pack in the ground plane: middle of its bounding box along and across the heading. */
export function packCentre(pts: V3[], leader: V3, yaw: number): V3 {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
  for (const p of pts) {
    const a = p.x * fx + p.z * fz;
    const b = p.x * fz - p.z * fx;
    if (a < aMin) aMin = a;
    if (a > aMax) aMax = a;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  const a = (aMin + aMax) / 2, b = (bMin + bMax) / 2;
  return { x: a * fx + b * fz, y: leader.y, z: a * fz - b * fx };
}

/**
 * The ideal pose: look at the middle of the pack from behind and above, as close as still shows
 * every kart within `radius` of the leader (a hard rule). Karts out to `softRadius` are shown too
 * when that costs no more than `softMaxDist` of zoom. `yaw` is the track heading at the leader.
 */
export function framePack(leader: V3, yaw: number, others: V3[], o: FrameOpts = DEFAULT_FRAME): Pose {
  const hard = packMembers(leader, others, o.radius);
  const soft = packMembers(leader, others, o.softRadius);
  if (soft.length > hard.length) {
    const centre = packCentre(soft, leader, yaw);
    const d = fitDistance(soft, centre, yaw, { ...o, maxDist: o.softMaxDist });
    // the hard set must fit from here too, whatever the soft set does
    if (d < o.softMaxDist && fitDistance(hard, centre, yaw, o) <= d + 1e-9) {
      return { target: centre, yaw, dist: d, eye: eyeOf(centre, yaw, o.pitchDeg, d) };
    }
  }
  const target = packCentre(hard, leader, yaw);
  const dist = fitDistance(hard, target, yaw, o);
  return { target, yaw, dist, eye: eyeOf(target, yaw, o.pitchDeg, dist) };
}

/** Shortest signed turn from a to b, radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// ---------------------------------------------------------------------------------------------
//  Catch-up

/** Largest speed bonus, as a fraction of top speed. */
export const CATCHUP_MAX = 0.25;
/** No help inside this gap to the leader, metres. */
export const CATCHUP_FREE_GAP = 10;
/** Full help from this gap on, metres. */
export const CATCHUP_FULL_GAP = 130;

/** Speed bonus (0..0.25) for a kart `gap` metres behind the leader. The leader (gap <= 0) gets none. */
export function catchUpBonus(gap: number): number {
  if (!(gap > CATCHUP_FREE_GAP)) return 0;
  const x = Math.min(1, (gap - CATCHUP_FREE_GAP) / (CATCHUP_FULL_GAP - CATCHUP_FREE_GAP));
  return CATCHUP_MAX * x;
}
