/**
 * Bell 206B-3 JetRanger model preview: the helicopter on a light apron under a gradient-sky
 * environment with a shadowing sun. URL parameters:
 *   view = front34 | side | rear34 | rear | top | belly | front | nose | tail | rotorhead | skids | cockpit | cabin
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the nose, −90 = left side)
 *   rpm= main-rotor rpm (tail rotor × gear ratio)   coll=0..1 cyc=long,lat (−1..1, + aft/right) pedal=−1..1
 *   flap=long,lat (tip-path-plane tilt, deg, + aft/right)   thrust=N   comp=front,left,right (skid loads, m)
 *   nr=,n2=,n1=,tq= (rotor instruments, %)   ias=kt alt=ft vs=fpm pitch= roll= hdg=
 *   lights=nav,beacon,landing   t=seconds   night=1   sun=az,el   exposure=   air=1 (5 m up)
 *   lookYaw, lookDown (cockpit view)   crashed=1 crashAge=s   hide=name,name   spin=1 (orbit)
 *   ortho=side|top|front: orthographic three-view with a 1 m grid (for checking real dimensions)
 * window.__ready, window.__stats {calls, triangles, buildMs}.
 */
import * as THREE from 'three';
import { createB206Model } from '../aircraft/b206';
import { createDefaultVisualState, createRestReadings } from '../aircraft/types';
import { CONFIG, B206_AIRCRAFT } from '../config';
import type { RotorState } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const pair = (k: string, d: [number, number]): [number, number] => (q.has(k) ? (q.get(k)!.split(',').map(Number) as [number, number]) : d);
const DEG = Math.PI / 180;
const G = B206_AIRCRAFT.geometry;
const RC = B206_AIRCRAFT.rotorcraft!;
const night = q.get('night') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', night ? 1.2 : 1.0);
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
    uniforms: { uSun: { value: sunDir }, uNight: { value: night ? 1 : 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; uniform float uNight; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 zen = mix(vec3(0.16, 0.34, 0.72), vec3(0.004, 0.006, 0.014), uNight);
        vec3 hor = mix(vec3(0.72, 0.82, 0.92), vec3(0.03, 0.035, 0.05), uNight);
        vec3 gnd = mix(vec3(0.34, 0.33, 0.30), vec3(0.01, 0.01, 0.012), uNight);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor * 0.8, gnd, pow(-h, 0.4));
        float sd = max(dot(normalize(vDir), normalize(uSun)), 0.0);
        c += (1.0 - uNight) * vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 60.0 + pow(sd, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const [saz, sel] = pair('sun', [215, 38]);
  sunDir.set(Math.sin(saz * DEG) * Math.cos(sel * DEG), Math.sin(sel * DEG), -Math.cos(saz * DEG) * Math.cos(sel * DEG));
  s.add(new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat));
  return s;
}
const pmrem = new THREE.PMREMGenerator(renderer);
const envRT = pmrem.fromScene(skyScene(), 0.02);
scene.environment = envRT.texture;
scene.background = envRT.texture;
scene.backgroundBlurriness = 0.35;

const sun = new THREE.DirectionalLight(0xfff3e0, night ? 0.05 : 3.0);
sun.position.copy(sunDir).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 80 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
if (night) scene.environmentIntensity = 0.15;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: night ? 0x2a2a2a : 0xb9bab4, roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── The helicopter ─────────────────────────────────────────────────────────
const t0 = performance.now();
const heli = createB206Model();
const buildMs = performance.now() - t0;
scene.add(heli.root);
const view = q.get('view') ?? 'front34';
const airborne = view === 'belly' || q.get('air') === '1';
const skidY = RC.skids.points[0].y;
heli.root.position.set(0, airborne ? 5 : -skidY, 0);
// ?rotaz=deg: park the blades at this azimuth (one slow step before the stills).
if (q.has('rotaz')) {
  const s0 = createDefaultVisualState();
  s0.propRpm = (num('rotaz', 0) / 360) * 60 * 4;
  heli.setVisualState(s0, 0.25);
}
for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
  const o = heli.root.getObjectByName(name);
  if (o) o.visible = false;
}

