// Pure market logic. No sockets. Integer chips. Total chips never change.

export const START_CHIPS = 1000;
export const MAX_TEXT = 120;
export const MAX_OPEN_BETS = 30;
export const KEEP_RESOLVED = 20;

export type Side = 'yes' | 'no';
export type MarketErrorCode = 'BAD_REQUEST' | 'NOT_LEADER' | 'NO_BET' | 'CLOSED' | 'NO_CHIPS' | 'TOO_MANY';
export class MarketError extends Error {
  constructor(
    public code: MarketErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Bet {
  id: string;
  text: string;
  by: string;
  open: boolean;
  outcome: Side | null;
  yes: Map<string, number>; // playerId -> chips staked
  no: Map<string, number>;
  payouts: Map<string, number>; // set on resolve: chips handed back (stake + winnings)
}

/** Plain text only. Renderers must use textContent. */
export function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT).trim();
  return t.length ? t : null;
}

const sum = (m: Map<string, number>) => {
  let t = 0;
  for (const v of m.values()) t += v;
  return t;
};
const idNum = (id: string) => Number(id.replace(/\D/g, '')) || 0;

/**
 * Split pools. Winners get stake back plus a share of the losing pool, in proportion to stake.
 * Floors first; the leftover chips go one each to the largest fractional remainders
 * (tie: lower player number). If a side is empty, everybody gets the stake back.
 */
export function payouts(yes: Map<string, number>, no: Map<string, number>, outcome: Side): Map<string, number> {
  const win = outcome === 'yes' ? yes : no;
  const lose = outcome === 'yes' ? no : yes;
  const W = sum(win);
  const L = sum(lose);
  const out = new Map<string, number>();
  const add = (id: string, n: number) => out.set(id, (out.get(id) ?? 0) + n);
  if (W === 0 || L === 0) {
    for (const [id, n] of yes) add(id, n);
    for (const [id, n] of no) add(id, n);
    return out;
  }
  const rows = [...win].map(([id, stake]) => ({ id, stake, share: Math.floor((stake * L) / W), rem: (stake * L) % W }));
  let left = L - rows.reduce((a, r) => a + r.share, 0);
  rows.sort((a, b) => b.rem - a.rem || idNum(a.id) - idNum(b.id));
  for (const r of rows) {
    if (left > 0 && r.rem > 0) {
      r.share += 1;
      left -= 1;
    }
  }
  // left is now 0: sum of remainders is a multiple of W, and each r.rem < W, so enough rows exist.
  for (const r of rows) add(r.id, r.stake + r.share);
  return out;
}

export class Market {
  balances = new Map<string, number>();
  bets: Bet[] = [];
  private seq = 0;

  constructor(public leaderId: () => string | null) {}

  ensure(playerId: string) {
    if (!this.balances.has(playerId)) this.balances.set(playerId, START_CHIPS);
  }
  balance(playerId: string) {
    return this.balances.get(playerId) ?? 0;
  }

  propose(by: string, rawText: unknown): Bet {
    this.ensure(by);
    const text = cleanText(rawText);
    if (!text) throw new MarketError('BAD_REQUEST', 'Write the bet as a question.');
    if (this.bets.filter((b) => b.open).length >= MAX_OPEN_BETS) throw new MarketError('TOO_MANY', 'Too many open bets. Ask the leader to resolve some.');
    const bet: Bet = { id: `b${++this.seq}`, text, by, open: true, outcome: null, yes: new Map(), no: new Map(), payouts: new Map() };
    this.bets.push(bet);
    return bet;
  }

  buy(playerId: string, betId: unknown, side: unknown, amount: unknown): Bet {
    this.ensure(playerId);
    if (side !== 'yes' && side !== 'no') throw new MarketError('BAD_REQUEST', 'Pick YES or NO.');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) throw new MarketError('BAD_REQUEST', 'Amount must be a whole number, 1 or more.');
    const bet = this.bets.find((b) => b.id === betId);
    if (!bet) throw new MarketError('NO_BET', 'No such bet.');
    if (!bet.open) throw new MarketError('CLOSED', 'That bet is resolved.');
    if (amount > this.balance(playerId)) throw new MarketError('NO_CHIPS', `You only have ${this.balance(playerId)} chips.`);
    this.balances.set(playerId, this.balance(playerId) - amount);
    const pool = side === 'yes' ? bet.yes : bet.no;
    pool.set(playerId, (pool.get(playerId) ?? 0) + amount);
    return bet;
  }

  resolve(playerId: string, betId: unknown, outcome: unknown): Bet {
    if (this.leaderId() === null || playerId !== this.leaderId()) throw new MarketError('NOT_LEADER', 'Only the leader can resolve bets.');
    if (outcome !== 'yes' && outcome !== 'no') throw new MarketError('BAD_REQUEST', 'Resolve as YES or NO.');
    const bet = this.bets.find((b) => b.id === betId);
    if (!bet) throw new MarketError('NO_BET', 'No such bet.');
    if (!bet.open) throw new MarketError('CLOSED', 'That bet is already resolved.');
    bet.payouts = payouts(bet.yes, bet.no, outcome);
    for (const [id, n] of bet.payouts) this.balances.set(id, this.balance(id) + n);
    bet.open = false;
    bet.outcome = outcome;
    // Drop old resolved bets (their chips already sit in balances).
    const resolved = this.bets.filter((b) => !b.open);
    if (resolved.length > KEEP_RESOLVED) {
      const drop = new Set(resolved.slice(0, resolved.length - KEEP_RESOLVED));
      this.bets = this.bets.filter((b) => !drop.has(b));
    }
    return bet;
  }

  /** Chips in balances plus chips locked in open bets. Must equal START_CHIPS * accounts. */
  totalChips(): number {
    let t = 0;
    for (const v of this.balances.values()) t += v;
    for (const b of this.bets) if (b.open) t += sum(b.yes) + sum(b.no);
    return t;
  }

  locked(playerId: string): number {
    let t = 0;
    for (const b of this.bets) if (b.open) t += (b.yes.get(playerId) ?? 0) + (b.no.get(playerId) ?? 0);
    return t;
  }
}

export { sum as poolSum };
