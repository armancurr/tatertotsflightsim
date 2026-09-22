import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createTowns } from '../../../src/world/towns';
import { createRoads } from '../../../src/world/roads';
import { createObstacleIndex } from '../../../src/world/towns/obstacles';
import { NEAR_KINDS } from '../../../src/world/towns/archetypes';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT } from './fixtures';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const camAt = (x: number, y: number, z: number, tx: number, tz: number): THREE.PerspectiveCamera => {
  const cam = new THREE.PerspectiveCamera(60, 1440 / 900, 1, 60000);
  cam.position.set(x, y, z);
  cam.lookAt(tx, HEIGHT(tx, tz), tz);
  cam.updateMatrixWorld();
  return cam;
};

describe('createTowns (functional)', async () => {
  const scene = new THREE.Scene();
  const towns = createTowns(scene, { heightAt: HEIGHT });
  await towns.ready();
  const city = LAYOUT.towns[1];
  const group = scene.getObjectByName('towns') as THREE.Group;
  const meshes = () => group.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
  const byName = (n: string) => meshes().find((m) => m.name === n)!;

  it('adds one mesh per near archetype plus the mid LOD, and answers obstacle queries from the same placement', () => {
    expect(group).toBeTruthy();
    for (const k of NEAR_KINDS) expect(byName(`buildings-${k}`)).toBeTruthy();
    expect(byName('buildings-mid')).toBeTruthy();
    expect(towns.stats().buildings).toBe(towns.buildings.length);
    expect(towns.buildings.length).toBeGreaterThan(8000);
    const idx = createObstacleIndex(towns.buildings);
    for (const b of towns.buildings.slice(0, 300)) expect(towns.obstacleTop(b.x, b.z)).toBe(idx(b.x, b.z));
  });

  it('flying over the city: detailed buildings near, a handful of draw calls, shadows only from the chunks around the focus', () => {
    const cam = camAt(city.x, 300, city.z + 900, city.x, city.z);
    towns.update(cam, 0, cam.position);
    const s = towns.stats();
    expect(s.nearInstances).toBeGreaterThan(1500);
    expect(s.drawCalls).toBeGreaterThanOrEqual(3);
    expect(s.drawCalls).toBeLessThanOrEqual(NEAR_KINDS.length + 1);
    expect(s.shadowInstances).toBeGreaterThan(0);
    expect(s.shadowInstances).toBeLessThan(s.nearInstances);
    // the render hooks switch the instance count per pass
    const flat = byName('buildings-flat');
    const geo = flat.geometry as THREE.InstancedBufferGeometry;
    flat.onBeforeShadow(null as never, scene, cam, cam, geo, flat.customDepthMaterial!, null as never);
    const nShadow = geo.instanceCount;
    flat.onBeforeRender(null as never, scene, cam, geo, flat.material as THREE.Material, null as never);
    expect(geo.instanceCount).toBeGreaterThanOrEqual(nShadow);
    expect(flat.castShadow).toBe(true);
    expect(byName('buildings-mid').castShadow).toBe(false);
  });

  it('far away out at sea nothing near is drawn and the mid LOD culls everything in its shader', () => {
    towns.update(camAt(0, 500, 60000, 0, 80000), 0);
    expect(towns.stats().nearInstances).toBe(0);
    expect(towns.stats().drawCalls).toBeLessThanOrEqual(1);
  });

  it('moving the camera away and back restores the same near set (hysteresis, no leaks)', () => {
    const cam = camAt(city.x, 300, city.z + 900, city.x, city.z);
    towns.update(cam, 0, cam.position);
    const a = towns.stats().nearInstances;
    towns.update(camAt(city.x, 300, city.z + 20000, city.x, city.z), 0);
    towns.update(cam, 0, cam.position);
    expect(towns.stats().nearInstances).toBe(a);
  });

  it('marks the near chunks for the mid shader (texture) and sets the LOD uniforms', () => {
    const cam = camAt(city.x, 300, city.z + 900, city.x, city.z);
    towns.update(cam, 0, cam.position);
    const mid = byName('buildings-mid');
    const mat = mid.material as THREE.MeshStandardMaterial & { userData: { uniforms?: { uBldChunkNear: { value: THREE.DataTexture }; uBldLod: { value: THREE.Vector4 } } } };
    const u = mat.userData.uniforms!;
    const data = u.uBldChunkNear.value.image.data as Uint8Array;
    expect(data.some((v) => v === 255)).toBe(true);
    expect(u.uBldLod.value.x).toBeCloseTo(CONFIG.world.towns.minAngularSize);
    expect(u.uBldLod.value.z).toBeCloseTo(CONFIG.world.towns.farDistance);
  });

  it('lights windows at dusk: the night uniform follows the sun elevation', () => {
    const cam = camAt(city.x, 300, city.z + 900, city.x, city.z);
    towns.update(cam, 0, cam.position, new THREE.Vector3(0, 1, 0));
    expect(towns.stats().night).toBe(0);
    const low = new THREE.Vector3(Math.cos(0.07), Math.sin(0.07), 0);
    towns.update(cam, 0, cam.position, low);
    expect(towns.stats().night).toBeGreaterThan(0.6);
  });

  it('update allocates nothing per frame once built (same objects, stable counts over many frames)', () => {
    const cam = camAt(city.x, 300, city.z + 900, city.x, city.z);
    const before = towns.stats().rebuilds;
    for (let i = 0; i < 200; i++) towns.update(cam, i / 60, cam.position);
    expect(towns.stats().rebuilds).toBe(before);
    // drifting slowly across the city: rebuilds only when chunks enter/leave
    for (let i = 0; i < 300; i++) {
      cam.position.x += 4;
      cam.updateMatrixWorld();
      towns.update(cam, i / 60, cam.position);
    }
    expect(towns.stats().rebuilds - before).toBeLessThan(60);
  });

  it('dispose removes everything', () => {
    towns.dispose();
    expect(scene.getObjectByName('towns')).toBeUndefined();
  });
});

describe('createRoads (functional)', () => {
  const scene = new THREE.Scene();
  const roads = createRoads(scene, { heightAt: HEIGHT });
  it('builds merged chunk meshes and culls by distance/frustum', () => {
    expect(scene.getObjectByName('roads')).toBeTruthy();
    expect(roads.stats().chunks).toBeGreaterThan(50);
    roads.update(camAt(2100, 400, 4500, 2100, 2100), 0);
    expect(roads.stats().drawCalls).toBeGreaterThan(0);
    roads.update(camAt(0, 500, 90000, 0, 120000), 0);
    expect(roads.stats().drawCalls).toBe(0);
    roads.dispose();
    expect(scene.getObjectByName('roads')).toBeUndefined();
  });
});
