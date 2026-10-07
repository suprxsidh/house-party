import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';

// Server part: counts pings per player and tells that phone, privately.
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  const pings = new Map<string, number>();
  return {
    onStart(c) {
      ctx = c;
      ctx.toTv('started', { players: ctx.players().length });
    },
    onPhoneMessage(playerId, type) {
      if (type !== 'ping') return;
      const n = (pings.get(playerId) ?? 0) + 1;
      pings.set(playerId, n);
      ctx.toPhone(playerId, 'pong', { n });
    },
    onPlayerConnected(playerId) {
      ctx.toPhone(playerId, 'pong', { n: pings.get(playerId) ?? 0 });
    },
  };
});
