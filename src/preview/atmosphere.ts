/**
 * Atmosphere preview: sky, sun, haze, clouds, shadows and flare over a test
 * world. URL parameters:
 *   x, y, z          camera position (m; default 0, 2, 0)
 *   heading, pitch   degrees (heading clockwise from north)
 *   fov              vertical field of view (default 60)
 *   tod              time-of-day preset index (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   focus=x,y,z      shadow focus point (default: the dummy aircraft)
 *   clouds=0 fog=0 shadows=0 flare=0 cirrus=0 post=0 hdr=0   feature toggles
 *   tm=agx|aces|neutral   tone mapping      dyn=1  dynamic resolution
 *   zf=1             z-fighting test strips far away      hud=0  hide the label
 * window.__fps (smoothed), window.__bench(frames) → ms/frame (GPU-synchronised),
 * window.__atmo, window.__setTod(i).
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { fbm2, mulberry32 } from '../render/noise';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const flag = (k: string, d = true) => (q.has(k) ? q.get(k) !== '0' : d);

const container = document.getElementById('app')!;
const rend = createRenderer(container, {
  hdr: flag('hdr'),
  toneMapping: q.get('tm') ?? undefined,
  dynamicResolution: flag('dyn', false),
});
const renderer = rend.renderer;
if (!flag('post')) {
  rend.post.flare = false;
  rend.post.vignette = 0;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.08, 90000);
camera.position.set(num('x', 0), num('y', 2), num('z', 0));
camera.rotation.set((num('pitch', 3) * Math.PI) / 180, (-num('heading', 0) * Math.PI) / 180, 0, 'YXZ');
scene.add(camera);
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ── Ground: huge subdivided plane with a noisy field texture ────────────────
function fieldTexture(): THREE.DataTexture {
  // A 2 km tile of rectangular fields (farmland patchwork) with fine noise.
  const n = 1024;
  const data = new Uint8Array(n * n * 4);
  const palette = [
    [70, 92, 40],
    [98, 116, 52],
    [132, 124, 74],
    [56, 78, 36],
    [150, 138, 92],
    [86, 102, 48],
    [112, 104, 64],
    [64, 88, 52],
  ];
  const cells = 14;
  const rng = mulberry32(21);
  const cellColor: number[] = [];
  for (let i = 0; i < cells * cells; i++) cellColor.push(Math.floor(rng() * palette.length));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n;
      const v = y / n;
      const wu = u + (fbm2(u * 6, v * 6, 2, 5, 6) - 0.5) * 0.03;
      const wv = v + (fbm2(u * 6 + 3, v * 6, 2, 6, 6) - 0.5) * 0.03;
      const cx = Math.floor(((wu % 1) + 1) % 1 * cells);
      const cy = Math.floor(((wv % 1) + 1) % 1 * cells);
      const c = palette[cellColor[cy * cells + cx]];
      const fine = 0.78 + 0.44 * fbm2(u * 96, v * 96, 3, 9, 96);
      const o = (y * n + x) * 4;
      data[o] = Math.min(255, c[0] * fine);
      data[o + 1] = Math.min(255, c[1] * fine);
      data[o + 2] = Math.min(255, c[2] * fine);
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}
const groundTex = fieldTexture();
groundTex.repeat.set(80, 80); // 2 km per repeat on a 160 km plane
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(160000, 160000, 200, 200).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, metalness: 0 }),
);
ground.receiveShadow = true;
scene.add(ground);

// ── Mountains at 10–40 km ───────────────────────────────────────────────────
const cones = [
  { x: -12000, z: -15000, h: 1800, r: 5000 },
  { x: 6000, z: -26000, h: 2600, r: 7500 },
  { x: 24000, z: -9000, h: 2100, r: 6000 },
  { x: -31000, z: 4000, h: 2400, r: 8000 },
  { x: 16000, z: 21000, h: 1500, r: 5000 },
  { x: -6000, z: 36000, h: 2200, r: 7000 },
  { x: 33000, z: 26000, h: 2500, r: 8000 },
  { x: -22000, z: -34000, h: 2000, r: 7000 },
  { x: 30000, z: 9000, h: 1400, r: 4500 },
];
const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d7358, roughness: 0.92, flatShading: false });
for (const c of cones) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(c.r, c.h, 64, 8), rockMat);
  m.position.set(c.x, c.h / 2, c.z);
  scene.add(m);
}
const groundHeight = (x: number, z: number) => {
  let h = 0;
  for (const c of cones) {
    const d = Math.hypot(x - c.x, z - c.z);
    if (d < c.r) h = Math.max(h, c.h * (1 - d / c.r));
  }
  return h;
};

// ── Test objects near the camera (north of the origin) ──────────────────────
const env: THREE.Object3D[] = [];
function add<T extends THREE.Mesh | THREE.Points | THREE.InstancedMesh>(o: T, cast = true): T {
  (o as THREE.Mesh).castShadow = cast;
  (o as THREE.Mesh).receiveShadow = true;
  scene.add(o);
  env.push(o);
  return o;
}
add(new THREE.Mesh(new THREE.SphereGeometry(2, 64, 32), new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }))).position.set(-7, 2, -28);
add(new THREE.Mesh(new THREE.SphereGeometry(1.5, 64, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 }))).position.set(-2, 1.5, -24);
add(new THREE.Mesh(new THREE.SphereGeometry(1.5, 48, 24), new THREE.MeshStandardMaterial({ color: 0xb02a1e, roughness: 0.45 }))).position.set(3, 1.5, -26);
add(new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3), new THREE.MeshLambertMaterial({ color: 0x8a8f99 }))).position.set(9, 1.5, -32);
add(new THREE.Mesh(new THREE.BoxGeometry(2, 5, 2), new THREE.MeshBasicMaterial({ color: 0x3060a0 }))).position.set(14, 2.5, -40);

// Dummy "Cessna": fuselage, wing, tail — a 1 m-scale shadow caster.
const plane = new THREE.Group();
const paint = new THREE.MeshPhysicalMaterial({ color: 0xf2f2f0, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.1 });
const fus = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.3, 7.5), paint);
fus.position.set(0, 1.55, 0);
const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.14, 1.6), paint);
wing.position.set(0, 2.45, -0.3);
const stab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 1.0), paint);
stab.position.set(0, 1.6, 3.6);
const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.1), paint);
fin.position.set(0, 2.4, 3.7);
const wheel = (x: number, z: number) => {
  const w = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.14, 20).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  w.position.set(x, 0.19, z);
  return w;
};
for (const m of [fus, wing, stab, fin, wheel(-1.27, 0.45), wheel(1.27, 0.45), wheel(0, -1.25)]) {
  m.castShadow = true;
  m.receiveShadow = true;
  plane.add(m);
}
plane.position.set(0, 0, -14);
plane.rotation.y = 0.5;
scene.add(plane);

// InstancedMesh "trees" from 60 m to 6 km — haze on instanced geometry.
{
  const rng = mulberry32(4);
  const N = 600;
  const trees = new THREE.InstancedMesh(new THREE.ConeGeometry(3, 12, 10).translate(0, 6, 0), new THREE.MeshStandardMaterial({ color: 0x2f4a24, roughness: 0.9 }), N);
  const m = new THREE.Matrix4();
  for (let i = 0; i < N; i++) {
    const a = rng() * Math.PI * 2;
    const d = 60 + Math.pow(rng(), 1.5) * 6000;
    const s = 0.7 + rng() * 0.8;
    m.makeScale(s, s, s).setPosition(Math.sin(a) * d, 0, -Math.cos(a) * d);
    trees.setMatrixAt(i, m);
  }
  trees.castShadow = true;
  trees.receiveShadow = true;
  scene.add(trees);
}

// Custom ShaderMaterial with the fog includes (checker panel), near and 5 km away.
const checker = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uColor: { value: new THREE.Color(0xe8c040) } }]),
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    #include <fog_pars_vertex>
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    varying vec2 vUv;
    #include <fog_pars_fragment>
    void main() {
      vec2 c = floor( vUv * 8.0 );
      float k = mod( c.x + c.y, 2.0 );
      gl_FragColor = vec4( mix( uColor * 0.25, uColor, k ), 1.0 );
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`,
  fog: true,
  side: THREE.DoubleSide,
});
const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), checker);
panel.position.set(-16, 3, -36);
panel.rotation.y = 0.4;
scene.add(panel);
const farPanel = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), checker);
farPanel.position.set(1500, 200, -5000);
scene.add(farPanel);

// Points (PointsMaterial, fog: true): a row of lamp posts' lights.
{
  const pts: number[] = [];
  for (let i = 0; i < 40; i++) pts.push(-30 + i * 1.5, 4, -60 - i * 40);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffe0a0, size: 0.6, sizeAttenuation: true })));
}

// z-fighting test: a 12 m wide "road" 0.15 m above the ground, 4–16 km out, and a
// "runway" plate 0.05 m above it.
if (flag('zf', false)) {
  const road = new THREE.Mesh(new THREE.PlaneGeometry(12, 12000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x303030, roughness: 0.9 }));
  road.position.set(0, 0.15, -10000);
  scene.add(road);
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(2, 12000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }));
  mark.position.set(0, 0.2, -10000);
  scene.add(mark);
}

// ── Atmosphere ─────────────────────────────────────────────────────────────
const atmo = createAtmosphere(renderer, scene, {
  timeOfDay: num('tod', 0),
  clouds: flag('clouds'),
  cirrus: flag('cirrus'),
  shadows: flag('shadows'),
  flare: flag('flare'),
  fog: flag('fog'),
  groundHeight,
});

// Frame a cloud: cloud=<i-th nearest to the origin>&cd=<distance in cloud radii>&side=<view heading>&dy=<height offset>
if (q.has('cloud') && atmo.clouds) {
  const list = [...atmo.clouds.field.clouds].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  const c = list[Math.min(list.length - 1, num('cloud', 0))];
  const centre = new THREE.Vector3(c.x, c.base + c.height * 0.45 + num('dy', 0), c.z);
  const h = (num('side', 0) * Math.PI) / 180;
  const dist = c.radius * num('cd', 3);
  const fwd = new THREE.Vector3(Math.sin(h), 0, -Math.cos(h));
  camera.position.copy(centre).addScaledVector(fwd, -dist);
  camera.position.y = centre.y + num('dy', 0) * 0 + num('cy', 0);
  if (q.get('incloud') === '1') camera.position.set(c.x, c.base + c.height * 0.35, c.z);
  const look = new THREE.Vector3(c.x, c.base + c.height * 0.45, c.z).sub(camera.position);
  camera.rotation.set(Math.atan2(look.y, Math.hypot(look.x, look.z)) + (num('pitch', 0) * Math.PI) / 180, Math.atan2(-look.x, -look.z), 0, 'YXZ');
}

const focus = new THREE.Vector3();
if (q.has('focus')) {
  const [fx, fy, fz] = q.get('focus')!.split(',').map(Number);
  focus.set(fx, fy, fz);
} else focus.copy(plane.position);

// ── Loop ──────────────────────────────────────────────────────────────────
const label = document.getElementById('label')!;
const showHud = flag('hud');
let fps = 0;
let frames = 0;
let acc = 0;
let last = performance.now();
declare global {
  interface Window {
    __fps: number;
    __bench: (frames?: number) => number;
    __atmo: typeof atmo;
    __setTod: (i: number) => void;
    __rend: typeof rend;
  }
}
window.__fps = 0;
window.__atmo = atmo;
window.__rend = rend;
window.__setTod = (i) => atmo.setTimeOfDay(i);

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dt;
  frames++;
  if (acc >= 0.5) {
    fps = frames / acc;
    window.__fps = Math.round(fps * 10) / 10;
    frames = 0;
    acc = 0;
  }
  camera.updateMatrixWorld();
  atmo.update(camera, dt, focus);
  renderer.render(scene, camera);
  if (showHud) {
    label.textContent = `${atmo.timeOfDayName} · ${fps.toFixed(0)} fps · depth ${rend.depthMode} · pr ${rend.pixelRatio} · alt ${camera.position.y.toFixed(0)} m`;
  }
}
renderer.setAnimationLoop(frame);

/** GPU-synchronised frame cost: render N frames back to back, reading one pixel after each. */
window.__bench = (n = 60) => {
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  renderer.setAnimationLoop(null);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    camera.updateMatrixWorld();
    atmo.update(camera, 1 / 60, focus);
    renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }
  const ms = (performance.now() - t0) / n;
  renderer.setAnimationLoop(frame);
  return Math.round(ms * 100) / 100;
};
