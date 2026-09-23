/**
 * 172RG retractable tricycle gear: meshes + the per-frame rig. The motion comes
 * from the pure kinematics in gearKinematics.ts (tested for the stowed envelope
 * and a clip-free path); this file builds the parts and applies the poses.
 *
 * Nose: trunnion, painted oleo barrel with steering collar and shimmy damper,
 * chrome piston sliding with compression, fork, torque-link scissors that fold
 * as the oleo compresses, 5.00-5 tyre; a two-link drag brace folds as the leg
 * swings aft into its well; clamshell doors close behind it.
 * Mains: tapered tubular spring-steel legs (white), brake line clipped along the
 * leg, axle fitting, Cleveland wheel halves with bolts, brake disc and caliper,
 * 6.00-6 tyres with tread grooves and a sidewall band. The wheels spin with the
 * ground roll and are stopped by the well snubbers when retracted.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AircraftAnimation } from './animate';
import type { AircraftVisualState } from './types';
import { GEAR } from './shape';
import { merge, tint, type AircraftMaterials } from './materials';
import { loftGeometry } from './loft';
import {
  MAIN_GEAR,
  NOSE_GEAR,
  WELL,
  bellyY,
  createMainGearPose,
  createNoseGearPose,
  mainGearHinge,
  mainGearPose,
  noseGearPose,
  tyreProfile,
} from './gearKinematics';

const G = CONFIG.aircraft.geometry;

export const GEAR_PART = {
  axleNose: 'axle.nose',
  axleLeft: 'axle.left',
  axleRight: 'axle.right',
} as const;

export interface GearRig {
  group: THREE.Group;
  /** Containers (identity transforms, children animated) that break off separately in a crash. */
  nose: THREE.Group;
  mainLeft: THREE.Group;
  mainRight: THREE.Group;
  /** `crashed` shows the collapsed gear of a wreck (nose folded, mains splayed and bent back, a door torn off). */
  update(anim: AircraftAnimation, v: AircraftVisualState, dt: number, crashed?: boolean): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// ─── Primitive helpers ───────────────────────────────────────────────────────

/** A tube from a to b (radius ra at a, rb at b). */
function tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, segs = 12): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(rb, ra, d.length(), segs, 1);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Unit link along +Y (0 → 1) for meshes stretched between two moving points each frame. */
function unitLink(r: number, hex: number, rough: number, metal: number): THREE.BufferGeometry {
  return merge([
    tint(tube(V(0, 0, 0), V(0, 1, 0), r, r, 8), hex, rough, metal),
  ]);
}

// ─── Wheels ──────────────────────────────────────────────────────────────────

/**
 * Tyre + Cleveland hub (+ brake disc on mains), axle along X, centred on the
 * origin. `outboard` = the side (±1 in local x) that faces away from the leg.
 */
