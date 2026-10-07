import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { Market, MarketError, poolSum, type Bet } from './engine.ts';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const SHOW_RESOLVED = 5;
const TOP = 5;

// Always-on layer: starts with the room, runs next to any game. State lives in server memory.
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  let market: Market;

  const nameOf = (id: string) => ctx.players().find((p) => p.id === id)?.name ?? id;

  /** Public view. Safe for the TV: pools and net worth only, no one's positions. */
  const publicView = () => {
    const viewBet = (b: Bet) => {
      const yesPool = poolSum(b.yes);
      const noPool = poolSum(b.no);
      const total = yesPool + noPool;
      return {
        id: b.id,
        text: b.text,
        by: b.by,
        byName: nameOf(b.by),
        open: b.open,
        outcome: b.outcome,
        yesPool,
        noPool,
        yesPct: total ? Math.round((100 * yesPool) / total) : 50,
        traders: new Set([...b.yes.keys(), ...b.no.keys()]).size,
      };
    };
    const open = market.bets.filter((b) => b.open).map(viewBet);
    const resolved = market.bets.filter((b) => !b.open).slice(-SHOW_RESOLVED).reverse().map(viewBet);
    const traders = ctx
      .players()
      .map((p) => ({ id: p.id, name: p.name, worth: market.balance(p.id) + market.locked(p.id) }))
      .sort((a, b) => b.worth - a.worth || a.id.localeCompare(b.id, undefined, { numeric: true }))
      .slice(0, TOP);
    return { leaderId: ctx.leaderId(), bets: [...open, ...resolved], traders };
  };

  /** Private view: only this phone gets it. */
  const meView = (id: string) => {
    const positions: Record<string, { yes: number; no: number; payout?: number }> = {};
    for (const b of market.bets) {
      const yes = b.yes.get(id) ?? 0;
      const no = b.no.get(id) ?? 0;
      if (yes || no) positions[b.id] = { yes, no, ...(b.open ? {} : { payout: b.payouts.get(id) ?? 0 }) };
    }
    return { balance: market.balance(id), locked: market.locked(id), positions };
  };

  const sendTv = () => ctx.toTv('market:state', publicView());
  const sendPhone = (id: string, pub = publicView()) => ctx.toPhone(id, 'market:state', { ...pub, me: meView(id) });
  const sendAll = () => {
    const pub = publicView();
    ctx.toTv('market:state', pub);
    for (const p of ctx.players()) sendPhone(p.id, pub);
  };

  return {
    onStart(c) {
      ctx = c;
      market = new Market(() => ctx.leaderId());
    },
    onPhoneMessage(playerId, type, data) {
      if (!ctx.players().some((p) => p.id === playerId)) return;
      market.ensure(playerId);
      const d = isObj(data) ? data : {};
      try {
        switch (type) {
          case 'market:sync':
            return sendPhone(playerId);
          case 'market:propose':
            market.propose(playerId, d.text);
            break;
          case 'market:buy':
            market.buy(playerId, d.betId, d.side, d.amount);
            break;
          case 'market:resolve':
            market.resolve(playerId, d.betId, d.outcome);
            break;
          default:
            return;
        }
        sendAll();
      } catch (e) {
        if (!(e instanceof MarketError)) throw e;
        ctx.toPhone(playerId, 'market:error', { code: e.code, message: e.message });
      }
    },
    onPlayerConnected(playerId) {
      market.ensure(playerId);
      sendAll(); // new name shows on the TV board; this phone gets its state
    },
    onTvConnected() {
      sendAll();
    },
  };
});
