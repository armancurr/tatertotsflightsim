/**
 * Boeing 747-400 model preview: the jumbo on a light apron under a gradient-sky environment with a
 * shadowing sun. URL parameters:
 *   view = front34 | side | rear34 | rear | top | belly | front | nose | tail | gear | cockpit | engine | wing
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the nose, −90 = left side)
 *   gear=0..1 flaps=deg elev= ail= rud= (−1..1) sb=0..1 thr=0..100 (core %) aoa=deg air=1 steer=
 *   comp=m (strut compression)   hide=name,name (hide parts by name)
 *   lights=nav,strobe,beacon,landing,taxi   t=seconds   night=1   sun=az,el   exposure=
 *   lookYaw, lookDown (cockpit view)   crashed=1 crashAge=s
 * window.__ready, window.__stats {calls, triangles, buildMs}.
 */
import * as THREE from 'three';
import { createB747Model } from '../aircraft/b747';
import { createDefaultVisualState, createRestReadings } from '../aircraft/types';
import { CONFIG, B747_AIRCRAFT } from '../config';
import { createGpuTimer } from '../render/gpuTimer';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DEG = Math.PI / 180;
const G = B747_AIRCRAFT.geometry;
const night = q.get('night') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', night ? 1.2 : 1.0);
renderer.setClearColor(0xd9dee3);
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
  const [saz, sel] = (q.get('sun') ?? '215,38').split(',').map(Number);
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
sun.position.copy(sunDir).multiplyScalar(150);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 300 });
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
if (night) scene.environmentIntensity = 0.15;

const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), new THREE.MeshStandardMaterial({ color: night ? 0x2a2a2a : 0xb9bab4, roughness: 0.92 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── The jet ────────────────────────────────────────────────────────────────
const t0 = performance.now();
const jet = createB747Model();
const buildMs = performance.now() - t0;
scene.add(jet.root);
const view = q.get('view') ?? 'front34';
const airborne = view === 'belly' || q.get('air') === '1';
jet.root.position.set(0, airborne ? 12 : -G.noseWheel.y - num('comp', 0.12), 0);

const state = createDefaultVisualState();
state.engineRunning = q.get('engine') !== '0';
state.gearPos = num('gear', 1);
state.flapsDeg = num('flaps', 0);
state.elevator = num('elev', 0);
state.aileron = num('ail', 0);
state.rudder = num('rud', 0);
state.nosewheelSteer = num('steer', 0);
state.speedBrake = num('sb', 0);
state.crashed = q.get('crashed') === '1';
state.crashAge = num('crashAge', 0);
state.time = num('t', 0.02);
state.wheelCompression = airborne ? [0, 0, 0] : [num('comp', 0.12), num('comp', 0.12), num('comp', 0.12)];
const lightList = (q.get('lights') ?? 'nav').split(',');
state.lights = {
  nav: lightList.includes('nav'),
  strobe: lightList.includes('strobe'),
  beacon: lightList.includes('beacon'),
  landing: lightList.includes('landing'),
  taxi: lightList.includes('taxi'),
};
state.cameraMode = view === 'cockpit' ? 'cockpit' : 'orbit';
state.propRpm = num('thr', 72);
state.instruments = { ...createRestReadings(), throttlePct: num('thr', 72), aoaDeg: num('aoa', 0), airspeedKt: airborne ? 200 : 0, state: airborne ? 'airborne' : 'ground' };

// ── Camera ─────────────────────────────────────────────────────────────────
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -40, el: 7, dist: 115, fov: 40 },
  side: { az: -90, el: 1, dist: 125, fov: 38 },
  rear34: { az: -140, el: 12, dist: 115, fov: 40 },
  rear: { az: 180, el: 4, dist: 110, fov: 40 },
  top: { az: 0, el: 89.5, dist: 150, fov: 40 },
  belly: { az: -55, el: -35, dist: 100, fov: 40 },
  front: { az: 0, el: 3, dist: 110, fov: 40 },
  nose: { az: -40, el: 6, dist: 28, fov: 40, target: [0, 1.5, -26] },
  engine: { az: -45, el: 4, dist: 20, fov: 40, target: [-11.9, -2.4, -7] },
  wing: { az: -120, el: 25, dist: 45, fov: 40, target: [-18, 0, 10] },
  gear: { az: -70, el: -2, dist: 26, fov: 40, target: [-3, -3.5, 2] },
  tail: { az: -125, el: 10, dist: 40, fov: 40, target: [0, 7, 32] },
  cockpitExt: { az: -40, el: 12, dist: 16, fov: 40, target: [0, 3.8, -28] },
  orbit: { az: -40, el: 9, dist: 115, fov: 40 },
};
const p = presets[view] ?? presets.front34;
// ?ortho=side|top|front: orthographic 3-view with a 1 m grid (for checking real dimensions).
const ortho = q.get('ortho') as 'side' | 'top' | 'front' | null;
const aspect = innerWidth / innerHeight;
const halfW = ortho === 'top' ? 36 * aspect : ortho === 'side' ? 38 : 35;
const halfH = halfW / aspect;
const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = ortho
  ? new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 400)
  : new THREE.PerspectiveCamera(num('fov', view === 'cockpit' ? CONFIG.camera.cockpit.fov : p.fov), innerWidth / innerHeight, 0.05, 2000);
