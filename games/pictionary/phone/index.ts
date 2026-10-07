import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { COLORS, GRID_D, GRID_H, GRID_W, MAX_GUESS_LEN, SHAPES, type Item, type RoundState, type Score, type Shape } from '../common.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const STYLE = `
.pp{display:flex;flex-direction:column;gap:10px;padding:10px;font-family:system-ui,sans-serif;color:#fff}
.pp .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pp button{font-size:16px;padding:8px 12px;border-radius:8px;border:2px solid #556;background:#223;color:#fff}
.pp button.on{border-color:#fff;background:#446}
.pp .sw{width:34px;height:34px;padding:0;border-radius:50%}
.pp .word{font-size:30px;font-weight:700;text-align:center}
.pp .hint{font-size:28px;text-align:center;font-family:ui-monospace,monospace;white-space:pre}
.pp .grid{display:grid;grid-template-columns:repeat(${GRID_W},1fr);gap:2px;touch-action:manipulation}
.pp .cell{aspect-ratio:1;padding:0;border-radius:3px;border:1px solid #334;background:#16202c;position:relative}
.pp .cell i{position:absolute;inset:12%;display:block}
.pp .cell i.cube{border-radius:2px}.pp .cell i.sphere{border-radius:50%}.pp .cell i.cylinder{border-radius:35%/18%}
.pp input{font-size:20px;padding:10px;border-radius:8px;border:2px solid #556;background:#111a;color:#fff;flex:1;min-width:0}
.pp .feed{list-style:none;margin:0;padding:0;font-size:16px}
.pp .msg{text-align:center;font-size:20px}
.pp ol{padding-left:24px;font-size:20px}
`;

const LAYERS = ['Back', 'Middle', 'Front'];
const SHAPE_ICON: Record<Shape, string> = { cube: 'Cube', sphere: 'Sphere', cylinder: 'Cylinder' };

registerPhone(info, (): PhoneGame => {
  let root: HTMLElement;
  let toServer: (type: string, data?: unknown) => void;
  let myId = '';
  let st: RoundState | undefined;
  let word = '';
  let items: Item[] = [];
  let finalScores: Score[] | undefined;
  let guessLog: string[] = [];
  let note = '';
  let at = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  // drawer choices
  let shape: Shape = 'cube';
  let color: string = COLORS[0];
  let size: 1 | 2 = 1;
  let z = 1;
  let timeEl: HTMLElement | null = null;

  const scoreList = (list: Score[]) => {
    const ol = el('ol');
    for (const s of list) ol.append(el('li', '', `${s.name}: ${s.score}`));
    return ol;
  };

  const render = () => {
    root.replaceChildren(el('style', '', STYLE));
    const wrap = el('div', 'pp');
    root.append(wrap);
    timeEl = null;
    if (!st) {
      wrap.append(el('div', 'msg', 'Waiting for the round...'));
      return;
    }
    if (st.phase === 'final') {
      wrap.append(el('div', 'msg', 'Game over'), scoreList(finalScores ?? st.scores));
      wrap.append(el('div', 'msg', 'The leader taps End game to go back to the lobby.'));
      wrap.dataset.phase = 'final';
      return;
    }
    wrap.dataset.phase = st.phase;
    const head = el('div', 'msg', `Round ${st.round}/${st.rounds}`);
    timeEl = el('span', 'time');
    timeEl.id = 'pp-time';
    head.append('  ', timeEl);
    wrap.append(head);
    if (st.phase === 'reveal') {
      wrap.append(
        el('div', 'msg', st.winnerName ? `${st.winnerName} guessed it!` : "Time's up"),
        el('div', 'word', st.word ?? ''),
        scoreList(st.scores),
      );
      return;
    }
    if (st.drawerId === myId) renderDrawer(wrap);
    else renderGuesser(wrap);
    tickTime();
  };

  const tickTime = () => {
    if (!timeEl || !st) return;
    timeEl.textContent = `${Math.ceil(Math.max(0, st.endsInMs - (Date.now() - at)) / 1000)}s`;
  };

  const renderDrawer = (wrap: HTMLElement) => {
    const w = el('div', 'word', word ? `Draw: ${word}` : 'Draw...');
    w.id = 'pp-word';
    wrap.append(w);
    const shapes = el('div', 'row');
    for (const s of SHAPES) {
      const b = el('button', s === shape ? 'on' : '', SHAPE_ICON[s]);
      b.dataset.shape = s;
      b.onclick = () => ((shape = s), render());
      shapes.append(b);
    }
    for (const n of [1, 2] as const) {
      const b = el('button', n === size ? 'on' : '', n === 1 ? 'Small' : 'Big');
      b.dataset.size = String(n);
      b.onclick = () => ((size = n), render());
      shapes.append(b);
    }
    const colors = el('div', 'row');
    for (const c of COLORS) {
      const b = el('button', 'sw' + (c === color ? ' on' : ''));
      b.style.background = c;
      b.dataset.color = c;
      b.setAttribute('aria-label', c);
      b.onclick = () => ((color = c), render());
      colors.append(b);
    }
    const layers = el('div', 'row');
    for (let i = 0; i < GRID_D; i++) {
      const b = el('button', i === z ? 'on' : '', LAYERS[i]);
      b.dataset.z = String(i);
      b.onclick = () => ((z = i), render());
      layers.append(b);
    }
    const grid = el('div', 'grid');
    grid.id = 'pp-grid';
    for (let y = GRID_H - 1; y >= 0; y--) {
      for (let x = 0; x < GRID_W; x++) {
        const cell = el('button', 'cell');
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        const top = items.filter((i) => i.x <= x && x < i.x + i.size && i.y <= y && y < i.y + i.size).sort((a, b) => a.z - b.z).pop();
        if (top) {
          const m = el('i', top.shape);
          m.style.background = top.color;
          cell.append(m);
        }
        cell.onclick = () => toServer('place', { shape, color, x, y, z, size });
        grid.append(cell);
      }
    }
    const tools = el('div', 'row');
    const undo = el('button', '', 'Undo');
    undo.id = 'pp-undo';
    undo.onclick = () => toServer('undo');
    const clear = el('button', '', 'Clear');
    clear.id = 'pp-clear';
    clear.onclick = () => toServer('clear');
    tools.append(undo, clear, el('span', '', `${items.length} blocks`));
    wrap.append(shapes, colors, layers, grid, tools);
  };

  const renderGuesser = (wrap: HTMLElement) => {
    const hint = el('div', 'hint', st!.hint);
    hint.id = 'pp-hint';
    wrap.append(el('div', 'msg', `${st!.drawerName} is drawing. Watch the TV.`), hint);
    const form = el('form', 'row');
    const input = el('input');
    input.id = 'pp-guess';
    input.maxLength = MAX_GUESS_LEN;
    input.autocomplete = 'off';
    input.placeholder = 'Your guess';
    const go = el('button', '', 'Guess');
    go.id = 'pp-send';
    go.type = 'submit';
    form.append(input, go);
    form.onsubmit = (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      toServer('guess', { text });
      input.value = '';
      input.focus();
    };
    const log = el('ul', 'feed');
    for (const g of guessLog) log.append(el('li', '', g));
    wrap.append(form, log);
    if (note) wrap.append(el('div', 'msg', note));
  };

  return {
    mount(ctx) {
      root = ctx.root;
      myId = ctx.me.id;
      toServer = ctx.toServer;
      render();
      timer = setInterval(tickTime, 500);
      toServer('ready'); // the game may have started before this page mounted
    },
    onMessage(type, data) {
      const d = data as any;
      if (type === 'state') {
        const prev = st;
        st = d as RoundState;
        at = Date.now();
        if (!prev || prev.round !== st.round || prev.phase !== st.phase) {
          guessLog = [];
          note = '';
          if (!prev || prev.round !== st.round) {
            word = '';
            items = [];
          }
        }
        render();
      } else if (type === 'secret') {
        word = String(d.word ?? '');
        if (st && st.drawerId === myId) render();
      } else if (type === 'scene') {
        items = Array.isArray(d.items) ? d.items : [];
        if (st?.phase === 'drawing' && st.drawerId === myId) render();
      } else if (type === 'guess') {
        guessLog = [...guessLog.slice(-5), `${d.name}: ${d.text}`];
        if (st?.phase === 'drawing' && st.drawerId !== myId) {
          const log = root.querySelector('.feed');
          if (log) log.replaceChildren(...guessLog.map((g) => el('li', '', g)));
        }
      } else if (type === 'final') {
        finalScores = d.scores;
        if (st) st = { ...st, phase: 'final' };
        render();
      }
    },
    destroy() {
      clearInterval(timer);
      root?.replaceChildren();
    },
  };
});
