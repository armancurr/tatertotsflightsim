/**
 * Effects preview: the crash fireball / smoke column / debris and touchdown tyre smoke, with the
 * real renderer (HDR, tone mapping), atmosphere (sun, sky, aerial perspective) and the aircraft,
 * simulated deterministically to a chosen time so screenshots are repeatable.
 *
 *   /preview/fx.html?fx=crash&t=0.5          crash at 110 kt, seen from 60 m
 *   &speed=110 &dist=60 &cy=12 &az=200       impact speed; camera distance, height, azimuth (deg from north, around the event)
 *   &chase=1                                 camera where the chase camera sits after a crash (15 m behind, 4 m up)
 *   &fx=touchdown&fpm=-400&surface=runway    tyre smoke (t seconds after touchdown)
 *   &tod=0..3  &wind=4  &live=1 (keep simulating in real time)  &ac=0 (no aircraft)  &water=1 (ditching)
 *   &fx=wreck                                one burning tank-sized wreck (fire + oily smoke column), &dist=40
 *   &fx=battle                               the perf scene: 10 burning wrecks + 3 smoke columns + an explosion
 *                                            (&boom=s: explosion this many seconds before t, default 0.6)
 *   &fx=blast                                a Maverick-style hit at t = 0 (flash, fireball, sparks, embers, ring, fragments)
 *   &nofx=1                                  hide the effects (GPU A/B)
 * window.fxPreview = { setTime(t), fx, stats(), gpu(), cpuMs(), showFx(on) } for scripted multi-shot captures.
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { createEffects, smokeLighting } from '../fx';
import { createAircraft } from '../aircraft';
import { CONFIG } from '../config';
import type { SurfaceType } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const flag = (k: string, d = false) => (q.has(k) ? q.get(k) !== '0' : d);
const kind = q.get('fx') ?? 'crash';

const rend = createRenderer(document.getElementById('app')!, {});
const renderer = rend.renderer;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.08, 90000);
scene.add(camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── Ground: grass with a runway strip for the touchdown ─────────────────────
function groundTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#56703a';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = Math.random();
    g.fillStyle = `rgba(${40 + 60 * v},${70 + 50 * v},${25 + 25 * v},0.25)`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(400, 400);
  t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20000, 20000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
ground.receiveShadow = true;
scene.add(ground);
const runway = new THREE.Mesh(new THREE.PlaneGeometry(30, 1600).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.85 }));
runway.position.set(0, 0.03, 0);
runway.receiveShadow = true;
scene.add(runway);
const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(2.6, 11, 9).translate(0, 5.5, 0), new THREE.MeshStandardMaterial({ color: 0x2c4424, roughness: 0.9 }), 400);
{
  const m = new THREE.Matrix4();
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) {
    const a = rnd() * Math.PI * 2;
    const d = 70 + rnd() * 900;
    const k = 0.7 + rnd() * 0.7;
    m.makeScale(k, k, k).setPosition(60 + Math.sin(a) * d, 0, Math.cos(a) * d);
    trees.setMatrixAt(i, m);
  }
  trees.castShadow = true;
  trees.receiveShadow = true;
  scene.add(trees);
}

const atmo = createAtmosphere(renderer, scene, { timeOfDay: num('tod', 0), groundHeight: () => 0 });

// ── Event and aircraft ────────────────────────────────────────────────────
const fx = createEffects(scene, { groundHeight: () => 0 });
const combat = kind === 'wreck' || kind === 'battle' || kind === 'blast';
const P = kind === 'touchdown' ? new THREE.Vector3(0, 1.22, 200) : combat ? new THREE.Vector3(60, 0, 0) : new THREE.Vector3(60, 1.5, 0);
const headingDeg = num('hdg', kind === 'touchdown' ? 0 : 30);
const h = (headingDeg * Math.PI) / 180;
const speedMs = (num('speed', kind === 'touchdown' ? 58 : 110) * 1852) / 3600;
const V = new THREE.Vector3(Math.sin(h) * speedMs, kind === 'touchdown' ? -num('fpm', -400) / -196.85 : -12, -Math.cos(h) * speedMs);
const Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(kind === 'touchdown' ? 0.07 : -0.2, -h, kind === 'touchdown' ? 0 : 0.35, 'YXZ'));
let ac: ReturnType<typeof createAircraft> | null = null;
if (flag('ac', !combat)) {
  ac = createAircraft({ quality: 'high' });
  ac.root.position.copy(P);
  ac.root.quaternion.copy(Q);
  scene.add(ac.root);
}

// ── Wrecks (charred hull stand-ins, tank-sized) for the combat scenes ──────
const WRECKS: [number, number, number][] = []; // x, z, heading
if (kind === 'wreck') WRECKS.push([P.x, P.z, 0.4]);
if (kind === 'battle') {
  let r = 11;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 10; i++) WRECKS.push([P.x - 180 + (i % 5) * 90 + (rnd() - 0.5) * 40, P.z - 60 + Math.floor(i / 5) * 120 + (rnd() - 0.5) * 40, rnd() * 6.28]);
}
if (WRECKS.length) {
  const hull = new THREE.InstancedMesh(new THREE.BoxGeometry(3.6, 2.2, 6.9).translate(0, 1.1, 0), new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.95 }), WRECKS.length);
  const m = new THREE.Matrix4();
  WRECKS.forEach(([x, z, h], i) => hull.setMatrixAt(i, m.makeRotationY(h).setPosition(x, 0, z)));
  hull.castShadow = hull.receiveShadow = true;
  scene.add(hull);
}

// ── Camera around the event ──────────────────────────────────────────────
const target = new THREE.Vector3(P.x, P.y + num('ty', kind === 'touchdown' ? 0.5 : kind === 'wreck' ? 4 : 6), P.z);
if (flag('chase')) {
  camera.position.set(P.x - Math.sin(h) * 15, P.y + 4, P.z + Math.cos(h) * 15);
} else {
  const az = (num('az', kind === 'touchdown' ? 150 : 200) * Math.PI) / 180;
  const dist = num('dist', kind === 'touchdown' ? 26 : kind === 'wreck' ? 40 : kind === 'battle' ? 320 : 70);
  camera.position.set(P.x + Math.sin(az) * dist, P.y + num('cy', kind === 'touchdown' ? 2.5 : 10), P.z - Math.cos(az) * dist);
}
camera.lookAt(target);
camera.updateMatrixWorld();

const wind = new THREE.Vector3(num('wind', 3), 0, num('windz', 1.5));
const surface = (q.get('surface') ?? 'runway') as SurfaceType;
let simT = 0;
const DT = 1 / 60;
/** A Maverick-style hit (what the combat effects play from the detonation event). */
const blast = (x: number, z: number, s: number) => {
  const sim = fx.sim;
  sim.flash(x, 2, z, 1.2 * s);
  sim.explosion(x, 1, z, 0, 1.3 * s);
  sim.shockRing(x, 0, z, 0.8 * s, 'dirt');
  sim.sparks(x, 1.5, z, 0, 6, 0, Math.round(60 * s));
  sim.fragments(x, 1.5, z, 0, 0, 8, 0, s, true);
};
const trigger = () => {
  if (kind === 'touchdown') fx.touchdown(P, num('fpm', -400), { orientation: Q, velocity: V, surface });
  else if (kind === 'wreck' || kind === 'battle') {
    WRECKS.forEach(([x, z], i) => {
      fx.sim.addFire(x, 2.3, z, 0, num('fire', 1) * (0.85 + 0.15 * ((i * 7) % 3)), 600, num('radius', 2.2), true);
      if (kind === 'wreck' || i % 4 === 0) fx.sim.addColumn(x, 0, z, 0, 0.9, 600);
    });
  } else if (kind === 'blast') blast(P.x, P.z, 1);
  else fx.crash(P, num('speed', 110), { velocity: V, water: flag('water') });
};
const boomAt = num('t', 0.5) - num('boom', 0.6);
const SUN = new THREE.Color();
const AMB = new THREE.Color();
const light = () => {
  smokeLighting(atmo.sunLight.color, atmo.sunLight.intensity, atmo.state.skyIrradiance, atmo.state.groundRadiance, SUN, AMB);
  fx.setSun(atmo.sunDirection, SUN, AMB);
};
let boomDone = false;
const maybeBoom = () => {
  if (kind === 'battle' && !boomDone && simT >= boomAt) {
    boomDone = true;
    blast(P.x + 20, P.z + 25, 1);
  }
};
const setTime = (t: number) => {
  fx.reset();
  simT = 0;
  boomDone = false;
  trigger();
  light();
  while (simT + 1e-9 < t) {
    maybeBoom();
    fx.update(camera, DT, wind);
    simT += DT;
  }
  maybeBoom();
  fx.update(camera, 0, wind);
};
setTime(num('t', 0.5));

const live = flag('live');
let last = performance.now();
let cpuAcc = 0, cpuN = 0;
fx.object.visible = !flag('nofx');
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  camera.updateMatrixWorld();
  atmo.update(camera, dt, P);
  light();
  const t0 = performance.now();
  if (live) {
    simT += dt;
    maybeBoom();
    fx.update(camera, dt, wind);
  } else fx.update(camera, 0, wind);
  cpuAcc += performance.now() - t0;
  cpuN++;
  renderer.render(scene, camera);
});

(window as unknown as { fxPreview: unknown }).fxPreview = {
  fx,
  setTime,
  time: () => simT,
  stats: () => ({ ...fx.stats(), calls: renderer.info.render.calls }),
  gpu: () => rend.gpuTimings(),
  cpuMs: () => {
    const v = cpuN ? cpuAcc / cpuN : 0;
    cpuAcc = 0;
    cpuN = 0;
    return v;
  },
  showFx: (on: boolean) => {
    fx.object.visible = on;
  },
  config: CONFIG.fx,
};
