import * as THREE from 'three';
import { registerHost } from '../../../shared/registry.ts';
import type { TvGame } from '../../../shared/games.ts';
import { info } from '../info.ts';
import { BOARD_HALF, HOLE_R, MARBLE_R, MAX_TILT_RAD, STEP, newMarble, step, type Hole, type Vec2 } from '../physics.ts';

const RESPAWN_MS = 1400;

// TV part: draws the board, runs the physics, reports which hole the marble fell into.
// It never learns who wants which hole.
registerHost(info, (): TvGame => {
  let renderer: THREE.WebGLRenderer | undefined;
  let raf = 0;
  let hud: HTMLElement;
  let msgEl: HTMLElement;
  let timeEl: HTMLElement;
  let onResize: (() => void) | undefined;

  let holes: Hole[] = [];
  let startsAt = 0;
  let endsAt = 0;
  let skew = 0; // server clock minus local clock
  let over = false;
  let tilt: Vec2 = { x: 0, z: 0 };
  let boardTilt: Vec2 = { x: 0, z: 0 }; // smoothed, for drawing
  const marble = newMarble();
  let fallenAt = 0; // 0 = rolling
  let fallenHole = -1;

  let board: THREE.Group;
  let ball: THREE.Mesh;
  let holeGroup: THREE.Group;

  const serverNow = () => Date.now() + skew;

  function buildHoles() {
    holeGroup.clear();
    const geo = new THREE.CircleGeometry(HOLE_R, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x05060a });
    holes.forEach((h) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(h.x, 0.52, h.z);
      holeGroup.add(m);
      const ring = new THREE.Mesh(new THREE.RingGeometry(HOLE_R, HOLE_R + 0.08, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
      ring.position.set(h.x, 0.53, h.z);
      holeGroup.add(ring);
    });
  }

  function respawn() {
    Object.assign(marble, newMarble());
    fallenAt = 0;
    fallenHole = -1;
  }

  return {
    mount(ctx) {
      const root = ctx.root;
      root.textContent = '';
      root.style.position = 'relative';
      hud = document.createElement('div');
      hud.style.cssText = 'position:absolute;inset:0;pointer-events:none;color:#fff;font-family:system-ui,sans-serif;text-shadow:0 2px 6px #000;';
      timeEl = document.createElement('div');
      timeEl.id = 'tilt-time';
      timeEl.style.cssText = 'position:absolute;top:16px;left:0;right:0;text-align:center;font-size:48px;font-weight:700;';
      msgEl = document.createElement('div');
      msgEl.id = 'tilt-msg';
      msgEl.style.cssText = 'position:absolute;bottom:24px;left:0;right:0;text-align:center;font-size:28px;';
      msgEl.textContent = 'Waiting for the round...';
      hud.append(timeEl, msgEl);

      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.domElement.id = 'tilt-canvas';
      renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';
      root.append(renderer.domElement, hud);

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x10131c);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 13, 9);
      camera.lookAt(0, 0, 0.5);
      scene.add(new THREE.AmbientLight(0xffffff, 0.8));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(4, 10, 6);
      scene.add(sun);

      board = new THREE.Group();
      const slab = new THREE.Mesh(new THREE.BoxGeometry(BOARD_HALF * 2, 1, BOARD_HALF * 2), new THREE.MeshStandardMaterial({ color: 0x2c7a5b, roughness: 0.8 }));
      slab.position.y = 0;
      board.add(slab);
      const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b });
      for (const [w, d, x, z] of [[BOARD_HALF * 2 + 0.4, 0.2, 0, BOARD_HALF + 0.1], [BOARD_HALF * 2 + 0.4, 0.2, 0, -BOARD_HALF - 0.1], [0.2, BOARD_HALF * 2, BOARD_HALF + 0.1, 0], [0.2, BOARD_HALF * 2, -BOARD_HALF - 0.1, 0]]) {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 0.8, d), wallMat);
        wall.position.set(x, 0.7, z);
        board.add(wall);
      }
      holeGroup = new THREE.Group();
      board.add(holeGroup);
      ball = new THREE.Mesh(new THREE.SphereGeometry(MARBLE_R, 24, 16), new THREE.MeshStandardMaterial({ color: 0xe8edf5, metalness: 0.6, roughness: 0.25 }));
      board.add(ball);
      scene.add(board);

      onResize = () => {
        const w = root.clientWidth || innerWidth;
        const h = root.clientHeight || innerHeight;
        renderer!.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      addEventListener('resize', onResize);
      onResize();

      let last = performance.now();
      let acc = 0;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        acc += Math.min(0.1, (now - last) / 1000);
        last = now;
        const t = serverNow();
        const playing = holes.length > 0 && t >= startsAt && t < endsAt && !over;
        if (!playing && !over) {
          if (holes.length && t < startsAt) timeEl.textContent = `Starts in ${Math.ceil((startsAt - t) / 1000)}`;
        }
        while (acc >= STEP) {
          acc -= STEP;
          if (!playing) continue;
          if (fallenAt) {
            if (now - fallenAt > RESPAWN_MS) respawn();
            continue;
          }
          const f = step(marble, tilt, holes);
          if (f >= 0) {
            fallenAt = now;
            fallenHole = f;
            ctx.toServer('fell', { hole: f });
            msgEl.textContent = `Marble fell into hole ${f + 1}`;
          }
        }
        if (playing) {
          timeEl.textContent = String(Math.max(0, Math.ceil((endsAt - t) / 1000)));
          if (!fallenAt && msgEl.textContent !== 'Roll the marble into a hole') msgEl.textContent = 'Roll the marble into a hole';
        }
        // Draw
        boardTilt.x += (tilt.x - boardTilt.x) * 0.2;
        boardTilt.z += (tilt.z - boardTilt.z) * 0.2;
        board.rotation.z = -boardTilt.x * MAX_TILT_RAD;
        board.rotation.x = boardTilt.z * MAX_TILT_RAD;
        if (fallenAt && fallenHole >= 0) {
          const k = Math.min(1, (now - fallenAt) / 500);
          const h = holes[fallenHole];
          ball.position.set(h.x, 0.5 + MARBLE_R - k * 0.9, h.z);
          ball.scale.setScalar(1 - 0.5 * k);
        } else {
          ball.position.set(marble.x, 0.5 + MARBLE_R, marble.z);
          ball.scale.setScalar(1);
        }
        renderer!.render(scene, camera);
      };
      raf = requestAnimationFrame(frame);
      // Ask the server for the layout (covers a TV reload mid-game).
      ctx.toServer('ready');
      (window as any).__tilt = { marble, get holes() { return holes; }, get tilt() { return tilt; } };
    },
    onPhoneMessage(from, type, data) {
      if (from !== 'server') return; // phones cannot spoof server messages
      const d = data as any;
      if (type === 'layout') {
        holes = Array.isArray(d.holes) ? d.holes : [];
        startsAt = d.startsAt;
        endsAt = d.endsAt;
        skew = d.now - Date.now();
        over = !!d.over;
        buildHoles();
        if (!fallenAt && !over) respawn();
      } else if (type === 'board') {
        tilt = { x: d.x, z: d.z };
      } else if (type === 'scored') {
        msgEl.textContent = `Marble fell into hole ${d.hole + 1}`;
      } else if (type === 'results') {
        over = true;
        timeEl.textContent = 'Time!';
        msgEl.replaceChildren();
        const ol = document.createElement('ol');
        ol.id = 'tilt-results';
        ol.style.cssText = 'display:inline-block;text-align:left;font-size:30px;margin:0;';
        for (const s of d.scores as { name: string; points: number }[]) {
          const li = document.createElement('li');
          li.textContent = `${s.name}: ${s.points}`;
          ol.append(li);
        }
        msgEl.append(ol);
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      if (onResize) removeEventListener('resize', onResize);
      renderer?.dispose();
      renderer?.domElement.remove();
      hud?.remove();
    },
  };
});
