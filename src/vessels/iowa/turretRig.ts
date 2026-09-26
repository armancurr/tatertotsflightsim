/**
 * The Iowa's three triple 16-inch turrets as rigs that follow the NavalTurretConfig contract
 * exactly (see ./turrets.ts for the maths the gunnery shares):
 *
 *   container (identity, a break-up part)
 *     └ train pivot at `position` (the turret floor on the barbette), rotation.y = −train
 *         ├ gunhouse (sloped face with the gun ports, roof hoods, rangefinder ears on II and III)
 *         └ elevation pivot at (0, trunnionHeight, −trunnionForward), rotation.x = +elev
 *             ├ barrel k at (x_k, 0, 0), sliding back by recoil (position.z = +recoil m)
 *             │   ├ the gun (breech, slide, canvas bloomer, 20.3 m of 16"/50, muzzle swell, bore)
 *             │   └ `muzzle` marker at (0, 0, −barrelLength)
 *             └ the muzzle-flash billboards (one quad per gun, sized / faded by flash[k])
 *
 * All nine guns share one geometry. Body frame: +X starboard, +Y up, −Z bow.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { gridGeometry, fanCap, boxMinMax, type P3 } from '../geom';
import type { NavalTurretConfig } from '../../config';
import { barrelOffset } from './turrets';
import { IOWA_COLORS as C } from './materials';

export interface TurretRig {
  container: THREE.Group;
  train: THREE.Group;
  elev: THREE.Group;
  house: THREE.Mesh;
  barrels: THREE.Group[];
  guns: THREE.Mesh[];
  muzzles: THREE.Object3D[];
  flash: THREE.Mesh;
}

/** Gunhouse outline: bottom and top plans (x, z) with the same vertex count (the face slopes back). */
const HOUSE = {
  y0: 0.05,
  y1: 3.75,
  lo: [[-6.3, -5.6], [6.3, -5.6], [6.9, -1.0], [6.9, 9.3], [5.6, 10.7], [-5.6, 10.7], [-6.9, 9.3], [-6.9, -1.0]] as [number, number][],
  hi: [[-5.9, -3.7], [5.9, -3.7], [6.6, -0.6], [6.6, 9.0], [5.4, 10.4], [-5.4, 10.4], [-6.6, 9.0], [-6.6, -0.6]] as [number, number][],
};

/** The gun: breech (behind the trunnion) to muzzle (−barrelLength), along −Z, axis at the origin. */
export function gunGeometry(len: number): THREE.BufferGeometry {
  // (radius, distance ahead of the trunnion)
  const prof: [number, number][] = [
    [0, -3.3], [0.9, -3.3], [0.95, -1.0], [1.12, -0.9], [1.12, 0.9], [1.05, 1.2], [1.05, 2.6], [0.8, 2.7],
    [0.78, 3.4], [0.64, len * 0.55], [0.53, len - 0.45], [0.59, len - 0.3], [0.58, len], [0.22, len],
  ];
  const lathe = new THREE.LatheGeometry(prof.map(([r, d]) => new THREE.Vector2(r, d)), 20);
  lathe.rotateX(-Math.PI / 2); // lathe +Y → −Z (ahead)
  const bore = new THREE.CircleGeometry(0.22, 16);
  bore.rotateY(Math.PI); // faces −Z
  bore.translate(0, 0, -len - 0.005);
  return merge([tint(lathe, C.haze, 0.55, 0.3), tint(bore, 0x050505, 1, 0)]);
}

