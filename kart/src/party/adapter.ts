// House Party adapter for the kart race. Runs inside the TV's /kart/ iframe.
// The TV page (games/kart/host) talks to `window.__party`; phones never reach this file directly.
import * as THREE from 'three';
import { RaceState, type Ctx } from '../types';
import type { Race } from '../game/Race';
import type { RemoteCmd, RemoteDriver } from './remote';

/** A phone not heard from for this long hands its kart to the AI until it returns. */
const STALE_MS = 2500;
/** After the first kart finishes, wait this long (race seconds) for the rest. */
const STRAGGLER_S = 75;
/** Hard cap on one race, race seconds. */
const MAX_RACE_S = 900;

export interface PhoneInput {
  s: number; // steer -1..1, right positive
  g: number; // gas 0..1
  i: number; // item tap counter (only ever grows)
}

interface Seat {
  seat: string;
  name: string;
  kart: number;
  steer: number;
  gas: number;
  itemSeen: number; // taps already used
  itemSent: number; // taps received
  at: number; // wall-clock ms of last input
  inputs: number; // messages received (test evidence)
}

export interface KartRow {
  seat: string | null;
  name: string;
  kart: number;
  human: boolean;
  /** true while a phone drives this kart right now */
  remote: boolean;
  place: number;
  lap: number;
  finished: boolean;
  finishTime: number;
  item: string;
  itemCount: number;
  speed: number;
  /** radians to the look-ahead point on the racing line, right positive (bot pilots read this) */
  aim: number;
  /** target speed on the racing line here, m/s */
  targetSpeed: number;
  inputs: number;
  /** last steer and gas the phone sent, and how many item taps arrived (test evidence) */
  steer: number;
  gas: number;
  taps: number;
}
export interface Snapshot {
  phase: 'wait' | 'countdown' | 'racing' | 'finished' | 'results';
  raceTime: number;
  laps: number;
  karts: number;
  leaderKart: number;
  rows: KartRow[];
  /** kart indices by finishing/current place, best first */
  order: number[];
}

const _a = new THREE.Vector3();
// ItemKind values 0..8 (const enum, so no reverse lookup)
const ITEM_NAMES = ['None', 'Mushroom', 'TripleMushroom', 'GreenShell', 'RedShell', 'Banana', 'Star', 'Bolt', 'Bomb'];

