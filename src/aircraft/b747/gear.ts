/**
 * The 747-400's 18-wheel landing gear: a two-wheel nose gear that retracts forward into the nose,
 * two four-wheel wing-gear trucks that fold inward into the wing-body fairing, and two four-wheel
 * body-gear trucks that fold forward into the belly. Each leg is a group rotated about its
 * trunnion; its lower part slides up by the strut compression; each truck tilts about its pivot
 * (aft wheels down in flight); every axle spins with the roll speed; the nose fork steers. The
 * well doors open only while the gear travels (hidden when closed: their seams are painted).
 */
import * as THREE from 'three';
import { merge, tint } from '../materials';
import { box, tube, V, wheelLathe } from '../f16/geom';
import { GEAR, lowerYAt } from './shape';
import type { B747Anim } from './animate';

const STRUT = 0xb9bec3;
const CHROME = 0xdfe3e7;
const TYRE = 0x141414;
const HUB = 0xa4a9ae;
const DARK = 0x3a3d40;
const DOOR = 0xc8ccd0;
const DEG = Math.PI / 180;

export interface GearLeg {
  group: THREE.Group;
  lower: THREE.Group;
  /** Truck (main gears) or steering fork (nose). */
  truck: THREE.Group;
  axles: THREE.Group[];
}

export interface GearDoor {
  object: THREE.Group;
  /** Rotation about the door's hinge (body z) at full open. */
  open: number;
}

export interface GearBuild {
  nose: GearLeg;
  wingLeft: GearLeg;
  wingRight: GearLeg;
  bodyLeft: GearLeg;
  bodyRight: GearLeg;
  /** Nose doors (forward fuselage) and the wing/body gear doors (centre fuselage). */
  noseDoors: GearDoor[];
  mainDoors: GearDoor[];
  /** Taxi lamps on the nose strut (in the nose leg's lower group). */
  taxiLamp: THREE.Object3D;
  update(a: B747Anim): void;
}

function tyreProfile(r: number, w: number): [number, number][] {
  const h = w / 2;
  const pts: [number, number][] = [[r * 0.6, -h * 0.92]];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([r - h * 0.55 + Math.cos(a) * h * 0.55, Math.sin(a) * h]);
  }
  pts.push([r * 0.6, h * 0.92]);
  return pts;
}

/** One airliner wheel (tyre + hub with brake detail) centred at x on the axle. */
function wheel(x: number, outboard: 1 | -1): THREE.BufferGeometry[] {
  const r = GEAR.wheelRadius;
  const w = GEAR.tyreWidth;
  const segs = 28;
  const c = V(x, 0, 0);
  const out = [
    tint(wheelLathe(tyreProfile(r, w), segs, c), TYRE, 0.88, 0),
    // Hub: outer face dished with a hub cap, inner face with the brake stack.
    tint(wheelLathe([[r * 0.6, outboard * w * 0.42], [r * 0.56, outboard * w * 0.36], [r * 0.3, outboard * w * 0.3], [r * 0.18, outboard * w * 0.4], [r * 0.02, outboard * w * 0.41]], segs, c), HUB, 0.4, 0.6),
    tint(wheelLathe([[r * 0.6, -outboard * w * 0.42], [r * 0.5, -outboard * w * 0.46], [r * 0.3, -outboard * w * 0.5]], segs, c), DARK, 0.6, 0.4),
  ];
  // Hub bolts.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    out.push(tint(box(0.02, 0.04, 0.04, V(x + outboard * w * 0.33, Math.cos(a) * r * 0.24, Math.sin(a) * r * 0.24)), 0x5a5e62, 0.5, 0.6));
  }
  return out;
}

function axle(name: string, half: number, parent: THREE.Object3D, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.z = z;
  g.userData.wheels = 2;
  const geo = merge([...wheel(half, 1), ...wheel(-half, -1), tint(tube(V(-half, 0, 0), V(half, 0, 0), 0.07, 0.07, 10), 0x6f7479, 0.4, 0.7)]);
  const m = new THREE.Mesh(geo);
  m.name = `${name}.wheels`;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  parent.add(g);
  return g;
}

function mesh(geo: THREE.BufferGeometry, name: string, parent: THREE.Object3D, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo);
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/**
 * A main leg: trunnion at `pivot`, truck centre (axle height) at `truckAt` (body). The cylinder runs
 * down from the trunnion, the chrome piston into the truck pivot, a drag brace and a side brace.
 */
