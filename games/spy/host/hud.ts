import type { EndMsg } from '../types.ts';

// DOM overlay. Every name and text from the network goes in through textContent.
export interface Hud {
  el: HTMLElement;
  setRound(text: string): void;
  setTime(text: string): void;
  setAlive(n: number | null): void;
  setStatus(text: string): void;
  feed(text: string, kind: 'kill' | 'arrest-ok' | 'arrest-wrong'): void;
  showEnd(d: EndMsg): void;
  hideEnd(): void;
  feedLines(): string[];
  tick(nowMs: number): void;
}

const FEED_MAX = 6;
const FEED_LIFE_MS = 14_000;

export function buildHud(): Hud {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;color:#fff;font-family:system-ui,sans-serif;text-shadow:0 2px 6px #000;';
  const mk = (id: string, css: string) => {
    const d = document.createElement('div');
    d.id = id;
    d.style.cssText = css;
    el.append(d);
    return d;
  };
  const roundEl = mk('spy-round', 'position:absolute;top:16px;left:24px;font-size:28px;font-weight:600;');
  const timeEl = mk('spy-time', 'position:absolute;top:8px;left:0;right:0;text-align:center;font-size:56px;font-weight:700;');
  const aliveEl = mk('spy-alive', 'position:absolute;top:16px;right:24px;font-size:28px;font-weight:600;');
  const statusEl = mk('spy-status', 'position:absolute;bottom:24px;left:0;right:0;text-align:center;font-size:28px;');
  const feedEl = mk('spy-feed', 'position:absolute;bottom:24px;left:24px;width:min(42vw,560px);font-size:24px;display:flex;flex-direction:column;gap:6px;');
  const endEl = mk('spy-end', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(8,10,16,0.82);');
  const lines: { el: HTMLElement; at: number }[] = [];

  return {
    el,
    setRound: (t) => void (roundEl.textContent = t),
    setTime: (t) => void (timeEl.textContent = t),
    setAlive: (n) => void (aliveEl.textContent = n === null ? '' : `Alive: ${n}`),
    setStatus: (t) => void (statusEl.textContent = t),
    feed(text, kind) {
      const li = document.createElement('div');
      li.className = `spy-feed-line ${kind}`;
      li.style.cssText = `padding:6px 12px;border-radius:8px;background:rgba(0,0,0,0.55);border-left:6px solid ${kind === 'kill' ? '#e5484d' : kind === 'arrest-ok' ? '#46c26b' : '#e0b23a'};`;
      li.textContent = text;
      feedEl.append(li);
      lines.push({ el: li, at: Date.now() });
      while (lines.length > FEED_MAX) lines.shift()!.el.remove();
    },
    showEnd(d) {
      endEl.replaceChildren();
      const box = document.createElement('div');
      box.style.cssText = 'text-align:left;font-size:28px;min-width:min(80vw,760px);';
      const h = document.createElement('div');
      h.id = 'spy-end-title';
      h.style.cssText = 'font-size:44px;font-weight:700;margin-bottom:6px;';
      h.textContent = d.final ? 'Final scores' : `Round ${d.round} of ${d.rounds} is over`;
      const why = document.createElement('div');
      why.style.cssText = 'margin-bottom:16px;opacity:0.85;';
      why.textContent = d.reason === 'assassins-caught' ? 'All assassins were caught.' : d.reason === 'civilians-out' ? 'All civilians are out.' : 'Time ran out.';
      const table = document.createElement('table');
      table.id = 'spy-end-table';
      table.style.cssText = 'width:100%;border-collapse:collapse;';
      const head = table.insertRow();
      for (const t of ['Player', 'Role', 'Round', 'Total']) {
        const th = document.createElement('th');
        th.textContent = t;
        th.style.cssText = 'text-align:left;padding:4px 12px;opacity:0.7;font-weight:500;';
        head.append(th);
      }
      for (const s of [...d.scores].sort((a, b) => b.total - a.total)) {
        const r = table.insertRow();
        r.className = s.role;
        const cells = [s.name + (s.out ? ' (out)' : ''), s.role === 'assassin' ? 'Assassin' : 'Civilian', (s.points >= 0 ? '+' : '') + s.points, String(s.total)];
        cells.forEach((t, i) => {
          const td = r.insertCell();
          td.textContent = t;
          td.style.cssText = `padding:4px 12px;${i === 1 && s.role === 'assassin' ? 'color:#ff7b7f;font-weight:700;' : ''}`;
        });
      }
      box.append(h, why, table);
      if (d.drinkers.length) {
        const dr = document.createElement('div');
        dr.id = 'spy-drinkers';
        dr.style.cssText = 'margin-top:16px;';
        dr.textContent = `Drink: ${d.drinkers.join(', ')}`;
        box.append(dr);
      }
      endEl.append(box);
      endEl.style.display = 'flex';
    },
    hideEnd() {
      endEl.style.display = 'none';
      endEl.replaceChildren();
    },
    feedLines: () => lines.map((l) => l.el.textContent ?? ''),
    tick(nowMs) {
      while (lines.length && nowMs - lines[0].at > FEED_LIFE_MS) lines.shift()!.el.remove();
    },
  };
}
