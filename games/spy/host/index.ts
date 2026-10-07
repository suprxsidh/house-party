import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { ARREST_RANGE, CROWD_SIZE, MAX_PLAYERS, ME_HZ, MSG, type ActMsg, type EndMsg, type MeMsg, type ResultMsg, type RoundMsg } from '../types.ts';
import { cleanMove, collide, mulberry32, moveHuman, nearest, newBot, randomPoint, stepBot, type BotState, type MoveInput, type Rng } from '../crowd.ts';
import { buildScene, randomColor, type PlazaScene } from './scene.ts';
import { buildHud, type Hud } from './hud.ts';

// The platform rewrites the URL to ?room=CODE once the room exists, so read flags now, at load.
const ORIGINAL_SEARCH = location.search;
const FALL_S = 0.6;
const INPUT_STALE_MS = 600; // a phone that stops sending stops walking
const PRESS_GAP_MS = 150;
const END_SCREEN_MS = 12_000;

interface Walker {
  id: string;
  human: boolean;
  x: number;
  z: number;
  color: number;
  yaw: number;
  fallen: boolean;
  fall: number; // 0 standing .. 1 flat
  input: MoveInput;
  inputAt: number;
  pressAt: number;
  bot?: BotState;
}

// TV part. The TV moves the walkers and runs the bots. It never knows a role:
// the server sends roles only in spy:end, and the TV shows them at once and keeps nothing.
registerHost(info, (): TvGame => {
  const q = new URLSearchParams(ORIGINAL_SEARCH);
  const low = q.get('quality') === 'low';
  const endMs = Number(q.get('endms')) > 0 ? Number(q.get('endms')) : END_SCREEN_MS;
  let rng: Rng = Math.random;
  if (q.get('seed')) rng = mulberry32(Number(q.get('seed')) || 1);

  let plaza: PlazaScene | undefined;
  let hud: Hud;
  let raf = 0;
  let meTimer: ReturnType<typeof setInterval> | undefined;
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let onResize: (() => void) | undefined;
  let toPhone: (id: string, type: string, data?: unknown) => void = () => {};
  let toServer: (type: string, data?: unknown) => void = () => {};

  let walkers: Walker[] = [];
  const byId = new Map<string, Walker>();
  let round: { n: number; rounds: number; startsAt: number; endsAt: number } | null = null;
  let skew = 0;
  let over = true;
  let lastSeq = 0;
  let alive: number | null = null;
  let ended = false;
  let frames = 0;
  let fps = 0;
  const out: { to: string; type: string; data: unknown }[] = []; // test log of what the TV sent
  const log = (to: string, type: string, data: unknown) => {
    out.push({ to, type, data });
    if (out.length > 300) out.shift();
  };

  const serverNow = () => Date.now() + skew;
  const playing = () => !!round && !over && serverNow() >= round.startsAt;

  function makeWalker(id: string, human: boolean): Walker {
    const p = randomPoint(rng);
    return { id, human, x: p.x, z: p.z, color: randomColor(rng), yaw: rng() * Math.PI * 2, fallen: false, fall: 0, input: { x: 0, y: 0 }, inputAt: 0, pressAt: 0, bot: human ? undefined : newBot(rng) };
  }

  function startRound(d: Partial<RoundMsg>) {
    const ids = Array.isArray(d.playerIds) ? [...new Set(d.playerIds.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 40))].slice(0, MAX_PLAYERS) : [];
    if (![d.round, d.rounds, d.startsAt, d.endsAt, d.now].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const same = round && round.n === d.round && round.startsAt === d.startsAt;
    skew = d.now! - Date.now();
    over = !!d.over;
    if (same) {
      round!.endsAt = d.endsAt!;
      return; // a resend (TV reload on the server side): keep walkers where they are
    }
    round = { n: d.round!, rounds: d.rounds!, startsAt: d.startsAt!, endsAt: d.endsAt! };
    clearTimeout(endTimer);
    ended = false;
    lastSeq = 0;
    hud.hideEnd();
    walkers = [];
    byId.clear();
    for (const id of ids) walkers.push(makeWalker(id, true));
    for (let i = 0; walkers.length < CROWD_SIZE; i++) walkers.push(makeWalker(`bot-${i}`, false));
    for (const w of walkers) byId.set(w.id, w);
    alive = ids.length;
    hud.setRound(`Round ${round.n} of ${round.rounds}`);
    hud.setAlive(alive);
    hud.setStatus('');
  }

  function onResult(d: Partial<ResultMsg>) {
    if (typeof d.seq !== 'number' || d.seq <= lastSeq) return; // duplicate or old
    lastSeq = d.seq;
    const outIds = Array.isArray(d.out) ? d.out.filter((s): s is string => typeof s === 'string') : [];
    for (const id of outIds) {
      const w = byId.get(id);
      if (w) w.fallen = true;
    }
    if (typeof d.alive === 'number' && Number.isFinite(d.alive)) {
      alive = d.alive;
      hud.setAlive(alive);
    }
    const tname = typeof d.targetName === 'string' ? d.targetName : '';
    // Never name or mark the killer or the arrester. A kill names the victim only.
    if (d.kind === 'kill' && outIds.length) hud.feed(`${tname || 'Someone'} was stabbed`, 'kill');
    else if (d.kind === 'arrest-ok') hud.feed('An arrest was made: assassin caught!', 'arrest-ok');
    else if (d.kind === 'arrest-wrong') hud.feed(tname ? `Wrong arrest: ${tname} is innocent` : 'Wrong arrest', 'arrest-wrong');
  }

  function onEnd(d: Partial<EndMsg>) {
    if (ended || !Array.isArray(d.scores)) return;
    ended = true;
    over = true;
    hud.showEnd(d as EndMsg);
    hud.setTime('Time!');
    const n = d.round ?? round?.n ?? 0;
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      toServer(MSG.next, { round: n });
      log('server', MSG.next, { round: n });
    }, endMs);
  }

  function onPress(from: string) {
    const me = byId.get(from);
    if (!me || !me.human || me.fallen || !playing()) return;
    const t = performance.now();
    if (t - me.pressAt < PRESS_GAP_MS) return;
    me.pressAt = t;
    const hit = nearest(walkers, me, ARREST_RANGE, (c) => c.fallen);
    if (!hit) return; // nothing in range: nothing to resolve
    const msg: ActMsg = { actor: me.id, target: hit.target.id, dist: Math.round(hit.dist * 1000) / 1000 };
    toServer(MSG.act, msg);
    log('server', MSG.act, msg);
  }

  function update(dt: number, nowMs: number) {
    const go = playing();
    for (const w of walkers) {
      if (w.fallen) {
        w.fall = Math.min(1, w.fall + dt / FALL_S);
        continue;
      }
      if (w.bot) {
        if (!over) stepBot(w, w.bot, dt, rng);
      } else if (go && nowMs - w.inputAt < INPUT_STALE_MS) {
        moveHuman(w, w.input, dt, collide);
      }
    }
  }

  function updateTime() {
    if (!round) return;
    const t = serverNow();
    if (over) return;
    if (t < round.startsAt) hud.setTime(`Starts in ${Math.ceil((round.startsAt - t) / 1000)}`);
    else {
      const s = Math.max(0, Math.ceil((round.endsAt - t) / 1000));
      hud.setTime(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }
  }

  // Server messages arrive here with playerId 'server'. Phones cannot fake them.
  function handle(from: string, type: string, data: unknown) {
    const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
    if (type === MSG.round || type === MSG.result || type === MSG.end) {
      if (from !== 'server') return;
      if (type === MSG.round) startRound(d as Partial<RoundMsg>);
      else if (type === MSG.result) onResult(d as Partial<ResultMsg>);
      else onEnd(d as Partial<EndMsg>);
    } else if (type === MSG.move) {
      const w = byId.get(from);
      if (!w || !w.human || w.fallen) return; // unknown sender, a bot id, or out
      const m = cleanMove(data);
      if (!m) return;
      w.input = m;
      w.inputAt = performance.now();
    } else if (type === MSG.act) {
      if (from === 'server') return;
      onPress(from);
    }
  }

  return {
    mount(ctx) {
      toPhone = ctx.toPhone;
      toServer = ctx.toServer;
      const root = ctx.root;
      root.textContent = '';
      root.style.position = 'relative';
      plaza = buildScene(root, low);
      hud = buildHud();
      root.append(hud.el);
      hud.setStatus('Waiting for the round...');

      onResize = () => plaza!.resize(root.clientWidth || innerWidth, root.clientHeight || innerHeight);
      addEventListener('resize', onResize);
      onResize();

      let last = performance.now();
      let fpsFrom = last;
      let fpsFrames = 0;
      const t0 = last;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        update(dt, now);
        updateTime();
        hud.tick(Date.now());
        plaza!.draw(walkers, (now - t0) / 1000);
        frames++;
        fpsFrames++;
        if (now - fpsFrom >= 1000) {
          fps = (fpsFrames * 1000) / (now - fpsFrom);
          fpsFrames = 0;
          fpsFrom = now;
        }
      };
      raf = requestAnimationFrame(frame);

      // Each phone sees only its own position.
      meTimer = setInterval(() => {
        for (const w of walkers) {
          if (!w.human) continue;
          const m: MeMsg = { x: Math.round(w.x * 100) / 100, z: Math.round(w.z * 100) / 100 };
          toPhone(w.id, MSG.me, m);
          log(w.id, MSG.me, m);
        }
      }, 1000 / ME_HZ);

      // Test hooks. Positions only; there is no role anywhere in this object.
      const api = {
        get walkers() {
          return walkers.map((w) => ({ id: w.id, human: w.human, x: w.x, z: w.z, fallen: w.fallen, fall: w.fall }));
        },
        get fps() { return fps; },
        get frames() { return frames; },
        get alive() { return alive; },
        get over() { return over; },
        get feed() { return hud.feedLines(); },
        get sent() { return out; },
        /** Longest time (s) any bot went without real movement, pauses included. */
        get maxStillS() { return Math.max(0, ...walkers.filter((w) => w.bot).map((w) => w.bot!.maxStillS)); },
        /** Ids of bots that have been still longer than `s` seconds right now. */
        stuckBots: (s = 10) => walkers.filter((w) => w.bot && w.bot.stillS >= s).map((w) => w.id),
        get repicks() { return walkers.reduce((a, w) => a + (w.bot?.repicks ?? 0), 0); },
        /** Test only: put a walker at a spot. */
        place: (id: string, x: number, z: number) => {
          const w = byId.get(id);
          if (w) {
            w.x = x;
            w.z = z;
          }
        },
        /** Feed a message to the TV as if it came from `from` (the browser test plays server and phones). */
        inject: (from: string, type: string, data: unknown) => handle(from, type, data),
      };
      (window as unknown as { __spy: typeof api }).__spy = api;
    },

    onPhoneMessage(from, type, data) {
      handle(from, type, data);
    },

    destroy() {
      cancelAnimationFrame(raf);
      clearInterval(meTimer);
      clearTimeout(endTimer);
      if (onResize) removeEventListener('resize', onResize);
      plaza?.dispose();
      hud?.el.remove();
      delete (window as unknown as { __spy?: unknown }).__spy;
    },
  };
});
