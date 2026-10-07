import { registerServer } from '../../../shared/registry.ts';
import type { ServerGame, ServerGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { DECK } from './deck.ts';

// Ten-Yen server part. It alone holds the votes.
//
// Vote rule (documented): the FIRST valid vote of a player in a round is final.
// A second vote in the same round is refused ("locked"). A vote after the reveal is refused ("closed").
// A vote with a bad choice is refused ("bad"). In predict mode a vote without a guess is refused ("need-guess")
// and does not lock.
//
// Privacy: the TV gets only the question, the count of players who voted, and, at reveal,
// the totals, the minority side and the number of drinkers. Never a per-player vote.

type Side = 'yes' | 'no';
type Phase = 'lobby' | 'voting' | 'reveal';

export const MAX_Q_LEN = 120;
export const MIN_Q_LEN = 6;
export const MAX_PER_PLAYER = 5;
export const MAX_CUSTOM = 100;

/** Clean a player-added question. Returns null when it is not acceptable. Stays plain text: the UI uses textContent. */
export function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < MIN_Q_LEN || t.length > MAX_Q_LEN) return null;
  return t;
}

interface Result {
  yes: number;
  no: number;
  minority: Side | null;
  majority: Side | null;
  lone: boolean;
  drinkers: number;
}

registerServer(info, (): ServerGame => {
  let ctx: ServerGameContext;
  let phase: Phase = 'lobby';
  let round = 0;
  let question = '';
  const config = { predict: false, double: false };
  const votes = new Map<string, { choice: Side; guess: Side | null }>();
  let result: Result | null = null;
  const sips = new Map<string, number>();

  const custom: { text: string; by: string }[] = [];
  const usedDeck = new Set<number>();
  const usedCustom = new Set<number>();

  const known = (id: string) => ctx.players().some((p) => p.id === id);
  const connected = (id: string) => (ctx.isConnected ? ctx.isConnected(id) : true);
  const isLeader = (id: string) => (ctx.leaderId ? ctx.leaderId() === id : false);

  function draw(): string {
    const freeCustom = custom.map((_, i) => i).filter((i) => !usedCustom.has(i));
    let freeDeck = DECK.map((_, i) => i).filter((i) => !usedDeck.has(i));
    // Player questions get a boosted chance, so they show up early.
    if (freeCustom.length && (!freeDeck.length || Math.random() < 0.4)) {
      const i = freeCustom[Math.floor(Math.random() * freeCustom.length)];
      usedCustom.add(i);
      return custom[i].text;
    }
    if (!freeDeck.length) {
      usedDeck.clear();
      freeDeck = DECK.map((_, i) => i);
    }
    const i = freeDeck[Math.floor(Math.random() * freeDeck.length)];
    usedDeck.add(i);
    return DECK[i];
  }

  function tally(): Result {
    let yes = 0;
    let no = 0;
    for (const v of votes.values()) v.choice === 'yes' ? yes++ : no++;
    const majority: Side | null = yes === no ? null : yes > no ? 'yes' : 'no';
    const lesser = Math.min(yes, no);
    const minority: Side | null = majority && lesser > 0 ? (majority === 'yes' ? 'no' : 'yes') : null;
    const lone = !!minority && lesser === 1;
    return { yes, no, minority, majority, lone, drinkers: 0 };
  }

  function sipsFor(id: string, r: Result): number {
    const v = votes.get(id);
    if (!v) return 0;
    let s = 0;
    if (r.minority && v.choice === r.minority) s += r.lone && config.double ? 2 : 1;
    if (config.predict && r.majority && v.guess && v.guess !== r.majority) s += 1;
    return s;
  }

  const totalConnected = () => ctx.players().filter((p) => connected(p.id)).length;

  function tvState() {
    return {
      phase,
      round,
      question: phase === 'lobby' ? '' : question,
      config: { ...config },
      voted: votes.size,
      total: totalConnected(),
      result:
        phase === 'reveal' && result
          ? { yes: result.yes, no: result.no, minority: result.minority, lone: result.lone && config.double, drinkers: result.drinkers }
          : null,
    };
  }

  function phoneState(id: string) {
    const v = votes.get(id);
    const mine = custom.filter((c) => c.by === id).length;
    const r = phase === 'reveal' ? result : null;
    return {
      phase,
      round,
      question: phase === 'lobby' ? '' : question,
      config: { ...config },
      leader: isLeader(id),
      voted: votes.size,
      total: totalConnected(),
      mine,
      you: v ? { choice: v.choice, guess: v.guess } : null,
      result: r
        ? {
            yes: r.yes,
            no: r.no,
            minority: r.minority,
            lone: r.lone && config.double,
            drink: (sips.get(id) ?? 0) > 0,
            sips: sips.get(id) ?? 0,
          }
        : null,
    };
  }

  function pushAll() {
    ctx.toTv('state', tvState());
    for (const p of ctx.players()) ctx.toPhone(p.id, 'state', phoneState(p.id));
  }

  function reveal() {
    if (phase !== 'voting') return;
    const r = tally();
    sips.clear();
    for (const p of ctx.players()) {
      const s = sipsFor(p.id, r);
      if (s > 0) {
        sips.set(p.id, s);
        r.drinkers++;
      }
    }
    result = r;
    phase = 'reveal';
    pushAll();
  }

  function newRound() {
    round++;
    question = draw();
    votes.clear();
    sips.clear();
    result = null;
    phase = 'voting';
    pushAll();
  }

  const note = (id: string, ok: boolean, msg: string) => ctx.toPhone(id, 'note', { ok, msg });

  return {
    onStart(c) {
      ctx = c;
      pushAll();
    },
    onTvMessage(type) {
      // A reloaded TV asks for the current state.
      if (type === 'tv-ready') ctx.toTv('state', tvState());
    },
    onPlayerConnected(id) {
      if (!ctx) return;
      ctx.toPhone(id, 'state', phoneState(id));
      ctx.toTv('state', tvState());
    },
    onPhoneMessage(id, type, data) {
      if (!known(id)) return;
      const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      switch (type) {
        case 'hello':
          return ctx.toPhone(id, 'state', phoneState(id));
        case 'start':
        case 'next':
          if (!isLeader(id)) return note(id, false, 'Only the leader can do that.');
          if (phase === 'voting') return;
          return newRound();
        case 'reveal':
          if (!isLeader(id)) return note(id, false, 'Only the leader can do that.');
          return reveal();
        case 'toggle': {
          if (!isLeader(id)) return note(id, false, 'Only the leader can change this.');
          if (phase === 'voting') return note(id, false, 'Change this between rounds.');
          if (typeof d.predict === 'boolean') config.predict = d.predict;
          if (typeof d.double === 'boolean') config.double = d.double;
          return pushAll();
        }
        case 'vote': {
          if (phase === 'reveal' || phase === 'lobby') return ctx.toPhone(id, 'vote-rejected', { reason: 'closed' });
          if (d.round !== undefined && d.round !== round) return ctx.toPhone(id, 'vote-rejected', { reason: 'closed' });
          if (d.choice !== 'yes' && d.choice !== 'no') return ctx.toPhone(id, 'vote-rejected', { reason: 'bad' });
          if (votes.has(id)) return ctx.toPhone(id, 'vote-rejected', { reason: 'locked' });
          let guess: Side | null = null;
          if (config.predict) {
            if (d.guess !== 'yes' && d.guess !== 'no') return ctx.toPhone(id, 'vote-rejected', { reason: 'need-guess' });
            guess = d.guess;
          }
          votes.set(id, { choice: d.choice, guess });
          ctx.toPhone(id, 'vote-ok', { round, choice: d.choice, guess });
          // Everyone connected has voted: reveal now. Else just update the count.
          const waiting = ctx.players().filter((p) => connected(p.id) && !votes.has(p.id));
          if (!waiting.length) return reveal();
          return pushAll();
        }
        case 'addq': {
          const text = cleanQuestion(d.text);
          if (!text) return note(id, false, `Questions need ${MIN_Q_LEN} to ${MAX_Q_LEN} characters.`);
          if (custom.length >= MAX_CUSTOM) return note(id, false, 'The question box is full.');
          if (custom.filter((c) => c.by === id).length >= MAX_PER_PLAYER) return note(id, false, `Max ${MAX_PER_PLAYER} questions each.`);
          const key = text.toLowerCase();
          if (custom.some((c) => c.text.toLowerCase() === key)) return note(id, false, 'Someone already added that one.');
          custom.push({ text, by: id });
          note(id, true, 'Added. It will show up at random.');
          return ctx.toPhone(id, 'state', phoneState(id));
        }
      }
    },
  };
});
