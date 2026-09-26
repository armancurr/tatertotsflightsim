/**
 * Princess V50 model preview: the yacht floating on a calm water plane (its static waterline at
 * body y ≈ −0.45) under a gradient-sky environment with a shadowing sun. URL parameters:
 *   view = front34 | side | rear34 | rear | top | bow | stern | helm | pods | cockpit | under
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the bow, −90 = port side)
 *   steer=deg (+ = bow to starboard; both pods, or steer=port,stbd)   n=rev/s (props; n=port,stbd)
 *   tabs=0..1   lights=nav   night=1   sun=az,el   exposure=   water=0 (no water: on a cradle floor)
 *   waterline=y (body y at the surface, default −0.45)   crashed=1 crashAge=s   hide=name,name
 *   lookYaw, lookDown (cockpit view)   spin=1 (orbit)   t=seconds
 *   ortho=side|top|front: orthographic three-view with a 1 m grid (for checking real dimensions)
 * window.__ready, window.__stats {calls, triangles, buildMs}.
 */
import * as THREE from 'three';
import { createV50Model } from '../vessels/v50';
import { createDefaultVisualState } from '../aircraft/types';
import { CONFIG, V50_AIRCRAFT } from '../config';
import type { PropulsorState, VesselState } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const pair = (k: string, d: [number, number]): [number, number] => {
  if (!q.has(k)) return d;
  const v = q.get(k)!.split(',').map(Number);
  return [v[0], v.length > 1 ? v[1] : v[0]];
};
const DEG = Math.PI / 180;
const G = V50_AIRCRAFT.geometry;
const WC = V50_AIRCRAFT.watercraft!;
const night = q.get('night') === '1';
const withWater = q.get('water') !== '0';
const waterline = num('waterline', -0.45);

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
        vec3 gnd = mix(vec3(0.10, 0.20, 0.26), vec3(0.01, 0.01, 0.012), uNight);
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
sun.position.copy(sunDir).multiplyScalar(40);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 100 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
if (night) scene.environmentIntensity = 0.15;

// Calm sea (a glossy, slightly see-through plane) or a cradle floor under the keel.
const surface = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  withWater
    ? new THREE.MeshPhysicalMaterial({ color: night ? 0x02080c : 0x0f3a4a, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.86, envMapIntensity: 0.9 })
    : new THREE.MeshStandardMaterial({ color: night ? 0x2a2a2a : 0xb9bab4, roughness: 0.92 }),
);
surface.rotation.x = -Math.PI / 2;
surface.receiveShadow = true;
scene.add(surface);

// ── The yacht ──────────────────────────────────────────────────────────────
const t0 = performance.now();
const boat = createV50Model();
const buildMs = performance.now() - t0;
scene.add(boat.root);
const view = q.get('view') ?? 'front34';
// Floating: the surface at body y = waterline; dry: the drive skegs just clear of the floor.
boat.root.position.set(0, withWater ? -waterline : 1.7, 0);
for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
  const o = boat.root.getObjectByName(name);
  if (o) o.visible = false;
}

const state = createDefaultVisualState();
const [steerP, steerS] = pair('steer', [0, 0]);
const [nP, nS] = pair('n', [0, 0]);
const prop = (steerDeg: number, n: number): PropulsorState => ({
  rpm: Math.abs(n) * WC.engine.gearRatio * 60,
  n,
  gear: n > 0 ? 'ahead' : n < 0 ? 'astern' : 'neutral',
  thrust: 0,
  steerDeg,
  load: 0,
  boost: 0,
} as PropulsorState);
const vessel = {
  seaTime: 0,
  propulsors: WC.propulsors.map((p) => (p.position.x < 0 ? prop(steerP, nP) : prop(steerS, nS))),
  tabs: num('tabs', 0),
  mooring: null,
  speedMs: 0,
  leewayDeg: 0,
  trimDeg: 0,
  planing: 0,
  wettedLength: 0,
  wettedArea: 0,
  displacedVolume: 0,
  resistance: 0,
  depthUnderKeel: Infinity,
  aground: false,
  capsizeTime: 0,
  surfaceY: 0,
} as VesselState;
state.vessel = vessel;
state.engineRunning = nP !== 0 || nS !== 0;
state.propRpm = vessel.propulsors[0].rpm;
state.crashed = q.get('crashed') === '1';
state.crashAge = num('crashAge', 0);
state.time = num('t', 0.02);
const lightList = (q.get('lights') ?? 'nav').split(',');
state.lights = { nav: lightList.includes('nav'), strobe: false, beacon: false, landing: false, taxi: false };
state.cameraMode = view === 'cockpit' ? 'cockpit' : 'orbit';

