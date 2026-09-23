/**
 * Aircraft model preview: the C172RG on a light-grey apron under a gradient
 * sky environment with a shadow-casting sun. URL parameters:
 *   view = front34 | side | rear34 | top | cockpit | belly | nose | tail | orbit
 *   az, el, dist, fov        orbit camera (degrees; az 0 = straight ahead of the nose, −90 = left side)
 *   gear=0..1 flaps=deg elev= ail= rud= trim= steer= (−1..1) rpm= comp=nose,left,right
 *   lights=nav,strobe,beacon,landing,taxi   t=seconds (light timing)   q=high|low
 *   sun=azimuth,elevation (deg)   spin=1 (auto-rotate)   hud=0
 *   crash=1 (wreck)   explode=0..1 (break-up parts pushed apart from the CG, for inspection)
 *   view=mascot (the livery mascot flat, at several sizes)
 * window.__ready (after the first frames), window.__stats {calls, triangles, geometries, textures}.
 */
import * as THREE from 'three';
import { createAircraft, createDefaultVisualState } from '../aircraft/index';
import { CONFIG } from '../config';
import { MASCOT_BOX, drawTaterMascot } from '../aircraft/mascot';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DEG = Math.PI / 180;
const G = CONFIG.aircraft.geometry;

const container = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// ── Gradient sky, used both as background and (PMREM) environment ─────────
function skyScene(): THREE.Scene {
  const s = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: new THREE.Vector3() } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 zen = vec3(0.16, 0.34, 0.72);
        vec3 hor = vec3(0.72, 0.82, 0.92);
        vec3 gnd = vec3(0.34, 0.33, 0.30);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : mix(hor * 0.8, gnd, pow(-h, 0.4));
        float sd = max(dot(normalize(vDir), normalize(uSun)), 0.0);
        c += vec3(1.0, 0.95, 0.85) * (pow(sd, 900.0) * 60.0 + pow(sd, 12.0) * 0.35);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const [saz, sel] = (q.get('sun') ?? '215,38').split(',').map(Number);
  sunDir.set(Math.sin(saz * DEG) * Math.cos(sel * DEG), Math.sin(sel * DEG), -Math.cos(saz * DEG) * Math.cos(sel * DEG));
  mat.uniforms.uSun.value.copy(sunDir);
  s.add(new THREE.Mesh(geo, mat));
  return s;
}
const sunDir = new THREE.Vector3();
const pmrem = new THREE.PMREMGenerator(renderer);
const sky = skyScene();
const envRT = pmrem.fromScene(sky, 0.02);
scene.environment = envRT.texture;
scene.background = envRT.texture;
scene.backgroundBlurriness = 0.35;

const sun = new THREE.DirectionalLight(0xfff3e0, 3.0);
sun.position.copy(sunDir).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -9;
sun.shadow.camera.right = 9;
sun.shadow.camera.top = 9;
sun.shadow.camera.bottom = -9;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0xb9bab4, roughness: 0.92, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// Runway-ish painted line for scale/orientation.
const line = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 60), new THREE.MeshStandardMaterial({ color: 0xe8e6da, roughness: 0.8 }));
line.rotation.x = -Math.PI / 2;
line.position.set(0, 0.002, -20);
scene.add(line);

// ── Aircraft ───────────────────────────────────────────────────────────────
const quality = (q.get('q') as 'high' | 'low') ?? 'high';
const t0 = performance.now();
const ac = createAircraft({ quality });
const buildMs = performance.now() - t0;
scene.add(ac.root);
const view = q.get('view') ?? 'front34';
const airborne = view === 'belly' || q.get('air') === '1';
ac.root.position.set(0, airborne ? 4.5 : -G.noseWheel.y, 0);

