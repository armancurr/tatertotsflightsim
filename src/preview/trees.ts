/**
 * Trees preview: the seven species on a lawn, lit by the real renderer +
 * atmosphere. URL parameters:
 *   d=<m>        camera distance from the row (default 40)
 *   h=<m>        camera height (default 2)
 *   pitch        degrees (default: look at mid-height)
 *   imp=1        a second row of the same trees drawn as impostors (to compare)
 *   tod          time-of-day preset (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   heading      camera heading (default 0 = looking north at the row)
 *   species=i    only species i (bigger)
 *   spacing=<m>  spacing between trees (default 22)
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { buildSpeciesGeometry } from '../world/vegetation/species';
import { SPECIES_COUNT, SPECIES_NAMES } from '../world/vegetation/placement';
import { createVegUniforms, createNearMaterial, createNearDepthMaterial, createImpostorMaterial, tintColor } from '../world/vegetation/materials';
import { createImpostorAtlas } from '../world/vegetation/impostors';
import { getFoliageTextures } from '../world/vegetation/textures';
import { lodParams } from '../world/vegetation/lod';
import { I_STRIDE } from '../world/vegetation/pack';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const container = document.getElementById('app')!;
const label = document.getElementById('label')!;
declare global {
  interface Window {
    __fps: number;
    __ready: boolean;
  }
}
window.__fps = 0;
window.__ready = false;

const SIZES: [number, number][] = [
  [24, 4.6], // spruce h, r
  [21, 5.2],
  [17, 7.5],
  [15, 3.8],
  [24, 3.2],
  [12, 6.8],
  [3.2, 2.8],
];

async function main(): Promise<void> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, CONFIG.camera.far);
  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  const atmo = createAtmosphere(renderer, scene, { groundHeight: () => 0 });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));

  // lawn
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(0.055, 0.1, 0.03, THREE.LinearSRGBColorSpace), roughness: 0.95 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const cfg = CONFIG.world.vegetation;
  const lod = lodParams(cfg);
  const u = createVegUniforms(lod, cfg.translucency);
  const tex = getFoliageTextures();
  const nearMat = createNearMaterial(u, tex);
  const depthMat = createNearDepthMaterial(u, tex);
  const atlas = createImpostorAtlas(cfg.impostorTileSize, tex);
  atlas.bake(renderer);
  const impMat = createImpostorMaterial(u, atlas);

  const only = q.has('species') ? num('species', 0) : -1;
  const list = only >= 0 ? [only] : Array.from({ length: SPECIES_COUNT }, (_, i) => i);
  const spacing = num("spacing", 17);
  const x0 = -((list.length - 1) * spacing) / 2;
  const col = new THREE.Color();
  const m4 = new THREE.Matrix4();
  const impRows = q.get('imp') === '1';
  const impData = new Float32Array(list.length * I_STRIDE);
  list.forEach((sp, i) => {
    const [h, r] = SIZES[sp];
    const mesh = new THREE.InstancedMesh(buildSpeciesGeometry(sp), nearMat, 1);
    mesh.customDepthMaterial = depthMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    m4.makeScale(r, h, r).setPosition(x0 + i * spacing, 0, 0);
    mesh.setMatrixAt(0, m4);
    mesh.setColorAt(0, tintColor(0.5, sp, col));
    mesh.frustumCulled = false;
    scene.add(mesh);
    const o = i * I_STRIDE;
    impData.set([x0 + i * spacing, 0, -40, h, r, sp + 0.001, 0.5, 0], o);
  });
  if (impRows) {
    // the same trees again 40 m behind, as impostors (force the impostor LOD with a tiny mesh distance)
    const buf = new THREE.InstancedInterleavedBuffer(impData, I_STRIDE, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    g.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    g.instanceCount = list.length;
    const impU = createVegUniforms({ ...lod, meshDistance: 1, lodFadeBand: 0.5 }, cfg.translucency);
    const im = new THREE.Mesh(g, createImpostorMaterial(impU, atlas));
    im.frustumCulled = false;
    scene.add(im);
  }

  const d = num('d', 40);
  const hh = num('h', 2);
  const heading = num('heading', 0);
  const hr = (heading * Math.PI) / 180;
  camera.position.set(-Math.sin(hr) * d, hh, Math.cos(hr) * d);
  const pitch = q.has('pitch') ? num('pitch', 0) : (Math.atan2(9 - hh, d) * 180) / Math.PI;
  camera.rotation.set((pitch * Math.PI) / 180, -hr, 0, 'YXZ');
  scene.add(camera);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const focus = new THREE.Vector3(0, 0, 0);
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  const t0 = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    acc += dt;
    frames++;
    if (acc > 0.5) {
      window.__fps = Math.round((frames / acc) * 10) / 10;
      acc = 0;
      frames = 0;
      window.__ready = true;
      label.textContent = `fps ${window.__fps}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}  ${list.map((s) => SPECIES_NAMES[s]).join(' · ')}`;
    }
    camera.updateMatrixWorld();
    atmo.update(camera, dt, focus);
    u.uVegTime.value = (now - t0) / 1000;
    rend.render(scene, camera);
  });
}

main().catch((e) => {
  console.error(e);
  label.textContent = String(e);
});
