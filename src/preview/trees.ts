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
 *   variants=n   n trees of each species one behind the other (different tint hashes → crowns)
 *   t=<0..1>     tint hash of the first tree (default 0.5; < 0.005 dead, > 0.972 turning)
 *   compare=1    LOD check: each species drawn alone as the near mesh, then as its impostor, at
 *                `dist` m (default 155) and `elev` degrees; window.__compare holds the mean colour
 *                and coverage of both (tests/e2e/trees.e2e.test.ts)
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { buildSpeciesGeometry } from '../world/vegetation/species';
import { SPECIES_COUNT, SPECIES_NAMES } from '../world/vegetation/placement';
import { createVegUniforms, createNearMaterial, createNearDepthMaterial, createImpostorMaterial, CROWN_CENTER } from '../world/vegetation/materials';
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
    __compare: CompareResult[] | null;
  }
}
interface CompareResult {
  species: number;
  name: string;
  /** Mean sRGB colour (0..1) over the tree's own pixels, and the pixel count. */
  near: { rgb: [number, number, number]; luma: number; pixels: number };
  impostor: { rgb: [number, number, number]; luma: number; pixels: number };
}
window.__compare = null;
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
  const spacing = num('spacing', q.get('compare') === '1' ? 90 : 17);
  const variants = Math.max(1, Math.round(num('variants', 1)));
  const t0v = num('t', 0.5);
  const x0 = -((list.length - 1) * spacing) / 2;
  const col = new THREE.Color();
  const m4 = new THREE.Matrix4();
  const impRows = q.get('imp') === '1';
  const compare = q.get('compare') === '1';
  const impData = new Float32Array(list.length * I_STRIDE);
  const nearByIndex: THREE.InstancedMesh[] = [];
  list.forEach((sp, i) => {
    const [h, r] = SIZES[sp];
    const mesh = new THREE.InstancedMesh(buildSpeciesGeometry(sp), nearMat, variants);
    mesh.customDepthMaterial = depthMat;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let k = 0; k < variants; k++) {
      m4.makeScale(r, h, r).setPosition(x0 + i * spacing, 0, -k * spacing * 1.2);
      mesh.setMatrixAt(k, m4);
      // instance "colour" = (tint hash, species, 0) — the shader derives tint and crown variation
      const t = k === 0 ? t0v : (t0v + k * 0.1379) % 0.97;
      mesh.setColorAt(k, col.setRGB(t, sp, 0));
    }
    mesh.frustumCulled = false;
    scene.add(mesh);
    nearByIndex.push(mesh);
    const o = i * I_STRIDE;
    impData.set([x0 + i * spacing, 0, compare ? 0 : -40, h, r, sp + 0.001, t0v, 0], o);
  });
  let impMesh: THREE.Mesh | null = null;
  if (impRows || compare) {
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
    impMesh = im;
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

  /** Renders one frame and returns the canvas pixels (RGBA8, bottom-up). */
  const gl = renderer.getContext();
  const grab = (): Uint8Array => {
    camera.updateMatrixWorld();
    atmo.update(camera, 1 / 60, focus);
    rend.render(scene, camera);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const stats = (img: Uint8Array, bg: Uint8Array) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < img.length; i += 4) {
      const d = Math.abs(img[i] - bg[i]) + Math.abs(img[i + 1] - bg[i + 1]) + Math.abs(img[i + 2] - bg[i + 2]);
      if (d < 24) continue;
      r += img[i];
      g += img[i + 1];
      b += img[i + 2];
      n++;
    }
    const rgb: [number, number, number] = n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0];
    return { rgb, luma: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], pixels: n };
  };
  const runCompare = (): CompareResult[] => {
    const D = num('dist', 155);
    const elev = (num('elev', 6) * Math.PI) / 180;
    const out: CompareResult[] = [];
    rend.dynamicResolution = false;
    ground.visible = false;
    list.forEach((sp, i) => {
      const [h] = SIZES[sp];
      const cx = x0 + i * spacing;
      const cy = CROWN_CENTER * h;
      camera.fov = (2 * Math.atan((0.7 * h) / D) * 180) / Math.PI;
      camera.updateProjectionMatrix();
      camera.position.set(cx, cy + Math.sin(elev) * D, Math.cos(elev) * D);
      camera.lookAt(cx, cy, 0);
      for (const m of nearByIndex) m.visible = false;
      if (impMesh) impMesh.visible = false;
      const bg = grab();
      // average over several trees (tint hashes → per-tree tint and crown variation) on both paths
      const acc = { near: [] as ReturnType<typeof stats>[], imp: [] as ReturnType<typeof stats>[] };
      for (const t of [0.12, 0.31, 0.5, 0.69, 0.88]) {
        nearByIndex[i].setColorAt(0, col.setRGB(t, sp, 0));
        nearByIndex[i].instanceColor!.needsUpdate = true;
        impData[i * I_STRIDE + 6] = t;
        if (impMesh) ((impMesh.geometry.getAttribute('iB') as THREE.InterleavedBufferAttribute).data as THREE.InterleavedBuffer).needsUpdate = true;
        nearByIndex[i].visible = true;
        if (impMesh) impMesh.visible = false;
        grab();
        acc.near.push(stats(grab(), bg));
        nearByIndex[i].visible = false;
        if (impMesh) impMesh.visible = true;
        grab();
        acc.imp.push(stats(grab(), bg));
      }
      const mean = (a: ReturnType<typeof stats>[]) => {
        const rgb: [number, number, number] = [0, 1, 2].map((k) => a.reduce((x, y) => x + y.rgb[k], 0) / a.length) as [number, number, number];
        return { rgb, luma: a.reduce((x, y) => x + y.luma, 0) / a.length, pixels: a.reduce((x, y) => x + y.pixels, 0) / a.length };
      };
      const near = mean(acc.near);
      const imp = mean(acc.imp);
      out.push({ species: sp, name: SPECIES_NAMES[sp], near, impostor: imp });
    });
    return out;
  };

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
      if (compare && window.__compare === null) window.__compare = runCompare();
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