if (ortho) {
  ground.visible = false;
  scene.background = new THREE.Color(0xd9dee3);
  const lines: number[] = [];
  const gy = -G.noseWheel.y; // root height above the apron
  // 1 m grid (every 5th line is drawn by the darker overlay below).
  for (let k = -40; k <= 40; k++) {
    if (ortho === 'side') lines.push(0, -6 + gy, k, 0, 16 + gy, k);
    if (ortho === 'top') lines.push(-35, gy + 16, k, 35, gy + 16, k, k, gy + 16, -40, k, gy + 16, 40);
    if (ortho === 'front') lines.push(k, -6 + gy, -40, k, 16 + gy, -40);
  }
  for (let k = -6; k <= 16; k++) {
    if (ortho === 'side') lines.push(0, k + gy, -40, 0, k + gy, 40);
    if (ortho === 'front') lines.push(-40, k + gy, -40, 40, k + gy, -40);
  }
  const grid = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(lines, 3)), new THREE.LineBasicMaterial({ color: 0x44505a, transparent: true, opacity: 0.35 }));
  scene.add(grid);
  const cam = camera as THREE.OrthographicCamera;
  if (ortho === 'side') { cam.position.set(-150, gy + 4.5, 3.3); cam.lookAt(0, gy + 4.5, 3.3); }
  if (ortho === 'top') { cam.position.set(0, 150, 3.3); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 3.3); }
  if (ortho === 'front') { cam.position.set(0, gy + 4.5, -150); cam.lookAt(0, gy + 4.5, 0); }
  cam.updateProjectionMatrix();
}
function placeCamera() {
  jet.root.updateMatrixWorld(true);
  if (ortho) return;
  if (view === 'cockpit') {
    camera.position.copy(jet.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 2, 3];
  const target = jet.root.localToWorld(new THREE.Vector3(...tgt));
  camera.position.set(target.x + Math.sin(az) * Math.cos(el) * dist, target.y + Math.sin(el) * dist, target.z - Math.cos(az) * Math.cos(el) * dist);
  camera.lookAt(target);
}
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) (camera as THREE.PerspectiveCamera).aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ?atlas=map|roughness|bump shows the paint atlas full screen (for checking the livery).
const atlasKind = q.get('atlas') as 'map' | 'roughness' | 'bump' | null;
let atlasScene: THREE.Scene | null = null;
const atlasCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
if (atlasKind) {
  const skinMesh = jet.root.getObjectByName('b747.skin.centre') as THREE.Mesh;
  const tex = (skinMesh.material as THREE.MeshStandardMaterial)[atlasKind === 'map' ? 'map' : 'bumpMap'];
  atlasScene = new THREE.Scene();
  const aspect = innerWidth / innerHeight;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2 * Math.min(1, 2 / aspect), Math.min(1, 2 / aspect)), new THREE.MeshBasicMaterial({ map: tex }));
  atlasScene.add(quad);
}

const bench = q.get('bench') === '1';
const hidden = (q.get('hide') ?? '').split(',').filter(Boolean);
const gpu = createGpuTimer(renderer.getContext() as WebGL2RenderingContext, 0.05);
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
  // Settle the rate-limited parts quickly for stills.
  jet.setVisualState(state, frames < 30 ? 0.25 : dt);
  // ?hide=name,name hides parts (debugging what blocks a view).
  for (const n of hidden) { const o = jet.root.getObjectByName(n); if (o) o.visible = false; }
  placeCamera();
  renderer.info.reset();
  if (atlasScene) {
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.render(atlasScene, atlasCam);
  } else if (bench) {
    // Two phases (with the jet, then without); the GPU time difference is the jet's cost.
    const withJet = frames < 200;
    jet.root.visible = withJet;
    gpu.begin(withJet ? 'with' : 'without');
    renderer.render(scene, camera);
    gpu.end();
    gpu.poll();
    if (frames === 400) {
      const r = { withMs: gpu.get('with'), withoutMs: gpu.get('without'), jetMs: gpu.get('with') - gpu.get('without') };
      w.__gpu = r;
      console.log('[b747] gpu ' + JSON.stringify(r));
    }
  } else renderer.render(scene, camera);
  frames++;
  if (frames === 40) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, buildMs: Math.round(buildMs) };
    w.__stats = stats;
    console.log('[b747] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `747-400 N747TT · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
