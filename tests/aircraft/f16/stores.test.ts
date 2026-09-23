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
