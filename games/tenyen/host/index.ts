import { registerHost } from '../../../shared/registry.ts';
import type { TvGame, TvGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';

// TV side of Ten-Yen. Shows what the server sends: question, vote count, then totals only.
// Plain CSS animation. All text goes through textContent.

interface TvState {
  phase: 'lobby' | 'voting' | 'reveal';
  round: number;
  question: string;
  config: { predict: boolean; double: boolean };
  voted: number;
  total: number;
  result: { yes: number; no: number; minority: 'yes' | 'no' | null; lone: boolean; drinkers: number } | null;
}

const CSS = `
.ty{display:grid;gap:2.4vmin;text-align:center;padding:2vmin}
.ty h2{margin:0;font-size:4vmin;color:var(--dim);letter-spacing:.1em}
.ty .q{font-size:5vmin;font-weight:800;line-height:1.15;min-height:2.3em;display:flex;align-items:center;justify-content:center}
.ty .meta{font-size:3vmin;color:var(--dim)}
.ty .tags span{display:inline-block;margin:0 1vmin;padding:.4vmin 1.4vmin;border-radius:2vmin;background:var(--card);font-size:2.4vmin;color:var(--accent)}
.ty .piles{display:grid;grid-template-columns:1fr 1fr;gap:4vmin;align-items:end;min-height:26vmin}
.ty .pile{position:relative;border-radius:2vmin;background:var(--card);height:26vmin;overflow:hidden;border:.6vmin solid transparent;transition:border-color .4s,transform .4s}
.ty .pile.minority{border-color:var(--bad);transform:scale(1.03)}
.ty .pile .label{position:absolute;top:1vmin;left:0;right:0;font-size:4vmin;font-weight:900}
.ty .pile .count{position:absolute;top:6vmin;left:0;right:0;font-size:6vmin;font-weight:900;color:var(--accent)}
.ty .coin{position:absolute;width:5vmin;height:5vmin;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff3b0,#ffcf5a 55%,#b88a1a);box-shadow:0 .4vmin 0 #7a5a08;transform:translateY(-30vmin);opacity:0;animation:ty-drop .7s cubic-bezier(.3,.1,.6,1.2) forwards}
@keyframes ty-drop{0%{transform:translateY(-30vmin) rotate(0);opacity:1}80%{opacity:1}100%{transform:translateY(0) rotate(360deg);opacity:1}}
.ty .verdict{font-size:5.4vmin;font-weight:900;color:var(--bad);min-height:1.2em;animation:ty-pop .5s ease-out}
.ty .verdict.safe{color:var(--ok)}
@keyframes ty-pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}
.ty .bar{height:2vmin;background:var(--card);border-radius:1vmin;overflow:hidden}
.ty .bar i{display:block;height:100%;background:var(--accent);transition:width .3s}
`;

registerHost(info, (): TvGame => {
  let el: Record<string, HTMLElement> = {};
  let style: HTMLStyleElement | undefined;
  let shownRound = -1;
  let shownPhase = '';

  const mk = (tag: string, cls = '', text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };

  function renderPile(side: 'yes' | 'no', n: number, minority: boolean, animate: boolean) {
    const pile = el[side + 'Pile'];
    pile.classList.toggle('minority', minority);
    pile.querySelectorAll('.coin').forEach((c) => c.remove());
    el[side + 'Count'].textContent = String(n);
    const shown = Math.min(n, 12);
    for (let i = 0; i < shown; i++) {
      const c = mk('div', 'coin');
      c.style.left = `${5 + ((i * 17) % 80)}%`;
      c.style.bottom = `${1 + Math.floor(i / 4) * 4.4}vmin`;
      if (animate) c.style.animationDelay = `${i * 0.12}s`;
      else c.style.animation = 'none', (c.style.transform = 'none'), (c.style.opacity = '1');
      pile.append(c);
    }
  }

  function render(s: TvState) {
    const reveal = s.phase === 'reveal' && s.result;
    el.q.textContent = s.phase === 'lobby' ? 'Waiting for the leader to start.' : s.question;
    el.meta.textContent =
      s.phase === 'voting'
        ? `${s.voted} of ${s.total} have voted`
        : s.phase === 'lobby'
          ? 'Ten-Yen: secret YES or NO. The minority drinks.'
          : `Round ${s.round}`;
    el.bar.style.width = s.phase === 'voting' && s.total ? `${Math.round((100 * s.voted) / s.total)}%` : '0';
    el.bar.parentElement!.hidden = s.phase !== 'voting';
    el.tags.replaceChildren(
      ...(s.config.predict ? [mk('span', '', 'Predict mode: wrong guess = +1 sip')] : []),
      ...(s.config.double ? [mk('span', '', 'Lone dissenter drinks double')] : []),
    );
    el.piles.hidden = !reveal;
    if (reveal) {
      const r = s.result!;
      const fresh = shownRound !== s.round || shownPhase !== 'reveal';
      renderPile('yes', r.yes, r.minority === 'yes', fresh);
      renderPile('no', r.no, r.minority === 'no', fresh);
      el.verdict.className = 'verdict' + (r.minority ? '' : ' safe');
      el.verdict.textContent = r.minority
        ? `${r.minority.toUpperCase()} drinks!${r.lone ? ' Lone dissenter: double!' : ''}`
        : r.yes === r.no
          ? 'Tie. Nobody drinks.'
          : 'Everyone agreed. Nobody drinks from the vote.';
      el.next.textContent = r.drinkers ? `${r.drinkers} drinking` : '';
    } else {
      el.verdict.textContent = '';
      el.next.textContent = '';
    }
    shownRound = s.round;
    shownPhase = s.phase;
  }

  return {
    mount(ctx: TvGameContext) {
      style = document.createElement('style');
      style.textContent = CSS;
      document.head.append(style);
      ctx.root.replaceChildren();
      const root = mk('div', 'ty');
      el = {
        q: mk('div', 'q'),
        meta: mk('div', 'meta'),
        tags: mk('div', 'tags'),
        verdict: mk('div', 'verdict'),
        next: mk('div', 'meta'),
        piles: mk('div', 'piles'),
      };
      el.bar = mk('i');
      const barWrap = mk('div', 'bar');
      barWrap.append(el.bar);
      for (const side of ['yes', 'no'] as const) {
        const p = mk('div', 'pile');
        p.dataset.side = side;
        el[side + 'Pile'] = p;
        el[side + 'Count'] = mk('div', 'count', '0');
        p.append(mk('div', 'label', side.toUpperCase()), el[side + 'Count']);
        el.piles.append(p);
      }
      el.piles.hidden = true;
      root.append(mk('h2', '', 'TEN-YEN'), el.q, el.meta, barWrap, el.piles, el.verdict, el.next, el.tags);
      ctx.root.append(root);
      ctx.toServer('tv-ready');
    },
    onPhoneMessage(playerId, type, data) {
      // Only the server part (playerId '') drives this screen. Phones talk to the server, not the TV.
      if (playerId === '' && type === 'state' && el.q) render(data as TvState);
    },
    destroy() {
      style?.remove();
      el = {};
    },
  };
});

