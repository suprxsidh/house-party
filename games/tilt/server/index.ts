import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { cleanTilt, layoutHoles, sumTilts, type Vec2 } from '../physics.ts';

const POINTS = 10;
const COUNTDOWN_MS = 3000;
const TICK_MS = 40;
const MIN_FALL_GAP_MS = 300;

// Server part. Owns the secret goal holes, the tilt sum, the clock and the score.
// The TV gets hole positions and the board tilt only. It never gets who wants which hole.
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  let holes: { x: number; z: number }[] = [];
  const goal = new Map<string, number>();
  const score = new Map<string, number>();
  const tilts = new Map<string, Vec2 & { at: number }>();
  let startsAt = 0;
  let endsAt = 0;
  let over = false;
  let lastFall = 0;
  let timer: NodeJS.Timeout | undefined;
  let lastBoard = { x: NaN, z: NaN };

  // A tilt older than this is dropped (phone gone or frozen). Phones resend every 500 ms while tilted.
  const staleMs = () => Number(process.env.HP_TILT_STALE_MS) || 2000;
  const roundMs = () => Math.max(500, Number(process.env.HP_TILT_ROUND_MS) || 60000);
  const countdownMs = () => (process.env.HP_TILT_COUNTDOWN_MS !== undefined ? Number(process.env.HP_TILT_COUNTDOWN_MS) : COUNTDOWN_MS);

  const roundInfo = () => ({ startsAt, endsAt, now: Date.now(), over });
  const layoutMsg = () => ({ holes, ...roundInfo() });

  function assign(id: string): number {
    const have = goal.get(id);
    if (have !== undefined) return have;
    // Least-used hole first, so goals spread out. Ties are random.
    const use = holes.map(() => 0);
    for (const h of goal.values()) use[h]++;
    const min = Math.min(...use);
    const pool = use.flatMap((u, i) => (u === min ? [i] : []));
    const h = pool[Math.floor(Math.random() * pool.length)];
    goal.set(id, h);
    score.set(id, 0);
    return h;
  }

  function sendGoal(id: string) {
    const h = assign(id);
    ctx.toPhone(id, 'goal', { hole: h, holes, points: score.get(id) ?? 0, ...roundInfo() });
  }

  function results() {
    return ctx.players().map((p) => ({ id: p.id, name: p.name, points: score.get(p.id) ?? 0 })).sort((a, b) => b.points - a.points);
  }

  function finish() {
    if (over) return;
    over = true;
    clearInterval(timer);
    const r = results();
    ctx.toTv('results', { scores: r });
    ctx.toPhones('results', { scores: r });
  }

  function tick() {
    const now = Date.now();
    if (now >= endsAt) return finish();
    const fresh: Vec2[] = [];
    for (const [id, t] of tilts) {
      if (now - t.at > staleMs()) tilts.delete(id);
      else fresh.push(t);
    }
    const board = sumTilts(fresh);
    if (board.x !== lastBoard.x || board.z !== lastBoard.z) {
      lastBoard = board;
      ctx.toTv('board', board);
    }
  }

  return {
    onStart(c) {
      ctx = c;
      const players = ctx.players();
      holes = layoutHoles((Math.random() * 2 ** 31) | 0, Math.max(8, players.length + 2));
      startsAt = Date.now() + countdownMs();
      endsAt = startsAt + roundMs();
      // Everyone gets a goal, spread over distinct holes where possible.
      for (const p of players) assign(p.id);
      ctx.toTv('layout', layoutMsg());
      for (const p of players) sendGoal(p.id);
      timer = setInterval(tick, TICK_MS);
      timer.unref?.();
    },
    onPhoneMessage(playerId, type, data) {
      if (type !== 'tilt' || over) return;
      if (!ctx.players().some((p) => p.id === playerId)) return;
      const t = cleanTilt(data);
      if (t) tilts.set(playerId, { ...t, at: Date.now() }); // last value wins per player; nothing is dropped
    },
    onTvMessage(type, data) {
      if (type === 'ready') {
        // TV (re)loaded: send everything it needs again.
        ctx.toTv('layout', layoutMsg());
        if (over) ctx.toTv('results', { scores: results() });
        lastBoard = { x: NaN, z: NaN };
        return;
      }
      if (type !== 'fell' || over) return;
      const now = Date.now();
      const hole = (data as { hole?: unknown } | null)?.hole;
      if (now < startsAt || now >= endsAt) return;
      if (typeof hole !== 'number' || !Number.isInteger(hole) || hole < 0 || hole >= holes.length) return;
      if (now - lastFall < MIN_FALL_GAP_MS) return;
      lastFall = now;
      for (const [id, g] of goal) {
        if (g !== hole) continue;
        score.set(id, (score.get(id) ?? 0) + POINTS);
        ctx.toPhone(id, 'score', { points: score.get(id) });
      }
      ctx.toTv('scored', { hole });
      ctx.toPhones('fell', { hole });
    },
    onPlayerConnected(playerId) {
      // Rejoin keeps the same hole and score. A new late joiner gets a goal now.
      sendGoal(playerId);
      if (over) ctx.toPhone(playerId, 'results', { scores: results() });
    },
    onEnd() {
      clearInterval(timer);
    },
  };
});
