/**
 * F-16 retractable tricycle gear. Like the real jet: the nose leg retracts AFT under the intake
 * duct, the wheel turning 90° to lie flat; the main legs swing FORWARD into the fuselage beside
 * the intake, their wheels also turning flat. Gloss-white legs, wells and door liners; the main
 * doors ride on the legs and close the wells flush; the nose doors hinge on the cowl bottom.
 *
 * Each leg is a group rotated about its retraction axis through the trunnion; its lower part
 * slides straight up by the strut compression (the physics' contact points move vertically);
 * the wheel twists flat as the leg stows and spins with the roll speed; the nose fork steers.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V, wheelLathe } from './geom';
import { ANCHOR } from './shape';
import type { F16Anim } from './animate';

const WHITE = 0xe9e9e4;
const STEEL = 0xb8bcbf;
const TYRE = 0x151515;
const LINER = 0xdcddd8;

export interface GearLeg {
  group: THREE.Group;
  leg: THREE.Group;
  lower: THREE.Group;
  steer: THREE.Group;
  mount: THREE.Group;
  wheel: THREE.Group;
  axis: THREE.Vector3;
  angle: number;
  stow: THREE.Quaternion;
}

export interface GearBuild {
  nose: GearLeg;
  left: GearLeg;
  right: GearLeg;
  /** Nose doors (hinged on the cowl bottom); attach to the fuselage. */
  doors: THREE.Group;
  /** Lamp positions (body) for the light glows: landing (left main door), taxi (nose strut). */
  lamps: { landing: THREE.Object3D; taxi: THREE.Object3D };
  update(a: F16Anim): void;
}

function tyreProfile(r: number, w: number): [number, number][] {
  // [radius, axial] from the inner hub face round the tread to the outer face.
  const h = w / 2;
  const pts: [number, number][] = [];
  pts.push([r * 0.55, -h * 0.92]);
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI;
    pts.push([r - h * 0.42 + Math.cos(a) * h * 0.42, Math.sin(a) * h]);
  }
  pts.push([r * 0.55, h * 0.92]);
  return pts;
}

function buildWheel(r: number, w: number, name: string, parts: 'nose' | 'main'): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const segs = parts === 'nose' ? 28 : 32;
  const geos = [
    tint(wheelLathe(tyreProfile(r, w), segs, V(0, 0, 0)), TYRE, 0.88, 0),
    // Hub: white rim with a darker bearing cap and a few lightening holes (show the spin).
    tint(wheelLathe([[r * 0.56, -w * 0.44], [r * 0.6, -w * 0.3], [r * 0.6, w * 0.3], [r * 0.56, w * 0.44], [r * 0.2, w * 0.46], [r * 0.18, w * 0.5]], segs, V(0, 0, 0)), WHITE, 0.35, 0.3),
    tint(wheelLathe([[r * 0.56, -w * 0.44], [r * 0.2, -w * 0.46], [r * 0.18, -w * 0.5]], segs, V(0, 0, 0)), WHITE, 0.35, 0.3),
    tint(tube(V(-w * 0.52, 0, 0), V(w * 0.52, 0, 0), r * 0.13, r * 0.13, 12), 0x55585b, 0.4, 0.6),
  ];
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    for (const s of [-1, 1]) geos.push(tint(tube(V(s * w * 0.44, Math.cos(a) * r * 0.38, Math.sin(a) * r * 0.38), V(s * w * 0.47, Math.cos(a) * r * 0.38, Math.sin(a) * r * 0.38), r * 0.07, r * 0.07, 8), 0x3a3c3e, 0.6, 0.2));
  }
  const mesh = new THREE.Mesh(merge(geos));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `${name}.mesh`;
  g.add(mesh);
  return g;
}

/** Rotation that carries (from − pivot) onto (to − pivot): axis and angle. */
function swing(pivot: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): { axis: THREE.Vector3; angle: number } {
  const a = from.clone().sub(pivot);
  const b = to.clone().sub(pivot);
  const axis = new THREE.Vector3().crossVectors(a, b).normalize();
  return { axis, angle: a.angleTo(b) };
}