function mainLeg(name: string, pivot: THREE.Vector3, truckAt: THREE.Vector3, braceTo: THREE.Vector3): GearLeg {
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(pivot);
  const rel = truckAt.clone().sub(pivot);
  const cylBottom = rel.clone().multiplyScalar(0.55);
  const legGeo = merge([
    tint(tube(V(0, 0.15, 0), cylBottom, 0.2, 0.18, 14), STRUT, 0.38, 0.55),
    tint(tube(V(0, 0, 0).lerp(cylBottom, 0.35), braceTo.clone().sub(pivot), 0.07, 0.06, 8), STRUT, 0.45, 0.5),
    tint(tube(cylBottom.clone().add(V(0, 0.2, 0)), V(0, 0.4, 0.9 * Math.sign(-rel.z || 1)), 0.07, 0.06, 8), STRUT, 0.45, 0.5),
    tint(tube(V(-0.24, 0.05, 0), V(0.24, 0.05, 0), 0.13, 0.13, 10), STRUT, 0.4, 0.5),
  ]);
  mesh(legGeo, `${name}.leg`, group);
  const lower = new THREE.Group();
  lower.name = `${name}.lower`;
  group.add(lower);
  const pistonTop = cylBottom.clone().add(V(0, 0.45, 0));
  const pistonBot = rel.clone().add(V(0, 0.16, 0));
  mesh(
    merge([
      tint(tube(pistonTop, pistonBot, 0.13, 0.13, 12), CHROME, 0.12, 0.95),
      // Torque links.
      tint(box(0.05, 0.5, 0.06, pistonBot.clone().add(V(0, 0.35, 0.19)), 0.35, 0, 0), STRUT, 0.4, 0.5),
    ]),
    `${name}.piston`,
    lower,
    false,
  );
  const truck = new THREE.Group();
  truck.name = `${name}.truck`;
  truck.position.copy(rel);
  lower.add(truck);
  const h = GEAR.truckHalf;
  mesh(
    merge([
      tint(tube(V(0, 0.12, -h - 0.12), V(0, 0.12, h + 0.12), 0.11, 0.11, 10), STRUT, 0.4, 0.55),
      tint(box(0.3, 0.26, 0.34, V(0, 0.16, 0)), STRUT, 0.4, 0.5),
      tint(tube(V(0, 0.12, -h), V(0, 0, -h), 0.09, 0.09, 8), STRUT, 0.4, 0.5),
      tint(tube(V(0, 0.12, h), V(0, 0, h), 0.09, 0.09, 8), STRUT, 0.4, 0.5),
    ]),
    `${name}.beam`,
    truck,
    false,
  );
  const axles = [axle(`${name}.axle.front`, GEAR.pairHalf, truck, -h), axle(`${name}.axle.rear`, GEAR.pairHalf, truck, h)];
  return { group, lower, truck, axles };
}

function noseLeg(name: string): { leg: GearLeg; lamp: THREE.Object3D } {
  const N = GEAR.nose;
  const pivot = V(N.pivot.x, N.pivot.y, N.pivot.z);
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(pivot);
  const rel = V(N.axle.x, N.axle.y, N.axle.z).sub(pivot);
  const cylBottom = V(0, rel.y * 0.55, rel.z * 0.3);
  mesh(
    merge([
      tint(tube(V(0, 0.1, 0), cylBottom, 0.15, 0.14, 12), STRUT, 0.38, 0.55),
      tint(tube(V(0, 0, 0).lerp(cylBottom, 0.4), V(0, 0.25, -1.3), 0.06, 0.05, 8), STRUT, 0.45, 0.5),
      tint(tube(V(-0.2, 0.05, 0), V(0.2, 0.05, 0), 0.1, 0.1, 10), STRUT, 0.4, 0.5),
    ]),
    `${name}.leg`,
    group,
  );
  const lower = new THREE.Group();
  lower.name = `${name}.lower`;
  group.add(lower);
  const steer = new THREE.Group();
  steer.name = `${name}.steer`;
  steer.position.copy(rel);
  lower.add(steer);
  const top = cylBottom.clone().sub(rel).add(V(0, 0.4, 0));
  mesh(
    merge([
      tint(tube(top, V(0, 0.2, 0), 0.1, 0.1, 12), CHROME, 0.12, 0.95),
      tint(box(0.5, 0.12, 0.2, V(0, 0.16, 0)), STRUT, 0.4, 0.5),
      // Taxi-light bar on the strut.
      tint(box(0.5, 0.1, 0.1, V(0, 0.95, -0.14)), DARK, 0.5, 0.3),
    ]),
    `${name}.fork`,
    steer,
    false,
  );
  const ax = axle(`${name}.axle`, N.pairHalf, steer);
  const lamp = new THREE.Object3D();
  lamp.name = `${name}.taxiLamp`;
  lamp.position.set(0, 0.95, -0.2);
  steer.add(lamp);
  return { leg: { group, lower, truck: steer, axles: [ax] }, lamp };
}

