import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';

interface BetView { id: string; text: string; byName: string; open: boolean; outcome: string | null; yesPool: number; noPool: number; yesPct: number; traders: number }
interface View { bets: BetView[]; traders: { id: string; name: string; worth: number }[] }

const CSS = `
#layer-market{position:fixed;left:0;right:0;bottom:0;z-index:50;pointer-events:none;display:flex;gap:2vmin;align-items:stretch;
  padding:1vmin 2vmin;background:rgba(15,18,32,.92);border-top:.3vmin solid #ffcf5a;font-size:2.2vmin;min-height:9vmin}
#layer-market[data-empty]{display:none}
#layer-market .mk-title{color:#ffcf5a;font-weight:900;letter-spacing:.08em;align-self:center;white-space:nowrap}
#layer-market .mk-bets{flex:1;display:flex;gap:1.6vmin;overflow:hidden;align-items:center}
#layer-market .mk-bet{flex:0 0 auto;max-width:30vmin;background:#1a1f36;border-radius:1.2vmin;padding:.8vmin 1.4vmin}
#layer-market .mk-q{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#layer-market .mk-odds{display:flex;gap:1vmin;font-weight:700;margin-top:.4vmin}
#layer-market .yes{color:#5be39a}#layer-market .no{color:#ff6b6b}
#layer-market .mk-bar{height:.8vmin;border-radius:.4vmin;background:#ff6b6b;margin-top:.4vmin;overflow:hidden}
#layer-market .mk-bar i{display:block;height:100%;background:#5be39a}
#layer-market .mk-bet.done{opacity:.6}
#layer-market .mk-top{display:flex;gap:1.4vmin;align-items:center;white-space:nowrap}
#layer-market .mk-top span.n{color:#9aa3c7}
`;

registerHost(info, (): TvGame => {
  let root: HTMLElement;
  let bets: HTMLElement;
  let top: HTMLElement;

  const el = (tag: string, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // plain text only
    return e;
  };

  function render(v: View) {
    root.toggleAttribute('data-empty', v.bets.length === 0);
    bets.replaceChildren(
      ...v.bets.map((b) => {
        const d = el('div', 'mk-bet' + (b.open ? '' : ' done'));
        d.dataset.betId = b.id;
        d.append(el('div', 'mk-q', b.text));
        const odds = el('div', 'mk-odds');
        if (b.open) {
          odds.append(el('span', 'yes', `YES ${b.yesPct}%`), el('span', 'no', `NO ${100 - b.yesPct}%`), el('span', 'n', `pool ${b.yesPool + b.noPool}`));
        } else {
          odds.append(el('span', b.outcome === 'yes' ? 'yes' : 'no', `Resolved ${String(b.outcome).toUpperCase()}`));
        }
        const bar = el('div', 'mk-bar');
        const fill = el('i');
        fill.style.width = `${b.yesPct}%`;
        bar.append(fill);
        d.append(odds, bar);
        return d;
      }),
    );
    top.replaceChildren(
      ...v.traders.slice(0, 3).map((t, i) => {
        const s = el('span');
        s.append(el('span', 'n', `${i + 1}.`), document.createTextNode(' '), el('b', undefined, t.name), document.createTextNode(` ${t.worth}`));
        return s;
      }),
    );
  }

  return {
    mount(ctx) {
      root = ctx.root;
      const st = document.createElement('style');
      st.textContent = CSS;
      root.append(st, el('div', 'mk-title', 'MARKET'));
      bets = el('div', 'mk-bets');
      top = el('div', 'mk-top');
      root.append(bets, top);
      root.dataset.empty = '';
    },
    onPhoneMessage(_from, type, data) {
      if (type === 'market:state') render(data as View);
    },
    destroy() {
      root?.replaceChildren();
    },
  };
});
