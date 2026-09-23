/**
 * A-10 landing gear. Like the real aircraft all three legs retract FORWARD: the main legs swing up
 * into the pods under the wing, where the wheels stay about half exposed (a belly landing rolls on
 * them); the nose leg — offset right of the centreline, clear of the GAU-8 — folds into the nose
 * behind two doors. Each leg is a group rotated about its trunnion; its lower part slides straight
 * up by the strut compression; the wheels spin with the roll speed; the nose fork steers.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import { box, tube, V, wheelLathe } from '../f16/geom';
import { ANCHOR, POD, bodyBottomY } from './shape';
import type { A10Anim } from './animate';

const STRUT = 0x9ea2a4;
const CHROME = 0xd0d4d8;
const TYRE = 0x151515;
const HUB = 0x8d9194;
const DARK = 0x3a3d40;

export interface GearLeg {
  group: THREE.Group;
  leg: THREE.Group;
  lower: THREE.Group;
  steer: THREE.Group;
  wheel: THREE.Group;
  axis: THREE.Vector3;
  angle: number;
}

export interface GearBuild {
  nose: GearLeg;
  left: GearLeg;
  right: GearLeg;
  /** Nose-well doors (attach to the fuselage). */
  doors: THREE.Group;
  /** Lamp positions for the light glows: landing (left pod nose), taxi (right pod nose). */
  lamps: { landing: THREE.Object3D; taxi: THREE.Object3D };
  /** Retracted axle positions (body) — for tests. */
  stowedAxles: { nose: THREE.Vector3; left: THREE.Vector3; right: THREE.Vector3 };
  update(a: A10Anim): void;
}

function tyreProfile(r: number, w: number): [number, number][] {
  const h = w / 2;
  const pts: [number, number][] = [];
  pts.push([r * 0.58, -h * 0.9]);
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([r - h * 0.5 + Math.cos(a) * h * 0.5, Math.sin(a) * h]);
  }
  pts.push([r * 0.58, h * 0.9]);
  return pts;
}

function buildWheel(r: number, w: number, name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const segs = 30;
  const geos = [
    tint(wheelLathe(tyreProfile(r, w), segs, V(0, 0, 0)), TYRE, 0.9, 0),
    tint(wheelLathe([[r * 0.59, -w * 0.43], [r * 0.62, -w * 0.3], [r * 0.62, w * 0.3], [r * 0.59, w * 0.43], [r * 0.22, w * 0.45], [r * 0.2, w * 0.5]], segs, V(0, 0, 0)), HUB, 0.45, 0.5),
    tint(wheelLathe([[r * 0.59, -w * 0.43], [r * 0.22, -w * 0.45], [r * 0.2, -w * 0.5]], segs, V(0, 0, 0)), HUB, 0.45, 0.5),
    tint(tube(V(-w * 0.52, 0, 0), V(w * 0.52, 0, 0), r * 0.12, r * 0.12, 12), 0x55585b, 0.4, 0.6),
  ];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    for (const s of [-1, 1]) geos.push(tint(tube(V(s * w * 0.44, Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4), V(s * w * 0.47, Math.cos(a) * r * 0.4, Math.sin(a) * r * 0.4), r * 0.06, r * 0.06, 8), 0x2e3032, 0.6, 0.3));
  }
  const mesh = new THREE.Mesh(merge(geos));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `${name}.mesh`;
  g.add(mesh);
  return g;
}

/** Axis/angle carrying (from − pivot) onto (to − pivot). */
function swing(pivot: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): { axis: THREE.Vector3; angle: number } {
  const a = from.clone().sub(pivot);
  const b = to.clone().sub(pivot);
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  return { axis, angle: a.angleTo(b) };
}

function makeLeg(name: string, pivot: THREE.Vector3, axleDown: THREE.Vector3, axleUp: THREE.Vector3): GearLeg {
  const group = new THREE.Group();
  group.name = name;
  group.position.copy(pivot);
  const leg = new THREE.Group();
  leg.name = `${name}.leg`;
  group.add(leg);
  const lower = new THREE.Group();
  lower.name = `${name}.lower`;
  leg.add(lower);
  const steer = new THREE.Group();
  steer.name = `${name}.steer`;
  steer.position.copy(axleDown).sub(pivot);
  lower.add(steer);
  const wheel = new THREE.Group();
  wheel.name = `${name}.wheelSpin`;
  steer.add(wheel);
  const { axis, angle } = swing(pivot, axleDown, axleUp);
  return { group, leg, lower, steer, wheel, axis, angle };
}

