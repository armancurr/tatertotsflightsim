/**
 * MS Tater Star (cruise ship) model preview: the ship floating on a calm water plane at its static
 * waterline under a gradient-sky environment with a shadowing sun. URL parameters:
 *   view = front34 | side | rear34 | rear | top | bow | stern | screws | helm | cockpit | aerial | far
 *   az, el, dist, fov, target=x,y,z   orbit camera (deg; az 0 = ahead of the bow, −90 = port side)
 *   steer=deg (rudders)   n=rev/s (props)   lights=nav   night=1   sun=az,el   exposure=
 *   crashed=1 crashAge=s   hide=name,name   lookYaw, lookDown (cockpit)   spin=1
 * window.__ready, window.__stats {calls, triangles, buildMs}.
 */
import * as THREE from 'three';
import { createCruiseModel, CRUISE_SHAPE } from '../vessels/cruise';
import { createDefaultVisualState } from '../aircraft/types';
import { CONFIG, CRUISE_AIRCRAFT } from '../config';
import type { PropulsorState, VesselState } from '../types';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DEG = Math.PI / 180;
const G = CRUISE_AIRCRAFT.geometry;
const WC = CRUISE_AIRCRAFT.watercraft!;
const night = q.get('night') === '1';

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', night ? 1.6 : 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = q.get('shadows') !== '0';
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3();
const [saz, sel] = q.has('sun') ? q.get('sun')!.split(',').map(Number) : night ? [215, -12] : [215, 38];
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
if (night) scene.environmentIntensity = 0.12;

const sun = new THREE.DirectionalLight(0xfff3e0, night ? 0.04 : 3.0);
sun.position.copy(sunDir).multiplyScalar(400);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -170, right: 170, top: 170, bottom: -170, near: 10, far: 1000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.2;
scene.add(sun, sun.target);

const surface = new THREE.Mesh(
  new THREE.PlaneGeometry(20000, 20000),
  new THREE.MeshPhysicalMaterial({ color: night ? 0x02080c : 0x0f3a4a, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.9, envMapIntensity: 0.9 }),
);
surface.rotation.x = -Math.PI / 2;
surface.receiveShadow = true;
scene.add(surface);

const t0 = performance.now();
const ship = createCruiseModel();
const buildMs = performance.now() - t0;
scene.add(ship.root);
const view = q.get('view') ?? 'front34';
ship.root.position.set(0, -CRUISE_SHAPE.waterlineY, 0);
for (const name of (q.get('hide') ?? '').split(',').filter(Boolean)) {
  const o = ship.root.getObjectByName(name);
  if (o) o.visible = false;
}

const state = createDefaultVisualState();
const steer = num('steer', 0);
const n = num('n', 0);
const prop = (i: number): PropulsorState => ({
  rpm: Math.abs(n) * WC.engine.gearRatio * 60,
  n: WC.propulsors[i].type === 'shaft' ? n : 0,
  gear: n > 0 ? 'ahead' : n < 0 ? 'astern' : 'neutral',
  thrust: 0,
  steerDeg: WC.propulsors[i].type === 'shaft' ? steer : 0,
  load: 0,
  boost: 0,
});
state.vessel = {
  seaTime: 0, propulsors: WC.propulsors.map((_p, i) => prop(i)), tabs: 0, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0,
  wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
} as VesselState;
state.engineRunning = n !== 0;
state.crashed = q.get('crashed') === '1';
state.crashAge = num('crashAge', 0);
state.time = num('t', 0.02);
const lightList = (q.get('lights') ?? 'nav').split(',');
state.lights = { nav: lightList.includes('nav'), strobe: false, beacon: false, landing: false, taxi: false };
state.cameraMode = view === 'cockpit' || view === 'helm' ? 'cockpit' : 'orbit';

const presets: Record<string, { az: number; el: number; dist: number; fov: number; target?: [number, number, number] }> = {
  front34: { az: -38, el: 9, dist: 420, fov: 40 },
  side: { az: -90, el: 2, dist: 470, fov: 40, target: [0, 12, 8] },
  rear34: { az: -145, el: 10, dist: 400, fov: 40 },
  rear: { az: 180, el: 6, dist: 300, fov: 40 },
  top: { az: 0, el: 89.5, dist: 520, fov: 40, target: [0, 0, 8] },
  bow: { az: -25, el: 5, dist: 150, fov: 40, target: [0, 8, -100] },
  stern: { az: -150, el: 6, dist: 140, fov: 40, target: [0, 5, 115] },
  screws: { az: -120, el: -8, dist: 40, fov: 45, target: [0, -8, 110] },
  aerial: { az: -60, el: 35, dist: 2500, fov: 40 },
  far: { az: -70, el: 4, dist: 5000, fov: 20 },
};
const p = presets[view] ?? presets.front34;
const camera = new THREE.PerspectiveCamera(num('fov', state.cameraMode === 'cockpit' ? CONFIG.camera.cockpit.fov : p.fov), innerWidth / innerHeight, 0.1, 40000);
function placeCamera() {
  ship.root.updateMatrixWorld(true);
  if (state.cameraMode === 'cockpit') {
    camera.position.copy(ship.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z)));
    const yaw = -num('lookYaw', 0) * DEG;
    const pitch = -num('lookDown', CONFIG.camera.cockpit.lookDownDeg) * DEG;
    camera.lookAt(camera.position.clone().add(new THREE.Vector3(Math.sin(-yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))));
    return;
  }
  const az = num('az', p.az) * DEG;
  const el = num('el', p.el) * DEG;
  const dist = num('dist', p.dist);
  const tgt = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target ?? [0, 10, 5];
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
const w = window as unknown as Record<string, unknown>;
const spin = q.get('spin') === '1';
renderer.info.autoReset = false;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!q.has('t') || spin) state.time += dt;
  if (spin) p.az += dt * 12;
  ship.setVisualState(state, dt);
  placeCamera();
  renderer.info.reset();
  renderer.render(scene, camera);
  frames++;
  if (frames === 40) {
    const info = renderer.info;
    const stats = { calls: info.render.calls, triangles: info.render.triangles, geometries: info.memory.geometries, textures: info.memory.textures, buildMs: Math.round(buildMs) };
    w.__stats = stats;
    console.log('[cruise] ' + JSON.stringify(stats));
    if (q.get('hud') !== '0') document.getElementById('label')!.textContent = `MS Tater Star · ${view} · ${stats.calls} draws · ${stats.triangles} tris · build ${stats.buildMs} ms`;
    w.__ready = true;
  }
});
