/**
 * Functional: the traffic renderer headless (three.js objects in node, no GL):
 * ten minutes of updates with the camera touring Taterville, the coast highway
 * and Port Chateau — the draw-call budget, instances ⇔ vehicles (no leaks),
 * finite matrices, lamps at dusk, and a clean hand-back when the camera leaves.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createCars } from '../../../src/world/cars';
import { RoadSurface } from '../../../src/world/roads/surface';
import type { Roads } from '../../../src/world/roads';
import { laneData, HEIGHT } from './fixtures';

function fakeRoads(): Roads {
  const lanes = laneData();
  const surface = new RoadSurface();
  return { lanes, surface } as unknown as Roads;
}

describe('traffic renderer (functional, headless)', () => {
  it('stays within 8 draw calls, never leaks an instance and hands everything back', { timeout: 120_000 }, () => {
    const scene = new THREE.Scene();
    const roads = fakeRoads();
    // one "building" block in the middle of Taterville so its car parks fill
    const obstacleTop = (x: number, z: number) => (Math.abs(x - 2100) < 120 && Math.abs(z - 2100) < 120 ? HEIGHT(x, z) + 12 : -Infinity);
    const cars = createCars(scene, { heightAt: HEIGHT, roads: () => roads, obstacleTop, urban: () => 1 });
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 60000);
    const sunNoon = new THREE.Vector3(0.3, 0.9, -0.3).normalize();
    const sunDusk = new THREE.Vector3(0.9, 0.06, 0.3).normalize();
    const path: [number, number, number][] = [
      [0, 2100, 2350],
      [150, 2100, 2350],
      [260, 3237, 5685],
      [420, 3237, 5685],
      [540, -4700, 6541],
      [600, -4700, 6541],
    ];
    const at = (t: number) => {
      let k = 0;
      while (k < path.length - 2 && t > path[k + 1][0]) k++;
      const f = Math.max(0, Math.min(1, (t - path[k][0]) / (path[k + 1][0] - path[k][0])));
      return [path[k][1] + (path[k + 1][1] - path[k][1]) * f, path[k][2] + (path[k + 1][2] - path[k][2]) * f];
    };
    const batch = cars.group.children.find((o) => (o as THREE.BatchedMesh).isBatchedMesh) as THREE.BatchedMesh;
    const far = cars.group.getObjectByName('cars-far') as THREE.InstancedMesh;
    const shadows = cars.group.getObjectByName('car-shadows') as THREE.InstancedMesh;
    const glows = cars.group.children.find((o) => (o as THREE.Points).isPoints) as THREE.Points;
    const m = new THREE.Matrix4();
    const dt = 1 / 15;
    let maxCalls = 0;
    let sawGlows = false;
    let checks = 0;
    for (let f = 0; f < 600 / dt; f++) {
      const t = f * dt;
      const [x, z] = at(t);
      camera.position.set(x, HEIGHT(x, z) + 220, z);
      camera.lookAt(x + 200, HEIGHT(x, z), z - 250);
      camera.updateMatrixWorld();
      const dusk = t > 400 && t < 470;
      cars.update(camera, dt, false, dusk ? sunDusk : sunNoon);
      if (f % 45 !== 0) continue;
      checks++;
      const st = cars.stats();
      // draw calls: near batch, far instances, shadows, glows — each one call when it draws anything
      const calls = (st.near > 0 ? 1 : 0) + (far.count > 0 ? 1 : 0) + (shadows.count > 0 ? 1 : 0) + (glows.visible ? 1 : 0);
      expect(calls).toBe(st.drawCalls);
      maxCalls = Math.max(maxCalls, calls);
      if (dusk && st.glows > 0) sawGlows = true;
      // every visible instance belongs to a living vehicle or a parked car; matrices finite
      const sim = cars.sim!;
      let visible = 0;
      for (let i = 0; i < batch.maxInstanceCount; i++) {
        if (!batch.getVisibleAt(i)) continue;
        visible++;
        batch.getMatrixAt(i, m);
        for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
        if (i < sim.cap) expect(sim.alive[i]).toBe(1);
      }
      expect(visible).toBe(st.near);
      expect(far.count).toBe(st.far);
      expect(st.near + st.far).toBe(st.drawn);
      for (let k = 0; k < far.count; k++) {
        far.getMatrixAt(k, m);
        for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
      }
      expect(shadows.count).toBeLessThanOrEqual(shadows.instanceMatrix.count);
    }
    expect(checks).toBeGreaterThan(100);
    expect(maxCalls).toBeLessThanOrEqual(8);
    expect(sawGlows).toBe(true);
    // leave the land: nothing left drawn, the pool is empty
    camera.position.set(0, 300, 40000);
    camera.updateMatrixWorld();
    for (let k = 0; k < 40; k++) cars.update(camera, dt, false, sunNoon);
    let left = 0;
    for (let i = 0; i < batch.maxInstanceCount; i++) if (batch.getVisibleAt(i)) left++;
    expect(left).toBe(0);
    expect(cars.sim!.count).toBe(0);
    expect(cars.stats().drawCalls).toBe(0);
    cars.dispose();
    expect(scene.children.length).toBe(0);
  });

  it('paused: the traffic clock stops (poses frozen) while the frame keeps drawing', () => {
    const scene = new THREE.Scene();
    const roads = fakeRoads();
    const cars = createCars(scene, { heightAt: HEIGHT, roads: () => roads });
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 60000);
    camera.position.set(3237, 200, 5900);
    camera.lookAt(3237, 0, 5685);
    camera.updateMatrixWorld();
    const sun = new THREE.Vector3(0.3, 0.9, -0.3).normalize();
    for (let k = 0; k < 200; k++) cars.update(camera, 1 / 30, false, sun);
    const sim = cars.sim!;
    const steps = sim.steps;
    const u = Array.from(sim.u);
    for (let k = 0; k < 60; k++) cars.update(camera, 1 / 30, true, sun);
    expect(sim.steps).toBe(steps);
    expect(Array.from(sim.u)).toEqual(u);
    for (let k = 0; k < 10; k++) cars.update(camera, 1 / 30, false, sun);
    expect(sim.steps).toBeGreaterThan(steps);
    cars.dispose();
  });
});