/** Solve the trunnion z so the leg has the same length down and stowed. */
function trunnionZ(tx: number, ty: number, down: THREE.Vector3, up: THREE.Vector3): number {
  // |down − T|² = |up − T|² is linear in T.z.
  const k = (down.x - tx) ** 2 + (down.y - ty) ** 2 + down.z ** 2 - (up.x - tx) ** 2 - (up.y - ty) ** 2 - up.z ** 2;
  return k / (2 * (down.z - up.z));
}

function makeLeg(name: string, pivot: THREE.Vector3, axleDown: THREE.Vector3, axleUp: THREE.Vector3, stowWorld: THREE.Quaternion): GearLeg {
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
  lower.add(steer);
  const mount = new THREE.Group();
  mount.name = `${name}.mount`;
  mount.position.copy(axleDown).sub(pivot);
  steer.add(mount);
  const wheel = new THREE.Group();
  wheel.name = `${name}.wheelSpin`;
  mount.add(wheel);
  const { axis, angle } = swing(pivot, axleDown, axleUp);
  // Wheel orientation at full retraction (in the leg frame, which is then swung by R_up).
  const rUp = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  const stow = rUp.clone().invert().multiply(stowWorld);
  return { group, leg, lower, steer, mount, wheel, axis, angle, stow };
}

