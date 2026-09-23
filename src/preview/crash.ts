/**
 * Crash preview: the full crash sequence (break-up, fireball, fires, smoke, scorch, crash camera)
 * with the real renderer, atmosphere, aircraft model and effects, simulated deterministically to a
 * chosen time so screenshots are repeatable.
 *
 *   /preview/crash.html?kind=nose&t=1          nose-in (45°) at 110 kt, 1 s after the impact
 *   &kind=skid|nose|forest|ditch               shallow skid on a field / dive / into trees / ditching
 *   &speed=110 &path=45 (deg below the horizon) &hdg=30
 *   &cam=chase|orbit|free  &az=200&dist=70&cy=12  (free: fixed camera around the impact)
 *   &tod=0..3  &wind=3  &live=1 (keep simulating in real time)
 * window.crashPreview = { setTime(t), director, fx, stats() } for scripted multi-shot captures.
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { createEffects, smokeLighting } from '../fx';
import { createAircraft } from '../aircraft';
import { createDefaultVisualState } from '../aircraft/types';
import { CrashDirector, type DirectorEnv } from '../crash/director';
import { CONFIG } from '../config';
import type { CameraMode } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const flag = (k: string, d = false) => (q.has(k) ? q.get(k) !== '0' : d);
const kind = q.get('kind') ?? 'nose';
const camMode = (q.get('cam') ?? 'chase') as CameraMode | 'free';

const rend = createRenderer(document.getElementById('app')!, {});
const renderer = rend.renderer;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.08, 90000);
scene.add(camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── World: gently rolling field (or sea), a forest, a runway strip ─────────
const water = kind === 'ditch';
const G0 = water ? -18 : 0;
const groundHeight = (x: number, z: number) => G0 + (water ? 0 : 0.6 * Math.sin(x * 0.013) + 0.5 * Math.cos(z * 0.011));
const inForest = (x: number, z: number) => kind === 'forest' && Math.hypot(x - 0, z + 60) < 260;
const TREE_H = 16;
const env: DirectorEnv = {
  groundHeight,
  waterLevel: () => (water ? 0 : null),
  obstacleTop: (x, z) => (inForest(x, z) ? groundHeight(x, z) + TREE_H : -Infinity),
  surfaceAt: () => (water ? 'water' : kind === 'forest' ? 'forest' : 'field'),
};

function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5b7038';
  g.fillRect(0, 0, 512, 512);
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const v = rnd();
    g.fillStyle = `rgba(${50 + 60 * v},${72 + 50 * v},${28 + 25 * v},0.25)`;
    g.fillRect(rnd() * 512, rnd() * 512, 2 + rnd() * 6, 2 + rnd() * 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(300, 300);
  t.anisotropy = 8;
  return t;
}
const groundGeo = new THREE.PlaneGeometry(6000, 6000, 240, 240).rotateX(-Math.PI / 2);
{
  const p = groundGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, groundHeight(p.getX(i), p.getZ(i)));
  groundGeo.computeVertexNormals();
}
const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);
if (water) {
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1d4a5e, roughness: 0.08, metalness: 0.1 }));
  sea.position.y = 0;
  scene.add(sea);
}
{
  const n = kind === 'forest' ? 2600 : 500;
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(2.8, TREE_H, 9).translate(0, TREE_H / 2, 0), new THREE.MeshStandardMaterial({ color: 0x2a4122, roughness: 0.9 }), n);
  const m = new THREE.Matrix4();
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    let x: number, z: number;
    if (kind === 'forest' && i < 2000) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 260;
      x = Math.cos(a) * d; z = -60 + Math.sin(a) * d;
    } else {
      const a = rnd() * Math.PI * 2, d = 250 + rnd() * 1200;
      x = Math.sin(a) * d; z = Math.cos(a) * d;
    }
    const k = 0.8 + rnd() * 0.5;
    m.makeScale(k, k, k).setPosition(x, water ? -40 : groundHeight(x, z), z);
    trees.setMatrixAt(i, m);
  }
  trees.castShadow = true;
  trees.receiveShadow = true;
  if (!water) scene.add(trees);
}

const atmo = createAtmosphere(renderer, scene, { timeOfDay: num('tod', 0), groundHeight: (x, z) => Math.max(groundHeight(x, z), water ? 0 : -1e9) });
const fx = createEffects(scene, { groundHeight: (x, z) => Math.max(groundHeight(x, z), water ? 0 : -1e9) });
const director = new CrashDirector(scene, env, { seed: num('seed', 5) });
director.fx = fx.sim;

// ── The crash ────────────────────────────────────────────────────────────
const DEFAULTS: Record<string, { speed: number; path: number; y: number; reason: string }> = {
  nose: { speed: 110, path: 45, y: 1.6, reason: 'Hit terrain' },
  skid: { speed: 85, path: 4, y: 1.2, reason: 'Hit terrain' },
  forest: { speed: 95, path: 8, y: TREE_H - 1, reason: 'Hit an obstacle' },
  ditch: { speed: 70, path: 6, y: 1.0, reason: 'Ditched in water' },
};
const D = DEFAULTS[kind] ?? DEFAULTS.nose;
const speedMs = num('speed', D.speed) * 0.514444;
const pathRad = (num('path', D.path) * Math.PI) / 180;
const hdg = (num('hdg', 30) * Math.PI) / 180;
const fwd = new THREE.Vector3(Math.sin(hdg), 0, -Math.cos(hdg));
const V = fwd.clone().multiplyScalar(Math.cos(pathRad) * speedMs).setY(-Math.sin(pathRad) * speedMs);
const surf0 = Math.max(groundHeight(0, 0), water ? 0 : -1e9);
const P = new THREE.Vector3(0, surf0 + D.y, 0);
const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pathRad * 0.8, -hdg, num('roll', 12) * (Math.PI / 180), 'YXZ'));

let ac = createAircraft({ quality: 'high' });
scene.add(ac.root);
const vis = createDefaultVisualState();

function placeAircraft() {
  ac.root.position.copy(P);
  ac.root.quaternion.copy(Q);
  ac.root.updateMatrixWorld(true);
}

// A stand-in for the camera rig: chase = behind and above the (frozen) aircraft root, orbit = a fixed offset.
const root = new THREE.Vector3();
function rigPose() {
  root.copy(P);
  if (camMode === 'free') {
    const az = (num('az', 200) * Math.PI) / 180;
    const dist = num('dist', 70);
    camera.position.set(P.x + Math.sin(az) * dist, P.y + num('cy', 12), P.z - Math.cos(az) * dist);
    camera.lookAt(P.x, P.y + num('ty', 4), P.z);
  } else if (camMode === 'orbit') {
    const az = hdg + Math.PI * 0.75;
    camera.position.set(P.x + Math.sin(az) * 22, P.y + 5, P.z - Math.cos(az) * 22);
    camera.lookAt(P);
  } else {
    camera.position.copy(P).addScaledVector(fwd, -15).setY(P.y + 3.6);
    camera.lookAt(P.x + fwd.x * 6, P.y, P.z + fwd.z * 6);
  }
  camera.updateMatrixWorld();
}

const wind = new THREE.Vector3(num('wind', 3), 0, num('windz', 1.5));
const SUN = new THREE.Color();
const AMB = new THREE.Color();
const light = () => {
  smokeLighting(atmo.sunLight.color, atmo.sunLight.intensity, atmo.state.skyIrradiance, atmo.state.groundRadiance, SUN, AMB);
  fx.setSun(atmo.sunDirection, SUN, AMB);
};
const DT = 1 / 60;
let simT = 0;
const stepOnce = (dt: number) => {
  director.update(dt);
  rigPose();
  if (camMode !== 'free') director.applyCamera(camera, camMode as CameraMode, dt, root);
  fx.update(camera, dt * director.timeScale(), wind);
};
const setTime = (t: number) => {
  director.reset();
  fx.reset();
  placeAircraft();
  vis.crashed = true;
  vis.crashAge = 0;
  ac.setVisualState(vis, 0);
  ac.root.updateMatrixWorld(true);
  director.begin(ac, { reason: D.reason, speedKt: speedMs / 0.514444, position: P, velocity: V, angularVelocity: { x: 0.2, y: 0.05, z: 0.3 }, massKg: CONFIG.aircraft.mass });
  simT = 0;
  light();
  rigPose();
  while (simT + 1e-9 < t) {
    vis.crashAge = simT;
    ac.setVisualState(vis, DT);
    stepOnce(DT);
    simT += DT;
  }
  rigPose();
  if (camMode !== 'free') director.applyCamera(camera, camMode as CameraMode, 0, root);
  fx.update(camera, 0, wind);
};
setTime(num('t', 1));

const live = flag('live');
let last = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (live) {
    simT += dt;
    stepOnce(dt);
  } else {
    rigPose();
    if (camMode !== 'free') director.applyCamera(camera, camMode as CameraMode, 0, root);
  }
  camera.updateMatrixWorld();
  atmo.update(camera, dt, director.focus);
  light();
  if (!live) fx.update(camera, 0, wind);
  renderer.render(scene, camera);
});

/** GPU cost of the crash effects: the scene pass with the particles/decals shown vs hidden (ms, timer queries). */
async function gpuCost(frames = 90): Promise<{ withFx: number; withoutFx: number; fxMs: number; available: boolean }> {
  const wait = (n: number) => new Promise<void>((res) => {
    let k = 0;
    const tick = () => (++k >= n ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const measure = async (show: boolean) => {
    fx.object.visible = show;
    if (director.scorch) director.scorch.group.visible = show;
    await wait(10);
    rend.gpuTimer.reset();
    await wait(frames);
    return rend.gpuTimings().scene ?? NaN;
  };
  const withFx = await measure(true);
  const withoutFx = await measure(false);
  fx.object.visible = true;
  if (director.scorch) director.scorch.group.visible = true;
  return { withFx, withoutFx, fxMs: Math.round((withFx - withoutFx) * 100) / 100, available: rend.gpuTimer.available };
}

(window as unknown as { crashPreview: unknown }).crashPreview = {
  director,
  fx,
  gpuCost,
  setTime,
  time: () => simT,
  stats: () => ({ ...fx.stats(), ...director.stats(), calls: renderer.info.render.calls }),
  swap: () => {
    director.dropModel();
    scene.remove(ac.root);
    ac.dispose();
    ac = createAircraft({ quality: 'high' });
    scene.add(ac.root);
  },
};
