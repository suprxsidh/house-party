import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame, PhoneGameContext } from '../../../shared/games.ts';
import { info } from '../info.ts';

// Phone side of Ten-Yen. Every string from the server or other players goes through textContent.

interface PhoneState {
  phase: 'lobby' | 'voting' | 'reveal';
  round: number;
  question: string;
  config: { predict: boolean; double: boolean };
  leader: boolean;
  voted: number;
  total: number;
  mine: number;
  you: { choice: 'yes' | 'no'; guess: 'yes' | 'no' | null } | null;
  result: { yes: number; no: number; minority: 'yes' | 'no' | null; lone: boolean; drink: boolean; sips: number } | null;
}

registerPhone(info, (): PhoneGame => {
  let ctx: PhoneGameContext;
  let root: HTMLElement;
  let s: PhoneState | null = null;
  let guess: 'yes' | 'no' | null = null;
  let note = '';
  let noteTimer: ReturnType<typeof setTimeout> | undefined;

  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = '') => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const btn = (label: string, id: string, fn: () => void, ghost = false) => {
    const b = mk('button', label, ghost ? 'ghost' : '');
    b.id = id;
    b.type = 'button';
    b.onclick = fn;
    return b;
  };

  function render() {
    root.replaceChildren();
    if (!s) return void root.append(mk('p', 'Loading Ten-Yen'));
    const box = mk('div');
    box.id = 'ty-phone';
    const q = mk('h2', s.phase === 'lobby' ? 'Ten-Yen' : s.question);
    q.id = 'ty-question';
    box.append(q);

    if (s.phase === 'lobby') {
      box.append(mk('p', s.leader ? 'You lead. Set the rules, then start.' : 'Waiting for the leader to start.'));
    }
    if (s.phase === 'voting') {
      if (!s.you) {
        if (s.config.predict) {
          box.append(mk('p', 'Predict: which side will win?'));
          const row = mk('div', '', 'row');
          for (const g of ['yes', 'no'] as const) {
            const b = btn(g.toUpperCase(), `ty-guess-${g}`, () => ((guess = g), render()), guess !== g);
            row.append(b);
          }
          box.append(row);
        }
        box.append(mk('p', 'Your vote is secret.'));
        const row = mk('div', '', 'row');
        for (const c of ['yes', 'no'] as const) {
          const b = btn(c.toUpperCase(), `ty-vote-${c}`, () => {
            if (s?.config.predict && !guess) return flash('Pick a prediction first.');
            ctx.toServer('vote', { round: s!.round, choice: c, guess: guess ?? undefined });
          });
          row.append(b);
        }
        box.append(row);
      } else {
        const p = mk('p', `You voted ${s.you.choice.toUpperCase()}${s.you.guess ? `, predicted ${s.you.guess.toUpperCase()}` : ''}. Locked.`);
        p.id = 'ty-voted';
        box.append(p, mk('p', `${s.voted} of ${s.total} voted`));
      }
      if (s.leader) box.append(btn('Reveal now', 'ty-reveal', () => ctx.toServer('reveal'), true));
    }
    if (s.phase === 'reveal' && s.result) {
      const r = s.result;
      const v = mk('p', r.drink ? `YOU DRINK${r.sips > 1 ? ` ${r.sips} sips` : ''}` : 'You are safe', 'ty-result');
      v.id = 'ty-result';
      v.style.fontSize = '1.6rem';
      v.style.fontWeight = '800';
      v.style.color = r.drink ? 'var(--bad)' : 'var(--ok)';
      box.append(v, mk('p', `YES ${r.yes} : NO ${r.no}${r.minority ? ` (${r.minority.toUpperCase()} is the minority)` : ' (tie or all agree)'}`));
    }
    if (s.leader && s.phase !== 'voting') {
      const b = btn(s.phase === 'lobby' ? 'Start' : 'Next question', 'ty-next', () => ctx.toServer(s!.phase === 'lobby' ? 'start' : 'next'));
      box.append(b);
    }
    if (s.leader && s.phase !== 'voting') {
      const t = mk('div', '', 'ty-toggles');
      for (const [key, label] of [['predict', 'Predict mode (wrong guess = +1 sip)'], ['double', 'Lone dissenter drinks double']] as const) {
        const l = mk('label');
        const cb = mk('input');
        cb.type = 'checkbox';
        cb.id = `ty-toggle-${key}`;
        cb.checked = s.config[key];
        cb.style.width = 'auto';
        cb.onchange = () => ctx.toServer('toggle', { [key]: cb.checked });
        l.append(cb, ' ', label);
        t.append(l);
      }
      box.append(t);
    }
    // Add a question
    const add = mk('div', '', 'ty-add');
    const inp = mk('input');
    inp.id = 'ty-addq-text';
    inp.maxLength = 120;
    inp.placeholder = 'Add your own YES/NO question';
    add.append(inp, btn('Add', 'ty-addq', () => { ctx.toServer('addq', { text: inp.value }); inp.value = ''; }, true));
    box.append(add, mk('p', `You added ${s.mine} of 5`));
    if (note) {
      const n = mk('p', note);
      n.id = 'ty-note';
      box.append(n);
    }
    root.append(box);
  }

  function flash(msg: string) {
    note = msg;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => ((note = ''), render()), 3000);
    render();
  }

  return {
    mount(c) {
      ctx = c;
      root = c.root;
      render();
      // The server's first push can land before this page mounts. Ask again.
      c.toServer('hello');
    },
    onMessage(type, data) {
      const d = (data ?? {}) as Record<string, unknown>;
      if (type === 'state') {
        const prev = s;
        s = data as PhoneState;
        if (!prev || prev.round !== s.round) guess = null;
        render();
      } else if (type === 'note') flash(String(d.msg ?? ''));
      else if (type === 'vote-rejected') flash(d.reason === 'locked' ? 'Your vote is already locked.' : d.reason === 'closed' ? 'Voting is closed.' : d.reason === 'need-guess' ? 'Pick a prediction first.' : 'Bad vote.');
    },
    destroy() {
      clearTimeout(noteTimer);
      root?.replaceChildren();
    },
  };
});
