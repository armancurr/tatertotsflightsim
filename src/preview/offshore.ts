/**
 * Offshore scenery preview: the "Tater Alpha" platform (flame, lights), one wind turbine turning in
 * the configured wind, and the race course's marks, on a calm sea under a gradient sky. Lights use
 * the same point-sprite material as the game. URL parameters:
 *   view = platform | helideck | flare | jacket | turbine | race     night=1 (dusk lighting, lights on)
 *   az, el, dist, fov, target=x,y,z   orbit camera override (deg; az 0 = from local +X)   t=seconds
 * window.__ready, window.__stats {calls, triangles, platformTris}.
 */
import * as THREE from 'three';
import { createPlatformModel } from '../world/offshore/platformModel';
import { PLATFORM } from '../world/offshore/platform';
import { buildRotor, buildTurbineStatic } from '../world/offshore/windFarmModel';
import { TURBINE, offshoreWind, rotorRpm } from '../world/offshore/windFarm';
import { createFlareUniforms, createOffshoreMaterial } from '../world/offshore/materials';
import { raceCourse } from '../world/offshore/raceCourse';
import { createRaceCourseModel } from '../world/offshore/raceModel';
import { getSeaSpectrum } from '../world/water/waves';
import { createLightingUniforms, createPointMaterial } from '../world/traffic/materials';
import { PointBuffer } from '../world/traffic/points';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DEG = Math.PI / 180;
const night = q.get('night') === '1';
const view = q.get('view') ?? 'platform';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exposure', night ? 0.9 : 1.0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
document.getElementById('app')!.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3(Math.sin(215 * DEG) * Math.cos((night ? 3 : 38) * DEG), Math.sin((night ? 3 : 38) * DEG), -Math.cos(215 * DEG) * Math.cos((night ? 3 : 38) * DEG));
{
  const sky = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: sunDir }, uNight: { value: night ? 1 : 0 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 uSun; uniform float uNight; varying vec3 vDir;
      void main(){ float h = vDir.y;
        vec3 zen = mix(vec3(0.16,0.34,0.72), vec3(0.03,0.05,0.12), uNight);
        vec3 hor = mix(vec3(0.72,0.82,0.92), vec3(0.55,0.32,0.2), uNight);
        vec3 c = h > 0.0 ? mix(hor, zen, pow(h, 0.55)) : hor * 0.5;
        gl_FragColor = vec4(c, 1.0); }`,
  });
  sky.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat));
  const env = new THREE.PMREMGenerator(renderer).fromScene(sky, 0.02);
  scene.environment = env.texture;
  scene.background = env.texture;
  scene.backgroundBlurriness = 0.3;
  if (night) scene.environmentIntensity = 0.25;
}
const sun = new THREE.DirectionalLight(night ? 0xff9a60 : 0xfff3e0, night ? 0.35 : 3.0);
sun.position.copy(sunDir).multiplyScalar(300);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 800 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshPhysicalMaterial({ color: night ? 0x03090d : 0x0f3a4a, roughness: 0.15, transparent: true, opacity: 0.9 }));
sea.rotation.x = -Math.PI / 2;
sea.receiveShadow = true;
scene.add(sea);

// ── Platform at the origin (its local frame), a turbine 400 m off, the race marks 700 m off ──
const t0 = performance.now();
const plat = createPlatformModel(PLATFORM.depth);
scene.add(plat.root);
const uni = createFlareUniforms();
const tmat = createOffshoreMaterial(uni, { flare: false, name: 'preview.turbine' });
const rmat = createOffshoreMaterial(uni, { flare: false, name: 'preview.rotor', doubleSide: true });
const turbine = new THREE.Group();
turbine.position.set(-420, 0, 260);
const wind = offshoreWind(null);
turbine.rotation.y = -wind.fromDeg * DEG; // faces the config wind (the preview is world-aligned)
const tower = new THREE.Mesh(buildTurbineStatic(PLATFORM.depth), tmat);
const rotor = new THREE.Mesh(buildRotor(), rmat);
rotor.position.set(0, TURBINE.hubHeight, -TURBINE.overhang);
rotor.rotation.x = TURBINE.tiltDeg * DEG;
tower.castShadow = rotor.castShadow = true;
turbine.add(tower, rotor);
scene.add(turbine);
const course = raceCourse();
const race = createRaceCourseModel({ ...course, marks: course.marks.map((m) => ({ ...m, x: m.x - course.cx + 700, z: m.z - course.cz - 200 })) }, getSeaSpectrum(), () => 8);
scene.add(race.group);
const buildMs = performance.now() - t0;

// lights (the same sprites as the game)
const shared = createLightingUniforms();
const pmat = createPointMaterial(shared);
const pts = new PointBuffer(400);
const pobj = new THREE.Points(pts.geometry, pmat);
pobj.frustumCulled = false;
scene.add(pobj);

const hd = PLATFORM.helideck;
const tip = plat.flareTip;
const presets: Record<string, { target: [number, number, number]; az: number; el: number; dist: number; fov: number }> = {
  platform: { target: [0, 30, 0], az: 215, el: 14, dist: 230, fov: 45 },
  helideck: { target: [hd.cx, hd.y, hd.cz], az: 200, el: 32, dist: 45, fov: 50 },
  flare: { target: [tip.x, tip.y + 6, tip.z], az: 140, el: 8, dist: 70, fov: 45 },
  jacket: { target: [0, 5, 0], az: 250, el: 3, dist: 110, fov: 55 },
  turbine: { target: [-420, 90, 260], az: 230, el: 8, dist: 420, fov: 50 },
  race: { target: [course.marks[0].x - course.cx + 700, 4, course.marks[0].z - course.cz - 200], az: 250, el: 10, dist: 90, fov: 50 },
};
const p = presets[view] ?? presets.platform;
const target = q.has('target') ? (q.get('target')!.split(',').map(Number) as [number, number, number]) : p.target;
const camera = new THREE.PerspectiveCamera(num('fov', p.fov), innerWidth / innerHeight, 0.5, 20000);
const az = num('az', p.az) * DEG;
const el = num('el', p.el) * DEG;
const dist = num('dist', p.dist);
camera.position.set(target[0] + Math.sin(az) * Math.cos(el) * dist, target[1] + Math.sin(el) * dist, target[2] + Math.cos(az) * Math.cos(el) * dist);
camera.lookAt(...target);

const rpm = rotorRpm(wind.speedHub);
let t = num('t', 0);
let last = performance.now();
const label = document.getElementById('label')!;
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;
  plat.update(t, night ? 1 : 0);
  rotor.rotation.z -= rpm * (Math.PI / 30) * dt;
  race.update(t, camera.position.x, camera.position.z, 4, t, night ? 1 : 0);
  uni.uNight.value = night ? 1 : 0;
  pts.reset();
  pts.push(tip.x, tip.y + 10, tip.z, 60 * (night ? 2.8 : 0.35), 26 * (night ? 2.8 : 0.35), 6 * (night ? 2.8 : 0.35), 0, 9, 3, 0);
  if (night) {
    for (const l of plat.lights) {
      const c = l.kind === 'obstruction' ? [1.2, 0.06, 0.02] : l.kind === 'perimeter' ? [0.08, 0.5, 0.15] : l.kind === 'flood' ? [1.6, 1.5, 1.3] : [0.3, 0.22, 0.12];
      pts.push(l.x, l.y, l.z, c[0] * 900, c[1] * 900, c[2] * 900, 0, l.kind === 'obstruction' ? 0.6 : 0.4, 1.8, 0);
    }
  }
  pts.commit();
  pmat.uniforms.uHalfHeight.value = renderer.domElement.height / 2;
  renderer.render(scene, camera);
  const info = renderer.info.render;
  (window as unknown as { __stats: unknown }).__stats = { calls: info.calls, triangles: info.triangles, platformTris: plat.triangles(0), buildMs: Math.round(buildMs) };
  label.textContent = `offshore preview · ${view}${night ? ' · night' : ''} · ${info.calls} calls · ${info.triangles} tris · built in ${Math.round(buildMs)} ms`;
  (window as unknown as { __ready: boolean }).__ready = true;
  requestAnimationFrame(frame);
}
frame();
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
