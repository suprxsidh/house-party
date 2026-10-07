// House Party: the high pack camera, the off-screen reposition rule and the in-frame evidence counters.
// ChaseCamera.lateUpdate hands the frame to `ctx.packCam` when it is set (party mode only).
import * as THREE from 'three';
import { RaceState, type Ctx } from '../types';
import type { Race } from '../game/Race';
import {
  DEFAULT_FRAME, angleDelta, eyeOf, fitDistance, framePack, packMembers, type FrameOpts, type V3,
} from './framing';

/** A kart off screen this long (race seconds) is moved next to the pack. */
export const OFFSCREEN_LIMIT_S = 5;
/** Where a moved kart lands: this far behind the leader, metres. */
const BEHIND_LEADER_M = 10;
/** Evidence: a kart counts as "in frame" with this much room to the edge (NDC 1 = edge). */
const EVIDENCE_LIM = 0.985;

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

interface Moved { t: number; kart: number; gap: number; lapBefore: number; cpBefore: number; lapIndex: number; cp: number; expectDist: number; offSec: number; afterDist: number | null }

export interface PackStats {
  frames: number;
  checks: number;
  memberChecks: number;
  memberOut: number;
  /** worst |NDC| seen for any kart within 40 m of the leader (1 = screen edge) */
  worstMemberNdc: number;
  allChecks: number;
  allIn: number;
  minDist: number;
  maxDist: number;
  maxOffscreenSec: number;
  moved: Moved[];
  /** first few failures, for the log */
  failures: string[];
}

