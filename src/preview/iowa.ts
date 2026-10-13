/**
 * USS Iowa (BB-61) model preview: the battleship on a calm water plane at her design waterline
 * under a gradient-sky environment with a shadowing sun (a DirectionalLight named 'sun', as the
 * game's, so the model's night lighting follows it). URL parameters:
 *   view = front34 | side | rear34 | top | bow | fantail | turrets | bridge | stern | aerial | helm | under
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the bow, −90 = port side)
 *   train=deg[,deg,deg]  elev=deg[,…]  recoil=0..1  flash=0..1   turrets (one value = all three;
 *                        turret III adds 180° to a single shared train so "train=0" stows it aft)
 *   anim=1               sweep the turrets (train and elevation) and fire broadsides on a cycle
 *   ui=1                 sliders for train / elevation / recoil / flash
 *   rudder=deg  n=rev/s  lights=nav  night=1  sun=az,el  exposure=  water=0  hide=name,name
 *   crashed=1 crashAge=s   spin=1 (orbit)   t=seconds   logdepth=1 (logarithmic depth buffer, as the game's fallback)
 * window.__ready, window.__stats {calls, triangles, buildMs, fps}.
 */
import * as THREE from 'three';
import { createIowaModel } from '../vessels/iowa';
import { createDefaultVisualState } from '../aircraft/types';
import { CONFIG, IOWA_AIRCRAFT, IOWA_FRAME, IOWA_WEAPONS } from '../config';
import type { TurretStatus } from '../combat/types';
import type { PropulsorState, VesselState } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const list = (k: string, d: number, n: number): number[] => {
  if (!q.has(k)) return new Array(n).fill(d);
  const v = q.get(k)!.split(',').map(Number);
  return Array.from({ length: n }, (_, i) => v[Math.min(i, v.length - 1)]);
};
const DEG = Math.PI / 180;
const G = IOWA_AIRCRAFT.geometry;
const WC = IOWA_AIRCRAFT.watercraft!;
const TURRETS = IOWA_WEAPONS.naval!.turrets;
const night = q.get('night') === '1';
const withWater = q.get('water') !== '0';
const view = q.get('view') ?? 'front34';

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: q.get('logdepth') === '1' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', night ? 1.3 : 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = q.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3();
const [saz, sel] = q.has('sun') ? (q.get('sun')!.split(',').map(Number) as [number, number]) : [215, night ? -12 : 38];
sunDir.set(Math.sin(saz * DEG) * Math.cos(sel * DEG), Math.sin(sel * DEG), -Math.cos(saz * DEG) * Math.cos(sel * DEG));
function skyScene(): THREE.Scene {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir }, uNight: { value: night ? 1 : 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; uniform float uNight; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 zen = mix(vec3(0.16, 0.34, 0.72), vec3(0.004, 0.006, 0.014), uNight);
        vec3 hor = mix(vec3(0.72, 0.82, 0.92), vec3(0.03, 0.035, 0.05), uNight);
        vec3 gnd = mix(vec3(0.10, 0.20, 0.26), vec3(0.01, 0.01, 0.012), uNight);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor * 0.8, gnd, pow(-h, 0.4));
        float sd = max(dot(normalize(vDir), normalize(uSun)), 0.0);
        c += (1.0 - uNight) * vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 60.0 + pow(sd, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat));
  return s;
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(skyScene(), 0.02);
scene.environment = envRT.texture;
scene.background = envRT.texture;
scene.backgroundBlurriness = 0.35;

const sun = new THREE.DirectionalLight(0xfff3e0, night ? 0.05 : 3.0);
sun.name = 'sun';
sun.position.copy(sunDir).multiplyScalar(400);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -160, right: 160, top: 160, bottom: -160, near: 1, far: 1000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.2;
scene.add(sun, sun.target);
if (night) {
  scene.environmentIntensity = 0.12;
  sun.visible = false;
  const moon = new THREE.DirectionalLight(0x9fb4d8, 0.25);
  moon.position.set(-200, 300, 150);
  scene.add(moon);
}

