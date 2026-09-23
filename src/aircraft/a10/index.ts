/**
 * A-10C Thunderbolt II model — PLACEHOLDER (grey blocks on the A10_AIRCRAFT geometry) until the
 * procedural model lands. Keeps the contract: named 'a10.gunMuzzle' at A10_WEAPONS.gun.muzzle and
 * one 'a10.store.<i>' per missile station, hidden as they are fired.
 */
import * as THREE from 'three';
import { A10_AIRCRAFT, A10_WEAPONS } from '../../config';
import type { AircraftVisualState } from '../types';
import type { AircraftModelHandle } from '../../fleet/types';

export function createA10Model(): AircraftModelHandle {
  const root = new THREE.Group();
  root.name = 'a10';
  const mat = new THREE.MeshStandardMaterial({ color: 0x6f7472, roughness: 0.8 });
  const geos: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, name: string) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.name = name;
    m.castShadow = true;
    root.add(m);
    return m;
  };
  add(1.6, 1.9, 15.6, 0, 0, 1.2, 'a10.fuselage');
  add(A10_AIRCRAFT.wingSpan, 0.35, 2.6, 0, -0.6, 0.55, 'a10.wing');
  add(5.74, 0.2, 1.8, 0, 0.45, 8.2, 'a10.tailplane');
  for (const sx of [-1, 1]) {
    add(0.2, 2.9, 1.9, sx * 2.87, 1.1, 8.6, `a10.fin.${sx < 0 ? 'l' : 'r'}`);
    add(1.25, 1.25, 3.3, sx * 1.55, 1.1, 4.75, `a10.engine.${sx < 0 ? 'l' : 'r'}`);
  }
  const muzzle = new THREE.Object3D();
  muzzle.name = 'a10.gunMuzzle';
  muzzle.position.set(A10_WEAPONS.gun!.muzzle.x, A10_WEAPONS.gun!.muzzle.y, A10_WEAPONS.gun!.muzzle.z);
  root.add(muzzle);
  const stores = (A10_WEAPONS.missiles?.stations ?? []).map((st, i) => add(0.3, 0.3, 2.49, st.x, st.y, st.z, `a10.store.${i}`));

  return {
    root,
    setVisualState(v: AircraftVisualState) {
      stores.forEach((m, i) => (m.visible = v.stores?.[i] ?? true));
    },
    dispose() {
      geos.forEach((x) => x.dispose());
      mat.dispose();
    },
  };
}