function wheelGeometry(R: number, rim: number, width: number, brake: number, segs: number, outboard: 1 | -1): THREE.BufferGeometry {
  const hw = width / 2;
  // Tyre: the shared cross-section, with three shallow tread grooves across the crown.
  const base = tyreProfile(R, rim, width, 22);
  const prof: THREE.Vector2[] = [new THREE.Vector2(rim + 0.004, -hw * 0.72)];
  const grooves = [-0.3, 0, 0.3].map((f) => f * hw);
  for (const [r, h] of base) {
    let rr = r;
    for (const gh of grooves) {
      const d = Math.abs(h - gh);
      if (d < 0.006 && r > R - 0.012) rr -= 0.004 * (1 - d / 0.006);
    }
    prof.push(new THREE.Vector2(rr, h));
  }
  prof.push(new THREE.Vector2(rim + 0.004, hw * 0.72));
  const tyre = new THREE.LatheGeometry(prof, segs);
  // Per-vertex tyre shading: worn tread slightly lighter, dark grooves, a faint lettering band on the sidewalls.
  const col = new THREE.Color();
  const tp = tyre.getAttribute('position');
  const tc = new Float32Array(tp.count * 3);
  const trm = new Float32Array(tp.count * 2);
  for (let i = 0; i < tp.count; i++) {
    const x = tp.getX(i);
    const z = tp.getZ(i);
    const r = Math.hypot(x, z);
    const h = tp.getY(i);
    let hex = 0x1d1d1f;
    let rough = 0.86;
    if (r > R - 0.02) {
      hex = 0x2a2a2b;
      rough = 0.95;
      for (const gh of grooves) if (Math.abs(h - gh) < 0.004) hex = 0x121213;
    } else if (Math.abs(r - (R + rim) * 0.52) < 0.01 && Math.abs(h) > hw * 0.6) {
      hex = 0x2c2c2e;
      rough = 0.7;
    }
    col.setHex(hex);
    tc.set([col.r, col.g, col.b], i * 3);
    trm.set([rough, 0], i * 2);
  }
  tint(tyre, 0x1d1d1f, 0.86, 0);
  tyre.setAttribute('color', new THREE.BufferAttribute(tc, 3));
  tyre.setAttribute('rm', new THREE.BufferAttribute(trm, 2));

  // Hub: flanged rim halves, the dished outboard half with a centre cap.
  const o = outboard;
  const hubProf = [
    new THREE.Vector2(0.001, -hw * 0.62),
    new THREE.Vector2(0.03, -hw * 0.62),
    new THREE.Vector2(0.045, -hw * 0.52),
    new THREE.Vector2(rim * 0.8, -hw * 0.5),
    new THREE.Vector2(rim + 0.008, -hw * 0.66),
    new THREE.Vector2(rim + 0.011, -hw * 0.6),
    new THREE.Vector2(rim, -hw * 0.4),
    new THREE.Vector2(rim, hw * 0.4),
    new THREE.Vector2(rim + 0.011, hw * 0.6),
    new THREE.Vector2(rim + 0.008, hw * 0.66),
    new THREE.Vector2(rim * 0.8, hw * 0.5),
    new THREE.Vector2(0.045, hw * 0.52),
    new THREE.Vector2(0.03, hw * 0.62),
    new THREE.Vector2(0.001, hw * 0.62),
  ];
  const hub = new THREE.LatheGeometry(hubProf, Math.max(16, segs / 2));
  const parts = [tyre, tint(hub, 0xd9dad6, 0.32, 0.55)];
  // Wheel-half through-bolts (6) and the valve stem, on the outboard face (lathe axis = local Y here).
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    const b = new THREE.CylinderGeometry(0.0055, 0.0055, 0.012, 8);
    b.translate(Math.cos(a) * rim * 0.62, o * hw * 0.53, Math.sin(a) * rim * 0.62);
    parts.push(tint(b, 0x8e9092, 0.35, 0.9));
  }
  const cap = new THREE.CylinderGeometry(0.022, 0.026, 0.02, 14);
  cap.translate(0, o * hw * 0.64, 0);
  parts.push(tint(cap, 0xb9bbbd, 0.25, 0.9));
  parts.push(tint(tube(V(rim * 0.9, o * hw * 0.45, 0), V(rim * 0.9, o * hw * 0.62, 0.012), 0.003, 0.003, 6), 0x2a2a2a, 0.5, 0.6));
  if (brake > 0) {
    // Brake disc on the inboard side (it turns with the wheel; the caliper stays on the axle).
    const disc = new THREE.CylinderGeometry(brake, brake, 0.008, 28);
    disc.translate(0, -o * hw * 0.78, 0);
    parts.push(tint(disc, 0x6a6c6e, 0.38, 0.9));
    const hat = new THREE.CylinderGeometry(brake * 0.55, brake * 0.6, 0.03, 18);
    hat.translate(0, -o * hw * 0.66, 0);
    parts.push(tint(hat, 0x4a4c4e, 0.5, 0.7));
  }
  const g = merge(parts);
  g.rotateZ(-Math.PI / 2); // lathe axis (Y) → axle (X); local +Y (outboard for o=1) → +X
  return g;
}

// ─── Build ───────────────────────────────────────────────────────────────────