/** A flat door panel hinged along a line parallel to body z at (hx, hy), spanning to x = x1. */
function door(name: string, hx: number, x1: number, z0: number, z1: number, open: number): GearDoor {
  const g = new THREE.Group();
  g.name = name;
  const hy = lowerYAt((z0 + z1) / 2, Math.abs(hx)) - 0.03;
  g.position.set(hx, hy, 0);
  const w = x1 - hx;
  const geo = tint(box(Math.abs(w), 0.05, z1 - z0, V(w / 2, 0, (z0 + z1) / 2)), DOOR, 0.35, 0.1);
  const m = new THREE.Mesh(geo);
  m.name = `${name}.panel`;
  m.castShadow = false;
  m.receiveShadow = true;
  g.add(m);
  g.visible = false;
  return { object: g, open };
}

export function buildGear(names: { nose: string; wing: (s: 'left' | 'right') => string; body: (s: 'left' | 'right') => string; door: (k: string) => string }): GearBuild {
  const { leg: nose, lamp } = noseLeg(names.nose);
  const W = GEAR.wing;
  const B = GEAR.body;
  const wingLeg = (s: 1 | -1) =>
    mainLeg(names.wing(s > 0 ? 'right' : 'left'), V(s * W.pivot.x, W.pivot.y, W.z), V(s * W.x, W.axleY, W.z), V(s * (W.pivot.x - 1.6), W.pivot.y + 0.5, W.z + 0.3));
  const bodyLeg = (s: 1 | -1) =>
    mainLeg(names.body(s > 0 ? 'right' : 'left'), V(s * B.x, B.pivot.y, B.pivot.z), V(s * B.x, B.axleY, GEAR.bodyZ), V(s * (B.x - 0.9), B.pivot.y + 0.3, B.pivot.z - 1.2));
  const wingLeft = wingLeg(-1);
  const wingRight = wingLeg(1);
  const bodyLeft = bodyLeg(-1);
  const bodyRight = bodyLeg(1);

  const noseDoors = [door(names.door('noseLeft'), -0.62, -0.05, -26.7, -22.8, -85 * DEG), door(names.door('noseRight'), 0.62, 0.05, -26.7, -22.8, 85 * DEG)];
  const mainDoors = [
    door(names.door('wingLeft'), -1.0, -3.55, 0.6, 3.4, 80 * DEG),
    door(names.door('wingRight'), 1.0, 3.55, 0.6, 3.4, -80 * DEG),
    door(names.door('bodyLeft'), -2.65, -1.15, 1.9, 6.1, -80 * DEG),
    door(names.door('bodyRight'), 2.65, 1.15, 1.9, 6.1, 80 * DEG),
  ];

  const legs = [nose, wingLeft, wingRight, bodyLeft, bodyRight];
  const update = (a: B747Anim) => {
    const stow = 1 - a.legs;
    nose.group.rotation.x = GEAR.nose.swing * stow;
    wingRight.group.rotation.z = -W.swing * stow;
    wingLeft.group.rotation.z = W.swing * stow;
    bodyLeft.group.rotation.x = bodyRight.group.rotation.x = B.swing * stow;
    nose.lower.position.y = a.compression[0];
    wingLeft.lower.position.y = bodyLeft.lower.position.y = a.compression[1];
    wingRight.lower.position.y = bodyRight.lower.position.y = a.compression[2];
    nose.truck.rotation.y = -a.noseSteerRad;
    // Trucks: tilt in flight; while stowing the body trucks fold flat against the leg.
    for (const l of [wingLeft, wingRight]) l.truck.rotation.x = a.truckTiltRad;
    for (const l of [bodyLeft, bodyRight]) l.truck.rotation.x = a.truckTiltRad - 70 * DEG * stow;
    for (const l of legs) {
      for (let i = 0; i < l.axles.length; i++) l.axles[i].rotation.x = -(l === nose ? a.wheelAngle[0] : a.wheelAngle[l === wingLeft || l === bodyLeft ? 1 : 2]);
    }
    for (const d of [...noseDoors, ...mainDoors]) {
      d.object.visible = a.doors > 0.01;
      d.object.rotation.z = d.open * a.doors;
    }
  };
  return { nose, wingLeft, wingRight, bodyLeft, bodyRight, noseDoors, mainDoors, taxiLamp: lamp, update };
}
