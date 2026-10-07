import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { info } from '../info.ts';

interface BetView { id: string; text: string; byName: string; open: boolean; outcome: string | null; yesPool: number; noPool: number; yesPct: number }
interface View {
  bets: BetView[];
  traders: { id: string; name: string; worth: number }[];
  me?: { balance: number; locked: number; positions: Record<string, { yes: number; no: number; payout?: number }> };
}

const CSS = `
#layer-market{margin:1em 0}
#layer-market summary{cursor:pointer;font-weight:800;color:var(--accent)}
#layer-market .mk-bet{background:var(--card);border-radius:12px;padding:.7em .9em;margin:.6em 0}
#layer-market .mk-q{font-weight:700;overflow-wrap:anywhere}
#layer-market .mk-row{display:flex;gap:.5em;margin-top:.5em;flex-wrap:wrap;align-items:center}
#layer-market input{width:6em;padding:.5em .6em}
#layer-market button{padding:.5em .9em}
#layer-market .yes{color:var(--ok)}#layer-market .no{color:var(--bad)}
#layer-market .mk-dim{color:var(--dim);font-size:.9em}
#layer-market .mk-err{color:var(--bad);min-height:1.2em}
`;

registerPhone(info, (): PhoneGame => {
  let ctx: Parameters<PhoneGame['mount']>[0];
  let box: HTMLElement;
  let list: HTMLElement;
  let head: HTMLElement;
  let err: HTMLElement;
  let view: View | null = null;
  // Keep typed amounts across re-renders.
  const amounts = new Map<string, string>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // plain text only
    return e;
  };
  const btn = (label: string, onclick: () => void, ghost = false) => {
    const b = el('button', ghost ? 'ghost' : undefined, label);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  };

  function render() {
    if (!view) return;
    const me = view.me;
    head.textContent = me ? `Chips ${me.balance} (+${me.locked} in bets)` : 'Market';
    const leader = ctx.isLeader();
    list.replaceChildren(
      ...view.bets.map((b) => {
        const d = el('div', 'mk-bet');
        d.dataset.betId = b.id;
        d.append(el('div', 'mk-q', b.text), el('div', 'mk-dim', `by ${b.byName} | YES ${b.yesPct}% (${b.yesPool}) | NO ${100 - b.yesPct}% (${b.noPool})`));
        const pos = me?.positions[b.id];
        if (pos) d.append(el('div', 'mk-dim', `You: YES ${pos.yes}, NO ${pos.no}` + (pos.payout !== undefined ? `, paid ${pos.payout}` : '')));
        if (b.open) {
          const row = el('div', 'mk-row');
          const amt = el('input');
          amt.type = 'number';
          amt.min = '1';
          amt.step = '1';
          amt.inputMode = 'numeric';
          amt.placeholder = 'chips';
          amt.value = amounts.get(b.id) ?? '50';
          amt.oninput = () => amounts.set(b.id, amt.value);
          const buy = (side: 'yes' | 'no') => () => {
            err.textContent = '';
            ctx.toServer('market:buy', { betId: b.id, side, amount: Number(amt.value) });
          };
          row.append(amt, btn('Buy YES', buy('yes')), btn('Buy NO', buy('no'), true));
          d.append(row);
          if (leader) {
            const r2 = el('div', 'mk-row');
            r2.append(el('span', 'mk-dim', 'Leader:'), btn('Resolve YES', () => ctx.toServer('market:resolve', { betId: b.id, outcome: 'yes' }), true), btn('Resolve NO', () => ctx.toServer('market:resolve', { betId: b.id, outcome: 'no' }), true));
            d.append(r2);
          }
        } else {
          d.append(el('div', b.outcome === 'yes' ? 'yes' : 'no', `Resolved ${String(b.outcome).toUpperCase()}`));
        }
        return d;
      }),
    );
  }

  return {
    mount(c) {
      ctx = c;
      const st = el('style');
      st.textContent = CSS;
      const details = el('details');
      details.open = true;
      head = el('summary', undefined, 'Market');
      const form = el('div', 'mk-row');
      const q = el('input');
      q.type = 'text';
      q.maxLength = 120;
      q.placeholder = 'Will ...?';
      q.style.cssText = 'flex:1;width:auto';
      q.id = 'market-q';
      form.append(q, btn('Propose', () => {
        if (!q.value.trim()) return;
        err.textContent = '';
        ctx.toServer('market:propose', { text: q.value });
        q.value = '';
      }));
      err = el('div', 'mk-err');
      err.setAttribute('role', 'alert');
      list = el('div');
      details.append(head, form, err, list);
      box = ctx.root;
      box.append(st, details);
      ctx.toServer('market:sync'); // state may have arrived before we mounted
    },
    onMessage(type, data) {
      if (type === 'market:state') {
        view = data as View;
        render();
      } else if (type === 'market:error') {
        err.textContent = (data as { message?: string }).message ?? 'Not allowed.';
      }
    },
    onRoomState() {
      render();
    },
    destroy() {
      box?.replaceChildren();
    },
  };
});