export function buildGear(mats: AircraftMaterials, quality: 'high' | 'low'): GearRig {
  const group = new THREE.Group();
  group.name = 'gear';
  const noseGroup = new THREE.Group();
  noseGroup.name = 'gear.nose';
  const mainGroups = [new THREE.Group(), new THREE.Group()];
  mainGroups[0].name = 'gear.main.left';
  mainGroups[1].name = 'gear.main.right';
  group.add(noseGroup, mainGroups[0], mainGroups[1]);
  const segs = quality === 'high' ? 44 : 24;
  const cast = (m: THREE.Mesh, name?: string) => {
    m.castShadow = true;
    m.receiveShadow = true;
    if (name) m.name = name;
    return m;
  };
  const PAINT = 0xe6e6e1;
  const STEEL = 0x8c8e90;
  const CHROME = 0xe8eaec;
  const BLACK = 0x161617;

  // ── Nose gear ──────────────────────────────────────────────────────────────
  const np = V(NOSE_GEAR.pivot.x, NOSE_GEAR.pivot.y, NOSE_GEAR.pivot.z);
  const axleY = NOSE_GEAR.axleDown.y - np.y; // axle below the pivot (negative)
  const noseSwing = new THREE.Group();
  noseSwing.position.copy(np);
  noseGroup.add(noseSwing);
  const collarY = -0.265;
  const upper = merge([
    // Trunnion across the pivot, oleo barrel, steering collar.
    tint(tube(V(-0.075, 0, 0), V(0.075, 0, 0), 0.02, 0.02, 12), STEEL, 0.4, 0.8),
    tint(box(0.07, 0.06, 0.07, 0, 0, 0), 0x7a7c7e, 0.5, 0.6),
    tint(tube(V(0, 0.02, 0), V(0, collarY, 0), 0.043, 0.041, 18), PAINT, 0.35, 0.1),
    tint(tube(V(0, collarY + 0.025, 0), V(0, collarY - 0.02, 0), 0.052, 0.052, 18), 0x9a9c9e, 0.4, 0.7),
    // Shimmy damper: body clamped beside the barrel, rod down to the collar.
    tint(tube(V(0.066, -0.06, -0.01), V(0.066, -0.19, -0.01), 0.017, 0.017, 12), 0x3d3f42, 0.45, 0.5),
    tint(tube(V(0.066, -0.19, -0.01), V(0.058, collarY + 0.01, -0.015), 0.007, 0.007, 8), CHROME, 0.12, 1),
    tint(box(0.03, 0.02, 0.03, 0.05, -0.06, -0.01), STEEL, 0.4, 0.8),
    // Torque-link upper lug on the collar (aft).
    tint(box(0.03, 0.03, 0.04, 0, collarY - 0.005, 0.05), STEEL, 0.4, 0.8),
  ]);
  noseSwing.add(cast(new THREE.Mesh(upper, mats.parts), 'noseLeg.upper'));
  const noseSteer = new THREE.Group();
  noseSwing.add(noseSteer);
  const noseLower = new THREE.Group();
  noseSteer.add(noseLower);
  const crown = axleY + 0.2;
  const forkW = GEAR.noseTyreWidth / 2 + 0.016;
  const lowerGeo = merge([
    tint(tube(V(0, -0.2, 0), V(0, crown, 0), 0.026, 0.026, 18), CHROME, 0.08, 1.0),
    tint(box(forkW * 2 + 0.018, 0.035, 0.075, 0, crown, 0), 0x8c8e90, 0.45, 0.6),
    tint(box(0.01, 0.22, 0.05, forkW, crown - 0.105, 0), 0x8c8e90, 0.45, 0.6),
    tint(box(0.01, 0.22, 0.05, -forkW, crown - 0.105, 0), 0x8c8e90, 0.45, 0.6),
    // Lower torque-link lug on the fork crown, axle through the fork, tow-bar lugs.
    tint(box(0.03, 0.03, 0.04, 0, crown + 0.01, 0.05), STEEL, 0.4, 0.8),
    tint(tube(V(-forkW - 0.012, axleY, 0), V(forkW + 0.012, axleY, 0), 0.011, 0.011, 8), 0x9a9c9e, 0.3, 0.9),
    tint(tube(V(forkW + 0.005, axleY, 0), V(forkW + 0.016, axleY, 0), 0.014, 0.014, 8), STEEL, 0.4, 0.8),
    tint(tube(V(-forkW - 0.005, axleY, 0), V(-forkW - 0.016, axleY, 0), 0.014, 0.014, 8), STEEL, 0.4, 0.8),
  ]);
  noseLower.add(cast(new THREE.Mesh(lowerGeo, mats.parts), 'noseLeg.lower'));
  const noseAxle = new THREE.Group();
  noseAxle.name = GEAR_PART.axleNose;
  noseAxle.position.set(NOSE_GEAR.axleDown.x - np.x, axleY, NOSE_GEAR.axleDown.z - np.z);
  noseLower.add(noseAxle);
  const noseSpin = new THREE.Group();
  noseSpin.name = 'wheelSpin.nose';
  noseAxle.add(noseSpin);
  noseSpin.add(cast(new THREE.Mesh(wheelGeometry(G.noseWheelRadius, 0.064, GEAR.noseTyreWidth, 0, segs, 1), mats.parts), 'wheel.nose'));

  // Torque links (scissors): upper lug on the collar ↔ lower lug on the fork crown, knee aft.
  const linkMat = mats.parts;
  const torqueU = new THREE.Mesh(unitLink(0.009, 0x77797b, 0.45, 0.7), linkMat);
  const torqueL = new THREE.Mesh(unitLink(0.009, 0x77797b, 0.45, 0.7), linkMat);
  torqueU.name = 'noseTorqueLink.upper';
  torqueL.name = 'noseTorqueLink.lower';
  noseSteer.add(torqueU, torqueL);
  const TL = 0.125;
  const tU = V(0, collarY - 0.01, 0.055);

  // Drag brace (body frame): anchor on the well roof → knee → attach on the leg.
  const braceU = new THREE.Mesh(unitLink(0.012, 0x8a8c8e, 0.4, 0.8), linkMat);
  const braceL = new THREE.Mesh(unitLink(0.012, 0x8a8c8e, 0.4, 0.8), linkMat);
  braceU.name = 'noseBrace.upper';
  braceL.name = 'noseBrace.lower';
  noseGroup.add(braceU, braceL);
  const anchor = V(NOSE_GEAR.braceAnchor.x, NOSE_GEAR.braceAnchor.y, NOSE_GEAR.braceAnchor.z);

  // Nose doors: clamshells along the belly under the cabin floor, curved to the belly line.
  const doorsGroup = new THREE.Group();
  doorsGroup.name = 'noseDoors';
  noseGroup.add(doorsGroup);
  const hw = WELL.nose.halfWidth + 0.01;
  const dz0 = WELL.nose.z0 - 0.01;
  const dz1 = WELL.nose.z1 + 0.01;
  const hinge0 = V(0, bellyY(hw, dz0) - 0.003, dz0);
  const hinge1 = V(0, bellyY(hw, dz1) - 0.003, dz1);
  const hingeDir = hinge1.clone().sub(hinge0).normalize();
  const doors: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'noseDoorHinge.left' : 'noseDoorHinge.right';
    pivot.position.set(side * hw, hinge0.y, hinge0.z);
    pivot.quaternion.setFromUnitVectors(V(0, 0, 1), hingeDir);
    const inv = pivot.quaternion.clone().invert();
    const rings: number[][] = [];
    const n = 16;
    const across = 6;
    for (let i = 0; i <= n; i++) {
      const z = dz0 + ((dz1 - dz0) * i) / n;
      const outer: number[] = [];
      const inner: number[] = [];
      for (let j = 0; j <= across; j++) {
        const x = side * (hw - ((hw - 0.002) * j) / across);
        const y = bellyY(x, z) - 0.003;
        const p = V(x, y, z).sub(pivot.position).applyQuaternion(inv);
        const q = V(x, y + 0.006, z).sub(pivot.position).applyQuaternion(inv);
        outer.push(p.x, p.y, p.z);
        inner.unshift(q.x, q.y, q.z);
      }
      rings.push([...outer, ...inner]);
    }
    const door = cast(new THREE.Mesh(loftGeometry(rings, { capStart: true, capEnd: true }), mats.paint), 'noseDoor');
    const opener = new THREE.Group();
    opener.name = side < 0 ? 'noseDoor.left' : 'noseDoor.right';
    opener.add(door);
    pivot.add(opener);
    doorsGroup.add(pivot);
    doors.push(opener);
  }

  // ── Main gear ──────────────────────────────────────────────────────────────
  interface Main {
    side: -1 | 1;
    leg: THREE.Mesh;
    axle: THREE.Group;
    spin: THREE.Group;
  }
  const mains: Main[] = [];
  const L = MAIN_GEAR.legLength;
  for (const side of [-1, 1] as const) {
    // Leg along local +Y (pivot at 0, foot at L): tapered tube, pivot trunnion, axle fitting, brake line clipped aft.
    // The trunnion lies along the hinge axis (fixed in the leg's frame, since the leg turns about it).
    const hinge = mainGearHinge(side).axis;
    const qRest = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), V(side * MAIN_GEAR.footDown.x, MAIN_GEAR.footDown.y, MAIN_GEAR.footDown.z).sub(V(side * MAIN_GEAR.pivot.x, MAIN_GEAR.pivot.y, MAIN_GEAR.pivot.z)).normalize());
    const hl = V(hinge.x, hinge.y, hinge.z).applyQuaternion(qRest.invert());
    const legParts = [
      tint(tube(V(0, -0.03, 0), V(0, L - 0.02, 0), 0.036, 0.026, 16), PAINT, 0.32, 0.15),
      tint(tube(hl.clone().multiplyScalar(-0.045), hl.clone().multiplyScalar(0.045), 0.024, 0.024, 12), 0x6f7173, 0.5, 0.7),
      tint(box(0.056, 0.07, 0.056, 0, L - 0.035, 0), 0x9a9c9e, 0.45, 0.7),
      tint(tube(V(0.0, 0.08, 0.036), V(0.0, L - 0.08, 0.029), 0.0045, 0.0045, 6), BLACK, 0.55, 0.1),
    ];
    for (const f of [0.3, 0.55, 0.8]) legParts.push(tint(box(0.012, 0.014, 0.012, 0, L * f, 0.033), 0x5c5e60, 0.5, 0.7));
    const legMesh = cast(new THREE.Mesh(merge(legParts), mats.parts), side < 0 ? 'leg.left' : 'leg.right');
    legMesh.position.set(side * MAIN_GEAR.pivot.x, MAIN_GEAR.pivot.y, MAIN_GEAR.pivot.z);
    mainGroups[side < 0 ? 0 : 1].add(legMesh);
    // Axle fitting: stub from the leg foot (inboard) to the wheel, caliper aft-low on the disc, brake-line loop.
    const axle = new THREE.Group();
    axle.name = side < 0 ? GEAR_PART.axleLeft : GEAR_PART.axleRight;
    mainGroups[side < 0 ? 0 : 1].add(axle);
    const st = MAIN_GEAR.stub;
    const hwM = MAIN_GEAR.tyreWidth / 2;
    const fitting = merge([
      tint(tube(V(-side * st, 0, 0), V(0, 0, 0), 0.02, 0.018, 10), STEEL, 0.4, 0.75),
      tint(box(0.045, 0.06, 0.07, -side * (hwM * 0.78 + 0.018), -0.05, 0.075), 0x2f3033, 0.55, 0.45),
      tint(box(0.02, 0.1, 0.03, -side * (hwM * 0.78 + 0.03), -0.02, 0.045), 0x505254, 0.5, 0.7),
      tint(tube(V(-side * (hwM * 0.78 + 0.04), -0.03, 0.1), V(-side * st, 0.02, 0.04), 0.0045, 0.0045, 6), BLACK, 0.55, 0.1),
    ]);
    axle.add(cast(new THREE.Mesh(fitting, mats.parts), side < 0 ? 'axleFitting.left' : 'axleFitting.right'));
    const spin = new THREE.Group();
    spin.name = side < 0 ? 'wheelSpin.left' : 'wheelSpin.right';
    axle.add(spin);
    spin.add(cast(new THREE.Mesh(wheelGeometry(G.mainWheelRadius, MAIN_GEAR.rim, MAIN_GEAR.tyreWidth, 0.088, segs, side), mats.parts), side < 0 ? 'wheel.left' : 'wheel.right'));
    mains.push({ side, leg: legMesh, axle, spin });
  }

  // ── Per-frame rig ──────────────────────────────────────────────────────────
  const mp = createMainGearPose();
  const npz = createNoseGearPose();
  const spinAngle = [0, 0, 0];
  const spinRate = [0, 0, 0];
  const radii = [G.noseWheelRadius, G.mainWheelRadius, G.mainWheelRadius];
  const _b = new THREE.Vector3();
  const _k = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _Y = new THREE.Vector3(0, 1, 0);
  const wrap = (a: number) => a % (Math.PI * 2);

  /** Wreck: a main leg splayed up/out and swept back about its pivot. */
  const _sq = new THREE.Quaternion();
  const _se = new THREE.Euler();
  const _sp = new THREE.Vector3();
  function splay(side: -1 | 1, pose: typeof mp) {
    _sq.setFromEuler(_se.set(0, -side * 0.35, side * 0.5, 'YXZ'));
    _sp.set(side * MAIN_GEAR.pivot.x, MAIN_GEAR.pivot.y, MAIN_GEAR.pivot.z);
    pose.foot.sub(_sp).applyQuaternion(_sq).add(_sp);
    pose.wheel.sub(_sp).applyQuaternion(_sq).add(_sp);
    pose.legQuat.premultiply(_sq);
    pose.axleQuat.premultiply(_sq);
  }

  /** Stretch a unit link mesh (local 0→+Y) from a to b. */
  function link(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) {
    _dir.copy(b).sub(a);
    const len = _dir.length();
    m.position.copy(a);
    if (len > 1e-6) m.quaternion.setFromUnitVectors(_Y, _dir.divideScalar(len));
    m.scale.set(1, Math.max(1e-4, len), 1);
  }

  return {
    group,
    nose: noseGroup,
    mainLeft: mainGroups[0],
    mainRight: mainGroups[1],
    update(anim, v, dt, crashed = false) {
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
      const c = v.wheelCompression;
      const rs = v.wheelRollSpeed;
      // Nose (a wreck's nose leg is folded back under the cowl and twisted).
      if (crashed) {
        noseGearPose(0.62, 0, 0, npz);
        npz.steerRad = 0.45;
        npz.slide = G.strutTravel;
      } else noseGearPose(anim.noseGearRetract, c[0], anim.noseSteerRad, npz);
      noseSwing.rotation.x = npz.swingRad;
      noseSteer.rotation.y = -npz.steerRad;
      noseLower.position.y = npz.slide;
      // Torque links: knee aft of the oleo, solved in the steering frame.
      _b.set(0, crown + 0.012 + npz.slide, 0.055);
      const d = Math.max(1e-4, Math.min(2 * TL - 1e-6, _b.distanceTo(tU)));
      const hk = Math.sqrt(Math.max(0, TL * TL - (d * d) / 4));
      _k.copy(tU).add(_b).multiplyScalar(0.5);
      _k.z += hk;
      link(torqueU, tU, _k);
      link(torqueL, _k, _b);
      link(braceU, anchor, npz.braceKnee);
      link(braceL, npz.braceKnee, npz.braceAttach);
      doors[0].rotation.z = -anim.gearDoorRad;
      doors[1].rotation.z = crashed ? 2.2 : anim.gearDoorRad;
      doors[0].visible = !crashed;
      // Mains.
      for (let i = 0; i < 2; i++) {
        const m = mains[i];
        mainGearPose(m.side, crashed ? 0 : anim.mainGearRetract, crashed ? 0 : c[i + 1], mp);
        if (crashed) splay(m.side, mp);
        m.leg.quaternion.copy(mp.legQuat);
        m.leg.scale.set(1, mp.legScale, 1);
        m.axle.position.copy(mp.wheel);
        m.axle.quaternion.copy(mp.axleQuat);
      }
      // Wheel spin: follows the ground roll while down and locked; the snubbers stop it once the gear moves.
      for (let i = 0; i < 3; i++) {
        const retract = crashed ? 1 : i === 0 ? anim.noseGearRetract : anim.mainGearRetract;
        if (retract > 0) spinRate[i] = retract >= 0.999 ? 0 : spinRate[i] * Math.exp(-step / 0.35);
        else spinRate[i] = Number.isFinite(rs[i]) ? rs[i] / radii[i] : 0;
        spinAngle[i] = wrap(spinAngle[i] - spinRate[i] * step);
      }
      noseSpin.rotation.x = spinAngle[0];
      mains[0].spin.rotation.x = spinAngle[1];
      mains[1].spin.rotation.x = spinAngle[2];
    },
  };
}