function gunhouseGeometry(t: NavalTurretConfig, rangefinder: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const { lo, hi, y0, y1 } = HOUSE;
  const n = lo.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mx = (lo[i][0] + lo[j][0]) / 2;
    const mz = (lo[i][1] + lo[j][1]) / 2 - 2;
    parts.push(tint(gridGeometry([[[lo[i][0], y0, lo[i][1]], [lo[j][0], y0, lo[j][1]]], [[hi[i][0], y1, hi[i][1]], [hi[j][0], y1, hi[j][1]]]], [mx, 0.3, mz]), C.haze, 0.72, 0.1));
  }
  parts.push(tint(fanCap(hi.map(([x, z]) => [x, y1, z] as P3), [0, 1, 0]), C.haze, 0.75, 0.1));
  // the floor (seen when the turret is thrown clear in a crash)
  parts.push(tint(fanCap(lo.map(([x, z]) => [x, y0, z] as P3), [0, -1, 0]), C.hazeDark, 0.8, 0.1));
  // gun-port slots on the sloped face (tall: the guns elevate to 45°)
  const slope = (hi[0][1] - lo[0][1]) / (y1 - y0);
  for (let k = 0; k < t.barrels; k++) {
    const x = barrelOffset(t, k);
    const ya = 1.2;
    const yb = 3.55;
    const za = lo[0][1] + (ya - y0) * slope - 0.03;
    const zb = lo[0][1] + (yb - y0) * slope - 0.03;
    parts.push(tint(gridGeometry([[[x - 0.75, ya, za], [x + 0.75, ya, za]], [[x - 0.75, yb, zb], [x + 0.75, yb, zb]]], [0, 0.5, -1]), 0x2b2f33, 0.9, 0));
  }
  // sight / periscope hoods on the roof, a ventilator, the rear hatch
  for (const x of [-4.2, 0, 4.2]) parts.push(tint(boxMinMax(x - 0.45, y1, -2.7, x + 0.45, y1 + 0.55, -1.5), C.haze, 0.7, 0.1));
  parts.push(tint(boxMinMax(-1.2, y1, 6.5, 1.2, y1 + 0.4, 8.2), C.hazeDark, 0.7, 0.1));
  parts.push(tint(boxMinMax(-0.8, 0.6, 10.66, 0.8, 2.4, 10.72), C.hazeDark, 0.7, 0.1));
  if (rangefinder) {
    // the 46 ft rangefinder's hoods sticking out of the sides at the rear
    for (const side of [-1, 1]) parts.push(tint(boxMinMax(side > 0 ? 6.6 : -7.9, 2.2, 5.2, side > 0 ? 7.9 : -6.6, 3.5, 6.8), C.haze, 0.7, 0.1));
  }
  return merge(parts);
}

/** Muzzle-flash billboards: one quad per gun at its muzzle (+4 m ahead), expanded in the vertex shader. */
function flashGeometry(t: NavalTurretConfig): THREE.BufferGeometry {
  const n = t.barrels;
  const pos = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const barrel = new Float32Array(n * 4);
  const idx: number[] = [];
  const C4 = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 4; c++) {
      const i = k * 4 + c;
      pos.set([barrelOffset(t, k), 0, -t.barrelLength - 4], i * 3);
      corner.set(C4[c], i * 2);
      barrel[i] = k;
    }
    idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setAttribute('aBarrel', new THREE.BufferAttribute(barrel, 1));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -t.barrelLength - 4), 40);
  return g;
}

export function buildTurret(t: NavalTurretConfig, name: string, gun: THREE.BufferGeometry, mats: { gray: THREE.Material; flash: THREE.Material }, rangefinder: boolean): TurretRig {
  const container = new THREE.Group();
  container.name = name;
  const train = new THREE.Group();
  train.name = `${name}.train`;
  train.position.set(t.position.x, t.position.y, t.position.z);
  container.add(train);
  const house = new THREE.Mesh(gunhouseGeometry(t, rangefinder), mats.gray);
  house.name = `${name}.house`;
  house.castShadow = true;
  house.receiveShadow = true;
  train.add(house);
  const elev = new THREE.Group();
  elev.name = `${name}.elev`;
  elev.position.set(0, t.trunnionHeight, -t.trunnionForward);
  train.add(elev);
  const barrels: THREE.Group[] = [];
  const guns: THREE.Mesh[] = [];
  const muzzles: THREE.Object3D[] = [];
  for (let k = 0; k < t.barrels; k++) {
    const b = new THREE.Group();
    b.name = `${name}.barrel${k}`;
    b.position.set(barrelOffset(t, k), 0, 0);
    const m = new THREE.Mesh(gun, mats.gray);
    m.name = `${name}.gun${k}`;
    m.castShadow = true;
    m.receiveShadow = true;
    b.add(m);
    const mz = new THREE.Object3D();
    mz.name = `${name}.muzzle${k}`;
    mz.position.set(0, 0, -t.barrelLength);
    b.add(mz);
    elev.add(b);
    barrels.push(b);
    guns.push(m);
    muzzles.push(mz);
  }
  const flash = new THREE.Mesh(flashGeometry(t), mats.flash);
  flash.name = `${name}.flash`;
  flash.frustumCulled = false;
  flash.renderOrder = 6;
  flash.visible = false;
  flash.userData.noBounds = true;
  elev.add(flash);
  return { container, train, elev, house, barrels, guns, muzzles, flash };
}
