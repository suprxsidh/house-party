import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { MSG, ROLE_CARD_MS, ROUNDS, ROUND_MS, type EndMsg, type RoleMsg, type RoundMsg } from '../types.ts';
import { act, cooldownLeft, endReason, finishRound, newRound, type EndReason, type Round } from '../rules.ts';

const GAP_MS = 20_000; // pause on the round-end screen before the next round starts by itself

const envMs = (name: string, dflt: number, min = 0) => {
  const v = process.env[name];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : dflt;
};

// Server part. Owns the roles, every kill and arrest, cooldowns, timers and scores.
// The TV picks targets and sends them with spy:act. It never receives a role before spy:end.
// Only the TV may send spy:act and spy:next. A phone may send spy:drinks (leader only).
registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  let round: Round | null = null;
  let roundN = 0;
  let ended = false; // the current round is over and its spy:end was sent
  let matchOver = false;
  let drinks = false;
  let lastEnd: EndMsg | null = null;
  const history: Record<string, number> = {}; // assassin turns so far (rotation)
  const totals: Record<string, number> = {}; // points over finished rounds
  let endTimer: NodeJS.Timeout | undefined;
  let gapTimer: NodeJS.Timeout | undefined;

  const roundMs = () => envMs('HP_SPY_ROUND_MS', ROUND_MS, 200);
  const cardMs = () => envMs('HP_SPY_CARD_MS', ROLE_CARD_MS);
  const gapMs = () => envMs('HP_SPY_GAP_MS', GAP_MS);

  const roundMsg = (): RoundMsg => ({
    round: roundN,
    rounds: ROUNDS,
    startsAt: round?.startsAt ?? 0,
    endsAt: round?.endsAt ?? 0,
    now: Date.now(),
    playerIds: round ? [...round.players.keys()] : [],
    botCount: round?.botCount ?? 0,
    drinks,
    over: matchOver,
  });
  const sendRound = (id?: string) => {
    if (!round) return;
    if (id) ctx.toPhone(id, MSG.round, roundMsg());
    else {
      ctx.toTv(MSG.round, roundMsg());
      ctx.toPhones(MSG.round, roundMsg());
    }
  };

  function sendRole(id: string) {
    const p = round?.players.get(id);
    if (!round || !p) return;
    const msg: RoleMsg = {
      role: p.role,
      round: roundN,
      rounds: ROUNDS,
      cooldownMs: cooldownLeft(p, Date.now()),
      arrestsLeft: p.arrestsLeft,
      out: p.out,
      points: (totals[id] ?? 0) + (ended ? 0 : p.points),
    };
    ctx.toPhone(id, MSG.role, msg);
  }

  function startRound() {
    clearTimeout(gapTimer);
    clearTimeout(endTimer);
    roundN += 1;
    ended = false;
    const startsAt = Date.now() + cardMs();
    round = newRound({ n: roundN, players: ctx.players(), history, startsAt, endsAt: startsAt + roundMs() });
    for (const p of round.players.values()) if (p.role === 'assassin') history[p.id] = (history[p.id] ?? 0) + 1;
    sendRound();
    for (const id of round.players.keys()) sendRole(id);
    endTimer = setTimeout(() => finish('timer'), Math.max(0, round.endsAt - Date.now()));
    endTimer.unref?.();
  }

  function finish(reason: EndReason) {
    if (!round || ended) return;
    clearTimeout(endTimer);
    const { scores, drinkers } = finishRound(round, reason, { drinks, totals });
    for (const s of scores) totals[s.id] = s.total;
    ended = true;
    matchOver = roundN >= ROUNDS;
    lastEnd = { round: roundN, rounds: ROUNDS, reason, scores, drinkers, final: matchOver };
    ctx.toTv(MSG.end, lastEnd); // first time roles leave the server
    for (const id of round.players.keys()) sendRole(id);
    if (matchOver) sendRound();
    else {
      gapTimer = setTimeout(startRound, gapMs());
      gapTimer.unref?.();
    }
  }

  function onAct(data: unknown) {
    if (!round || ended || !data || typeof data !== 'object') return;
    const d = data as { actor?: unknown; target?: unknown; dist?: unknown };
    const out = act(round, d.actor, d.target, Date.now(), d.dist);
    if (!out) return;
    const r = out.result;
    ctx.toTv(MSG.result, r);
    sendRole(r.actor);
    for (const id of r.out) sendRole(id);
    const why = endReason(round, Date.now());
    if (why) finish(why);
  }

  return {
    onStart(c) {
      ctx = c;
      startRound();
    },
    onPhoneMessage(playerId, type, data) {
      // Phones may only flip the drinks toggle, and only the leader. Everything else is ignored.
      if (type !== MSG.drinks || ctx.leaderId() !== playerId) return;
      const d = data as { on?: unknown; drinks?: unknown } | boolean | null | undefined;
      const v = typeof d === 'boolean' ? d : typeof d?.on === 'boolean' ? d.on : typeof d?.drinks === 'boolean' ? d.drinks : !drinks;
      if (v === drinks) return;
      drinks = v;
      sendRound();
    },
    onTvMessage(type, data) {
      if (type === MSG.act) onAct(data);
      else if (type === MSG.next && ended && !matchOver) startRound();
      else if (type === MSG.ready) {
        // TV mounted after leader:pick (or reloaded): resend what it missed.
        sendRound();
        if (ended && lastEnd) ctx.toTv(MSG.end, lastEnd);
      }
    },
    onPlayerConnected(playerId) {
      sendRound(playerId);
      sendRole(playerId);
    },
    onTvConnected() {
      sendRound();
      if (ended && lastEnd) ctx.toTv(MSG.end, lastEnd);
    },
    onEnd() {
      clearTimeout(endTimer);
      clearTimeout(gapTimer);
    },
  };
});
