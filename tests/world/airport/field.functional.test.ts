/**
 * Functional: the busier field in the real airport scene (three.js in node, no WebGL) — the draw
 * calls stay within budget, the field's vehicles are one merged mesh, the windsocks are one
 * instanced mesh (one per runway end + the field windsock), and the ops pickup drives the
 * perimeter road (always on pavement, keeping moving).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createAirport, countDrawCalls } from '../../../src/world/airport';
import { pavementAt } from '../../../src/world/airport/plan';
import { toRunwayCoords } from '../../../src/world/runway';

const scene = new THREE.Scene();
const airport = createAirport(scene, null);
const cam = new THREE.PerspectiveCamera();
cam.position.set(0, 500, 0);

describe('the busier field (functional)', () => {
  it('adds at most 15 draw calls over the 12 the airport used before 03/21 (14 now)', () => {
    const calls = countDrawCalls(airport.group);
    expect(calls).toBeLessThanOrEqual(12 + 15);
    expect(calls).toBe(14);
    expect(airport.stats().parked).toBeGreaterThanOrEqual(20);
  });

  it('merges the field vehicles into one mesh and instances the windsocks', () => {
    const veh = airport.group.getObjectByName('field-vehicles') as THREE.Mesh;
    expect(veh).toBeTruthy();
    expect(veh.geometry.index!.count / 3).toBeGreaterThan(20000);
    const socks = airport.group.getObjectByName('windsock') as THREE.InstancedMesh;
    expect(socks.isInstancedMesh).toBe(true);
    expect(socks.count).toBe(5);
  });

  it('the ops pickup patrols the perimeter road: on pavement at every moment, and moving', () => {
    const patrol = airport.group.getObjectByName('patrol') as THREE.Mesh;
    const p = new THREE.Vector3();
    let last: THREE.Vector3 | null = null;
    let moved = 0;
    for (let t = 0; t < 900; t += 7.3) {
      airport.update(cam, t, 30);
      patrol.updateMatrixWorld(true);
      p.setFromMatrixPosition(patrol.matrixWorld);
      const q = toRunwayCoords(p.x, p.z, airport.plan.rw);
      // on the perimeter road — or crossing the access road (drawn by the roads system) at the east gate
      const r3 = airport.plan.pavement.find((r) => r.name === 'road-3')!;
      const r4 = airport.plan.pavement.find((r) => r.name === 'road-4')!;
      const atGate = q.along > r3.a1 - 1 && q.along < r4.a0 + 1 && q.across > r3.c0 - 1 && q.across < r3.c1 + 1;
      if (!atGate) expect(pavementAt(airport.plan, q.along, q.across), `t=${t}`).toBe('road');
      if (last) moved += p.distanceTo(last);
      last = p.clone();
    }
    expect(moved).toBeGreaterThan(3000);
  });
});
