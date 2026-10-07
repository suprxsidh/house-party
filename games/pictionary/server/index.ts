import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { WORDS } from './words.ts';
import {
  COLORS, GRID_D, GRID_H, GRID_W, MAX_GUESS_LEN, MAX_ITEMS, SHAPES,
  hintFor, normalize, type Item, type RoundState, type Score,
} from '../common.ts';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(+v) && +v > 0 ? +v : d);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function parseItem(d: unknown): Item | null {
  if (!isObj(d)) return null;
  const { shape, color, x, y, z, size } = d;
  if (!(SHAPES as readonly unknown[]).includes(shape)) return null;
  if (!(COLORS as readonly unknown[]).includes(color)) return null;
  if (!isInt(x, 0, GRID_W - 1) || !isInt(y, 0, GRID_H - 1) || !isInt(z, 0, GRID_D - 1)) return null;
  if (size !== 1 && size !== 2) return null;
  return { shape: shape as Item['shape'], color: color as string, x, y, z, size };
}

// Server part: owns the word, the scene, the guesses and the scores.
// The word goes only to the drawer's phone until the round ends.
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  const roundMs = num(process.env.HP_PICTIONARY_ROUND_MS, 90_000);
  const revealMs = num(process.env.HP_PICTIONARY_REVEAL_MS, 5_000);
  const scores = new Map<string, number>();
  const used = new Set<string>();
  let order: string[] = [];
  let rounds = 0;
  let round = 0;
  let phase: RoundState['phase'] = 'reveal';
  let drawerId: string | null = null;
  let word = '';
  let scene: Item[] = [];
  let endsAt = 0;
  let winnerId: string | null = null;
  let recent: { playerId: string; name: string; text: string }[] = [];
  let timer: NodeJS.Timeout | undefined;
  let ended = false;

  const nameOf = (id: string | null) => ctx.players().find((p) => p.id === id)?.name ?? '';
  const scoreList = (): Score[] =>
    ctx.players().map((p) => ({ id: p.id, name: p.name, score: scores.get(p.id) ?? 0 })).sort((a, b) => b.score - a.score);

  const stateMsg = (): RoundState => {
    const s: RoundState = {
      phase, round, rounds, drawerId, drawerName: nameOf(drawerId),
      hint: word ? hintFor(word) : '', endsInMs: Math.max(0, endsAt - Date.now()), scores: scoreList(),
    };
    if (phase !== 'drawing') {
      s.word = word;
      s.winnerId = winnerId;
      s.winnerName = nameOf(winnerId);
    }
    return s;
  };
  const sendScene = () => {
    ctx.toTv('scene', { items: scene });
    if (drawerId) ctx.toPhone(drawerId, 'scene', { items: scene });
  };
  const sendState = () => {
    ctx.toTv('state', stateMsg());
    ctx.toPhones('state', stateMsg());
    if (phase === 'drawing' && drawerId) ctx.toPhone(drawerId, 'secret', { word });
  };

  const pickWord = () => {
    let pool = WORDS.filter((w) => !used.has(w));
    if (!pool.length) {
      used.clear();
      pool = WORDS;
    }
    const w = pool[Math.floor(Math.random() * pool.length)];
    used.add(w);
    return w;
  };

  const startRound = () => {
    if (ended) return;
    if (round >= rounds) return finish();
    round++;
    const ids = ctx.players().map((p) => p.id);
    // Rotate through the original order, skipping anyone who left.
    let pick: string | undefined;
    for (let i = 0; i < order.length && !pick; i++) {
      const cand = order[(round - 1 + i) % order.length];
      if (ids.includes(cand)) pick = cand;
    }
    drawerId = pick ?? ids[0] ?? null;
    word = pickWord();
    scene = [];
    winnerId = null;
    recent = [];
    phase = 'drawing';
    endsAt = Date.now() + roundMs;
    clearTimeout(timer);
    timer = setTimeout(() => endRound(null, 0), roundMs);
    sendState();
    sendScene();
  };

  const endRound = (winner: string | null, points: number) => {
    if (phase !== 'drawing') return; // the one-winner guard: only the first call counts
    phase = 'reveal';
    winnerId = winner;
    endsAt = Date.now() + revealMs;
    clearTimeout(timer);
    if (winner && drawerId) {
      scores.set(winner, (scores.get(winner) ?? 0) + points);
      scores.set(drawerId, (scores.get(drawerId) ?? 0) + DRAWER_POINTS);
      const msg = { playerId: winner, name: nameOf(winner), points, drawerId, drawerPoints: DRAWER_POINTS, word };
      sendState();
      ctx.toTv('correct', msg);
      ctx.toPhones('correct', msg);
    } else sendState();
    timer = setTimeout(startRound, revealMs);
  };

  const finish = () => {
    phase = 'final';
    clearTimeout(timer);
    endsAt = Date.now();
    drawerId = null;
    sendState();
    const results = scoreList();
    ctx.toTv('final', { scores: results });
    ctx.toPhones('final', { scores: results });
  };

  const DRAWER_POINTS = 50;

  return {
    onStart(c) {
      ctx = c;
      order = ctx.players().map((p) => p.id);
      rounds = Math.floor(num(process.env.HP_PICTIONARY_ROUNDS, Math.min(Math.max(order.length, 2), 6)));
      for (const id of order) scores.set(id, 0);
      startRound();
    },
    onPhoneMessage(playerId, type, data) {
      // A phone page mounts after the game starts, so it asks for its state.
      if (type === 'ready') return this.onPlayerConnected!(playerId);
      if (phase !== 'drawing') return;
      if (type === 'place') {
        if (playerId !== drawerId || scene.length >= MAX_ITEMS) return;
        const item = parseItem(data);
        if (!item) return;
        scene.push(item);
        sendScene();
      } else if (type === 'undo') {
        if (playerId !== drawerId || !scene.length) return;
        scene.pop();
        sendScene();
      } else if (type === 'clear') {
        if (playerId !== drawerId || !scene.length) return;
        scene = [];
        sendScene();
      } else if (type === 'guess') {
        if (playerId === drawerId || !isObj(data) || typeof data.text !== 'string') return;
        const text = data.text.trim().slice(0, MAX_GUESS_LEN);
        if (!text) return;
        const g = normalize(text);
        if (g && g === normalize(word)) {
          const left = Math.max(0, endsAt - Date.now());
          endRound(playerId, 100 + Math.round((100 * left) / roundMs));
          return;
        }
        // Wrong guesses are shown on the TV. Hide any that spell out the word.
        const shown = g.includes(normalize(word)) ? '(too close!)' : text;
        const entry = { playerId, name: nameOf(playerId), text: shown };
        recent = [...recent.slice(-19), entry];
        ctx.toTv('guess', entry);
        ctx.toPhones('guess', entry);
      }
    },
    onTvMessage(type) {
      // A reloaded TV page asks for everything again.
      if (type !== 'tv-ready') return;
      ctx.toTv('state', stateMsg());
      ctx.toTv('scene', { items: scene });
      for (const g of recent) ctx.toTv('guess', g);
    },
    onPlayerConnected(playerId) {
      if (!ctx) return;
      if (!scores.has(playerId)) scores.set(playerId, 0);
      ctx.toPhone(playerId, 'state', stateMsg());
      if (phase === 'drawing' && playerId === drawerId) {
        ctx.toPhone(playerId, 'secret', { word });
        ctx.toPhone(playerId, 'scene', { items: scene });
      }
      if (phase === 'final') ctx.toPhone(playerId, 'final', { scores: scoreList() });
    },
    onEnd() {
      ended = true;
      clearTimeout(timer);
    },
  };
});
