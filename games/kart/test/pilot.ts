// Test helper: bots act as phones. A "pilot" reads telemetry from the TV page
// (aim angle to the racing line, speed) and sends steer/gas through the real socket path.
import type { Page } from 'playwright';
import type { Bot } from '../../../bots/Bot.ts';

export interface Row {
  seat: string | null; kart: number; name: string; human: boolean; remote: boolean; place: number; lap: number;
  finished: boolean; finishTime: number; item: string; itemCount: number; speed: number; aim: number; targetSpeed: number; inputs: number; steer: number; gas: number; taps: number;
}
export interface Snap { phase: string; raceTime: number; laps: number; karts: number; leaderKart: number; rows: Row[]; order: number[] }

export const snapshot = (page: Page): Promise<Snap> => page.evaluate(() => (window as any).__kart.snapshot());
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export class Pilot {
  items = new Map<string, number>();
  paused = new Set<string>(); // seats the test silences (e.g. a dropped phone)
  sent = 0;
  constructor(public bots: Bot[]) {}
  /** One control tick: read telemetry, send one input per bot. Returns the snapshot. */
  async tick(page: Page, opts: { tapItemEvery?: number } = {}): Promise<Snap> {
    const snap = await snapshot(page);
    for (const r of snap.rows) {
      if (!r.seat || this.paused.has(r.seat)) continue;
      const bot = this.bots.find((b) => b.id === r.seat);
      if (!bot) continue;
      let i = this.items.get(r.seat) ?? 0;
      if (opts.tapItemEvery && r.itemCount > 0 && Math.random() < 1 / opts.tapItemEvery) {
        i++;
        this.items.set(r.seat, i);
      }
      const s = clamp(r.aim * 1.8, -1, 1);
      const g = r.speed < r.targetSpeed ? 1 : 0.15;
      bot.sendToTv('input', { s: Math.round(s * 100) / 100, g, i });
      this.sent++;
    }
    return snap;
  }
}
