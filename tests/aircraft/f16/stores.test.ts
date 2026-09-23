import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createF16Model } from '../../../src/aircraft/f16';
import { createDefaultVisualState } from '../../../src/aircraft/types';
import { F16_WEAPONS } from '../../../src/config';
import { getAircraftDef } from '../../../src/fleet';

describe('F-16 stores: two AGM-65 Mavericks on LAU-117s under stations 3 and 7', () => {
  it('the F-16 carries its M61A1 gun and two Mavericks', () => {
    const w = getAircraftDef('f16').config.weapons;
    expect(w.gun?.name).toMatch(/M61A1/);
    expect(w.missiles?.stations).toHaveLength(2);
    expect(w.missiles?.name).toMatch(/AGM-65/);
  });

  it('hangs one missile at each configured station (within 3 cm) and hides it once fired', () => {
    const m = createF16Model();
    m.root.updateMatrixWorld(true);
    const stations = F16_WEAPONS.missiles!.stations;
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    stations.forEach((st, i) => {
      const o = m.root.getObjectByName(`f16.store.${i}`);
      expect(o, `f16.store.${i}`).toBeTruthy();
      box.setFromObject(o!).getCenter(c);
      expect(Math.hypot(c.x - st.x, c.y - st.y, c.z - st.z)).toBeLessThan(0.03);
    });
    const v = createDefaultVisualState();
    v.stores = [false, true];
    m.setVisualState(v, 1 / 60);
    expect(m.root.getObjectByName('f16.store.0')!.visible).toBe(false);
    expect(m.root.getObjectByName('f16.store.1')!.visible).toBe(true);
    v.stores = [true, true];
    m.setVisualState(v, 1 / 60);
    expect(m.root.getObjectByName('f16.store.0')!.visible).toBe(true);
    m.dispose();
  });

  it('stores clear the ground with the gear down (≥ 0.5 m) and sit under the wing, not in it', () => {
    const [st] = F16_WEAPONS.missiles!.stations;
    const wheelY = getAircraftDef('f16').config.aircraft.geometry.noseWheel.y;
    expect(st.y - 0.1525 - wheelY).toBeGreaterThan(0.5);
    expect(st.y).toBeLessThan(-0.6);
  });
});

describe('F-16 stores: two AIM-9M Sidewinders on the wingtip LAU-129 rails', () => {
  it('hangs one Sidewinder centred on each airMissiles station (within 3 cm), on the matching wing', () => {
    const m = createF16Model();
    m.root.updateMatrixWorld(true);
    const stations = F16_WEAPONS.airMissiles!.stations;
    expect(stations).toHaveLength(2);
    const box = new THREE.Box3();
    const c = new THREE.Vector3();
    const size = new THREE.Vector3();
    stations.forEach((st, i) => {
      const o = m.root.getObjectByName(`f16.aim9.${i}`);
      expect(o, `f16.aim9.${i}`).toBeTruthy();
      box.setFromObject(o!).getCenter(c);
      box.getSize(size);
      expect(Math.hypot(c.x - st.x, c.y - st.y, c.z - st.z)).toBeLessThan(0.03);
      // A 2.87 m missile with its X fins (0.64 m span).
      expect(Math.abs(size.z - 2.87)).toBeLessThan(0.05);
      expect(size.x).toBeGreaterThan(0.4);
      expect(size.x).toBeLessThan(0.66);
      // It rides with its wing (a crash throws it away with the wing).
      let wing = '';
      o!.traverseAncestors((a) => {
        if (a.name === 'f16.leftWing' || a.name === 'f16.rightWing') wing = a.name;
      });
      expect(wing).toBe(st.x < 0 ? 'f16.leftWing' : 'f16.rightWing');
    });
    m.dispose();
  });

  it('hides each Sidewinder once fired (visual.airStores); the launcher rail stays', () => {
    const m = createF16Model();
    const v = createDefaultVisualState();
    const rails = ['f16.leftWing.tipStore', 'f16.rightWing.tipStore'].map((n) => m.root.getObjectByName(n)!);
    for (const r of rails) expect(r).toBeTruthy();
    v.airStores = [false, true];
    m.setVisualState(v, 1 / 60);
    expect(m.root.getObjectByName('f16.aim9.0')!.visible).toBe(false);
    expect(m.root.getObjectByName('f16.aim9.1')!.visible).toBe(true);
    for (const r of rails) expect(r.visible).toBe(true);
    v.airStores = [false, false];
    m.setVisualState(v, 1 / 60);
    expect(m.root.getObjectByName('f16.aim9.1')!.visible).toBe(false);
    // Reset (re-arm) brings them back; no airStores at all means both are loaded.
    v.airStores = undefined;
    m.setVisualState(v, 1 / 60);
    expect(m.root.getObjectByName('f16.aim9.0')!.visible).toBe(true);
    expect(m.root.getObjectByName('f16.aim9.1')!.visible).toBe(true);
    // The rails alone stay out at the tip: without the missiles the tip assembly still spans the tip rib.
    m.root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(rails[1]);
    expect(b.max.x).toBeGreaterThan(4.55);
    expect(b.max.x).toBeLessThan(4.8);
    m.dispose();
  });
});
