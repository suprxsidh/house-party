import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { enableTilt, onTilt } from '../../../web/common/tilt.ts';
import { info } from '../info.ts';
import type { AssignMsg, RaceMsg, ResultRow } from '../shared.ts';
import { currentScreenAngle, steerFromTilt } from './steer.ts';

const CSS = `
#kart-pad{position:fixed;inset:0;z-index:100;background:#0b0e1a;color:#f2f4ff;display:grid;grid-template-rows:auto 1fr;
  touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;font-family:system-ui,sans-serif}
#kart-pad *{touch-action:none;user-select:none;-webkit-user-select:none}
#kart-pad .hud{display:flex;gap:2vmin;align-items:center;justify-content:space-between;padding:calc(env(safe-area-inset-top) + 1.5vmin) 3vmin 1vmin;font-weight:800}
#kart-pad .pos{font-size:9vmin;line-height:1}
#kart-pad .pos small{font-size:4vmin;opacity:.7}
#kart-pad .lap,#kart-pad .item{font-size:4.2vmin}
#kart-pad .chip{width:4vmin;height:4vmin;border-radius:50%;display:inline-block;vertical-align:middle;margin-right:1.2vmin;background:var(--kc,#888)}
#kart-pad .zones{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2vmin;padding:1vmin 3vmin calc(env(safe-area-inset-bottom) + 3vmin)}
#kart-pad .zone{border-radius:3vmin;display:flex;align-items:center;justify-content:center;font-size:5vmin;font-weight:900;background:#1a1f36;border:.6vmin solid #343b63}
#kart-pad .zone.on{background:#ffcf5a;color:#1b1500;border-color:#fff}
#kart-pad .steer{display:grid;grid-template-columns:1fr 1fr;gap:2vmin;background:none;border:0;padding:0}
#kart-pad .steer .zone{height:100%}
#kart-pad .tiltbox{flex-direction:column;gap:2vmin}
#kart-pad .gauge{position:relative;width:80%;height:3vmin;border-radius:2vmin;background:#343b63}
#kart-pad .gauge i{position:absolute;top:-1vmin;left:50%;width:5vmin;height:5vmin;margin-left:-2.5vmin;border-radius:50%;background:#ffcf5a}
#kart-pad .gas{font-size:7vmin}
#kart-pad .small{font-size:3.2vmin;font-weight:600;opacity:.85;text-align:center;padding:1vmin}
#kart-pad .msg{position:absolute;inset:0;display:flex;flex-direction:column;gap:3vmin;align-items:center;justify-content:center;background:#0b0e1aee;text-align:center;font-size:5vmin;font-weight:800;padding:6vmin}
#kart-pad .msg button{font-size:5vmin}
#kart-pad .res{font-size:3.6vmin;font-weight:600;list-style:none;padding:0;margin:0;max-height:55vh;overflow:auto;text-align:left}
#kart-pad .res li.me{color:#ffcf5a}
#kart-pad .endlink{position:absolute;left:50%;transform:translateX(-50%);bottom:0;font-size:3vmin;opacity:.6;background:none;color:#f2f4ff;padding:.4em .6em}
`;

const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
const ITEM_LABEL: Record<string, string> = {
  None: 'no item', Mushroom: 'Mushroom', TripleMushroom: '3 Mushrooms', GreenShell: 'Green shell', RedShell: 'Red shell',
  Banana: 'Banana', Star: 'Star', Bolt: 'Bolt', Bomb: 'Bomb',
};