const surface = new THREE.Mesh(
  new THREE.PlaneGeometry(8000, 8000),
  withWater
    ? new THREE.MeshPhysicalMaterial({ color: night ? 0x02080c : 0x0f3a4a, roughness: 0.14, metalness: 0, transparent: true, opacity: 0.9, envMapIntensity: 0.9 })
    : new THREE.MeshStandardMaterial({ color: night ? 0x2a2a2a : 0xb9bab4, roughness: 0.92 }),
);
surface.rotation.x = -Math.PI / 2;
surface.receiveShadow = true;
scene.add(surface);

// ── The ship ────────────────────────────────────────────────────────────────
const t0 = performance.now();
const ship = createIowaModel();
const buildMs = performance.now() - t0;
scene.add(ship.root);
// floating: the design waterline (body y = cgBelowWl) at the surface; dry: the keel on the floor
ship.root.position.set(0, withWater ? -IOWA_FRAME.cgBelowWl : IOWA_FRAME.draft - IOWA_FRAME.cgBelowWl + 0.1, 0);
for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
  const o = ship.root.getObjectByName(name);
  if (o) o.visible = false;
}

const state = createDefaultVisualState();
const n = num('n', 0);
const rudder = num('rudder', 0);
const vessel = {
  seaTime: 0,
  propulsors: WC.propulsors.map((): PropulsorState => ({ rpm: Math.abs(n) * WC.engine.gearRatio * 60, n, gear: n > 0 ? 'ahead' : n < 0 ? 'astern' : 'neutral', thrust: 0, steerDeg: rudder, load: 0, boost: 0 })),
  tabs: 0, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0,
  depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
} as VesselState;
state.vessel = vessel;
state.engineRunning = n !== 0;
state.crashed = q.get('crashed') === '1';
state.crashAge = num('crashAge', 0);
state.time = num('t', 0.02);
const lightList = (q.get('lights') ?? 'nav').split(',');
state.lights = { nav: lightList.includes('nav'), strobe: false, beacon: false, landing: false, taxi: false };
state.cameraMode = view === 'helm' ? 'cockpit' : 'orbit';

// Turrets: from the URL, the sliders or the animation.
const shared = q.has('train') && q.get('train')!.split(',').length === 1;
const trains = list('train', 0, 3).map((t, i) => (q.has('train') ? (shared && TURRETS[i].stowDeg > 90 ? t + 180 : t) : TURRETS[i].stowDeg));
const elevs = list('elev', 0, 3);
const recoils = list('recoil', 0, 3);
const flashes = list('flash', 0, 3);
const status: TurretStatus[] = TURRETS.map((t, i) => ({ trainDeg: trains[i], elevDeg: elevs[i], recoil: new Array(t.barrels).fill(recoils[i]), flash: new Array(t.barrels).fill(flashes[i]), ready: new Array(t.barrels).fill(true) }));
state.turrets = status;
const anim = q.get('anim') === '1';

if (q.get('ui') === '1') {
  const ui = document.getElementById('ui')!;
  ui.hidden = false;
  const add = (label: string, min: number, max: number, step: number, value: number, set: (v: number) => void) => {
    const row = document.createElement('div');
    const out = document.createElement('span');
    const inp = document.createElement('input');
    inp.type = 'range';
    Object.assign(inp, { min: String(min), max: String(max), step: String(step), value: String(value) });
    const upd = () => {
      set(Number(inp.value));
      out.textContent = ` ${Number(inp.value).toFixed(step < 1 ? 2 : 0)}`;
    };
    inp.addEventListener('input', upd);
    row.append(`${label} `, inp, out);
    ui.appendChild(row);
    upd();
  };
  add('train', -150, 150, 1, trains[0], (v) => status.forEach((s, i) => (s.trainDeg = TURRETS[i].stowDeg > 90 ? 180 + v : v)));
  add('elev', -2, 45, 0.5, elevs[0], (v) => status.forEach((s) => (s.elevDeg = v)));
  add('recoil', 0, 1, 0.01, recoils[0], (v) => status.forEach((s) => s.recoil.fill(v)));
  add('flash', 0, 1, 0.01, flashes[0], (v) => status.forEach((s) => s.flash.fill(v)));
}