const state = createDefaultVisualState();
state.gearPos = num('gear', 1);
state.flapsDeg = num('flaps', 0);
state.elevator = num('elev', 0);
state.aileron = num('ail', 0);
state.rudder = num('rud', 0);
state.trim = num('trim', 0);
state.nosewheelSteer = num('steer', 0);
state.propRpm = num('rpm', 0);
state.engineRunning = state.propRpm > 500;
state.time = num('t', 0.02);
if (q.has('comp')) {
  const c = q.get('comp')!.split(',').map(Number);
  state.wheelCompression = [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}
const lightList = (q.get('lights') ?? 'nav,beacon').split(',');
state.lights = {
  nav: lightList.includes('nav'),
  strobe: lightList.includes('strobe'),
  beacon: lightList.includes('beacon'),
  landing: lightList.includes('landing'),
  taxi: lightList.includes('taxi'),
};
state.cameraMode = view === 'cockpit' ? 'cockpit' : 'orbit';
state.crashed = q.get('crash') === '1';
state.crashAge = num('crashAge', 8);
// Exploded view of the crash break-up parts: each part slides away from the CG along its centre.
const explode = num('explode', 0);
if (explode > 0) {
  ac.root.updateMatrixWorld(true);
  for (const part of ac.getBreakupParts()) {
    const box = new THREE.Box3().setFromObject(part.object);
    const c = box.getCenter(new THREE.Vector3());
    ac.root.worldToLocal(c);
    const dir = c.lengthSq() > 1e-6 ? c.normalize() : new THREE.Vector3(0, 1, 0);
    part.object.position.addScaledVector(dir, explode * 1.6);
  }
}
state.instruments = {
  airspeedKt: num('ias', 0), altitudeFt: 98, altitudeAglFt: 0, headingDeg: 360, verticalSpeedFpm: 0,
  pitchDeg: 0, rollDeg: 0, slipSkid: 0, turnRateDegPerSec: 0, throttlePct: num('thr', 0),
  rpm: state.propRpm, engineStatus: state.propRpm > 500 ? 'RUNNING' : 'OFF', flapsDeg: state.flapsDeg,
  flapsTargetDeg: state.flapsDeg, gear: state.gearPos >= 1 ? 'down' : state.gearPos <= 0 ? 'up' : 'transit',
  gearLight: state.gearPos >= 1 ? 'green' : state.gearPos <= 0 ? 'off' : 'red', brakes: false, parkingBrake: true,
  trimPct: state.trim * 100, stallWarning: false, overspeed: false, aoaDeg: 0, gLoad: 1, groundSpeedKt: 0, state: 'ground',
};

// ── Camera ─────────────────────────────────────────────────────────────────
const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -38, el: 10, dist: 12.5, fov: 40 },
  side: { az: -90, el: 2, dist: 15.5, fov: 36 },
  rear34: { az: -142, el: 14, dist: 13, fov: 40 },
  top: { az: 0, el: 89.5, dist: 19, fov: 40 },
  belly: { az: -60, el: -38, dist: 11, fov: 40 },
  front: { az: 0, el: 3, dist: 14, fov: 40 },
  nose: { az: -32, el: 6, dist: 4.2, fov: 40, target: [0, 0.1, -1.4] },
  tail: { az: -128, el: 14, dist: 5.2, fov: 40, target: [0, 0.6, 4.9] },
  cabin: { az: -70, el: 8, dist: 4.5, fov: 40, target: [0, 0.4, -0.2] },
  orbit: { az: -38, el: 10, dist: 12.5, fov: 40 },
};
const p = presets[view] ?? presets.front34;
const camera = new THREE.PerspectiveCamera(num('fov', view === 'cockpit' ? CONFIG.camera.cockpit.fov : p.fov), innerWidth / innerHeight, 0.05, 2000);
function placeCamera() {
  ac.root.updateMatrixWorld(true);
  if (view === 'cockpit') {
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    camera.position.copy(ac.root.localToWorld(eye.clone()));
    const lookYaw = num('lookYaw', 0) * DEG;
    const lookPitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    const dir = new THREE.Vector3(Math.sin(lookYaw) * Math.cos(lookPitch), Math.sin(lookPitch), -Math.cos(lookYaw) * Math.cos(lookPitch));
    camera.lookAt(camera.position.clone().add(dir));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 0.15, 1.6];
  const target = ac.root.localToWorld(new THREE.Vector3(...tgt));
  camera.position.set(
    target.x + Math.sin(az) * Math.cos(el) * dist,
    target.y + Math.sin(el) * dist,
    target.z - Math.cos(az) * Math.cos(el) * dist,
  );
  camera.lookAt(target);
}
placeCamera();

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── Loop ─────────────────────────────────────────────────────────────────
let frames = 0;
let last = performance.now();
const label = document.getElementById('label')!;
const w = window as unknown as Record<string, unknown>;
const spin = q.get('spin') === '1';
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (q.has('t') && !spin) {
    // frozen light timing
  } else {
    state.time += dt;
  }
  if (spin) p.az += dt * 20;
  ac.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  renderer.render(scene, camera);
  frames++;
  if (frames === 12) {
    const info = renderer.info;
    const stats = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      buildMs: Math.round(buildMs),
    };
    w.__stats = stats;
    console.log('[aircraft] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') label.textContent = `C172RG N172JT · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
renderer.autoClear = true;
renderer.info.autoReset = false;

// ── Flat mascot sheet (view=mascot): the livery art at several sizes on white paint ──────────
if (q.get('view') === 'mascot') {
  const c = document.createElement('canvas');
  c.width = innerWidth;
  c.height = innerHeight;
  Object.assign(c.style, { position: 'fixed', inset: '0', zIndex: '5' });
  document.body.appendChild(c);
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 0, c.width, c.height);
  const big = Math.min((c.width * 0.62) / MASCOT_BOX.w, (c.height * 0.9) / MASCOT_BOX.h);
  g.save();
  g.translate(20, 20);
  g.scale(big, big);
  drawTaterMascot(g);
  g.restore();
  for (const [k, y] of [[0.3, 40], [0.15, 260], [0.07, 420]] as const) {
    g.save();
    g.translate(c.width * 0.66, y);
    g.scale(k, k);
    drawTaterMascot(g, { outline: 7 / Math.sqrt(k / 0.3) });
    g.restore();
  }
}
