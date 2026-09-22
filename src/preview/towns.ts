/**
 * Buildings preview (real renderer + atmosphere). URL parameters:
 *   x, z, y            camera position (m); y is above the ground (default 120)
 *   heading, pitch     degrees (heading clockwise from north, pitch + up)
 *   fov                vertical field of view (default 55)
 *   tod                time-of-day preset (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   gallery=1          a flat lot with one of each building type (close-up iteration)
 *   veg=1, roads=0     vegetation on / roads off (world mode)
 *   hud=0              hide the label
 * window.__ready (buildings placed + terrain ready), window.__stats().
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { createTerrain } from '../world/terrain';
import { createWater } from '../world/water';
import { createRoads } from '../world/roads';
import { createTowns, type Building } from '../world/towns';
import { instanceFlags } from '../world/towns/instances';
import { FLAG } from '../world/towns/archetypes';
import { STYLE } from '../world/towns/placement';
import { terrainHeight } from '../world/heightfield';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __fps: number;
    __ready: boolean;
    __stats: () => unknown;
  }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const flag = (k: string, d = false) => (q.has(k) ? q.get(k) !== '0' : d);
const label = document.getElementById('label')!;
if (!flag('hud', true)) label.style.display = 'none';
window.__fps = 0;
window.__ready = false;

/** Gallery: one of each, standing on flat ground at y = 0 along a street (z = 0) facing south. */
function gallery(): Building[] {
  const out: Building[] = [];
  let x = -170;
  const add = (b: Partial<Building> & Pick<Building, 'width' | 'depth' | 'wallHeight' | 'roofHeight' | 'archetype' | 'use'>, want = 0, gap = 8): void => {
    const base: Building = {
      x: 0,
      z: 0,
      y: 0,
      headingDeg: 180,
      ridge: 1,
      ridgeAxis: 0,
      wallColor: 0xe9dfc6,
      roofColor: 0xb0553a,
      floorHeight: 2.8,
      style: STYLE.house,
      rand: 0.1,
      town: 0,
      farm: -1,
      plinth: 0.4,
      ...b,
    };
    const along = base.ridgeAxis === 1 ? base.depth : base.width;
    base.x = x + (base.headingDeg === 180 ? base.width : along) / 2;
    base.z = base.z || -base.depth / 2;
    for (let i = 0; i < 4000; i++) {
      base.rand = (i * 0.618034 + 0.05) % 1;
      if ((instanceFlags(base) & want) === want) break;
    }
    out.push(base);
    x += (base.headingDeg === 180 ? base.width : along) + gap;
  };
  const DEG = Math.PI / 180;
  const pitch = (span: number, deg: number) => (span / 2) * Math.tan(deg * DEG);
  add({ archetype: 'gable', use: 'house', width: 11, depth: 8.5, wallHeight: 6.1, roofHeight: pitch(8.5, 42), wallColor: 0xe9dfc6, roofColor: 0xb0553a }, FLAG.chimney | FLAG.dormers | FLAG.shutters);
  add({ archetype: 'hip', use: 'house', width: 12, depth: 9, wallHeight: 3.3, roofHeight: pitch(9, 28), ridge: 3 / 12, wallColor: 0xbcc8d0, roofColor: 0x4a4f57 }, FLAG.chimney | FLAG.garage);
  add({ archetype: 'gable', use: 'house', width: 9, depth: 11, wallHeight: 6.1, roofHeight: pitch(9, 38), ridgeAxis: 1, wallColor: 0xa55c40, roofColor: 0x5a3e2e }, FLAG.chimney);
  for (let k = 0; k < 3; k++) add({ archetype: 'gable', use: 'house', width: 6.5, depth: 10, wallHeight: 9.1, roofHeight: pitch(10, 36), floorHeight: 2.9, wallColor: [0xdccaa6, 0xcfcfca, 0xe8d9a4][k] as number, roofColor: 0x4a4f57 }, 0, 0.7);
  add({ archetype: 'flat', use: 'shop', width: 12, depth: 15, wallHeight: 10.2, roofHeight: 1.1, floorHeight: 3.2, style: STYLE.shop, wallColor: 0xcfb99a, roofColor: 0x7a7a7c }, FLAG.shopfront, 0.7);
  add({ archetype: 'gable', use: 'shop', width: 10, depth: 14, wallHeight: 7, roofHeight: pitch(14, 35), floorHeight: 3.2, style: STYLE.shop, wallColor: 0xe0d4bc, roofColor: 0xb0553a }, FLAG.shopfront);
  add({ archetype: 'flat', use: 'apartment', width: 26, depth: 13, wallHeight: 18.6, roofHeight: 1.1, floorHeight: 3, style: STYLE.apartment, wallColor: 0xd9d1c2, roofColor: 0x8a8886 }, FLAG.balcony);
  add({ archetype: 'hip', use: 'apartment', width: 22, depth: 12, wallHeight: 12.6, roofHeight: pitch(12, 26), ridge: 10 / 22, floorHeight: 3, style: STYLE.apartment, wallColor: 0x9e5c44, roofColor: 0x4a4f57 }, 0);
  add({ archetype: 'flat', use: 'office', width: 28, depth: 20, wallHeight: 29.6, roofHeight: 1.6, floorHeight: 3.2, style: STYLE.apartment, wallColor: 0xb8b4ac, roofColor: 0x6c6e70 }, FLAG.ribbon);
  add({ archetype: 'flat', use: 'tower', width: 30, depth: 28, wallHeight: 91.2, roofHeight: 2, floorHeight: 3.8, style: STYLE.office, wallColor: 0x5b6e7a, roofColor: 0x6c6e70, tierHeight: 57.4, tierInset: 4 }, FLAG.glass);
  add({ archetype: 'flat', use: 'tower', width: 26, depth: 26, wallHeight: 68, roofHeight: 1.8, floorHeight: 3.8, style: STYLE.office, wallColor: 0x8d9ba3, roofColor: 0x6c6e70 }, FLAG.glass);
  add({ archetype: 'gable', use: 'industrial', width: 26, depth: 18, wallHeight: 6.5, roofHeight: pitch(18, 12), style: STYLE.industrial, floorHeight: 0, wallColor: 0xb9bdbf, roofColor: 0x8e9496 }, 0, 10);
  add({ archetype: 'flat', use: 'warehouse', width: 50, depth: 34, wallHeight: 9.5, roofHeight: 0.8, style: STYLE.industrial, floorHeight: 0, wallColor: 0xc4b89e, roofColor: 0xa3a7a6 }, 0, 12);
  // church: nave end-on to the street with the steeple in front
  const naveW = 11;
  const naveD = 26;
  add({ archetype: 'gable', use: 'church', width: naveW, depth: naveD, wallHeight: 9, roofHeight: pitch(naveW, 52), ridgeAxis: 1, style: STYLE.church, floorHeight: 0, wallColor: 0xcfc6b4, roofColor: 0x4a4f57, z: -naveD / 2 - 6.2 }, 0, -naveW / 2 - 3);
  add({ archetype: 'hip', use: 'steeple', width: 6, depth: 6, wallHeight: 24, roofHeight: 15, ridge: 0, style: STYLE.church, floorHeight: 0, wallColor: 0xcfc6b4, roofColor: 0x5e8c7a, z: -3 }, FLAG.steeple, naveW / 2 + 10);
  // farm
  add({ archetype: 'gable', use: 'farmhouse', width: 12, depth: 9, wallHeight: 6.1, roofHeight: pitch(9, 40), wallColor: 0xf2efe8, roofColor: 0x3a3c40, farm: 0 }, FLAG.chimney);
  add({ archetype: 'gambrel', use: 'barn', width: 13, depth: 26, wallHeight: 5, roofHeight: 6, ridgeAxis: 1, style: STYLE.barn, floorHeight: 0, wallColor: 0x8e2b22, roofColor: 0x4e5156, farm: 0 }, FLAG.cupola);
  add({ archetype: 'gable', use: 'barn', width: 12, depth: 24, wallHeight: 5, roofHeight: pitch(12, 40), ridgeAxis: 1, style: STYLE.barn, floorHeight: 0, wallColor: 0x7a7068, roofColor: 0x6d6f72, farm: 0 }, 0);
  add({ archetype: 'silo', use: 'silo', width: 6, depth: 6, wallHeight: 18, roofHeight: 2.3, style: STYLE.silo, floorHeight: 0, wallColor: 0xc9cacb, roofColor: 0x9aa0a4, farm: 0 }, 0, 2);
  add({ archetype: 'silo', use: 'silo', width: 6.5, depth: 6.5, wallHeight: 20, roofHeight: 2.5, style: STYLE.silo, floorHeight: 0, wallColor: 0x2f4a6a, roofColor: 0x2f4a6a, farm: 0 }, 0, 2);
  add({ archetype: 'silo', use: 'silo', width: 10, depth: 10, wallHeight: 6.5, roofHeight: 2.4, ridge: 0, style: STYLE.silo, floorHeight: 0, wallColor: 0xc3c8cb, roofColor: 0xb7bcc0, farm: 0 }, 0, 2);
  add({ archetype: 'gable', use: 'shed', width: 22, depth: 12, wallHeight: 5, roofHeight: pitch(12, 16), style: STYLE.shed, floorHeight: 0, wallColor: 0x5f7a5a, roofColor: 0x8e9496, farm: 0 }, 0);
  return out;
}

