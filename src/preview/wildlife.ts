/**
 * Marine wildlife models preview: the dolphin, humpback, gull (flying and perched) and harbour
 * seal on a calm sea plane under the real sky, lights and environment map, animated by the same
 * vertex shaders as in the game. URL parameters:
 *   show   all (default) | dolphin | whale | gull | seal
 *   flap   0..1 gull flapping (default 1), fold 0..1 (perched), arch / lift (whale), beat 0..1
 *   pitch  whale pitch (deg), dy whale centre height (m)
 *   dist, az, el   orbit (m, deg, deg) around tx, ty, tz;  tod  time-of-day preset;  t freeze time (s)
 * window.__ready, window.__renderer, window.__tris.
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { CONFIG } from '../config';
import { buildDolphin, buildGull, buildSeal, buildWhale, DOLPHIN_LENGTH, SEAL_LENGTH, WHALE_LENGTH } from '../world/wildlife/models';
import { createAnimalMaterial, createUnderwaterMaterial } from '../world/wildlife/material';
import { poseMatrix } from '../world/traffic/points';

declare global {
  interface Window {
    __ready: boolean;
    __renderer: THREE.WebGLRenderer;
    __tris: number;
  }
}
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
window.__ready = false;

interface Item {
  mesh: THREE.InstancedMesh;
  anim: THREE.InstancedBufferAttribute;
  set(t: number): void;
}

function item(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, place: (i: number, m: THREE.Matrix4) => void, anim: (i: number, t: number) => [number, number, number, number]): Item {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  geo.setAttribute('aAnim', a);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    place(i, m);
    mesh.setMatrixAt(i, m);
  }
  mesh.frustumCulled = false;
  return {
    mesh,
    anim: a,
    set(t) {
      for (let i = 0; i < n; i++) a.setXYZW(i, ...anim(i, t));
      a.needsUpdate = true;
    },
  };
}

async function main() {
  const container = document.getElementById('app')!;
  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  window.__renderer = renderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  scene.add(camera);
  const atmo = createAtmosphere(renderer, scene, { groundHeight: () => -50 });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0d2a36, roughness: 0.12, metalness: 0 }));
  scene.add(sea);
  const show = q.get('show') ?? 'all';
  const items: Item[] = [];
  let tris = 0;
  const add = (it: Item) => {
    items.push(it);
    scene.add(it.mesh);
    tris += (it.mesh.geometry.index!.count / 3) * it.mesh.count;
  };
  const flap = num('flap', 1);
  const beat = num('beat', 0.6);
  if (show === 'all' || show === 'dolphin') {
    const mat = createAnimalMaterial({ kind: 'cetacean', length: DOLPHIN_LENGTH, roughness: 0.5, name: 'p.dolphin' });
    add(item(buildDolphin(), mat, 3, (i, m) => poseMatrix(m, -6 + i * 3.2, [0.35, 0.05, 1.6][i], i * 1.2, 90, [0, 5, 35][i], [0, 20, 0][i], 1), (i, t) => [t * 8 + i, beat, 0, 0]));
  }
  if (show === 'under') {
    // submerged dolphins seen through the water (the silhouette pass) and one at the surface
    const mat = createAnimalMaterial({ kind: 'cetacean', length: DOLPHIN_LENGTH, roughness: 0.5, name: 'p.dolphin' });
    const depths = [-0.4, -0.9, -1.6, 0.05];
    const it = item(buildDolphin(), mat, 4, (i, m) => poseMatrix(m, -5 + i * 3.3, depths[i], 0, 90, 0, 0, 1), (i, t) => [t * 8 + i, beat, 0, 0]);
    add(it);
    const surf = new THREE.InstancedBufferAttribute(new Float32Array(4 * 4), 4);
    for (let i = 0; i < 4; i++) surf.setXYZW(i, 0, 0.12, 1.3, 0);
    it.mesh.geometry.setAttribute('aSurf', surf);
    const um = new THREE.InstancedMesh(it.mesh.geometry, createUnderwaterMaterial({ length: DOLPHIN_LENGTH, name: 'p.under' }), 4);
    um.instanceMatrix = it.mesh.instanceMatrix;
    um.renderOrder = 5;
    um.frustumCulled = false;
    scene.add(um);
  }
  if (show === 'all' || show === 'whale') {
    const mat = createAnimalMaterial({ kind: 'cetacean', length: WHALE_LENGTH, roughness: 0.62, name: 'p.whale' });
    add(item(buildWhale(), mat, 1, (_i, m) => poseMatrix(m, show === 'whale' ? 0 : 14, num('dy', 0.2), show === 'whale' ? 0 : -18, 90, num('pitch', 0), num('roll', 0), 1), (_i, t) => [t * 1.5, beat * 0.4, num('arch', 0), num('lift', 0)]));
  }
  if (show === 'all' || show === 'gull') {
    const mat = createAnimalMaterial({ kind: 'gull', length: 0.6, roughness: 0.85, name: 'p.gull' });
    add(
      item(
        buildGull(),
        mat,
        3,
        (i, m) => poseMatrix(m, show === 'gull' ? (i - 1) * 1.6 : -2 + i * 1.8, show === 'gull' ? 1.2 : 3, show === 'gull' ? 0 : 4, [90, 250, 140][i], [0, 0, 8][i], [0, -20, 0][i], 1),
        (i, t) => [t * 18 + i * 2, i === 2 ? 0 : flap * (i === 1 ? 0.2 : 1), i === 2 ? num('fold', 1) : 0, 0],
      ),
    );
  }
  if (show === 'all' || show === 'seal') {
    const mat = createAnimalMaterial({ kind: 'seal', length: SEAL_LENGTH, roughness: 0.45, name: 'p.seal' });
    const rock = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.9 }));
    const rx = show === 'seal' ? 0 : 6;
    const rz = show === 'seal' ? 0 : 10;
    rock.position.set(rx, 0.1, rz);
    scene.add(rock);
    add(item(buildSeal(), mat, 2, (i, m) => poseMatrix(m, rx - 1 + i * 2.2, 0.72, rz + i, [60, 200][i], 0, 0, 1), (i, t) => [0, i ? 1 : 0, i ? 0.2 : 1, i ? 0 : Math.sin(t)]));
  }
  window.__tris = Math.round(tris);
  const az = (num('az', 200) * Math.PI) / 180;
  const el = (num('el', 14) * Math.PI) / 180;
  const d = num('dist', show === 'all' ? 42 : show === 'whale' ? 30 : show === 'gull' ? 5 : show === 'under' ? 14 : 9);
  const tx = num('tx', show === 'all' ? 4 : 0);
  const ty = num('ty', show === 'gull' ? 1.2 : 0.5);
  const tz = num('tz', show === 'all' ? -2 : 0);
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * d, ty + Math.sin(el) * d, tz + Math.cos(az) * Math.cos(el) * d);
  camera.lookAt(tx, ty, tz);
  const label = document.getElementById('label')!;
  label.textContent = `wildlife ${show}: ${window.__tris} triangles`;
  const focus = new THREE.Vector3();
  let last = performance.now();
  let t = q.has('t') ? num('t', 0) : 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!q.has('t')) t += dt;
    for (const it of items) it.set(t);
    atmo.update(camera, dt, focus);
    rend.render(scene, camera);
    if (now > 2000) window.__ready = true;
  });
}
main().catch((e) => console.error(e));
