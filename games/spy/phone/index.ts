import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { MOVE_HZ, MSG, PLAZA_SIZE, ROLE_CARD_MS, type MeMsg, type RoleMsg, type RoundMsg } from '../types.ts';

// Phone controller. It shows what the server sends and never invents a role.
// Joystick axes: x is right-positive, y is down-positive (up on screen = -1).

const CSS = `
#spy-pad{position:fixed;inset:0;z-index:100;background:#0d1016;color:#eef1f7;font-family:system-ui,sans-serif;
  display:flex;flex-direction:column;touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;overflow:hidden}
#spy-pad *{touch-action:none;user-select:none;-webkit-user-select:none;box-sizing:border-box}
#spy-pad .top{display:flex;justify-content:space-between;align-items:center;padding:calc(env(safe-area-inset-top) + 12px) 16px 4px;font-weight:700;font-size:16px}
#spy-pad .top .sub{opacity:.7;font-weight:600}
#spy-pad .mid{flex:1;display:flex;align-items:center;justify-content:space-between;padding:8px 16px;gap:12px}
#spy-pad .map{position:relative;width:132px;height:132px;border:2px solid #2d3548;border-radius:10px;background:#161b27;flex:none}
#spy-pad .map i{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#ffcf5a;box-shadow:0 0 0 2px #0d1016}
#spy-pad .opts{display:flex;flex-direction:column;gap:10px;align-items:flex-end;font-size:14px}
#spy-pad button{font:inherit;color:inherit;border:2px solid #3a4560;background:#1b2234;border-radius:12px;padding:10px 14px;font-weight:700}
#spy-pad button.on,#spy-pad button:active{background:#ffcf5a;color:#1a1400;border-color:#fff}
#spy-pad button:disabled{opacity:.35}
#spy-pad .peek{font-size:20px;letter-spacing:.06em;min-height:28px;text-align:center;font-weight:800}
#spy-pad .bottom{display:flex;justify-content:space-between;align-items:center;padding:0 24px calc(env(safe-area-inset-bottom) + 28px);height:230px}
#spy-pad .stick{position:relative;width:150px;height:150px;border-radius:50%;background:#161b27;border:2px solid #2d3548}
#spy-pad .stick i{position:absolute;left:50%;top:50%;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;background:#4b5c8c}
#spy-pad .actwrap{position:relative;width:150px;height:150px}
#spy-pad .ring{position:absolute;inset:0;border-radius:50%;background:#2d3548;display:none}
#spy-pad .ring.on{display:block}
#spy-pad .act{position:absolute;inset:10px;border-radius:50%;font-size:28px;font-weight:900;background:#c43c4b;border:3px solid #ffb3bb;padding:0}
#spy-pad .act:active,#spy-pad .act.on{background:#ff6b7b;color:#fff;border-color:#fff}
#spy-pad .card,#spy-pad .out{position:absolute;inset:0;z-index:5;display:flex;flex-direction:column;gap:14px;align-items:center;justify-content:center;
  background:#0d1016f2;text-align:center;padding:24px;font-weight:800}
#spy-pad .card .big{font-size:44px;letter-spacing:.06em}
#spy-pad .card .small,#spy-pad .out .small{font-size:16px;font-weight:600;opacity:.8}
#spy-pad .card .bar{width:200px;height:6px;border-radius:3px;background:#2d3548;overflow:hidden}
#spy-pad .card .bar i{display:block;height:100%;background:#ffcf5a;animation:spybar ${ROLE_CARD_MS}ms linear forwards}
@keyframes spybar{from{width:100%}to{width:0}}
#spy-pad .out .big{font-size:36px}
`;

