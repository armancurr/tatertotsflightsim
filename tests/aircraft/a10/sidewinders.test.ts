/**
 * The two AIM-9M Sidewinders on the LAU-105 at station 11: one mesh per rail, centred on
 * A10_WEAPONS.airMissiles.stations (where the missiles system launches them), riding with the right
 * wing (they break away with it), and hidden one by one per `visual.airStores` as they are fired —
 * independently of the Mavericks (`visual.stores`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { getAircraftDef } from '../../../src/fleet';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { A10_WEAPONS } from '../../../src/config';

const ST = A10_WEAPONS.airMissiles!.stations;
type Model = ReturnType<typeof createA10Model>;
const state = (patch: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', ...patch });

describe('A-10 Sidewinders (LAU-105, station 11)', () => {
  let m: Model;
  beforeAll(() => {
    m = createA10Model();
  });
  afterAll(() => m.dispose());

  it('the config carries two AIM-9M stations on the right outer wing', () => {
    expect(ST).toHaveLength(2);
    for (const s of ST) expect(s.x).toBeGreaterThan(6);
  });

  it('one mesh per station, centred on the station (missile centre), under the right wing group', () => {
    m.root.updateMatrixWorld(true);
    const wing = m.root.getObjectByName(A10_PART.rightWing)!;
    ST.forEach((st, i) => {
      const o = m.root.getObjectByName(A10_PART.airStore(i)) as THREE.Mesh;
      expect(o, `airStore ${i}`).toBeTruthy();
      expect(o.parent).toBe(wing);
      const p = m.root.worldToLocal(o.getWorldPosition(new THREE.Vector3()));
      expect(p.distanceTo(new THREE.Vector3(st.x, st.y, st.z))).toBeLessThan(0.03);
      // The missile body is centred on its origin: 2.87 m long, ~0.64 m fin span, axis along z.
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox!;
      expect(b.max.z - b.min.z).toBeGreaterThan(2.8);
      expect(b.max.z - b.min.z).toBeLessThan(2.95);
      expect(Math.abs((b.max.z + b.min.z) / 2)).toBeLessThan(0.05);
      expect(Math.abs((b.max.x + b.min.x) / 2)).toBeLessThan(0.01);
      expect(b.max.x - b.min.x).toBeLessThan(0.7);
    });
  });

  it('the missile bodies hang just below the LAU-105 rails, well clear of each other and of the wing', () => {
    // Body radius 0.0635 m (5"): its top meets the rail (≈ y −0.66) with the launcher shoe.
    for (const s of ST) {
      expect(s.y + 0.0635).toBeLessThan(-0.655);
      expect(s.y + 0.0635).toBeGreaterThan(-0.7);
    }
    expect(Math.abs(ST[1].x - ST[0].x) - 2 * 0.0635).toBeGreaterThan(0.3);
  });

  it('hides each Sidewinder per visual.airStores (fired in order), independent of the Mavericks', () => {
    const vis = () => ST.map((_, i) => m.root.getObjectByName(A10_PART.airStore(i))!.visible);
    const mav = () => A10_WEAPONS.missiles!.stations.map((_, i) => m.root.getObjectByName(A10_PART.store(i))!.visible);
    m.setVisualState(state(), 1 / 30);
    expect(vis()).toEqual([true, true]);
    m.setVisualState(state({ airStores: [false, true] }), 1 / 30);
    expect(vis()).toEqual([false, true]);
    expect(mav()).toEqual([true, true, true, true]);
    m.setVisualState(state({ airStores: [false, false], stores: [false, true, true, true] }), 1 / 30);
    expect(vis()).toEqual([false, false]);
    expect(mav()).toEqual([false, true, true, true]);
    // A reset (missing arrays) hangs everything again.
    m.setVisualState(state({ airStores: undefined, stores: undefined }), 1 / 30);
    expect(vis()).toEqual([true, true]);
    expect(mav()).toEqual([true, true, true, true]);
  });

  it('the fleet A-10 exposes the air-to-air store names', () => {
    const model = getAircraftDef('a10').createModel();
    for (let i = 0; i < ST.length; i++) expect(model.root.getObjectByName(A10_PART.airStore(i))).toBeTruthy();
    model.dispose();
  });
});
