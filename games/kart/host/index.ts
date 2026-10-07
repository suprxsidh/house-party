import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { KART_COLORS, MAX_KARTS, MIN_KARTS, type AssignMsg, type InputMsg, type RaceMsg } from '../shared.ts';

interface PartyApi {
  ready: boolean;
  setRoster(r: { seat: string; name: string }[]): void;
  input(seat: string, d: Partial<InputMsg>): boolean;
  kartOf(seat: string): number | null;
  results(): { place: number; seat: string | null; name: string; human: boolean; finished: boolean; time: number | null }[];
  snapshot(): { phase: RaceMsg['phase']; raceTime: number; laps: number; rows: (RaceMsg['rows'][number] & { kart: number })[] };
}

// TV side. The race runs in an iframe (/kart/) so the kart code keeps its own page,
// renderer and globals. This file feeds it phone input and reports back to phones.
registerHost(info, (): TvGame => {
  let iframe: HTMLIFrameElement | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let party: PartyApi | null = null;
  let toPhone: (id: string, type: string, data?: unknown) => void = () => {};
  let toPhones: (type: string, data?: unknown) => void = () => {};
  let toServer: (type: string, data?: unknown) => void = () => {};
  let roster: { seat: string; name: string }[] = [];
  const pending = new Map<string, InputMsg>(); // inputs that arrive before the race page is ready
  let resultsSent = false;

  const assignFor = (seat: string): AssignMsg => {
    const kart = roster.findIndex((r) => r.seat === seat);
    return {
      kart: kart < 0 ? null : kart,
      name: roster[kart]?.name ?? '',
      color: KART_COLORS[kart] ?? '#888',
      humans: roster.length,
    };
  };

  return {
    mount(ctx) {
      toPhone = ctx.toPhone;
      toPhones = ctx.toPhones;
      toServer = ctx.toServer;
      // Seats at start get karts, in seat order. Phones that join later watch.
      roster = ctx.players()
        .slice()
        .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
        .slice(0, MAX_KARTS)
        .map((p) => ({ seat: p.id, name: p.name }));
      const karts = Math.min(MAX_KARTS, Math.max(MIN_KARTS, roster.length));

      const q = new URLSearchParams(location.search);
      const pass = new URLSearchParams({ party: '1', karts: String(karts) });
      for (const k of ['quality', 'scale', 'laps', 'renderevery']) if (q.get(k)) pass.set(k, q.get(k)!);

      ctx.root.textContent = '';
      iframe = document.createElement('iframe');
      iframe.id = 'kart-frame';
      iframe.title = 'Kart race';
      iframe.src = `/kart/?${pass}`;
      iframe.allow = 'autoplay';
      iframe.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;background:#05070d;z-index:50';
      ctx.root.append(iframe);

      timers.push(setInterval(() => {
        // wait for the race page, then hand it the roster once
        if (!party) {
          const p = (iframe?.contentWindow as (Window & { __party?: PartyApi }) | null)?.__party;
          if (!p?.ready) return;
          party = p;
          party.setRoster(roster);
          for (const [seat, d] of pending) party.input(seat, d);
          pending.clear();
          for (const r of roster) toPhone(r.seat, 'assign', assignFor(r.seat));
          (window as any).__kart = party;
        }
        const snap = party.snapshot();
        const msg: RaceMsg = {
          phase: snap.phase,
          raceTime: snap.raceTime,
          laps: snap.laps,
          rows: snap.rows
            .filter((r) => r.seat)
            .map((r) => ({ seat: r.seat, place: r.place, lap: r.lap, finished: r.finished, item: r.item, itemCount: r.itemCount })),
        };
        toPhones('race', msg);
        if (snap.phase === 'results' && !resultsSent) {
          resultsSent = true;
          toServer('results', { order: party.results() });
        }
      }, 200));
    },
    onPhoneMessage(playerId, type, data) {
      (window as any).__kartMsgs = ((window as any).__kartMsgs ?? 0) + 1; // test evidence: messages the TV received
      if (type === 'hello') {
        toPhone(playerId, 'assign', assignFor(playerId));
        return;
      }
      if (type !== 'input' || typeof data !== 'object' || data === null) return;
      const d = data as InputMsg;
      if (party) party.input(playerId, d);
      else pending.set(playerId, d);
    },
    destroy() {
      timers.forEach(clearInterval);
      timers = [];
      iframe?.remove(); // drops the iframe's WebGL context and loop
      iframe = null;
      party = null;
      delete (window as any).__kart;
    },
  };
});
