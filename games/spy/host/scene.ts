import * as THREE from 'three';
import { CROWD_SIZE, PLAZA_SIZE } from '../types.ts';
import { FOUNTAIN_R } from '../crowd.ts';

export interface Drawable { x: number; z: number; color: number; fall: number; yaw: number }

export interface PlazaScene {
  renderer: THREE.WebGLRenderer;
  resize(w: number, h: number): void;
  draw(chars: Drawable[], tSec: number): void;
  dispose(): void;
}

const PALETTE = [0xd94f4f, 0x3f7fd9, 0x4fb36b, 0xe0b23a, 0x9a5bd0, 0xe07a3a, 0x3fc1c9, 0xd9669f, 0x8a8f99, 0xf0f0f0, 0x5a4a3a, 0x2b2f3a];
export const randomColor = (rng: () => number) => PALETTE[Math.floor(rng() * PALETTE.length)];

/** Plaza, low buildings, fountain, instanced crowd, slow orbiting camera. Primitive shapes only. */
export function buildScene(root: HTMLElement, low: boolean): PlazaScene {
  const renderer = new THREE.WebGLRenderer({ antialias: !low, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.domElement.id = 'spy-canvas';
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;';
  renderer.shadowMap.enabled = !low;
  root.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc4e8);
  scene.fog = new THREE.Fog(0x9fc4e8, 120, 260);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 400);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x70685a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
  sun.position.set(30, 50, 20);
  if (!low) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const c = sun.shadow.camera;
    c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 10; c.far = 140;
  }
  scene.add(sun);

  // Ground and paving
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6b7f5a, roughness: 1 }));
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);
  const paving = new THREE.Mesh(new THREE.BoxGeometry(PLAZA_SIZE, 0.1, PLAZA_SIZE), new THREE.MeshStandardMaterial({ color: 0xc9c2b2, roughness: 0.95 }));
  paving.position.y = -0.05;
  paving.receiveShadow = true;
  scene.add(paving);
  const tileMat = new THREE.MeshStandardMaterial({ color: 0xb4ad9d, roughness: 1 });
  for (let i = -2; i <= 2; i++) {
    for (const [w, d, x, z] of [[PLAZA_SIZE, 0.2, 0, i * 12], [0.2, PLAZA_SIZE, i * 12, 0]]) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(w, 0.02, d), tileMat);
      line.position.set(x, 0.01, z);
      scene.add(line);
    }
  }

  // Fountain
  const stone = new THREE.MeshStandardMaterial({ color: 0xa8a49a, roughness: 0.8 });
  const water = new THREE.MeshStandardMaterial({ color: 0x4aa3d8, roughness: 0.2, metalness: 0.1 });
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(FOUNTAIN_R, FOUNTAIN_R + 0.1, 0.7, 40), stone);
  basin.position.y = 0.35;
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(FOUNTAIN_R - 0.35, FOUNTAIN_R - 0.35, 0.72, 40), water);
  pool.position.y = 0.36;
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 2.4, 16), stone);
  column.position.y = 1.4;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 0.5, 0.4, 24), stone);
  bowl.position.y = 2.5;
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), water);
  top.position.y = 2.9;
  for (const m of [basin, pool, column, bowl, top]) {
    m.castShadow = !low;
    m.receiveShadow = !low;
    scene.add(m);
  }

  // Low buildings around the plaza edge (outside the walkable square)
  const half = PLAZA_SIZE / 2;
  const wall = [0xd9c7a3, 0xc98b6b, 0xb9c4cf, 0xe3d6b8, 0xa9b89a];
  let bi = 0;
  const addBuilding = (x: number, z: number, w: number, d: number, h: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: wall[bi++ % wall.length], roughness: 0.9 }));
    m.position.set(x, h / 2, z);
    m.castShadow = !low;
    m.receiveShadow = !low;
    scene.add(m);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.4, d + 0.6), new THREE.MeshStandardMaterial({ color: 0x7a4a3a, roughness: 0.9 }));
    roof.position.set(x, h + 0.2, z);
    roof.castShadow = !low;
    scene.add(roof);
  };
  for (let i = 0; i < 5; i++) {
    const t = -half + 6 + i * 12;
    const h = 5 + ((i * 7) % 4);
    addBuilding(t, -half - 5, 10, 8, h);
    addBuilding(t, half + 5, 10, 8, h + 1);
    addBuilding(-half - 5, t, 8, 10, h + 1);
    addBuilding(half + 5, t, 8, 10, h);
  }

  // Crowd: one instanced body and one instanced head. Every character has the same shape.
  const bodyGeo = new THREE.CylinderGeometry(0.28, 0.3, 1.15, 12).translate(0, 0.65, 0);
  const headGeo = new THREE.SphereGeometry(0.22, 12, 8).translate(0, 1.5, 0);
  const bodies = new THREE.InstancedMesh(bodyGeo, new THREE.MeshStandardMaterial({ roughness: 0.7 }), CROWD_SIZE);
  const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xe8c9a6, roughness: 0.8 }), CROWD_SIZE);
  for (const m of [bodies, heads]) {
    m.castShadow = !low;
    m.frustumCulled = false;
    m.count = 0;
    scene.add(m);
  }
  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';
  const col = new THREE.Color();

  let aspect = 1;
  let radius = 62;
  const resize = (w: number, h: number) => {
    renderer.setSize(w, h, false);
    aspect = w / Math.max(1, h);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    // Distance that keeps the plaza (diagonal ~85 m) in view on a narrow window too.
    radius = Math.max(62, 62 * (1.78 / Math.max(0.6, aspect)) * 0.8);
  };

  return {
    renderer,
    resize,
    draw(chars, tSec) {
      const n = Math.min(chars.length, CROWD_SIZE);
      bodies.count = heads.count = n;
      for (let i = 0; i < n; i++) {
        const c = chars[i];
        dummy.position.set(c.x, c.fall * 0.3, c.z);
        dummy.rotation.set(-c.fall * (Math.PI / 2), c.yaw, 0);
        dummy.updateMatrix();
        bodies.setMatrixAt(i, dummy.matrix);
        heads.setMatrixAt(i, dummy.matrix);
        bodies.setColorAt(i, col.setHex(c.color));
      }
      bodies.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      const a = tSec * 0.06; // one lap in about 105 s
      camera.position.set(Math.sin(a) * radius * 0.8, radius * 0.62, Math.cos(a) * radius * 0.8);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    },
    dispose() {
      const seen = new Set<{ dispose(): void }>();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) seen.add(m.geometry);
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) seen.add(x);
      });
      for (const x of seen) x.dispose();
      bodies.dispose();
      heads.dispose();
      sun.shadow.map?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
