import { registerPhone } from '../../../shared/registry.ts';
import type { PhoneGame } from '../../../shared/games.ts';
import { enableTilt, onTilt } from '../../../web/common/tilt.ts';
import { info } from '../info.ts';
import { BOARD_HALF, HOLE_R, type Hole, type Vec2 } from '../physics.ts';

const SEND_GAP_MS = 50;
const DEG_FULL = 25; // phone angle that counts as full tilt

registerPhone(info, (): PhoneGame => {
  let root: HTMLElement;
  let ctx: Parameters<PhoneGame['mount']>[0];
  let status: HTMLElement;
  let scoreEl: HTMLElement;
  let timeEl: HTMLElement;
  let canvas: HTMLCanvasElement;
  let holes: Hole[] = [];
  let goal = -1;
  let flash = -1;
  let endsAt = 0;
  let skew = 0;
  let over = false;
  let results: { name: string; points: number }[] | null = null;
  let tick: number | undefined;
  let stopTilt: (() => void) | undefined;
  let source: 'tilt' | 'pad' = 'tilt';
  let sensor: Vec2 = { x: 0, z: 0 };
  let padVal: Vec2 = { x: 0, z: 0 };
  let base: { beta: number; gamma: number } | null = null;
  let sent: Vec2 = { x: NaN, z: NaN };
  let lastSent = 0;
  let trail: number | undefined;

  const clamp = (v: number) => Math.max(-1, Math.min(1, v));

  function push() {
    const v = source === 'pad' ? padVal : sensor;
    if (v.x === sent.x && v.z === sent.z) return;
    const wait = lastSent + SEND_GAP_MS - Date.now();
    if (wait > 0) {
      if (trail === undefined) trail = window.setTimeout(() => { trail = undefined; push(); }, wait);
      return;
    }
    lastSent = Date.now();
    sent = { x: v.x, z: v.z };
    ctx.toServer('tilt', sent);
  }

  function draw() {
    const g = canvas.getContext('2d');
    if (!g) return;
    const S = canvas.width;
    const k = S / (BOARD_HALF * 2);
    g.fillStyle = '#1d5a43';
    g.fillRect(0, 0, S, S);
    holes.forEach((h, i) => {
      const x = (h.x + BOARD_HALF) * k;
      const z = (h.z + BOARD_HALF) * k;
      g.beginPath();
      g.arc(x, z, HOLE_R * k, 0, Math.PI * 2);
      g.fillStyle = i === goal ? '#f2c14e' : '#0a0c12';
      g.fill();
      if (i === flash) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.stroke(); }
    });
  }

  function render() {
    if (results) {
      status.textContent = 'Final scores';
      return;
    }
    status.textContent = goal >= 0 ? 'Your hole is the gold one. Keep it secret.' : 'Waiting...';
  }

  return {
    mount(c) {
      ctx = c;
      root = c.root;
      root.textContent = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px;';
      timeEl = document.createElement('div');
      timeEl.id = 'tilt-phone-time';
      timeEl.style.cssText = 'font-size:28px;font-weight:700;';
      status = document.createElement('div');
      status.id = 'tilt-status';
      scoreEl = document.createElement('div');
      scoreEl.id = 'tilt-score';
      scoreEl.textContent = 'Score: 0';
      canvas = document.createElement('canvas');
      canvas.id = 'tilt-map';
      canvas.width = canvas.height = 240;
      canvas.style.cssText = 'width:min(60vw,240px);border-radius:8px;';
      const row = document.createElement('div');
      const en = document.createElement('button');
      en.id = 'tilt-enable';
      en.textContent = 'Enable tilt';
      const lvl = document.createElement('button');
      lvl.id = 'tilt-level';
      lvl.textContent = 'Set level';
      row.append(en, lvl);
      const pad = document.createElement('div');
      pad.id = 'tilt-pad';
      pad.textContent = 'Or drag here';
      pad.style.cssText = 'width:min(60vw,220px);height:min(60vw,220px);border:2px dashed #888;border-radius:12px;display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;';
      wrap.append(timeEl, status, scoreEl, canvas, row, pad);
      root.append(wrap);

      const setPad = (e: PointerEvent) => {
        const r = pad.getBoundingClientRect();
        padVal = {
          x: clamp(((e.clientX - r.left) / r.width - 0.5) * 2),
          z: clamp(((e.clientY - r.top) / r.height - 0.5) * 2),
        };
        source = 'pad';
        push();
      };
      pad.addEventListener('pointerdown', (e) => { pad.setPointerCapture(e.pointerId); setPad(e); });
      pad.addEventListener('pointermove', (e) => { if (pad.hasPointerCapture(e.pointerId)) setPad(e); });
      const release = () => { padVal = { x: 0, z: 0 }; push(); source = 'tilt'; push(); };
      pad.addEventListener('pointerup', release);
      pad.addEventListener('pointercancel', release);

      en.onclick = async () => {
        const r = await enableTilt();
        en.textContent = r === 'granted' ? 'Tilt on' : r === 'denied' ? 'Tilt blocked' : 'No tilt sensor';
        if (r === 'granted' && !stopTilt) {
          stopTilt = onTilt((t) => {
            if (!base) base = { beta: t.beta, gamma: t.gamma };
            // Right edge down (gamma +) rolls the marble right. Top edge up (beta +) rolls it toward the player.
            sensor = { x: clamp((t.gamma - base.gamma) / DEG_FULL), z: clamp((t.beta - base.beta) / DEG_FULL) };
            if (source === 'tilt') push();
          });
        }
      };
      lvl.onclick = () => { base = null; };

      tick = window.setInterval(() => {
        // Keepalive: the server drops a tilt it has not heard from in 2 s.
        const v = source === 'pad' ? padVal : sensor;
        if (!over && (v.x !== 0 || v.z !== 0)) { sent = { x: NaN, z: NaN }; push(); }
        if (over || !endsAt) return;
        const left = Math.ceil((endsAt - (Date.now() + skew)) / 1000);
        timeEl.textContent = left > 0 ? String(left) : '';
      }, 500);
      render();
      draw();
    },
    onMessage(type, data) {
      const d = data as any;
      if (type === 'goal') {
        goal = d.hole;
        holes = d.holes;
        endsAt = d.endsAt;
        skew = d.now - Date.now();
        over = !!d.over;
        scoreEl.textContent = `Score: ${d.points}`;
        sent = { x: NaN, z: NaN }; // server may have restarted: send tilt again
        render();
        draw();
      } else if (type === 'score') {
        scoreEl.textContent = `Score: ${d.points}`;
        navigator.vibrate?.(200);
      } else if (type === 'fell') {
        flash = d.hole;
        draw();
        setTimeout(() => { flash = -1; draw(); }, 800);
      } else if (type === 'results') {
        over = true;
        results = d.scores;
        timeEl.textContent = 'Time!';
        render();
        const ol = document.createElement('ol');
        ol.id = 'tilt-phone-results';
        for (const s of results!) {
          const li = document.createElement('li');
          li.textContent = `${s.name}: ${s.points}`;
          ol.append(li);
        }
        root.querySelector('#tilt-phone-results')?.remove();
        root.firstElementChild?.append(ol);
      }
    },
    destroy() {
      clearInterval(tick);
      clearTimeout(trail);
      stopTilt?.();
      root?.replaceChildren();
    },
  };
});