function mesh(geo: THREE.BufferGeometry, name: string, parent: THREE.Object3D, shadow = true) {
  const m = new THREE.Mesh(geo);
  m.name = name;
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** Main-leg trunnion (on the pod's centreline, in the wing box) — solved so the leg length is the same down and stowed. */
export const MAIN_LEG = {
  trunnionY: -0.88,
  /** Stowed axle: forward in the pod, the wheel half below the pod bottom. */
  stowedY: POD.bottomY,
  stowedZ: -0.35,
} as const;

export function mainTrunnion(side: 1 | -1): THREE.Vector3 {
  const c = side > 0 ? ANCHOR.rightMainWheel : ANCHOR.leftMainWheel;
  const d = V(c.x, c.y + ANCHOR.mainWheelRadius, c.z);
  const ty = MAIN_LEG.trunnionY;
  const u = V(c.x, MAIN_LEG.stowedY, MAIN_LEG.stowedZ);
  // |d − T|² = |u − T|², T = (c.x, ty, tz): linear in tz.
  const k = (d.y - ty) ** 2 + d.z ** 2 - (u.y - ty) ** 2 - u.z ** 2;
  return V(c.x, ty, k / (2 * (d.z - u.z)));
}

export const NOSE_LEG = { trunnion: { y: -0.62, dz: 0.13 }, stowDeg: 85 } as const;

export function buildGear(names: { nose: string; left: string; right: string; axleNose: string; axleLeft: string; axleRight: string }): GearBuild {
  const rn = ANCHOR.noseWheelRadius;
  const rm = ANCHOR.mainWheelRadius;

  // ── Nose gear (offset right) ──
  const nw = ANCHOR.noseWheel;
  const nAxle = V(nw.x, nw.y + rn, nw.z);
  const nPivot = V(nw.x, NOSE_LEG.trunnion.y, nw.z + NOSE_LEG.trunnion.dz);
  const nUp = nAxle.clone().sub(nPivot).applyAxisAngle(V(1, 0, 0), NOSE_LEG.stowDeg * (Math.PI / 180)).add(nPivot);
  const nose = makeLeg(names.nose, nPivot, nAxle, nUp);
  {
    const P = (x: number, y: number, z: number) => V(x, y, z).sub(nPivot);
    const x = nw.x;
    const oleoBottom = nAxle.y + 0.38;
    const upper: THREE.BufferGeometry[] = [
      tint(tube(P(x, nPivot.y + 0.04, nPivot.z), P(x, oleoBottom, nAxle.z + 0.02), 0.07, 0.066, 14), STRUT, 0.4, 0.3),
      tint(tube(P(x - 0.13, nPivot.y + 0.02, nPivot.z), P(x + 0.13, nPivot.y + 0.02, nPivot.z), 0.05, 0.05, 10), STRUT, 0.4, 0.3),
      // Drag brace forward to the well (the leg folds forward).
      tint(tube(P(x, oleoBottom + 0.15, nAxle.z + 0.01), P(x, nPivot.y + 0.02, nPivot.z - 0.5), 0.028, 0.028, 8), STRUT, 0.4, 0.3),
    ];
    mesh(merge(upper), `${names.nose}.strut`, nose.leg);
    const low: THREE.BufferGeometry[] = [
      tint(tube(P(x, oleoBottom + 0.25, nAxle.z + 0.02), P(x, nAxle.y + 0.12, nAxle.z + 0.01), 0.045, 0.045, 12), CHROME, 0.12, 1.0),
    ];
    mesh(merge(low), `${names.nose}.piston`, nose.lower, false);
    // Fork (steers), torque link.
    const fork: THREE.BufferGeometry[] = [
      tint(box(0.3, 0.07, 0.12, V(0, 0.16, 0.01)), STRUT, 0.4, 0.3),
      tint(box(0.035, 0.2, 0.09, V(-0.125, 0.06, 0)), STRUT, 0.4, 0.3),
      tint(box(0.035, 0.2, 0.09, V(0.125, 0.06, 0)), STRUT, 0.4, 0.3),
      tint(tube(V(0, 0.2, -0.1), V(0, 0.36, -0.14), 0.016, 0.016, 6), 0xb8bcbf, 0.4, 0.8),
    ];
    mesh(merge(fork), `${names.nose}.fork`, nose.steer);
    const w = buildWheel(rn, 0.2, names.axleNose);
    nose.wheel.add(w);
  }

  // ── Main gear: trunnion in the pod, leg raked aft, strut on the inboard side of the wheel ──
  const mainLeg = (side: 1 | -1, name: string, axleName: string) => {
    const c = side > 0 ? ANCHOR.rightMainWheel : ANCHOR.leftMainWheel;
    const aDown = V(c.x, c.y + rm, c.z);
    const T = mainTrunnion(side);
    const aUp = V(c.x, MAIN_LEG.stowedY, MAIN_LEG.stowedZ);
    const L = makeLeg(name, T, aDown, aUp);
    const P = (x: number, y: number, z: number) => V(x, y, z).sub(T);
    const sx = c.x - side * 0.24; // strut line, inboard of the tyre
    const upper: THREE.BufferGeometry[] = [
      // Trunnion yoke, main oleo cylinder down to just above the axle.
      tint(tube(P(sx - side * 0.06, T.y, T.z), P(sx + side * 0.1, T.y, T.z), 0.06, 0.06, 10), STRUT, 0.4, 0.3),
      tint(tube(P(sx, T.y, T.z), P(sx, aDown.y + 0.3, aDown.z - 0.02), 0.085, 0.08, 14), STRUT, 0.4, 0.3),
      // Drag strut forward/up into the pod.
      tint(tube(P(sx, aDown.y + 0.36, aDown.z - 0.05), P(sx, T.y - 0.05, T.z - 0.62), 0.035, 0.032, 8), STRUT, 0.4, 0.3),
    ];
    mesh(merge(upper), `${name}.strut`, L.leg);
    const low: THREE.BufferGeometry[] = [
      tint(tube(P(sx, aDown.y + 0.42, aDown.z - 0.01), P(sx, aDown.y - 0.02, aDown.z), 0.058, 0.058, 12), CHROME, 0.12, 1.0),
      // Axle beam and the brake housing.
      tint(tube(P(sx, aDown.y, aDown.z), P(c.x - side * 0.1, aDown.y, aDown.z), 0.05, 0.045, 10), STRUT, 0.4, 0.3),
      tint(tube(P(c.x - side * 0.15, aDown.y, aDown.z), P(c.x - side * 0.1, aDown.y, aDown.z), rm * 0.5, rm * 0.5, 16), 0x6c7074, 0.5, 0.6),
      // Torque links.
      tint(tube(P(sx, aDown.y + 0.08, aDown.z + 0.1), P(sx, aDown.y + 0.36, aDown.z + 0.13), 0.018, 0.018, 6), 0xb8bcbf, 0.4, 0.8),
    ];
    mesh(merge(low), `${name}.piston`, L.lower, false);
    const w = buildWheel(rm, 0.29, axleName);
    L.wheel.add(w);
    return { L, T, aUp };
  };
  const right = mainLeg(1, names.right, names.axleRight);
  const left = mainLeg(-1, names.left, names.axleLeft);

  // ── Nose-well doors: hinged along the well's side edges, hanging open with the gear down. ──
  const doorGroup = new THREE.Group();
  doorGroup.name = 'a10.gearDoors';
  const wellZ0 = nUp.z - rn - 0.08;
  const wellZ1 = nAxle.z + 0.16;
  const wellHalf = 0.17;
  const doorY = Math.max(bodyBottomY(wellZ0), bodyBottomY(wellZ1)) - 0.012;
  const makeDoor = (s: 1 | -1) => {
    const pivot = new THREE.Group();
    pivot.position.set(nw.x + s * wellHalf, doorY, (wellZ0 + wellZ1) / 2);
    const len = wellZ1 - wellZ0;
    const g: THREE.BufferGeometry[] = [
      tint(box(wellHalf, 0.012, len, V(-s * wellHalf * 0.5, 0, 0)), 0x62676a, 0.6, 0),
      tint(box(wellHalf - 0.02, 0.008, len - 0.04, V(-s * wellHalf * 0.5, 0.01, 0)), 0xc9cac5, 0.5, 0),
    ];
    const m = new THREE.Mesh(merge(g));
    m.castShadow = false;
    m.receiveShadow = true;
    pivot.add(m);
    doorGroup.add(pivot);
    return pivot;
  };
  const dR = makeDoor(1);
  const dL = makeDoor(-1);

  // Lamps in the pod noses: landing (left), taxi (right).
  const landing = new THREE.Object3D();
  landing.name = 'a10.lamp.landing';
  landing.position.set(-POD.x, -0.96, POD.noseZ + 0.03);
  const taxi = new THREE.Object3D();
  taxi.name = 'a10.lamp.taxi';
  taxi.position.set(POD.x, -0.96, POD.noseZ + 0.03);

  const legs = [nose, left.L, right.L];
  const ext = [1, 1, 1];
  const DOOR_OPEN = 85 * (Math.PI / 180);
  return {
    nose,
    left: left.L,
    right: right.L,
    doors: doorGroup,
    lamps: { landing, taxi },
    stowedAxles: { nose: nUp, left: left.aUp, right: right.aUp },
    update(a: A10Anim) {
      ext[0] = a.noseLeg;
      ext[1] = ext[2] = a.mainLeg;
      for (let i = 0; i < 3; i++) {
        const L = legs[i];
        const e = ext[i];
        L.leg.quaternion.setFromAxisAngle(L.axis, (1 - e) * L.angle);
        L.lower.position.y = e > 0.999 ? a.compression[i] : 0;
        L.wheel.rotation.x = -a.wheelAngle[i];
      }
      nose.steer.rotation.y = -a.noseSteerRad;
      dR.rotation.z = a.noseDoor * DOOR_OPEN;
      dL.rotation.z = -a.noseDoor * DOOR_OPEN;
      // Fully stowed: the nose leg is behind closed doors (the main wheels stay in view).
      nose.group.visible = a.noseLeg > 0.0005 || a.noseDoor > 0;
    },
  };
}
