// Pure rules engine for Spy in the Crowd. No I/O, no timers, no clock reads: callers pass `now`.
// Spec: docs/specs/2026-10-07-spy-in-crowd-design.md
import {
  ARRESTS_PER_ROUND,
  ARREST_RANGE,
  POINTS,
  STAB_BOT_COOLDOWN_MS,
  STAB_COOLDOWN_MS,
  STAB_RANGE,
  assassinCount,
  botCount,
  type EndMsg,
  type PlayerScore,
  type ResultMsg,
  type Role,
} from './types.ts';

export interface PlayerState {
  id: string;
  name: string;
  role: Role;
  out: boolean;
  /** Epoch ms when ACT works again. */
  cooldownUntil: number;
  arrestsLeft: number;
  /** Points won in this round so far. */
  points: number;
}

export interface Round {
  n: number;
  startsAt: number;
  endsAt: number;
  players: Map<string, PlayerState>;
  botCount: number;
  seq: number;
  /** Names of assassins arrested and of wrong arresters (for the drinks list). */
  caught: string[];
  wrongArresters: string[];
  over: boolean;
}

export type EndReason = EndMsg['reason'];

/** Pick `count` assassins, preferring players with the fewest turns so far. Ties are random. */
export function pickAssassins(ids: string[], history: Record<string, number>, count: number, rng: () => number = Math.random): string[] {
  const pool = ids.map((id) => ({ id, turns: history[id] ?? 0, r: rng() })).sort((a, b) => a.turns - b.turns || a.r - b.r);
  return pool.slice(0, Math.min(count, ids.length)).map((p) => p.id);
}

export function assignRoles(ids: string[], history: Record<string, number>, rng: () => number = Math.random): Map<string, Role> {
  // Always leave one civilian when there are 2 or more players.
  const count = Math.min(assassinCount(ids.length), Math.max(1, ids.length - 1));
  const picked = new Set(pickAssassins(ids, history, count, rng));
  return new Map(ids.map((id) => [id, picked.has(id) ? 'assassin' : 'civilian'] as [string, Role]));
}

export function newRound(o: {
  n: number;
  players: { id: string; name: string }[];
  history: Record<string, number>;
  startsAt: number;
  endsAt: number;
  rng?: () => number;
  /** Fixed roles (tests). */
  roles?: Record<string, Role>;
}): Round {
  const roles = o.roles ? new Map(Object.entries(o.roles)) : assignRoles(o.players.map((p) => p.id), o.history, o.rng);
  const players = new Map<string, PlayerState>();
  for (const p of o.players) {
    players.set(p.id, { id: p.id, name: p.name, role: roles.get(p.id) ?? 'civilian', out: false, cooldownUntil: 0, arrestsLeft: ARRESTS_PER_ROUND, points: 0 });
  }
  return { n: o.n, startsAt: o.startsAt, endsAt: o.endsAt, players, botCount: botCount(o.players.length), seq: 0, caught: [], wrongArresters: [], over: false };
}

export const cooldownLeft = (p: PlayerState, now: number) => Math.max(0, p.cooldownUntil - now);
export const aliveCount = (r: Round) => [...r.players.values()].filter((p) => !p.out).length;

/** True if `id` is a crowd bot id ("bot-N", N a small whole number within this round's crowd). */
function isBotId(r: Round, id: string): boolean {
  const m = /^bot-(\d{1,3})$/.exec(id);
  return !!m && Number(m[1]) <= r.botCount;
}

export interface ActOutcome {
  result: ResultMsg;
}

/**
 * Resolve one ACT from the TV. Returns null when the press is ignored (bad input, out player,
 * cooldown, no arrests left, round not running). Otherwise returns the result to broadcast.
 * `dist` (metres, optional): over the range for the role means a miss.
 */
export function act(r: Round, actorId: unknown, targetId: unknown, now: number, dist?: unknown): ActOutcome | null {
  if (r.over || now < r.startsAt || now >= r.endsAt) return null;
  if (typeof actorId !== 'string' || typeof targetId !== 'string') return null;
  const actor = r.players.get(actorId);
  if (!actor || actor.out || actorId === targetId) return null;
  if (dist !== undefined && (typeof dist !== 'number' || !Number.isFinite(dist) || dist < 0)) return null;
  const target = r.players.get(targetId);
  if (!target && !isBotId(r, targetId)) return null;

  const stab = actor.role === 'assassin';
  if (stab ? now < actor.cooldownUntil : actor.arrestsLeft <= 0) return null;

  const make = (kind: ResultMsg['kind'], out: string[]): ActOutcome => ({
    result: {
      kind,
      actor: actor.id,
      target: targetId,
      actorName: actor.name,
      targetName: target?.name ?? '',
      out,
      alive: aliveCount(r),
      seq: ++r.seq,
    },
  });

  // Too far: a miss. No cost to the actor (the TV picked the target; distance is a safety check).
  if (dist !== undefined && dist > (stab ? STAB_RANGE : ARREST_RANGE)) return make('miss', []);

  if (stab) {
    if (!target) {
      actor.cooldownUntil = now + STAB_BOT_COOLDOWN_MS; // a bot is unharmed
      return make('miss', []);
    }
    actor.cooldownUntil = now + STAB_COOLDOWN_MS;
    if (target.out) return make('miss', []); // second kill on the same target: no points
    target.out = true;
    actor.points += POINTS.assassinKill;
    return make('kill', [target.id]);
  }

  // Civilian arrest.
  if (target?.out) return make('miss', []); // already out: nothing happens, arrest kept
  actor.arrestsLeft -= 1;
  if (target && target.role === 'assassin') {
    target.out = true;
    actor.points += POINTS.civilianArrestAssassin;
    r.caught.push(target.name);
    return make('arrest-ok', [target.id]);
  }
  // Bot or civilian: wasted, and the arrester loses points. An arrested civilian is out.
  actor.points += POINTS.civilianWrongArrest;
  r.wrongArresters.push(actor.name);
  if (target) target.out = true;
  return make('arrest-wrong', target ? [target.id] : []);
}

/** Why the round is over now, or null if it runs on. A group that never existed cannot end it. */
export function endReason(r: Round, now: number): EndReason | null {
  const all = [...r.players.values()];
  const assassins = all.filter((p) => p.role === 'assassin');
  const civilians = all.filter((p) => p.role === 'civilian');
  if (assassins.length > 0 && civilians.length > 0) {
    if (assassins.every((p) => p.out)) return 'assassins-caught';
    if (civilians.every((p) => p.out)) return 'civilians-out';
  }
  if (now >= r.endsAt) return 'timer';
  return null;
}

/** Close the round: add the alive bonuses and build the end message parts. Runs once. */
export function finishRound(r: Round, _reason: EndReason, o: { drinks: boolean; totals: Record<string, number> }): { scores: PlayerScore[]; drinkers: string[] } {
  if (!r.over) {
    r.over = true;
    for (const p of r.players.values()) if (!p.out) p.points += p.role === 'assassin' ? POINTS.assassinAlive : POINTS.civilianAlive;
  }
  const scores = [...r.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    points: p.points,
    total: (o.totals[p.id] ?? 0) + p.points,
    out: p.out,
  }));
  const drinkers = o.drinks ? [...new Set([...r.caught, ...r.wrongArresters])] : [];
  return { scores, drinkers };
}
