import * as THREE from 'three';
import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { GRID_D, GRID_W, type Item, type RoundState, type Score } from '../common.ts';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text; // always textContent: guesses and names are plain text
  return e;
};

const STYLE = `
.pic{display:grid;grid-template-columns:1fr 300px;grid-template-rows:auto 1fr;gap:12px;height:100%;padding:12px;box-sizing:border-box;color:#fff;font-family:system-ui,sans-serif}
.pic .top{grid-column:1/3;display:flex;justify-content:space-between;align-items:baseline;gap:16px}
.pic .hint{font-size:44px;letter-spacing:4px;font-family:ui-monospace,monospace;white-space:pre}
.pic .meta{font-size:22px;opacity:.8}
.pic .stage{position:relative;min-height:0;border-radius:12px;overflow:hidden;background:#1b2a3a}
.pic canvas{width:100%;height:100%;display:block}
.pic .overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(10,15,25,.8);text-align:center;gap:10px}
.pic .overlay[hidden]{display:none}
.pic .overlay .big{font-size:64px;font-weight:700}
.pic .side{display:flex;flex-direction:column;gap:12px;min-height:0}
.pic ol,.pic ul{margin:0;padding:0;list-style:none}
.pic .scores li{display:flex;justify-content:space-between;font-size:22px;padding:3px 0}
.pic .scores li.drawer .name::after{content:' \\270E'}
.pic .feed{flex:1;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;font-size:20px}
.pic .feed li{padding:2px 0;opacity:.9}
.pic .feed b{opacity:.7;margin-right:6px}
`;

registerHost(info, (): TvGame => {
  let raf = 0;
  let renderer: THREE.WebGLRenderer | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let ro: ResizeObserver | undefined;
  let styleEl: HTMLStyleElement | undefined;
  let handle: ((type: string, data: any) => void) | undefined;

  return {
    mount(ctx) {
      const root = ctx.root;
      root.textContent = '';
      styleEl = el('style');
      styleEl.textContent = STYLE;
      const wrap = el('div', 'pic');
      const hint = el('div', 'hint');
      hint.id = 'pic-hint';
      const meta = el('div', 'meta');
      meta.id = 'pic-meta';
      const top = el('div', 'top');
      top.append(hint, meta);
      const stage = el('div', 'stage');
      const canvas = el('canvas');
      const overlay = el('div', 'overlay');
      overlay.id = 'pic-overlay';
      overlay.hidden = true;
      stage.append(canvas, overlay);
      const side = el('div', 'side');
      const scoresUl = el('ul', 'scores');
      scoresUl.id = 'pic-scores';
      const feed = el('ul', 'feed');
      feed.id = 'pic-feed';
      side.append(el('h3', '', 'Scores'), scoresUl, feed);
      wrap.append(top, stage, side);
      root.append(styleEl, wrap);

      // three.js scene: a slowly turning stage with the drawn blocks
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1b2a3a);
      const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      cam.position.set(0, 7, 14);
      cam.lookAt(0, 3.5, 0);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(6, 12, 8);
      scene.add(sun);
      const spin = new THREE.Group();
      scene.add(spin);
      const floor = new THREE.Mesh(
        new THREE.CylinderGeometry(7, 7, 0.2, 48),
        new THREE.MeshStandardMaterial({ color: 0x2f4a63 }),
      );
      floor.position.y = -0.1;
      spin.add(floor);
      const blocks = new THREE.Group();
      spin.add(blocks);
      const geos = {
        cube: new THREE.BoxGeometry(1, 1, 1),
        sphere: new THREE.SphereGeometry(0.5, 24, 16),
        cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
      };
      const mats = new Map<string, THREE.MeshStandardMaterial>();
      let itemCount = 0;
      const drawScene = (items: Item[]) => {
        blocks.clear();
        itemCount = items.length;
        for (const it of items) {
          let m = mats.get(it.color);
          if (!m) mats.set(it.color, (m = new THREE.MeshStandardMaterial({ color: it.color, roughness: 0.6 })));
          const mesh = new THREE.Mesh(geos[it.shape], m);
          mesh.scale.setScalar(it.size);
          mesh.position.set(it.x + it.size / 2 - GRID_W / 2, it.y + it.size / 2, it.z + 0.5 - GRID_D / 2);
          blocks.add(mesh);
        }
        canvas.dataset.items = String(itemCount);
      };
      const resize = () => {
        const w = stage.clientWidth || 640;
        const h = stage.clientHeight || 360;
        renderer!.setSize(w, h, false);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      };
      ro = new ResizeObserver(resize);
      ro.observe(stage);
      resize();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        spin.rotation.y += 0.004;
        renderer!.render(scene, cam);
      };
      loop();

      // state from the server part
      let cur: RoundState | undefined;
      let at = 0;
      const renderScores = (list: Score[], drawerId: string | null) => {
        scoresUl.replaceChildren(
          ...list.map((s) => {
            const li = el('li', s.id === drawerId ? 'drawer' : '');
            li.append(el('span', 'name', s.name), el('span', 'pts', String(s.score)));
            return li;
          }),
        );
      };
      const renderTimer = () => {
        if (!cur) return;
        const left = Math.max(0, cur.endsInMs - (Date.now() - at));
        const label = cur.phase === 'drawing' ? `${Math.ceil(left / 1000)}s` : '';
        meta.textContent = `Round ${cur.round}/${cur.rounds}  ${cur.phase === 'drawing' ? `${cur.drawerName} is drawing  ` : ''}${label}`;
      };
      const onState = (s: RoundState) => {
        cur = s;
        at = Date.now();
        hint.textContent = s.phase === 'drawing' ? s.hint : '';
        renderScores(s.scores, s.drawerId);
        overlay.hidden = s.phase === 'drawing';
        overlay.replaceChildren();
        if (s.phase === 'reveal') {
          overlay.append(
            el('div', '', s.winnerName ? `${s.winnerName} got it!` : "Time's up"),
            el('div', 'big', s.word ?? ''),
          );
        } else if (s.phase === 'final') {
          overlay.append(el('div', 'big', 'Final scores'));
          const ol = el('ol', 'scores');
          for (const p of s.scores) {
            const li = el('li');
            li.append(el('span', 'name', p.name), el('span', 'pts', String(p.score)));
            ol.append(li);
          }
          overlay.append(ol, el('div', '', 'The leader taps End game on their phone to go back to the lobby.'));
        }
        if (s.phase === 'drawing') feed.replaceChildren();
        renderTimer();
        wrap.dataset.phase = s.phase;
      };
      tick = setInterval(renderTimer, 250);

      handle = (type, data) => {
        if (type === 'state') onState(data as RoundState);
        else if (type === 'scene') drawScene((data as { items: Item[] }).items ?? []);
        else if (type === 'guess') {
          const li = el('li');
          li.append(el('b', '', String(data.name ?? '')), el('span', 'text', String(data.text ?? '')));
          feed.append(li);
          while (feed.children.length > 8) feed.firstChild!.remove();
        }
      };
      // Ask the server part for the current state (also after a TV reload).
      ctx.toServer('tv-ready');
    },
    onPhoneMessage(from, type, data) {
      // Server-part messages arrive with from = "server". Ignore anything a phone sends to the TV.
      if (from === 'server') handle?.(type, data);
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearInterval(tick);
      ro?.disconnect();
      renderer?.dispose();
      styleEl?.remove();
      handle = undefined;
    },
  };
});
