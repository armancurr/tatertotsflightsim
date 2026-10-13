/**
 * Sea-Doo RXP-X 325 model preview: the ski and its rider floating on a calm water plane (static
 * waterline at body y ≈ −0.17) under a gradient-sky environment with a shadowing sun. URL parameters:
 *   state = idle | cruise | carve | carveL | reverse | off | jump | righting | crashed
 *   view  = front34 | side | rear34 | rear | front | top | stern | under | helm | orbit
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the bow, −90 = port side)
 *   steer=deg  lean=−1..1  fwd=−1..1  bucket=0..1  trim=deg  speed=m/s  aboard=0   (override the state)
 *   roll, pitch (deg, the craft's attitude)  y (root height)  water=0  spin=1  t=seconds  hud=0
 *   lookYaw, lookDown (helm view)
 * window.__ready, window.__stats {calls, triangles, buildMs}.
 */
import * as THREE from 'three';
import { createSeadooModel, SEADOO_SHAPE } from '../vessels/seadoo';
import { createDefaultVisualState } from '../aircraft/types';
import { CONFIG, SEADOO_AIRCRAFT } from '../config';
import type { PropulsorState, VesselState } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DEG = Math.PI / 180;
const G = SEADOO_AIRCRAFT.geometry;
const withWater = q.get('water') !== '0';

interface Preset { steer: number; lean: number; fwd: number; bucket: number; trim: number; speed: number; aboard: boolean; righting: number; roll: number; pitch: number; y: number; crashed?: boolean }
const STATES: Record<string, Preset> = {
  idle: { steer: 0, lean: 0, fwd: 0, bucket: 0.45, trim: 0, speed: 0, aboard: true, righting: 0, roll: 0, pitch: 0, y: 0 },
  cruise: { steer: 0, lean: 0, fwd: 0.2, bucket: 0, trim: 0, speed: 15, aboard: true, righting: 0, roll: 0, pitch: 2, y: 0.08 },
  carve: { steer: 22, lean: 1, fwd: 0.4, bucket: 0, trim: -4, speed: 18, aboard: true, righting: 0, roll: 22, pitch: 2, y: 0.08 },
  carveL: { steer: -22, lean: -1, fwd: 0.4, bucket: 0, trim: -4, speed: 18, aboard: true, righting: 0, roll: -22, pitch: 2, y: 0.08 },
  reverse: { steer: 0, lean: 0, fwd: -0.7, bucket: 1, trim: 0, speed: -1.5, aboard: true, righting: 0, roll: 0, pitch: -1, y: 0 },
  off: { steer: 0, lean: 0, fwd: 0, bucket: 0.45, trim: 0, speed: 0, aboard: false, righting: 0, roll: 0, pitch: 0, y: 0 },
  jump: { steer: 6, lean: 0.2, fwd: 1, bucket: 0, trim: 8, speed: 22, aboard: true, righting: 0, roll: 4, pitch: 12, y: 1.1 },
  righting: { steer: 0, lean: 0, fwd: 0, bucket: 0.45, trim: 0, speed: 0, aboard: false, righting: 0.5, roll: 95, pitch: 0, y: 0.1 },
  crashed: { steer: 0, lean: 0, fwd: 0, bucket: 0, trim: 0, speed: 0, aboard: true, righting: 0, roll: 0, pitch: 0, y: 0, crashed: true },
};
const stateName = q.get('state') ?? 'idle';
const P = { ...(STATES[stateName] ?? STATES.idle) };
P.steer = num('steer', P.steer);
P.lean = num('lean', P.lean);
P.fwd = num('fwd', P.fwd);
P.bucket = num('bucket', P.bucket);
P.trim = num('trim', P.trim);
P.speed = num('speed', P.speed);
if (q.has('aboard')) P.aboard = q.get('aboard') !== '0';
P.roll = num('roll', P.roll);
P.pitch = num('pitch', P.pitch);
P.y = num('y', P.y);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = q.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3();
function skyScene(): THREE.Scene {
  const s = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 zen = vec3(0.16, 0.34, 0.72);
        vec3 hor = vec3(0.72, 0.82, 0.92);
        vec3 gnd = vec3(0.10, 0.20, 0.26);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor * 0.8, gnd, pow(-h, 0.4));
        float sd = max(dot(normalize(vDir), normalize(uSun)), 0.0);
        c += vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 60.0 + pow(sd, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const saz = num('sunAz', 215);
  const sel = num('sunEl', 40);
  sunDir.set(Math.sin(saz * DEG) * Math.cos(sel * DEG), Math.sin(sel * DEG), -Math.cos(saz * DEG) * Math.cos(sel * DEG));
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat));
  return s;
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(skyScene(), 0.02);
scene.environment = envRT.texture;
scene.background = envRT.texture;
scene.backgroundBlurriness = 0.35;