// ── Camera ─────────────────────────────────────────────────────────────────
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -38, el: 11, dist: 24, fov: 40 },
  side: { az: -90, el: 3, dist: 26, fov: 38, target: [0, 0.6, -1.4] },
  rear34: { az: -145, el: 13, dist: 23, fov: 40 },
  rear: { az: 180, el: 6, dist: 20, fov: 40 },
  top: { az: 0, el: 89.5, dist: 34, fov: 40, target: [0, 0, -1.4] },
  bow: { az: -25, el: 4, dist: 12, fov: 40, target: [0, 0.8, -6] },
  stern: { az: -150, el: 8, dist: 10, fov: 40, target: [0, 0.2, 5] },
  helm: { az: 165, el: 28, dist: 1.5, fov: 60, target: [0.6, 1.15, -2.35] },
  pods: { az: -130, el: -12, dist: 5.5, fov: 40, target: [0, -1.2, 4.2] },
  under: { az: -60, el: -30, dist: 22, fov: 40, target: [0, -0.8, -1.4] },
  orbit: { az: -40, el: 10, dist: 26, fov: 40 },
};
const p = presets[view] ?? presets.front34;
const ortho = q.get('ortho') as 'side' | 'top' | 'front' | null;
const aspect = innerWidth / innerHeight;
const HALF_W = 9.5;
const halfH = HALF_W / aspect;
const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = ortho
  ? new THREE.OrthographicCamera(-HALF_W, HALF_W, halfH, -halfH, 0.1, 300)
  : new THREE.PerspectiveCamera(num('fov', view === 'cockpit' ? CONFIG.camera.cockpit.fov : p.fov), aspect, 0.03, 3000);
if (ortho) {
  surface.visible = false;
  scene.background = new THREE.Color(0xd9dee3);
  const lines: number[] = [];
  const gy = boat.root.position.y;
  for (let k = -12; k <= 12; k++) {
    if (ortho === 'side') lines.push(0, -3 + gy, k, 0, 5 + gy, k, 0, k * 0.5 + gy, -12, 0, k * 0.5 + gy, 12);
    if (ortho === 'top') lines.push(-12, gy + 5, k, 12, gy + 5, k, k, gy + 5, -12, k, gy + 5, 12);
    if (ortho === 'front') lines.push(k, -3 + gy, -12, k, 5 + gy, -12, -12, k * 0.5 + gy, -12, 12, k * 0.5 + gy, -12);
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: 0x44505a, transparent: true, opacity: 0.35 }));
  scene.add(grid);
  const cam = camera as THREE.OrthographicCamera;
  if (ortho === 'side') { cam.position.set(-80, gy + 0.8, -1.45); cam.lookAt(0, gy + 0.8, -1.45); }
  if (ortho === 'top') { cam.position.set(0, 80, -1.45); cam.up.set(-1, 0, 0); cam.lookAt(0, 0, -1.45); }
  if (ortho === 'front') { cam.position.set(0, gy + 0.8, -80); cam.lookAt(0, gy + 0.8, 0); }
  cam.updateProjectionMatrix();
}
function placeCamera() {
  boat.root.updateMatrixWorld(true);
  if (ortho) return;
  if (view === 'cockpit') {
    camera.position.copy(boat.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = -num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(-yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 0.8, -1.2];
  const target = boat.root.localToWorld(new THREE.Vector3(...tgt));
  camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z - Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(target);
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) (camera as THREE.PerspectiveCamera).aspect = innerWidth / innerHeight;
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
  boat.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  renderer.render(scene, camera);
  frames++;
  if (frames === 40) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, buildMs: Math.round(buildMs) };
    w.__stats = stats;
    console.log('[v50] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `Princess V50 TATER TOT · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