async function main() {
  const container = document.getElementById('app')!;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('fov', 55), innerWidth / innerHeight, 0.5, CONFIG.camera.far);
  const isGallery = flag('gallery');
  const heightAt = isGallery ? () => 0 : terrainHeight;
  const cx = num('x', isGallery ? 0 : -4700);
  const cz = num('z', isGallery ? 70 : 7400);
  camera.position.set(cx, heightAt(cx, cz) + num('y', isGallery ? 25 : 120), cz);
  const heading = num('heading', 0);
  camera.rotation.set((num('pitch', isGallery ? -8 : -15) * Math.PI) / 180, (-heading * Math.PI) / 180, 0, 'YXZ');
  scene.add(camera);

  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  const atmo = createAtmosphere(renderer, scene, { groundHeight: heightAt });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    rend.resize();
  });

  let terrainReady: Promise<void> = Promise.resolve();
  const updaters: ((dt: number, t: number) => void)[] = [];
  if (isGallery) {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x55703a, roughness: 0.95 }));
    ground.receiveShadow = true;
    scene.add(ground);
    const street = new THREE.Mesh(new THREE.PlaneGeometry(600, 9).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3a3a3c, roughness: 0.9 }));
    street.position.set(0, 0.03, 8);
    street.receiveShadow = true;
    scene.add(street);
  } else {
    const terrain = createTerrain(renderer, scene);
    const water = createWater(scene);
    terrain.update(camera);
    terrainReady = terrain.ready();
    updaters.push((_, t) => {
      terrain.update(camera);
      water.update(camera, t, atmo.sunDirection);
    });
    if (flag('roads', true)) {
      const roads = createRoads(scene, { heightAt: terrainHeight });
      updaters.push((_, t) => roads.update(camera, t));
    }
    if (flag('veg')) {
      const { createVegetation } = await import('../world/vegetation');
      const { treeDensity } = await import('../world/landcover');
      const veg = createVegetation(scene, { heightAt: terrainHeight, densityAt: treeDensity, seed: CONFIG.world.seed, renderer });
      updaters.push((_, t) => veg.update(camera, t, atmo.sunDirection));
    }
  }
  const towns = createTowns(scene, isGallery ? { heightAt, buildings: gallery() } : { heightAt: terrainHeight, worker: true });
  Promise.all([towns.ready(), terrainReady]).then(() => (window.__ready = true));

  const focus = new THREE.Vector3();
  const frameMs: number[] = [];
  window.__stats = () => {
    const s = [...frameMs].sort((a, b) => a - b);
    const p = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
    return { ...towns.stats(), fps: window.__fps, p50: p(0.5), p95: p(0.95), max: s[s.length - 1] ?? 0, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  };
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  const t0 = performance.now();
  renderer.info.autoReset = false;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs.push(now - last);
    if (frameMs.length > 600) frameMs.shift();
    last = now;
    acc += dt;
    frames++;
    if (acc > 0.5) {
      window.__fps = Math.round((frames / acc) * 10) / 10;
      acc = 0;
      frames = 0;
    }
    renderer.info.reset();
    camera.updateMatrixWorld();
    // shadow focus: a point on the ground ahead of the camera
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const k = dir.y < -0.05 ? Math.min(600, (camera.position.y - heightAt(camera.position.x, camera.position.z)) / -dir.y) : 150;
    focus.copy(camera.position).addScaledVector(dir, k);
    focus.y = heightAt(focus.x, focus.z);
    atmo.update(camera, dt, focus);
    const t = (now - t0) / 1000;
    for (const u of updaters) u(dt, t);
    towns.update(camera, t, focus, atmo.sunDirection);
    rend.render(scene, camera);
    if (flag('hud', true) && frames === 0) {
      const st = towns.stats();
      label.textContent = `fps ${window.__fps}  calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1e6).toFixed(2)}M  near ${st.nearInstances} shadow ${st.shadowInstances}  ${window.__ready ? 'ready' : 'loading'}`;
    }
  });
}

main().catch((e) => {
  console.error(e);
  label.textContent = String(e);
});
