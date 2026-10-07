// House Party: the seam between the kart race and phone controllers.
// Race.update asks a RemoteDriver for each kart's command before it falls back to the AI.
import type { IKart } from '../types';

export interface RemoteCmd {
  steer: number; // -1 left .. 1 right (screen-right positive, same as keyboard input)
  throttle: number; // 0..1
  brake: number; // 0..1
  drift: boolean;
  useItem: boolean; // true for exactly one frame per phone tap
}

export interface RemoteDriver {
  /** A command if a human drives this kart right now. Null hands the kart to the AI. */
  command(k: IKart): RemoteCmd | null;
  /** True if this kart belongs to a phone (even while it is stale and the AI fills in). */
  owns(k: IKart): boolean;
}

/** `?karts=N`: how many karts to build (humans, padded to 4 by AI). Default: all. */
export function partyKartCount(max: number): number {
  const v = Number(new URLSearchParams(location.search).get('karts'));
  return Number.isFinite(v) && v >= 1 ? Math.min(max, Math.floor(v)) : max;
}

/** `?laps=N` (test aid): shorten the race. */
export function partyLaps(def: number): number {
  const v = Number(new URLSearchParams(location.search).get('laps'));
  return Number.isFinite(v) && v >= 1 && v <= 9 ? Math.floor(v) : def;
}