registerPhone(info, (): PhoneGame => {
  let ctx: Parameters<PhoneGame['mount']>[0];
  let pad: HTMLElement | null = null;
  let style: HTMLStyleElement | null = null;
  const el: Record<string, HTMLElement> = {};
  let role: RoleMsg | null = null;
  let roleAt = 0; // when the current role message arrived
  let cdTotal = 0;
  let round: RoundMsg | null = null;
  let roundAt = 0;
  let cardRound = 0; // last round whose card was shown
  let cardTimer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  let vec = { x: 0, y: 0 };
  let touching = false;
  let moveTimer: ReturnType<typeof setInterval> | undefined;
  let uiTimer: ReturnType<typeof setInterval> | undefined;
  let drinksOn = false;

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  const over = () => !!role?.out || !!round?.over;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const roleWord = (r: RoleMsg) => (r.role === 'assassin' ? 'ASSASSIN' : 'CIVILIAN');

  function cooldownLeft() {
    return role ? Math.max(0, role.cooldownMs - (Date.now() - roleAt)) : 0;
  }

  function renderPeek() {
    // The role text exists in the DOM only while the button is held.
    el.peek.replaceChildren();
    if (!held || !role || over()) return;
    const lines = [roleWord(role)];
    if (role.role === 'civilian') lines.push(role.arrestsLeft > 0 ? `${role.arrestsLeft} arrest left` : 'No arrests left');
    el.peek.textContent = lines.join('  |  ');
  }

  function renderCard() {
    el.card?.remove();
    delete el.card;
    if (!role || !pad) return;
    const c = make('div', 'card');
    c.append(make('div', 'small', `Round ${role.round} of ${role.rounds}`), make('div', 'big', roleWord(role)), make('div', 'small', 'Secret. Hold Role to look again.'));
    const bar = make('div', 'bar');
    bar.append(make('i'));
    c.append(bar);
    pad.append(c);
    el.card = c;
  }
  function hideCard() {
    clearTimeout(cardTimer);
    el.card?.remove();
    delete el.card;
  }

  function maybeShowCard() {
    if (!role || role.out || role.round === cardRound) return;
    cardRound = role.round;
    let ms = ROLE_CARD_MS;
    if (round && round.round === role.round) {
      const skew = round.now - roundAt;
      ms = round.startsAt - (Date.now() + skew) + ROLE_CARD_MS; // card lasts until 6 s after the round start
      ms = Math.min(ms, ROLE_CARD_MS);
    }
    if (ms <= 0) return;
    renderCard();
    clearTimeout(cardTimer);
    cardTimer = setTimeout(hideCard, ms);
  }

  function renderOut() {
    el.out?.remove();
    delete el.out;
    if (!pad || !over()) return;
    const o = make('div', 'out');
    const finished = !!round?.over && !role?.out;
    o.append(make('div', 'big', finished ? 'Game over' : 'You are out'), make('div', 'small', finished ? 'Look at the TV for the scores.' : 'Watch the TV. You play again next round.'));
    if (role) o.append(make('div', 'small', `Points: ${role.points}`));
    pad.append(o);
    el.out = o;
  }

  function renderStatic() {
    const dead = over();
    (el.act as HTMLButtonElement).disabled = dead;
    (el.roleBtn as HTMLButtonElement).disabled = dead || !role;
    pad?.classList.toggle('dead', dead);
    el.round.textContent = role ? `Round ${role.round} of ${role.rounds}` : 'Waiting for the TV';
    el.pts.textContent = role ? `${role.points} pts` : '';
    el.drinks.hidden = !ctx.isLeader();
    el.drinks.textContent = drinksOn ? 'Drinks: on' : 'Drinks: off';
    el.drinks.classList.toggle('on', drinksOn);
    renderOut();
    renderPeek();
  }

  function tick() {
    const left = cooldownLeft();
    const ring = el.ring;
    if (left > 0 && cdTotal > 0 && !over()) {
      ring.classList.add('on');
      ring.style.background = `conic-gradient(#ffcf5a ${Math.round((1 - left / cdTotal) * 360)}deg, #2d3548 0)`;
    } else {
      ring.classList.remove('on');
    }
  }

  function sendMove() {
    ctx.toTv(MSG.move, { x: round2(vec.x), y: round2(vec.y) });
  }
  function stopStick() {
    if (!touching) return;
    touching = false;
    vec = { x: 0, y: 0 };
    clearInterval(moveTimer);
    moveTimer = undefined;
    (el.knob as HTMLElement).style.transform = '';
    sendMove(); // final zero vector
  }

  function setupStick(stick: HTMLElement) {
    let pid = -1;
    const R = 43; // knob travel in px (stick radius 75 minus knob radius 32)
    const update = (e: PointerEvent) => {
      const r = stick.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
      vec = { x: clamp(dx / R), y: clamp(dy / R) };
      (el.knob as HTMLElement).style.transform = `translate(${dx}px,${dy}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      if (over() || pid !== -1) return;
      e.preventDefault();
      pid = e.pointerId;
      try { stick.setPointerCapture(pid); } catch { /* ignore */ }
      touching = true;
      update(e);
      sendMove();
      moveTimer = setInterval(sendMove, Math.round(1000 / MOVE_HZ));
    });
    stick.addEventListener('pointermove', (e) => { if (e.pointerId === pid && touching) update(e); });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      pid = -1;
      stopStick();
    };
    stick.addEventListener('pointerup', end);
    stick.addEventListener('pointercancel', end);
    stick.addEventListener('lostpointercapture', end);
  }

  function setPeek(on: boolean) {
    if (held === on) return;
    held = on;
    el.roleBtn.classList.toggle('on', on);
    renderPeek();
  }

  return {
    mount(c) {
      ctx = c;
      style = document.createElement('style');
      style.textContent = CSS;
      document.head.append(style);
      pad = make('div');
      pad.id = 'spy-pad';
      const top = make('div', 'top');
      el.round = make('div', '', 'Waiting for the TV');
      el.round.id = 'spy-round';
      el.pts = make('div', 'sub');
      el.pts.id = 'spy-pts';
      top.append(el.round, el.pts);

      const mid = make('div', 'mid');
      el.map = make('div', 'map');
      el.map.id = 'spy-map';
      el.dot = make('i');
      el.dot.id = 'spy-dot';
      el.dot.hidden = true;
      el.map.append(el.dot);
      const opts = make('div', 'opts');
      el.peek = make('div', 'peek');
      el.peek.id = 'spy-peek';
      el.roleBtn = make('button', '', 'Role');
      el.roleBtn.id = 'spy-role-btn';
      (el.roleBtn as HTMLButtonElement).type = 'button';
      (el.roleBtn as HTMLButtonElement).disabled = true;
      el.drinks = make('button', '', 'Drinks: off');
      el.drinks.id = 'spy-drinks';
      (el.drinks as HTMLButtonElement).type = 'button';
      el.drinks.hidden = true;
      opts.append(el.roleBtn, el.drinks);
      mid.append(el.map, opts);

      const bottom = make('div', 'bottom');
      const stick = make('div', 'stick');
      stick.id = 'spy-stick';
      el.knob = make('i');
      stick.append(el.knob);
      const aw = make('div', 'actwrap');
      el.ring = make('div', 'ring');
      el.ring.id = 'spy-ring';
      el.act = make('button', 'act', 'ACT');
      el.act.id = 'spy-act';
      (el.act as HTMLButtonElement).type = 'button';
      aw.append(el.ring, el.act);
      bottom.append(stick, aw);
      pad.append(top, mid, el.peek, bottom);
      document.body.append(pad);

      setupStick(stick);

      el.act.addEventListener('pointerdown', (e) => {
        if (over()) return;
        e.preventDefault();
        el.act.classList.add('on');
        ctx.toTv(MSG.act, {});
      });
      const actUp = () => el.act.classList.remove('on');
      el.act.addEventListener('pointerup', actUp);
      el.act.addEventListener('pointercancel', actUp);
      el.act.addEventListener('pointerleave', actUp);

      const rb = el.roleBtn;
      rb.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { rb.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        setPeek(true);
      });
      const rbUp = () => setPeek(false);
      rb.addEventListener('pointerup', rbUp);
      rb.addEventListener('pointercancel', rbUp);
      rb.addEventListener('lostpointercapture', rbUp);
      rb.addEventListener('contextmenu', (e) => e.preventDefault());
      document.addEventListener('visibilitychange', onHide);

      el.drinks.addEventListener('click', () => {
        drinksOn = !drinksOn;
        ctx.toServer(MSG.drinks, { on: drinksOn });
        renderStatic();
      });

      uiTimer = setInterval(tick, 50);
      renderStatic();
    },
    onMessage(type, data) {
      const d = data as Record<string, unknown> | null;
      if (!d || typeof d !== 'object') return;
      const fin = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if (type === MSG.role) {
        if ((d.role !== 'assassin' && d.role !== 'civilian') || !fin(d.round) || !fin(d.rounds) || !fin(d.cooldownMs) || !fin(d.arrestsLeft) || !fin(d.points) || typeof d.out !== 'boolean') return;
        role = d as unknown as RoleMsg;
        roleAt = Date.now();
        cdTotal = Math.max(role.cooldownMs, 1);
        if (role.out) { hideCard(); stopStick(); setPeek(false); }
        maybeShowCard();
        renderStatic();
        tick();
      } else if (type === MSG.round) {
        if (!fin(d.round) || !fin(d.rounds) || !fin(d.startsAt) || !fin(d.now) || typeof d.over !== 'boolean') return;
        round = d as unknown as RoundMsg;
        roundAt = Date.now();
        drinksOn = !!round.drinks;
        if (round.over) { hideCard(); stopStick(); setPeek(false); }
        renderStatic();
      } else if (type === MSG.me) {
        const m = d as unknown as MeMsg;
        if (!fin(m.x) || !fin(m.z)) return;
        const h = PLAZA_SIZE / 2;
        const px = (Math.max(-h, Math.min(h, m.x)) + h) / PLAZA_SIZE;
        const pz = (Math.max(-h, Math.min(h, m.z)) + h) / PLAZA_SIZE;
        el.dot.hidden = false;
        el.dot.style.left = `${px * 100}%`;
        el.dot.style.top = `${pz * 100}%`;
      }
    },
    onRoomState() {
      if (pad) renderStatic();
    },
    destroy() {
      clearInterval(moveTimer);
      clearInterval(uiTimer);
      clearTimeout(cardTimer);
      document.removeEventListener('visibilitychange', onHide);
      pad?.remove();
      style?.remove();
      pad = null;
      style = null;
    },
  };

  function onHide() {
    if (document.hidden) { setPeek(false); stopStick(); }
  }
});
