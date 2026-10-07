// Shared constants and helpers for the three sides of Block Pictionary.
export const SHAPES = ['cube', 'sphere', 'cylinder'] as const;
export type Shape = (typeof SHAPES)[number];
export const COLORS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#6d4c41', '#f5f5f5', '#212121'] as const;
export const GRID_W = 8; // columns (x)
export const GRID_H = 8; // rows (y, 0 = ground)
export const GRID_D = 3; // depth layers (z): back, middle, front
export const SIZES = [1, 2] as const; // fixed size menu, in grid cells
export const MAX_ITEMS = 80;
export const MAX_GUESS_LEN = 40;

export interface Item {
  shape: Shape;
  color: string;
  x: number;
  y: number;
  z: number;
  size: 1 | 2;
}

export interface Score {
  id: string;
  name: string;
  score: number;
}

/** What phones and the TV get about the round. Never has the word until `word` is set at reveal. */
export interface RoundState {
  phase: 'drawing' | 'reveal' | 'final';
  round: number; // 1-based
  rounds: number;
  drawerId: string | null;
  drawerName: string;
  hint: string; // letter blanks, e.g. "_ _ _ _ _"
  endsInMs: number;
  scores: Score[];
  word?: string; // only at reveal/final
  winnerId?: string | null;
  winnerName?: string;
}

/** Case, space and punctuation insensitive form used for guess matching. */
export const normalize = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export const hintFor = (word: string) =>
  word
    .split(' ')
    .map((w) => '_'.repeat(w.length).split('').join(' '))
    .join('   ');
