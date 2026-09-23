/**
 * Vehicle models preview: every model (near LOD in the front row, far LOD
 * behind) on a plain asphalt apron under the real sky, lights and environment
 * map, rendered through the same material as the traffic. URL parameters:
 *   tod     time-of-day preset (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   dist    camera distance (default 22), az / el orbit angles (deg)
 *   lights=1  lamps on, brake=1, ind=1 (left indicator)
 *   spin    wheel spin (odometer m)
 * window.__ready, window.__renderer.
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { buildVehicleGeometry } from '../world/cars/vehicles';
import { createCarMaterial, createCarUniforms, FLAG_HEAD, FLAG_BRAKE, FLAG_IND_L } from '../world/cars/material';
import { MODEL_COUNT, VT } from '../world/cars/specs';
import { paintFor, paintRGB, paintFinish } from '../world/cars/paint';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __ready: boolean;
    __renderer: THREE.WebGLRenderer;
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
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.92 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const N = MODEL_COUNT;
  const tex = new THREE.DataTexture(new Float32Array(256 * 4 * 4), 256, 4, THREE.RGBAFormat, THREE.FloatType);
  const U = createCarUniforms(tex);
  U.uLodLift.value = [0, 0, 0, 0, 0, 0, 0, 0];
  U.uDepthPull.value = 0;
  U.uLights.value = q.get('lights') === '1' ? 1 : 0;
  U.uBlink.value = 1;
  const geos = [];
  let v = 0;
  let ix = 0;
  for (let m = 0; m < N; m++)
    for (const lod of [0, 1]) {
      const g = buildVehicleGeometry(m, lod);
      geos.push(g);
      v += g.getAttribute('position').count;
      ix += g.index!.count;
    }
  const batch = new THREE.BatchedMesh(N * 2, v, ix, createCarMaterial(U));
  batch.castShadow = true;
  batch.receiveShadow = true;
  const ids = geos.map((g) => batch.addGeometry(g));
  const data = tex.image.data as Float32Array;
  const col = new THREE.Color();
  const m4 = new THREE.Matrix4();
  let x = -40;
  const spacing = [3.2, 3.2, 3.4, 3.6, 3.6, 4, 4.4, 4.4, 4, 4.4];
  for (let m = 0; m < N; m++) {
    for (const lod of [0, 1]) {
      const inst = batch.addInstance(ids[m * 2 + lod]);
      m4.makeRotationY(-Math.PI / 2 + 0.35);
      m4.setPosition(x, 0, lod ? -14 : 0);
      batch.setMatrixAt(inst, m4);
      const paint = m === 9 ? paintFor(VT.semi, 0.05) : paintFor(m, (m * 0.137 + 0.61) % 1);
      col.setHex(paintRGB(paint));
      data.set([col.r, col.g, col.b, paintFinish(paint)], inst * 8);
      let flags = 0;
      if (q.get('lights') === '1') flags |= FLAG_HEAD;
      if (q.get('brake') === '1') flags |= FLAG_BRAKE;
      if (q.get('ind') === '1') flags |= FLAG_IND_L;
      data.set([num('spin', 0), m === VT.tractor ? 0.3 : 0.2, flags, 4], inst * 8 + 4);
    }
    x += spacing[m] * 2;
  }
  tex.needsUpdate = true;
  scene.add(batch);
  const az = (num('az', 200) * Math.PI) / 180;
  const el = (num('el', 14) * Math.PI) / 180;
  const d = num('dist', 60);
  const tx = num('tx', -2);
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * d, 1.2 + Math.sin(el) * d, -4 + Math.cos(az) * Math.cos(el) * d);
  camera.lookAt(tx, 1.0, -4);
  const focus = new THREE.Vector3(0, 0, 0);
  let last = performance.now();
  let t = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    atmo.update(camera, dt, focus);
    rend.render(scene, camera);
    if (t > 2) window.__ready = true;
  });
}
main().catch((e) => console.error(e));