registerPhone(info, (): PhoneGame => {
  let style: HTMLStyleElement | null = null;
  let pad: HTMLElement | null = null;
  let timers: ReturnType<typeof setInterval>[] = [];
  let offTilt: (() => void) | null = null;
  let wake: { release(): Promise<void> } | null = null;
  let toTv: (type: string, data?: unknown) => void = () => {};
  let meId = '';
  let tiltSteer = 0;
  let lastTiltAt = 0;
  let tiltWanted = false;
  let btnL = false;
  let btnR = false;
  let gas = false;
  let itemCount = 0; // taps so far; the TV counts them so none is lost
  let lastSent = '';
  let lastSentAt = 0;
  let assign: AssignMsg | null = null;
  let autoEnd: ReturnType<typeof setTimeout> | null = null;
  const el: Record<string, HTMLElement> = {};

  const tiltLive = () => tiltWanted && Date.now() - lastTiltAt < 1000;
  const steerNow = () => (tiltLive() ? tiltSteer : (btnR ? 1 : 0) - (btnL ? 1 : 0));

  function send(force = false) {
    const s = Math.round(steerNow() * 100) / 100;
    const g = gas ? 1 : 0;
    const key = `${s}|${g}|${itemCount}`;
    const now = Date.now();
    if (!force && key === lastSent && now - lastSentAt < 250) return; // keep-alive every 250 ms
    lastSent = key;
    lastSentAt = now;
    toTv('input', { s, g, i: itemCount });
  }

  function hold(node: HTMLElement, set: (on: boolean) => void) {
    const ids = new Set<number>();
    const down = (e: PointerEvent) => {
      e.preventDefault();
      ids.add(e.pointerId);
      try { node.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      node.classList.add('on');
      set(true);
      send(true);
    };
    const up = (e: PointerEvent) => {
      ids.delete(e.pointerId);
      if (ids.size === 0) {
        node.classList.remove('on');
        set(false);
        send(true);
      }
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);
  }

  function zone(cls: string, text: string, parent: HTMLElement) {
    const z = document.createElement('div');
    z.className = `zone ${cls}`;
    z.textContent = text;
    parent.append(z);
    return z;
  }

  function showMsg(build: (box: HTMLElement) => void) {
    el.msg?.remove();
    const box = document.createElement('div');
    box.className = 'msg';
    build(box);
    pad!.append(box);
    el.msg = box;
  }
  const clearMsg = () => { el.msg?.remove(); delete el.msg; };

  function renderHud(r: RaceMsg) {
    const mine = r.rows.find((x) => x.seat === meId);
    if (!mine) {
      el.pos.textContent = '-';
      el.lap.textContent = 'Watching';
      el.item.textContent = 'Race in progress';
      return;
    }
    el.pos.replaceChildren(document.createTextNode(String(mine.place)), Object.assign(document.createElement('small'), { textContent: ord(mine.place).slice(String(mine.place).length) }));
    const lapNo = Math.min(r.laps, Math.max(1, mine.lap + (mine.finished ? 0 : 1)));
    el.lap.textContent = mine.finished ? 'Finished' : `Lap ${lapNo}/${r.laps}`;
    const label = ITEM_LABEL[mine.item] ?? mine.item;
    el.item.textContent = mine.item === 'None' ? 'Item: none' : `Item: ${label}`;
    if (r.phase === 'countdown') {
      if (!el.msg) {
        showMsg((b) => { b.dataset.kind = 'count'; b.style.pointerEvents = 'none'; b.textContent = 'Get ready. Hold GAS at the lights.'; });
      }
    } else if (el.msg?.dataset.kind === 'count') clearMsg();
  }

  function showResults(order: ResultRow[]) {
    showMsg((b) => {
      b.dataset.kind = 'results';
      const h = document.createElement('div');
      h.textContent = 'Race over';
      const ul = document.createElement('ol');
      ul.className = 'res';
      for (const r of order) {
        const li = document.createElement('li');
        if (r.seat === meId) li.className = 'me';
        li.textContent = `${r.place}. ${r.name}${r.human ? '' : ' (AI)'}${r.time != null ? `  ${r.time.toFixed(1)}s` : ''}`;
        ul.append(li);
      }
      const back = document.createElement('button');
      back.type = 'button';
      back.id = 'kart-back';
      back.textContent = 'Back to lobby';
      back.onclick = () => (document.getElementById('end-game') as HTMLButtonElement | null)?.click();
      b.append(h, ul, back);
    });
    // The leader's phone returns everyone to the lobby after a short look at the board.
    if (autoEnd) clearTimeout(autoEnd);
    autoEnd = setTimeout(() => {
      const bar = document.getElementById('game-bar');
      if (bar && !bar.hidden) (document.getElementById('end-game') as HTMLButtonElement | null)?.click();
    }, 15000);
  }

  async function turnOnTilt() {
    const r = await enableTilt();
    tiltWanted = r === 'granted';
    el.tiltStatus.textContent = tiltWanted ? 'Tilt on' : r === 'denied' ? 'Tilt blocked. Use the buttons.' : 'No tilt here. Use the buttons.';
    if (el.msg?.dataset.kind === 'tilt') clearMsg();
    updateSteerUi();
  }

  function updateSteerUi() {
    const tilt = tiltLive();
    el.steerBtns.hidden = tilt;
    el.tiltBox.hidden = !tilt;
    const s = steerNow();
    (el.gaugeKnob as HTMLElement).style.left = `${50 + s * 42}%`;
  }

  return {
    mount(ctx) {
      toTv = ctx.toTv;
      meId = ctx.me.id;
      style = document.createElement('style');
      style.textContent = CSS;
      document.head.append(style);

      pad = document.createElement('div');
      pad.id = 'kart-pad';
      pad.innerHTML = `
        <div class="hud"><div class="pos"></div><div class="lap"></div><div class="item"></div></div>
        <div class="zones">
          <div class="zone steer"></div>
          <div class="zone item-btn"></div>
          <div class="zone gas-btn"></div>
        </div>`;
      document.body.append(pad);
      const q = <T extends HTMLElement>(s: string) => pad!.querySelector(s) as T;
      el.pos = q('.pos'); el.lap = q('.lap'); el.item = q('.item');
      const steerZone = q('.steer');
      el.steerBtns = steerZone;
      const left = zone('left', '< LEFT', steerZone);
      const right = zone('right', 'RIGHT >', steerZone);
      hold(left, (on) => (btnL = on));
      hold(right, (on) => (btnR = on));
      // tilt view replaces the two buttons while the sensor is live
      const tb = document.createElement('div');
      tb.className = 'zone tiltbox';
      tb.innerHTML = '<div>TILT TO STEER</div><div class="gauge"><i></i></div>';
      tb.hidden = true;
      steerZone.after(tb);
      el.tiltBox = tb;
      el.gaugeKnob = tb.querySelector('i') as HTMLElement;
      const itemZone = q('.item-btn');
      itemZone.textContent = 'ITEM';
      itemZone.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        itemZone.classList.add('on');
        itemCount++;
        send(true);
      });
      const clearItem = () => itemZone.classList.remove('on');
      itemZone.addEventListener('pointerup', clearItem);
      itemZone.addEventListener('pointercancel', clearItem);
      const gasZone = q('.gas-btn');
      gasZone.classList.add('gas');
      gasZone.textContent = 'GAS';
      hold(gasZone, (on) => (gas = on));

      el.tiltStatus = document.createElement('div');
      el.tiltStatus.className = 'small';
      tb.append(el.tiltStatus);

      // let the leader leave a stuck race
      const endLink = document.createElement('button');
      endLink.type = 'button';
      endLink.className = 'endlink';
      endLink.textContent = 'end race';
      endLink.onclick = () => (document.getElementById('end-game') as HTMLButtonElement | null)?.click();
      pad.append(endLink);

      offTilt = onTilt((t) => {
        lastTiltAt = Date.now();
        tiltSteer = steerFromTilt(t.beta, t.gamma, currentScreenAngle());
      });

      // iPhones need a tap before tilt works, and again after every reload.
      const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: unknown } }).DeviceOrientationEvent;
      if (D && typeof D.requestPermission === 'function') {
        showMsg((b) => {
          b.dataset.kind = 'tilt';
          const t = document.createElement('div');
          t.textContent = 'Tap to turn on tilt steering';
          const go = document.createElement('button');
          go.type = 'button';
          go.id = 'kart-tilt';
          go.textContent = 'Enable tilt';
          go.onclick = () => void turnOnTilt();
          const skip = document.createElement('button');
          skip.type = 'button';
          skip.className = 'ghost';
          skip.textContent = 'Use buttons instead';
          skip.onclick = clearMsg;
          b.append(t, go, skip);
        });
      } else {
        void turnOnTilt(); // Android and desktop: no tap needed
      }

      try {
        const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
        void nav.wakeLock?.request('screen').then((w) => (wake = w)).catch(() => {});
      } catch { /* not supported */ }

      timers.push(setInterval(() => { send(); updateSteerUi(); }, 50));
      toTv('hello'); // the TV answers with our kart and colour
    },
    onMessage(type, data) {
      if (type === 'assign') {
        assign = data as AssignMsg;
        pad?.style.setProperty('--kc', assign.color);
        if (assign.kart === null) {
          el.lap.textContent = 'Watching';
        } else {
          el.lap.dataset.kart = String(assign.kart);
        }
        if (el.pos && !el.pos.textContent) el.pos.textContent = '-';
      } else if (type === 'race') {
        renderHud(data as RaceMsg);
      } else if (type === 'results') {
        showResults((data as { order: ResultRow[] }).order ?? []);
      }
    },
    destroy() {
      timers.forEach(clearInterval);
      timers = [];
      if (autoEnd) clearTimeout(autoEnd);
      offTilt?.();
      void wake?.release();
      pad?.remove();
      style?.remove();
      pad = null;
      style = null;
    },
  };
});