export function installParty(ctx: Ctx) {
  const race = ctx.race as Race;
  const seats = new Map<string, Seat>();
  const byKart = new Map<number, Seat>();
  let firstFinishAt = -1;
  let forced = false;
  let started = false;

  // --- the party page chrome: no menus, no touch pad -----------------------
  const style = document.createElement('style');
  style.textContent = `
    .tc-root { display: none !important; }
    .kr-screens .kr-screen:not(.kr-s-results) { display: none !important; }
    .kr-s-results .kr-menu-list, .kr-s-results .kr-laps { display: none !important; }
    .kr-screens { pointer-events: none !important; }
  `;
  document.head.append(style);

  const driver: RemoteDriver = {
    owns: (k) => byKart.has(k.id),
    command(k) {
      const s = byKart.get(k.id);
      if (!s || s.inputs === 0 || performance.now() - s.at > STALE_MS) return null;
      let useItem = false;
      if (s.itemSeen < s.itemSent) {
        s.itemSeen++; // one tap per frame; extra taps queue
        useItem = true;
      }
      cmd.steer = s.steer;
      cmd.throttle = s.gas;
      cmd.brake = 0;
      cmd.drift = false;
      cmd.useItem = useItem;
      return cmd;
    },
  };
  const cmd: RemoteCmd = { steer: 0, throttle: 0, brake: 0, drift: false, useItem: false };
  race.remote = driver;
  // No kart is "the player" any more: `race.player` just follows the leader.
  for (const k of race.karts) k.isPlayer = false;

  const humansFinished = () => {
    if (!byKart.size) return false;
    for (const s of byKart.values()) if (!race.karts[s.kart].finished) return false;
    return true;
  };

  const finishRace = () => {
    if (race.state === RaceState.Racing) race.state = RaceState.Finished;
  };

  // Everyone with a phone has finished: close the race. Stragglers get a time limit too.
  const tick = () => {
    if (race.state === RaceState.Racing) {
      const any = race.karts.some((k) => k.finished);
      if (any && firstFinishAt < 0) firstFinishAt = race.raceTime;
      if (humansFinished()) finishRace();
      else if (firstFinishAt >= 0 && race.raceTime - firstFinishAt > STRAGGLER_S) { forced = true; finishRace(); }
      else if (race.raceTime > MAX_RACE_S) { forced = true; finishRace(); }
    }
  };
  setInterval(tick, 250);

  function lookAhead(k: Race['karts'][number]) {
    const line = (race as any).ai?.line;
    if (!line) return { aim: 0, targetSpeed: 20 };
    const L = line.length as number;
    const d = k.t * L;
    const look = 10 + Math.max(0, k.forwardSpeed) * 0.55;
    line.point(d + look, _a);
    const dx = _a.x - k.position.x;
    const dz = _a.z - k.position.z;
    const f = k.forward;
    const fl = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / fl, fz = f.z / fl;
    // Screen-right of the kart in world XZ (three.js is right-handed: facing +Z, right is -X).
    // Checked against the chase camera: steer +1 turns the heading toward this vector.
    const rx = -fz, rz = fx;
    const aim = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
    // slow for what is coming, not for what is under the wheels
    let ts = Infinity;
    for (let m = 0; m <= 40; m += 10) ts = Math.min(ts, line.speedAt(d + m) as number);
    return { aim, targetSpeed: ts };
  }

  function snapshot(): Snapshot {
    const st = race.state;
    const phase: Snapshot['phase'] =
      !started ? 'wait'
      : st === RaceState.Countdown ? 'countdown'
      : st === RaceState.Racing || st === RaceState.Paused ? 'racing'
      : st === RaceState.Finished ? 'finished'
      : st === RaceState.Results ? 'results' : 'wait';
    const order = race.standings.map((k) => k.id);
    const rows: KartRow[] = race.karts.map((k) => {
      const s = byKart.get(k.id);
      const held = ctx.items.held(k);
      const la = s ? lookAhead(k) : { aim: 0, targetSpeed: 0 };
      return {
        seat: s?.seat ?? null,
        name: k.stats.name,
        kart: k.id,
        human: !!s,
        remote: !!s && s.inputs > 0 && performance.now() - s.at <= STALE_MS,
        place: k.place,
        lap: k.lap,
        finished: k.finished,
        finishTime: (race as any).prog?.[k.id]?.finishTime ?? 0,
        item: ITEM_NAMES[held.kind] ?? 'None',
        itemCount: held.count,
        speed: Math.round(k.forwardSpeed * 10) / 10,
        aim: Math.round(la.aim * 1000) / 1000,
        targetSpeed: Math.round(la.targetSpeed * 10) / 10,
        inputs: s?.inputs ?? 0,
        steer: s?.steer ?? 0,
        gas: s?.gas ?? 0,
        taps: s?.itemSent ?? 0,
      };
    });
    return {
      phase,
      raceTime: Math.round(race.raceTime * 100) / 100,
      laps: race.totalLaps,
      karts: race.karts.length,
      leaderKart: race.standings[0]?.id ?? 0,
      rows,
      order,
    };
  }

  const api = {
    ready: true,
    /** Assign seats to karts in order and start the countdown. Call once. */
    setRoster(roster: { seat: string; name: string }[]) {
      if (started) return;
      roster.slice(0, race.karts.length).forEach((r, i) => {
        const nm = String(r.name).replace(/\s+/g, ' ').trim().slice(0, 10) || `P${i + 1}`;
        const s: Seat = { seat: r.seat, name: nm, kart: i, steer: 0, gas: 0, itemSeen: 0, itemSent: 0, at: 0, inputs: 0 };
        seats.set(r.seat, s);
        byKart.set(i, s);
        race.karts[i].stats.name = nm;
      });
      started = true;
      race.start();
    },
    /** A phone input. Latest wins for steer and gas; item taps are counted so none is lost. */
    input(seat: string, d: Partial<PhoneInput>) {
      const s = seats.get(seat);
      if (!s || !d || typeof d !== 'object') return false;
      const st = Number(d.s), g = Number(d.g), i = Number(d.i);
      if (Number.isFinite(st)) s.steer = Math.max(-1, Math.min(1, st));
      if (Number.isFinite(g)) s.gas = Math.max(0, Math.min(1, g));
      if (Number.isFinite(i) && i > s.itemSent && i - s.itemSent < 50) s.itemSent = Math.floor(i);
      s.at = performance.now();
      s.inputs++;
      return true;
    },
    kartOf(seat: string): number | null {
      return seats.get(seat)?.kart ?? null;
    },
    /** Ordered result list for the lobby. */
    results() {
      const snap = snapshot();
      const prog = (race as any).prog as { finishOrder: number; finishTime: number }[];
      return snap.order.map((id, idx) => ({
        place: idx + 1,
        kart: id,
        seat: byKart.get(id)?.seat ?? null,
        name: race.karts[id].stats.name,
        human: byKart.has(id),
        finished: race.karts[id].finished,
        time: race.karts[id].finished ? Math.round(prog[id].finishTime * 100) / 100 : null,
      }));
    },
    forced: () => forced,
    snapshot,
  };
  (window as any).__party = api;
  console.info('[party] adapter installed; karts', race.karts.length);
}