export function installPack(ctx: Ctx, race: Race, checkEvery = 4) {
  const opts: FrameOpts = { ...DEFAULT_FRAME };
  const karts = race.karts;
  const prog = (race as any).prog as { lapIndex: number; cp: number; respawnT: number; stuckT: number; badT: number }[];
  const offT = new Float32Array(karts.length);

  const st: PackStats = {
    frames: 0, checks: 0, memberChecks: 0, memberOut: 0, worstMemberNdc: 0, allChecks: 0, allIn: 0,
    minDist: Infinity, maxDist: 0, maxOffscreenSec: 0, moved: [], failures: [],
  };

  // smoothed rig state
  let ready = false;
  const target = new THREE.Vector3();
  let yaw = 0;
  let dist = opts.minDist;
  let eased = opts.minDist;

  const pos = (k: { position: THREE.Vector3 }): V3 => k.position;

  /** front-most kart still racing (everyone, once all have finished) */
  function leaderOf(): typeof karts[number] {
    let best: typeof karts[number] | null = null;
    for (const k of karts) if (!k.finished && (!best || k.raceDistance > best.raceDistance)) best = k;
    if (best) return best;
    return race.standings[0] as typeof karts[number];
  }

  function update(c: Ctx, dt: number) {
    dt = Math.min(Math.max(dt, 1 / 480), 0.1);
    st.frames++;
    const cam = c.camera;
    const leader = leaderOf();
    const allDone = karts.every((x) => x.finished);
    const others = karts.filter((k) => allDone || !k.finished).map(pos);
    const L = pos(leader);

    // heading: the track direction at the leader, smoothed round the bends
    const s = c.track.sample(leader.t);
    const wantYaw = Math.atan2(s.tangent.x, s.tangent.z);
    opts.aspect = cam.aspect || opts.aspect;
    opts.fovDeg = DEFAULT_FRAME.fovDeg;
    const members = packMembers(L, others, opts.radius);
    const ideal = framePack(L, wantYaw, others, opts);
    const wantTarget = ideal.target;

    if (!ready) {
      yaw = wantYaw;
      target.set(wantTarget.x, wantTarget.y, wantTarget.z);
      dist = eased = ideal.dist;
      ready = true;
    } else {
      yaw += angleDelta(yaw, wantYaw) * Math.min(1, dt * 3.5);
      const k = Math.min(1, dt * 7);
      target.x += (wantTarget.x - target.x) * k;
      target.y += (wantTarget.y - target.y) * k;
      target.z += (wantTarget.z - target.z) * k;
    }
    // zoom: out fast, in slowly; and never closer than what shows every kart within 40 m right now
    const must = fitDistance(members, target, yaw, opts);
    eased += (ideal.dist - eased) * Math.min(1, dt * (ideal.dist > eased ? 8 : 1.2));
    dist = Math.min(opts.maxDist, Math.max(opts.minDist, eased, must));

    const eye = eyeOf(target, yaw, opts.pitchDeg, dist);
    if (cam.fov !== opts.fovDeg) { cam.fov = opts.fovDeg; cam.updateProjectionMatrix(); }
    cam.position.set(eye.x, eye.y, eye.z);
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    st.minDist = Math.min(st.minDist, dist);
    st.maxDist = Math.max(st.maxDist, dist);

    const racing = race.state === RaceState.Racing;
    // --- off-screen tracking, through the real camera ------------------------
    const doCheck = st.frames % checkEvery === 0;
    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      _p.copy(k.position).project(cam);
      const behind = _v.copy(k.position).applyMatrix4(cam.matrixWorldInverse).z >= 0;
      const ax = Math.abs(_p.x), ay = Math.abs(_p.y);
      const on = !behind && ax <= 1 && ay <= 1;
      if (racing && !k.finished) {
        offT[i] = on ? 0 : offT[i] + dt;
        if (offT[i] > st.maxOffscreenSec) st.maxOffscreenSec = offT[i];
      } else offT[i] = 0;

      if (doCheck && racing && !k.finished) {
        st.checks++;
        st.allChecks++;
        const ndc = behind ? 9 : Math.max(ax, ay);
        if (ndc <= EVIDENCE_LIM) st.allIn++;
        const near = Math.hypot(k.position.x - L.x, k.position.z - L.z) <= opts.radius;
        if (near) {
          st.memberChecks++;
          if (ndc > st.worstMemberNdc) st.worstMemberNdc = ndc;
          if (ndc > EVIDENCE_LIM) {
            st.memberOut++;
            if (st.failures.length < 8) st.failures.push(`t=${race.raceTime.toFixed(1)} kart ${k.id} ndc ${ndc.toFixed(3)} dist ${dist.toFixed(1)}`);
          }
        }
      }

      if (racing && !k.finished && offT[i] >= OFFSCREEN_LIMIT_S && k !== leader) reposition(c, i, leader);
    }

    // follow-up: did the progress code accept the move? (cp and lapIndex consistent)
    for (const m of st.moved) {
      if (m.afterDist === null && race.raceTime > m.t) m.afterDist = karts[m.kart].raceDistance;
    }
  }

  /** Put kart `i` just behind the leader, with checkpoint and lap set to match. */
  function reposition(c: Ctx, i: number, leader: typeof karts[number]) {
    const k = karts[i];
    const p = prog[i];
    const track = c.track;
    const line = (race as any).ai.line;
    const L = track.length;
    const D = leader.raceDistance - BEHIND_LEADER_M;
    if (!(k.raceDistance < D)) { offT[i] = 0; return; }
    const lap = Math.floor(D / L);
    const sOnLap = D - lap * L;
    line.point(sOnLap, _v);
    const probe = track.probe(_v, sOnLap / L);
    _v.y = probe.y + 1.2;
    const yawK = line.yaw[line.index(sOnLap)];
    const t = ((sOnLap / L) % 1 + 1) % 1;
    const rec: Moved = {
      t: race.raceTime, kart: i, gap: leader.raceDistance - k.raceDistance, lapBefore: p.lapIndex, cpBefore: p.cp,
      lapIndex: lap, cp: track.checkpointAt(t), expectDist: D, offSec: offT[i], afterDist: null,
    };
    k.placeAt(_v, yawK, t);
    k.invulnTime = 1.5;
    p.lapIndex = rec.lapIndex;
    p.cp = rec.cp;
    (p as { lapStart?: number }).lapStart = race.raceTime; // lap time restarts from the move
    p.respawnT = 0.55;
    p.stuckT = 0;
    p.badT = 0;
    k.raceDistance = D;
    offT[i] = 0;
    if (st.moved.length < 200) st.moved.push(rec);
  }

  (ctx as any).packCam = update;
  return {
    stats: () => JSON.parse(JSON.stringify(st, (_k, v) => (v === Infinity ? null : v))) as PackStats,
    /** test aid: every kart's position through the live camera right now (NDC, +-1 = screen edge) */
    ndc: () => {
      const cam = ctx.camera;
      cam.updateMatrixWorld(true);
      const ld = leaderOf();
      return karts.map((k) => {
        _p.copy(k.position).project(cam);
        const behind = _v.copy(k.position).applyMatrix4(cam.matrixWorldInverse).z >= 0;
        return {
          kart: k.id, x: Math.round(_p.x * 1000) / 1000, y: Math.round(_p.y * 1000) / 1000, behind,
          finished: k.finished, leader: k === ld,
          fromLeader: Math.round(Math.hypot(k.position.x - ld.position.x, k.position.z - ld.position.z) * 10) / 10,
        };
      });
    },
    /** test aid: seconds each kart has been off screen right now */
    offscreen: () => Array.from(offT, (v) => Math.round(v * 10) / 10),
  };
}
