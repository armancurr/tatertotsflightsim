/**
 * Vessel and harbour models preview: one model (or the marina) on a calm sea
 * plane under the real sky, lights and environment map, drawn through the
 * traffic batch material. URL parameters:
 *   kind     sail | motor | fish | launch | ferry | container | tanker | marina (default container)
 *   lod      0 near (default) / 1 far;  variant  model variant;  moored=1 (yachts)
 *   dist, az, el   orbit (m, deg, deg) around tx, ty, tz (m)
 *   tod      time-of-day preset;  night=0..1 lit windows
 * window.__ready, window.__renderer, window.__tris.
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { buildVesselPart, HULL_TINTS } from '../world/traffic/models/vessels';
import { buildMarina } from '../world/traffic/models/marina';
import { createBatchMaterial, createLightingUniforms } from '../world/traffic/materials';
import { createMarina, type VesselKind } from '../world/traffic/sea';
import { getLayout } from '../world/layout';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __ready: boolean;
    __renderer: THREE.WebGLRenderer;
    __tris: number;
  }
}
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
window.__ready = false;

async function main() {
  const container = document.getElementById('app')!;
  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  window.__renderer = renderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  scene.add(camera);
  const atmo = createAtmosphere(renderer, scene, { groundHeight: () => 0 });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0d2a36, roughness: 0.12, metalness: 0 }));
  sea.position.y = 0.02;
  scene.add(sea);
  const shared = createLightingUniforms();
  shared.uNight.value = num('night', 0);
  const mat = createBatchMaterial(shared, { underwater: true, name: 'ships-preview' });
  const kind = q.get('kind') ?? 'container';
  const lod = num('lod', 0);
  let geo: THREE.BufferGeometry;
  if (kind === 'marina') geo = buildMarina(createMarina(getLayout()), lod).build();
  else geo = buildVesselPart(kind as VesselKind, 'hull', lod, { variant: num('variant', 0), moored: q.get('moored') === '1' }).build();
  window.__tris = geo.index!.count / 3;
  const batch = new THREE.BatchedMesh(1, geo.getAttribute('position').count, geo.index!.count, mat);
  const id = batch.addInstance(batch.addGeometry(geo));
  const tints = kind === 'marina' ? [0xffffff] : HULL_TINTS[kind as VesselKind];
  const c = new THREE.Color(tints[num('variant', 0) % tints.length]);
  batch.setColorAt(id, new THREE.Vector4(c.r, c.g, c.b, 0.6) as unknown as THREE.Color);
  scene.add(batch);
  const bb = geo.boundingBox!;
  const size = bb.getSize(new THREE.Vector3()).length();
  const az = (num('az', 215) * Math.PI) / 180;
  const el = (num('el', 14) * Math.PI) / 180;
  const d = num('dist', size * 0.9);
  const tx = num('tx', 0);
  const ty = num('ty', (bb.max.y + Math.max(0, bb.min.y)) * 0.35);
  const tz = num('tz', 0);
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * d, ty + Math.sin(el) * d, tz + Math.cos(az) * Math.cos(el) * d);
  camera.lookAt(tx, ty, tz);
  const label = document.getElementById('label')!;
  label.textContent = `${kind} lod ${lod}: ${window.__tris} triangles`;
  const focus = new THREE.Vector3();
  let last = performance.now();
  let t = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    shared.uTime.value = t;
    atmo.update(camera, dt, focus);
    rend.render(scene, camera);
    if (t > 2) window.__ready = true;
  });
}
main().catch((e) => console.error(e));
