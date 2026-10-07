import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import type { ResultRow } from '../shared.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Clean the TV's result list: text only, bounded, numbers finite. */
export function cleanResults(raw: unknown): ResultRow[] | null {
  if (!isObj(raw) || !Array.isArray(raw.order)) return null;
  return raw.order.slice(0, 16).flatMap((r, i): ResultRow[] => {
    if (!isObj(r)) return [];
    return [{
      place: Number.isFinite(Number(r.place)) ? Math.floor(Number(r.place)) : i + 1,
      seat: typeof r.seat === 'string' ? r.seat.slice(0, 8) : null,
      name: String(r.name ?? '').slice(0, 30),
      human: r.human === true,
      finished: r.finished === true,
      time: Number.isFinite(Number(r.time)) && r.time !== null ? Number(r.time) : null,
    }];
  });
}

// The kart race runs on the TV. This part keeps the final results, so a phone that
// rejoins after the race still sees them, and relays them to every phone.
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  let results: ResultRow[] | null = null;
  return {
    onStart(c) {
      ctx = c;
    },
    onPhoneMessage() {
      // Phones talk to the TV directly. Nothing from a phone changes server state.
    },
    onTvMessage(type, data) {
      if (type !== 'results' || results) return; // first report wins
      const r = cleanResults(data);
      if (!r) return;
      results = r;
      ctx.toPhones('results', { order: r });
    },
    onPlayerConnected(playerId) {
      if (results) ctx.toPhone(playerId, 'results', { order: results });
    },
  };
});