const state = createDefaultVisualState();
const rpm = num('rpm', 0);
state.engineRunning = rpm > 0;
state.propRpm = rpm;
const [cycLong, cycLat] = pair('cyc', [0, 0]);
const [flapLong, flapLat] = pair('flap', [0, 0]);
const comp = q.has('comp') ? (q.get('comp')!.split(',').map(Number) as [number, number, number]) : ([0, 0, 0] as [number, number, number]);
// Only the fields the model reads matter here (the physics owns the rest of RotorState).
const rotor = {
  omega: (rpm * 2 * Math.PI) / 60, vi: 0, viTail: 0,
  thrust: num('thrust', rpm > 300 ? B206_AIRCRAFT.mass * 9.81 : 0), tailThrust: 0,
  flapLong: flapLong * DEG, flapLat: flapLat * DEG,
  enginePower: 0, n1: 0, govInt: 0, torque: 0,
  collective: num('coll', 0), cyclicLong: cycLong, cyclicLat: cycLat, pedal: num('pedal', 0),
  sasOn: true, sasLong: 0, sasLat: 0, sasYaw: 0, headingRef: 0,
  vrs: 0, bladeStall: 0, groundEffect: 0, fx: 0, fy: 0,
} as RotorState;
state.rotor = rotor;
state.crashed = q.get('crashed') === '1';
state.crashAge = num('crashAge', 0);
state.time = num('t', 0.02);
state.wheelCompression = airborne ? [0, 0, 0] : comp;
const lightList = (q.get('lights') ?? 'nav').split(',');
state.lights = { nav: lightList.includes('nav'), strobe: false, beacon: lightList.includes('beacon'), landing: lightList.includes('landing'), taxi: false };
state.cameraMode = view === 'cockpit' ? 'cockpit' : 'orbit';
const nr = num('nr', (rpm / RC.rotor.nominalRpm) * 100);
state.instruments = {
  ...createRestReadings(),
  airspeedKt: num('ias', 0),
  altitudeFt: num('alt', 0),
  verticalSpeedFpm: num('vs', 0),
  pitchDeg: num('pitch', 0),
  rollDeg: num('roll', 0),
  headingDeg: num('hdg', 0),
  rpm,
  engineStatus: rpm > 0 ? 'RUNNING' : 'OFF',
  state: airborne ? 'airborne' : 'ground',
  rotor: {
    nrPct: nr, n2Pct: num('n2', nr), n1Pct: num('n1', rpm > 0 ? 88 : 0), torquePct: num('tq', rpm > 0 ? 62 : 0),
    collectivePct: num('coll', 0) * 100, sas: true, lowRotorRpm: rpm > 0 && nr < 95, overTorque: false, vrs: 0, bladeStall: 0,
  },
};

// ── Camera ─────────────────────────────────────────────────────────────────
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -40, el: 10, dist: 12.5, fov: 40 },
  side: { az: -90, el: 2, dist: 15, fov: 38, target: [0, 0.3, 1.8] },
  rear34: { az: -140, el: 12, dist: 13, fov: 40 },
  rear: { az: 180, el: 4, dist: 16, fov: 40 },
  top: { az: 0, el: 89.5, dist: 20, fov: 40 },
  belly: { az: -55, el: -35, dist: 14, fov: 40 },
  front: { az: 0, el: 3, dist: 12, fov: 40 },
  nose: { az: -35, el: 8, dist: 6, fov: 40, target: [0, 0.1, -1.6] },
  tail: { az: -125, el: 10, dist: 6, fov: 40, target: [0, 0.6, 5.4] },
  rotorhead: { az: -60, el: 18, dist: 3.2, fov: 40, target: [0, 1.35, -0.05] },
  skids: { az: -60, el: -4, dist: 6, fov: 40, target: [0, -0.9, 0] },
  cabin: { az: -60, el: 14, dist: 4.5, fov: 40, target: [0, 0.2, -1.2] },
  orbit: { az: -40, el: 10, dist: 17, fov: 40 },
};
const p = presets[view] ?? presets.front34;
const ortho = q.get('ortho') as 'side' | 'top' | 'front' | null;
const aspect = innerWidth / innerHeight;
const HALF_W = 7.2;
const halfH = HALF_W / aspect;
const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = ortho
  ? new THREE.OrthographicCamera(-HALF_W, HALF_W, halfH, -halfH, 0.1, 200)
  : new THREE.PerspectiveCamera(num('fov', view === 'cockpit' ? CONFIG.camera.cockpit.fov : p.fov), aspect, 0.03, 2000);
