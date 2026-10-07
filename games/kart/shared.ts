// Messages for the kart game. Phone -> TV: hello, input. TV -> phones: assign, race.
// TV -> server -> phones: results.
export const MIN_KARTS = 4; // AI fills up to this many karts when fewer humans play
export const MAX_KARTS = 10;

export interface InputMsg { s: number; g: number; i: number }
export interface AssignMsg { kart: number | null; name: string; color: string; humans: number }
export interface RaceMsg {
  phase: 'wait' | 'countdown' | 'racing' | 'finished' | 'results';
  raceTime: number;
  laps: number;
  rows: { seat: string | null; place: number; lap: number; finished: boolean; item: string; itemCount: number }[];
}
export interface ResultRow { place: number; seat: string | null; name: string; human: boolean; finished: boolean; time: number | null }

/** Kart colours as CSS hex, same order as ROSTER in kart/src/game/Race.ts. */
export const KART_COLORS = ['#ff3b5c', '#2ea8ff', '#ffd23f', '#4ade5a', '#8b5cf6', '#ff8a3d', '#7ee8fa', '#e8456b', '#f472b6', '#e5e7eb'];