const sun = new THREE.DirectionalLight(0xfff3e0, 3.0);
sun.position.copy(sunDir).multiplyScalar(20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 60 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

const surface = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  withWater
    ? new THREE.MeshPhysicalMaterial({ color: 0x0f3a4a, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.86, envMapIntensity: 0.9 })
    : new THREE.MeshStandardMaterial({ color: 0xb9bab4, roughness: 0.92 }),
);
surface.rotation.x = -Math.PI / 2;
surface.receiveShadow = true;
scene.add(surface);

// ── The ski ────────────────────────────────────────────────────────────────
const t0 = performance.now();
const ski = createSeadooModel();
const buildMs = performance.now() - t0;
scene.add(ski.root);
const view = q.get('view') ?? 'front34';
ski.root.position.set(0, (withWater ? -SEADOO_SHAPE.waterlineY : 0.45) + P.y, 0);
ski.root.rotation.set(P.pitch * DEG, 0, -P.roll * DEG, 'YXZ');

const state = createDefaultVisualState();
const prop = {
  rpm: P.speed > 1 ? 6500 : 1700,
  n: 0,
  gear: 'ahead',
  thrust: 0,
  steerDeg: P.steer,
  load: 0,
  boost: 0,
  jet: { bucket: P.bucket, trimDeg: P.trim, flow: 0, jetSpeed: 0, ventilation: 0, nozzleClear: stateName === 'jump' },
} as PropulsorState;
const vessel = {
  seaTime: 0,
  propulsors: [prop],
  tabs: 0,
  mooring: null,
  speedMs: P.speed,
  leewayDeg: 0,
  trimDeg: P.pitch,
  planing: P.speed > 8 ? 1 : 0,
  wettedLength: 0,
  wettedArea: 0,
  displacedVolume: 0,
  resistance: 0,
  depthUnderKeel: Infinity,
  aground: false,
  touching: false,
  capsizeTime: 0,
  surfaceY: 0,
  rider: { lean: P.lean, foreAft: P.fwd, aboard: P.aboard, off: P.aboard ? null : 'spill', offTime: 2 },
  righting: P.righting,
} as VesselState;
state.vessel = vessel;
state.engineRunning = true;
state.crashed = P.crashed === true;
state.crashAge = P.crashed ? 3 : 0;
state.time = num('t', 0.4);
state.cameraMode = view === 'helm' ? 'cockpit' : 'orbit';

// ── Camera ─────────────────────────────────────────────────────────────────
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -40, el: 12, dist: 6.2, fov: 38, target: [0, 0.35, -0.2] },
  side: { az: -90, el: 3, dist: 6.4, fov: 38, target: [0, 0.35, -0.3] },
  rear34: { az: -140, el: 14, dist: 6, fov: 38, target: [0, 0.35, 0] },
  rear: { az: 180, el: 8, dist: 5.5, fov: 38, target: [0, 0.3, 0] },
  front: { az: 0, el: 6, dist: 6, fov: 38, target: [0, 0.35, 0] },
  top: { az: 0, el: 89.5, dist: 7.5, fov: 38, target: [0, 0, -0.3] },
  stern: { az: -150, el: 6, dist: 2.2, fov: 40, target: [0, -0.15, 1.25] },
  under: { az: -60, el: -25, dist: 5.5, fov: 40, target: [0, -0.3, -0.3] },
  orbit: { az: -40, el: 10, dist: 6.5, fov: 40 },
};
const p = presets[view] ?? presets.front34;
const camera = new THREE.PerspectiveCamera(num('fov', view === 'helm' ? CONFIG.camera.cockpit.fov : p.fov), innerWidth / innerHeight, 0.02, 2000);
function placeCamera() {
  ski.root.updateMatrixWorld(true);
  if (view === 'helm') {
    camera.position.copy(ski.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = -num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    const fwd = new THREE.Vector3(Math.sin(-yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    camera.lookAt(camera.position.clone().add(fwd.transformDirection(ski.root.matrixWorld)));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 0.4, 0];
  const target = new THREE.Vector3(tgt[0], tgt[1] + ski.root.position.y, tgt[2]);
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
const w = window as unknown as Record<string, unknown>;
const spin = q.get('spin') === '1';
renderer.info.autoReset = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!q.has('t') || spin) state.time += dt;
  if (spin) p.az += dt * 20;
  ski.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  renderer.render(scene, camera);
  frames++;
  if (frames === 40) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, buildMs: Math.round(buildMs) };
    w.__stats = stats;
    console.log('[seadoo] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `Sea-Doo RXP-X 325 TATER JET · ${stateName} · ${view} · ${stats.calls} draws (incl. water/sky/shadows) · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