if (ortho) {
  ground.visible = false;
  scene.background = new THREE.Color(0xd9dee3);
  const lines: number[] = [];
  const gy = -skidY; // root height above the apron
  for (let k = -12; k <= 12; k++) {
    if (ortho === 'side') lines.push(0, -3 + gy, k, 0, 6 + gy, k, 0, k * 0.5 + gy, -12, 0, k * 0.5 + gy, 12);
    if (ortho === 'top') lines.push(-12, gy + 4, k, 12, gy + 4, k, k, gy + 4, -12, k, gy + 4, 12);
    if (ortho === 'front') lines.push(k, -3 + gy, -12, k, 6 + gy, -12, -12, k * 0.5 + gy, -12, 12, k * 0.5 + gy, -12);
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: 0x44505a, transparent: true, opacity: 0.35 }));
  scene.add(grid);
  const cam = camera as THREE.OrthographicCamera;
  if (ortho === 'side') { cam.position.set(-60, gy + 0.5, 1.9); cam.lookAt(0, gy + 0.5, 1.9); }
  if (ortho === 'top') { cam.position.set(0, 80, 0.5); cam.up.set(-1, 0, 0); cam.lookAt(0, 0, 0.5); }
  if (ortho === 'front') { cam.position.set(0, gy + 0.5, -60); cam.lookAt(0, gy + 0.5, 0); }
  cam.updateProjectionMatrix();
}
function placeCamera() {
  heli.root.updateMatrixWorld(true);
  if (ortho) return;
  if (view === 'cockpit') {
    camera.position.copy(heli.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = -num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(-yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 0.3, 0.8];
  const target = heli.root.localToWorld(new THREE.Vector3(...tgt));
  camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z - Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(target);
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) (camera as THREE.PerspectiveCamera).aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ?atlas=skin|cabin|mask shows a painted texture full screen (for checking the livery).
const atlasKind = q.get('atlas');
let atlasScene: THREE.Scene | null = null;
const atlasCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
if (atlasKind) {
  const pick = atlasKind === 'cabin' ? 'b206.lining' : atlasKind === 'panel' ? 'b206.cockpit.panel' : atlasKind === 'mask' ? 'b206.glass' : 'b206.skin';
  const m = (heli.root.getObjectByName(pick) as THREE.Mesh).material as THREE.MeshStandardMaterial;
  const tex = atlasKind === 'mask' ? m.alphaMap : m.map;
  atlasScene = new THREE.Scene();
  const img = tex?.image as { width: number; height: number } | undefined;
  const ar = img ? img.width / img.height : 1;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2 * ar * (innerHeight / innerWidth), 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  atlasScene.add(quad);
}

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
  heli.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  if (atlasScene) {
    renderer.toneMapping = THREE.NoToneMapping;
    scene.background = null;
    renderer.render(atlasScene, atlasCam);
  } else renderer.render(scene, camera);
  frames++;
  if (frames === 40) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, buildMs: Math.round(buildMs) };
    w.__stats = stats;
    console.log('[b206] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `Bell 206B-3 N206TT · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