// ── Camera ─────────────────────────────────────────────────────────────────
const z = (s: number) => s - IOWA_FRAME.stemToCg;
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -38, el: 12, dist: 360, fov: 40, target: [0, 12, 0] },
  side: { az: -90, el: 3, dist: 420, fov: 38, target: [0, 12, 0] },
  rear34: { az: -145, el: 14, dist: 340, fov: 40, target: [0, 12, 0] },
  top: { az: 0, el: 89.5, dist: 520, fov: 40, target: [0, 0, 0] },
  bow: { az: -30, el: 6, dist: 110, fov: 40, target: [0, 8, z(40)] },
  turrets: { az: -40, el: 18, dist: 95, fov: 40, target: [0, 14, z(80)] },
  bridge: { az: -35, el: 14, dist: 90, fov: 40, target: [0, 24, z(110)] },
  fantail: { az: -150, el: 26, dist: 95, fov: 40, target: [0, 7, z(235)] },
  stern: { az: -140, el: -2, dist: 80, fov: 40, target: [0, -4, z(240)] },
  under: { az: -120, el: -25, dist: 160, fov: 40, target: [0, -6, z(215)] },
  aerial: { az: -55, el: 38, dist: 3000, fov: 30, target: [0, 0, 0] },
  orbit: { az: -40, el: 10, dist: 400, fov: 40 },
};
const p = presets[view] ?? presets.front34;
const aspect = innerWidth / innerHeight;
const camera = new THREE.PerspectiveCamera(num('fov', view === 'helm' ? CONFIG.camera.cockpit.fov : p.fov), aspect, view === 'helm' ? 0.08 : 0.5, 30000);
function placeCamera() {
  ship.root.updateMatrixWorld(true);
  if (view === 'helm') {
    camera.position.copy(ship.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = -num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(-yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 10, 0];
  const target = ship.root.localToWorld(new THREE.Vector3(...tgt));
  camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z - Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(target);
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

let frames = 0;
let last = performance.now();
let fpsT0 = 0;
const w = window as unknown as Record<string, unknown>;
const spin = q.get('spin') === '1';
renderer.info.autoReset = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!q.has('t') || spin || anim) state.time += dt;
  if (spin) p.az += dt * 12;
  if (anim) {
    // sweep: train ±60° over 40 s, elevation 0–30°, a broadside every 12 s (recoil 0.2 s back, 2 s run-out)
    const t = state.time;
    status.forEach((s, i) => {
      const base = TURRETS[i].stowDeg;
      s.trainDeg = base + 60 * Math.sin((t * 2 * Math.PI) / 40) * (base > 90 ? -1 : 1);
      s.elevDeg = 15 + 15 * Math.sin((t * 2 * Math.PI) / 23);
      const since = (t % 12) - i * 0.15;
      for (let k = 0; k < s.recoil.length; k++) {
        const tk = since - k * 0.05;
        s.recoil[k] = tk < 0 ? 0 : tk < 0.15 ? tk / 0.15 : Math.max(0, 1 - (tk - 0.15) / 2);
        s.flash[k] = tk < 0 ? 0 : Math.max(0, 1 - tk / 0.35);
      }
    });
  }
  ship.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  renderer.render(scene, camera);
  frames++;
  if (frames === 20) fpsT0 = now;
  if (frames === 80) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, buildMs: Math.round(buildMs), fps: Math.round(60000 / (now - fpsT0)) };
    w.__stats = stats;
    console.log('[iowa] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `USS Iowa (BB-61) · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms · ${stats.fps} fps`;
    w.__ready = true;
  }
});