export function buildGear(partNames: { nose: string; left: string; right: string; axleNose: string; axleLeft: string; axleRight: string }): GearBuild {
  const rn = ANCHOR.noseWheelRadius;
  const rm = ANCHOR.mainWheelRadius;
  // ── Nose gear ──
  const nAxle = V(ANCHOR.noseWheel.x, ANCHOR.noseWheel.y + rn, ANCHOR.noseWheel.z);
  const nPivot = V(0, -0.8, nAxle.z - 0.02);
  // Stowed: swung 95° aft about +X, wheel flat.
  const nUp = nAxle.clone().sub(nPivot).applyAxisAngle(V(1, 0, 0), -95 * (Math.PI / 180)).add(nPivot);
  const flat = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2);
  const nose = makeLeg(partNames.nose, nPivot, nAxle, nUp, flat);
  {
    // Upper strut (fixed to the leg): pivot block → oleo cylinder.
    const P = (x: number, y: number, z: number) => V(x, y, z).sub(nPivot);
    const geos: THREE.BufferGeometry[] = [];
    const topY = nPivot.y + 0.02;
    const oleoBottom = nAxle.y + 0.3;
    geos.push(tint(tube(P(0, topY, nAxle.z - 0.04), P(0, oleoBottom, nAxle.z - 0.02), 0.058, 0.055, 14), WHITE, 0.3, 0.2));
    geos.push(tint(tube(P(-0.11, topY + 0.02, nPivot.z), P(0.11, topY + 0.02, nPivot.z), 0.045, 0.045, 10), WHITE, 0.35, 0.2));
    // Drag brace to the duct (aft).
    geos.push(tint(tube(P(0, oleoBottom + 0.12, nAxle.z), P(0, topY + 0.04, nAxle.z + 0.42), 0.025, 0.025, 8), WHITE, 0.35, 0.2));
    // Taxi-light housing on the front of the strut.
    geos.push(tint(box(0.07, 0.06, 0.06, P(0, oleoBottom + 0.2, nAxle.z - 0.09)), 0xd8d8d2, 0.35, 0.3));
    const m = new THREE.Mesh(merge(geos));
    m.castShadow = true;
    m.name = `${partNames.nose}.strut`;
    nose.leg.add(m);
    // Lower: chromed piston, torque links and the fork (steers).
    const low: THREE.BufferGeometry[] = [];
    low.push(tint(tube(P(0, oleoBottom + 0.22, nAxle.z - 0.02), P(0, nAxle.y + 0.1, nAxle.z - 0.02), 0.038, 0.038, 12), 0xd0d4d8, 0.12, 1.0));
    nose.lower.add(new THREE.Mesh(merge(low)));
    const fork: THREE.BufferGeometry[] = [];
    fork.push(tint(box(0.24, 0.06, 0.1, P(0, nAxle.y + 0.12, nAxle.z - 0.02)), WHITE, 0.35, 0.2));
    for (const s of [-1, 1]) fork.push(tint(box(0.03, 0.18, 0.08, P(s * 0.105, nAxle.y + 0.05, nAxle.z)), WHITE, 0.35, 0.2));
    // Torque link (scissor) on the front.
    fork.push(tint(tube(P(0, nAxle.y + 0.14, nAxle.z - 0.08), P(0, oleoBottom + 0.07, nAxle.z - 0.13), 0.014, 0.014, 6), STEEL, 0.4, 0.8));
    fork.push(tint(tube(P(0, oleoBottom + 0.07, nAxle.z - 0.13), P(0, oleoBottom + 0.02, nAxle.z - 0.06), 0.014, 0.014, 6), STEEL, 0.4, 0.8));
    const forkMesh = new THREE.Mesh(merge(fork));
    forkMesh.castShadow = true;
    nose.steer.add(forkMesh);
    const w = buildWheel(rn, 0.17, partNames.axleNose, 'nose');
    nose.wheel.add(w);
    // The named axle marker is the spinning wheel group itself (its origin = axle centre).
    w.name = partNames.axleNose;
  }

  // ── Main gear (right built, left mirrored by construction) ──
  const mainLeg = (side: 1 | -1, name: string, axleName: string) => {
    const c = side > 0 ? ANCHOR.rightMainWheel : ANCHOR.leftMainWheel;
    const aDown = V(c.x, c.y + rm, c.z);
    const aUp = V(side * 0.8, -0.38, 0);
    const tx = side * 0.74;
    const ty = -0.47;
    aUp.z = -0.474;
    const tz = trunnionZ(tx, ty, aDown, aUp);
    const T = V(tx, ty, tz);
    // Wheel flat when stowed: axle vertical.
    const legObj = makeLeg(name, T, aDown, aUp, new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), side * Math.PI / 2));
    const P = (x: number, y: number, z: number) => V(x, y, z).sub(T);
    const oleoX = aDown.x - side * 0.17;
    const oleoTop = -0.78;
    const geos: THREE.BufferGeometry[] = [];
    // Trunnion arm → oleo top, oleo cylinder.
    geos.push(tint(tube(P(tx, ty, tz), P(oleoX, oleoTop, aDown.z), 0.065, 0.06, 12), WHITE, 0.3, 0.2));
    geos.push(tint(tube(P(oleoX, oleoTop + 0.05, aDown.z), P(oleoX, aDown.y + 0.3, aDown.z), 0.068, 0.064, 14), WHITE, 0.3, 0.2));
    // Side brace up to the fuselage.
    geos.push(tint(tube(P(oleoX, oleoTop - 0.12, aDown.z), P(side * 0.66, -0.52, aDown.z - 0.35), 0.026, 0.024, 8), WHITE, 0.35, 0.2));
    // Strut door riding on the leg: stowed, it lies flush over the aft (strut) part of the well.
    const rUpInv = new THREE.Quaternion().setFromAxisAngle(legObj.axis, legObj.angle).invert();
    const door = (y: number, hex: number, rough: number, inset: number) => {
      const g = box(0.42 - inset, 0.007, 0.7 - inset, V(side * 0.85, y, 0.27));
      g.translate(-T.x, -T.y, -T.z);
      g.applyQuaternion(rUpInv);
      return tint(g, hex, rough, 0);
    };
    geos.push(door(-0.562, 0xa9acae, 0.55, 0));
    geos.push(door(-0.552, LINER, 0.3, 0.02));
    const m = new THREE.Mesh(merge(geos));
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = `${name}.strut`;
    legObj.leg.add(m);
    const low: THREE.BufferGeometry[] = [];
    low.push(tint(tube(P(oleoX, aDown.y + 0.42, aDown.z), P(oleoX, aDown.y - 0.02, aDown.z), 0.048, 0.048, 12), 0xd0d4d8, 0.12, 1.0));
    low.push(tint(tube(P(oleoX, aDown.y, aDown.z), P(aDown.x - side * 0.06, aDown.y, aDown.z), 0.045, 0.04, 10), WHITE, 0.35, 0.3));
    low.push(tint(tube(P(oleoX, aDown.y + 0.05, aDown.z + 0.08), P(oleoX, aDown.y + 0.32, aDown.z + 0.12), 0.016, 0.016, 6), STEEL, 0.4, 0.8));
    // Brake assembly housing.
    low.push(tint(tube(P(aDown.x - side * 0.09, aDown.y, aDown.z), P(aDown.x - side * 0.05, aDown.y, aDown.z), rm * 0.5, rm * 0.5, 16), 0x6c7074, 0.5, 0.6));
    const lm = new THREE.Mesh(merge(low));
    lm.castShadow = true;
    legObj.lower.add(lm);
    const w = buildWheel(rm, 0.2, axleName, 'main');
    legObj.wheel.add(w);
    return { legObj, T };
  };
  const right = mainLeg(1, partNames.right, partNames.axleRight);
  const left = mainLeg(-1, partNames.left, partNames.axleLeft);

  // ── Doors on the fuselage: nose doors hinged on the cowl bottom's outer edges (the plates reach
  // inboard), main-well doors hinged on the well's inboard edges (the plates reach outboard). They
  // swing down to hang vertically and stay open with the gear down.
  const doorGroup = new THREE.Group();
  doorGroup.name = 'f16.gearDoors';
  const makeDoor = (side: 1 | -1, px: number, py: number, pz: number, len: number, wdt: number, reach: 1 | -1) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * px, py, pz);
    const g: THREE.BufferGeometry[] = [];
    const cx = reach * side * wdt * 0.5;
    g.push(tint(box(wdt, 0.008, len, V(cx, -0.004, 0)), 0xa9acae, 0.55, 0));
    g.push(tint(box(wdt - 0.01, 0.006, len - 0.02, V(cx, 0.006, 0)), LINER, 0.3, 0));
    const mesh = new THREE.Mesh(merge(g));
    mesh.castShadow = true;
    pivot.add(mesh);
    doorGroup.add(pivot);
    return pivot;
  };
  const dRight = makeDoor(1, 0.165, -0.935, -3.18, 1.18, 0.16, -1);
  const dLeft = makeDoor(-1, 0.165, -0.935, -3.18, 1.18, 0.16, -1);
  const mRight = makeDoor(1, 0.64, -0.558, -0.5, 0.76, 0.42, 1);
  const mLeft = makeDoor(-1, 0.64, -0.558, -0.5, 0.76, 0.42, 1);

  // Lamps: landing light low on the left main strut, taxi light on the nose strut.
  const landing = new THREE.Object3D();
  landing.position.set(-1.0 - left.T.x, -1.08 - left.T.y, 0.38 - left.T.z);
  left.legObj.leg.add(landing);
  const taxi = new THREE.Object3D();
  taxi.position.set(0, nAxle.y + 0.3 + 0.2 - nPivot.y, nAxle.z - 0.12 - nPivot.z);
  nose.leg.add(taxi);

  const legs = [nose, left.legObj, right.legObj];
  const identity = new THREE.Quaternion();
  const ext = [1, 1, 1];
  const DOOR_OPEN = 88 * (Math.PI / 180);

  return {
    nose,
    left: left.legObj,
    right: right.legObj,
    doors: doorGroup,
    lamps: { landing, taxi },
    update(a: F16Anim) {
      ext[0] = a.noseLeg;
      ext[1] = ext[2] = a.mainLeg;
      for (let i = 0; i < 3; i++) {
        const L = legs[i];
        const e = ext[i];
        L.leg.quaternion.setFromAxisAngle(L.axis, (1 - e) * L.angle);
        L.mount.quaternion.copy(identity).slerp(L.stow, 1 - e);
        L.lower.position.y = e > 0.999 ? a.compression[i] : 0;
        L.wheel.rotation.x = -a.wheelAngle[i];
      }
      nose.steer.rotation.y = -a.noseSteerRad;
      // Hide wheels/legs fully inside the fuselage when stowed (saves draws, avoids poke-through).
      const stowed = a.mainLeg <= 0.0005;
      for (const L of legs) L.group.visible = !stowed || a.noseDoor > 0;
      dRight.rotation.z = a.noseDoor * DOOR_OPEN;
      dLeft.rotation.z = -a.noseDoor * DOOR_OPEN;
      mRight.rotation.z = -a.mainDoor * DOOR_OPEN;
      mLeft.rotation.z = a.mainDoor * DOOR_OPEN;
      doorGroup.visible = true;
    },
  };
}

export { ellipsoid };
