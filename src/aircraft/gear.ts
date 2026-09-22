/**
 * 172RG retractable tricycle gear.
 *
 * Nose: oleo strut on a pivot in the lower cowl; the leg swings aft into its
 * well, the lower strut slides up with compression and steers; two clamshell
 * doors open while the gear is out. Mains: tubular spring-steel legs that
 * swing aft and inward into the belly wells, the wheels turning flat as they
 * go; compression lifts the axle straight up (the leg flexes to follow).
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AircraftAnimation } from './animate';
import type { AircraftVisualState } from './types';
import { GEAR, fuselageSection, type SectionParams } from './shape';
import { merge, tint, type AircraftMaterials } from './materials';
import { loftGeometry } from './loft';

const G = CONFIG.aircraft.geometry;

export const GEAR_PART = {
  axleNose: 'axle.nose',
  axleLeft: 'axle.left',
  axleRight: 'axle.right',
} as const;

export interface GearRig {
  group: THREE.Group;
  update(anim: AircraftAnimation, v: AircraftVisualState, dt: number): void;
}

// ─── Wheels ──────────────────────────────────────────────────────────────────

/** Tyre + hub (+ brake disc on mains), axle along X, centred on the origin. */
function wheelGeometry(R: number, rim: number, width: number, brake: number, segs: number): THREE.BufferGeometry {
  // Tyre cross-section: a boxy superellipse from the rim bead round the tread.
  const prof: THREE.Vector2[] = [];
  const rc = (R + rim) / 2 + 0.01;
  const hr = R - rc;
  const hw = width / 2;
  prof.push(new THREE.Vector2(rim + 0.004, -hw * 0.72));
  const k = 16;
  for (let i = 0; i <= k; i++) {
    const phi = -Math.PI / 2 + (Math.PI * i) / k;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const e = 2 / 3.2;
    prof.push(new THREE.Vector2(rc + hr * Math.sign(c) * Math.pow(Math.abs(c), e) * 1.0, hw * Math.sign(s) * Math.pow(Math.abs(s), e)));
  }
  prof.push(new THREE.Vector2(rim + 0.004, hw * 0.72));
  const tyre = new THREE.LatheGeometry(prof, segs);
  // Hub: rim flange, dished wheel half and a centre cap (both faces).
  const hubProf = [
    new THREE.Vector2(0.001, -hw * 0.62),
    new THREE.Vector2(0.03, -hw * 0.62),
    new THREE.Vector2(0.045, -hw * 0.52),
    new THREE.Vector2(rim * 0.8, -hw * 0.5),
    new THREE.Vector2(rim + 0.008, -hw * 0.66),
    new THREE.Vector2(rim + 0.01, -hw * 0.6),
    new THREE.Vector2(rim, -hw * 0.4),
    new THREE.Vector2(rim, hw * 0.4),
    new THREE.Vector2(rim + 0.01, hw * 0.6),
    new THREE.Vector2(rim + 0.008, hw * 0.66),
    new THREE.Vector2(rim * 0.8, hw * 0.5),
    new THREE.Vector2(0.045, hw * 0.52),
    new THREE.Vector2(0.03, hw * 0.62),
    new THREE.Vector2(0.001, hw * 0.62),
  ];
  const hub = new THREE.LatheGeometry(hubProf, Math.max(12, segs / 2));
  const parts = [tint(tyre, 0x1c1c1e, 0.82, 0), tint(hub, 0xd8d9d6, 0.4, 0.3)];
  if (brake > 0) {
    const disc = new THREE.CylinderGeometry(brake, brake, 0.01, 24);
    disc.translate(0, -hw * 0.75, 0);
    parts.push(tint(disc, 0x55575a, 0.45, 0.8));
  }
  const g = merge(parts);
  g.rotateZ(-Math.PI / 2); // lathe axis (Y) → axle (X)
  return g;
}

/** A tube from a to b (radius ra at a, rb at b). */
function tube(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, segs = 12): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(rb, ra, d.length(), segs, 1);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export function buildGear(mats: AircraftMaterials, quality: 'high' | 'low'): GearRig {
  const group = new THREE.Group();
  group.name = 'gear';
  const segs = quality === 'high' ? 40 : 24;
  const cast = (m: THREE.Mesh) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // ── Nose gear ──────────────────────────────────────────────────────────────
  const np = V(GEAR.nosePivot.x, GEAR.nosePivot.y, GEAR.nosePivot.z);
  const axleY = GEAR.noseAxle.y - np.y; // axle below the pivot (negative)
  const noseSwing = new THREE.Group();
  noseSwing.position.copy(np);
  group.add(noseSwing);
  const upper = merge([
    tint(tube(V(0, 0.04, 0), V(0, -0.34, 0), 0.04, 0.036, 16), 0xcfd0cc, 0.45, 0.2),
    tint(box(0.11, 0.05, 0.08, 0, 0.02, 0), 0x8a8c8e, 0.5, 0.6),
    // Drag brace to the firewall and the shimmy damper.
    tint(tube(V(0, -0.2, 0.02), V(0, 0.02, 0.26), 0.014, 0.014, 8), 0x9a9c9e, 0.45, 0.7),
    tint(tube(V(0.045, -0.12, 0), V(0.05, -0.02, -0.14), 0.012, 0.012, 8), 0x7c7e80, 0.4, 0.7),
  ]);
  noseSwing.add(cast(new THREE.Mesh(upper, mats.parts)));
  const noseSteer = new THREE.Group();
  noseSwing.add(noseSteer);
  const noseLower = new THREE.Group();
  noseSteer.add(noseLower);
  const crown = axleY + 0.2;
  const forkW = GEAR.noseTyreWidth / 2 + 0.018;
  const lowerGeo = merge([
    tint(tube(V(0, -0.22, 0), V(0, crown, 0), 0.024, 0.024, 16), 0xe6e8ea, 0.12, 1.0),
    tint(box(forkW * 2 + 0.02, 0.035, 0.07, 0, crown, 0), 0x8c8e90, 0.45, 0.6),
    tint(box(0.012, 0.23, 0.05, forkW, crown - 0.1, 0), 0x8c8e90, 0.45, 0.6),
    tint(box(0.012, 0.23, 0.05, -forkW, crown - 0.1, 0), 0x8c8e90, 0.45, 0.6),
    // Torque links (scissors) behind the oleo.
    tint(tube(V(0, -0.27, 0.035), V(0, crown + 0.1, 0.075), 0.008, 0.008, 6), 0x6a6c6e, 0.45, 0.7),
    tint(tube(V(0, crown + 0.1, 0.075), V(0, crown + 0.01, 0.03), 0.008, 0.008, 6), 0x6a6c6e, 0.45, 0.7),
    tint(tube(V(-forkW - 0.01, axleY, 0), V(forkW + 0.01, axleY, 0), 0.012, 0.012, 8), 0x9a9c9e, 0.3, 0.9),
  ]);
  noseLower.add(cast(new THREE.Mesh(lowerGeo, mats.parts)));
  const noseAxle = new THREE.Group();
  noseAxle.name = GEAR_PART.axleNose;
  noseAxle.position.set(GEAR.noseAxle.x - np.x, axleY, GEAR.noseAxle.z - np.z);
  noseLower.add(noseAxle);
  const noseSpin = new THREE.Group();
  noseAxle.add(noseSpin);
  noseSpin.add(cast(new THREE.Mesh(wheelGeometry(G.noseWheelRadius, 0.064, GEAR.noseTyreWidth, 0, segs), mats.parts)));

  // Nose doors: clamshells along the belly under the cowling, curved to the belly line.
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
  const dz0 = -1.33;
  const dz1 = -0.37;
  const b0 = fuselageSection(dz0, sec).bottom;
  const b1 = fuselageSection(dz1, sec).bottom;
  const hinge0 = V(0, b0 - 0.004, dz0);
  const hinge1 = V(0, b1 - 0.004, dz1);
  const hingeDir = hinge1.clone().sub(hinge0).normalize();
  const doors: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.125, hinge0.y, hinge0.z);
    pivot.quaternion.setFromUnitVectors(V(0, 0, 1), hingeDir);
    const inv = pivot.quaternion.clone().invert();
    // Plate: rings across the door (hinge → inner edge) at stations along the belly, 5 mm thick.
    const rings: number[][] = [];
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const z = dz0 + ((dz1 - dz0) * i) / n;
      const yb = fuselageSection(z, sec).bottom - 0.004;
      const ring: number[] = [];
      for (const [dx, dy] of [[0, 0], [-0.122, 0], [-0.122, 0.005], [0, 0.005]]) {
        const p = V(side * 0.125 + side * dx, yb + dy, z).sub(pivot.position).applyQuaternion(inv);
        ring.push(p.x, p.y, p.z);
      }
      rings.push(ring);
    }
    const door = cast(new THREE.Mesh(loftGeometry(rings, { capStart: true, capEnd: true }), mats.paint));
    // The opener turns about the pivot's local Z (the hinge line); the pivot keeps the hinge alignment.
    const opener = new THREE.Group();
    opener.add(door);
    pivot.add(opener);
    group.add(pivot);
    doors.push(opener);
  }

  // ── Main gear ──────────────────────────────────────────────────────────────
  interface Main {
    swing: THREE.Group;
    qSwing: THREE.Quaternion;
    aim: THREE.Group;
    inner: THREE.Group;
    D: THREE.Vector3;
    Dlen: number;
    Dn: THREE.Vector3;
    axle: THREE.Group;
    axleRel: THREE.Vector3;
    qMount: THREE.Quaternion;
    spin: THREE.Group;
  }
  const mains: Main[] = [];
  const mainWheel = wheelGeometry(G.mainWheelRadius, 0.078, GEAR.mainTyreWidth, 0.085, segs);
  for (const side of [-1, 1] as const) {
    const P = V(side * GEAR.mainPivot.x, GEAR.mainPivot.y, GEAR.mainPivot.z);
    const A = V(side * GEAR.mainAxle.x, GEAR.mainAxle.y, GEAR.mainAxle.z);
    const S = V(side * GEAR.mainStowed.x, GEAR.mainStowed.y, GEAR.mainStowed.z);
    const Ain = A.clone().add(V(-side * 0.1, 0.0, 0));
    const swing = new THREE.Group();
    swing.position.copy(P);
    group.add(swing);
    const qSwing = new THREE.Quaternion().setFromUnitVectors(A.clone().sub(P).normalize(), S.clone().sub(P).normalize());
    const aim = new THREE.Group();
    swing.add(aim);
    const D = Ain.clone().sub(P);
    const inner = new THREE.Group();
    inner.quaternion.setFromUnitVectors(V(0, 1, 0), D.clone().normalize());
    aim.add(inner);
    const L = D.length();
    const legGeo = merge([
      tint(tube(V(0, -0.02, 0), V(0, L, 0), 0.038, 0.027, 14), 0xd4d5d1, 0.4, 0.25),
      tint(box(0.07, 0.06, 0.07, 0, 0.0, 0), 0x77797b, 0.5, 0.6),
    ]);
    inner.add(cast(new THREE.Mesh(legGeo, mats.parts)));
    // Axle stub from the leg foot into the wheel (static in the swing frame, follows via the axle group).
    const axle = new THREE.Group();
    axle.name = side < 0 ? GEAR_PART.axleLeft : GEAR_PART.axleRight;
    const axleRel = A.clone().sub(P);
    axle.position.copy(axleRel);
    swing.add(axle);
    const stub = tint(tube(V(-side * 0.11, 0, 0), V(0, 0, 0), 0.02, 0.02, 10), 0x88898b, 0.4, 0.7);
    const caliper = tint(box(0.03, 0.05, 0.05, -side * 0.065, -0.07, 0.06), 0x333436, 0.5, 0.5);
    axle.add(cast(new THREE.Mesh(merge([stub, caliper]), mats.parts)));
    const spin = new THREE.Group();
    axle.add(spin);
    spin.add(cast(new THREE.Mesh(mainWheel.clone(), mats.parts)));
    // Stowed wheel orientation: lying flat in the belly (axle vertical).
    const target = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), side * (Math.PI / 2));
    const qMount = qSwing.clone().invert().multiply(target);
    mains.push({ swing, qSwing, aim, inner, D, Dlen: L, Dn: D.clone().normalize(), axle, axleRel, qMount, spin });
  }
  mainWheel.dispose();

  const _I = new THREE.Quaternion();
  const _d = new THREE.Vector3();
  const spinAngle = [0, 0, 0];
  const travel = G.strutTravel;
  const comp = (c: number) => (Number.isFinite(c) ? Math.min(travel, Math.max(0, c)) : 0);
  const wrap = (a: number) => a % (Math.PI * 2);

  return {
    group,
    update(anim, v, dt) {
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
      const down = 1 - Math.max(anim.noseGearRetract, anim.mainGearRetract);
      // Nose
      noseSwing.rotation.x = anim.noseGearAngleRad;
      noseSteer.rotation.y = -anim.noseSteerRad;
      noseLower.position.y = comp(v.wheelCompression[0]) * down;
      const rs = v.wheelRollSpeed;
      const sp0 = Number.isFinite(rs[0]) ? rs[0] : 0;
      spinAngle[0] = wrap(spinAngle[0] - (sp0 / G.noseWheelRadius) * step);
      noseSpin.rotation.x = spinAngle[0];
      doors[0].rotation.z = -anim.gearDoorRad;
      doors[1].rotation.z = anim.gearDoorRad;
      // Mains
      for (let i = 0; i < 2; i++) {
        const m = mains[i];
        const c = comp(v.wheelCompression[i + 1]) * down;
        m.swing.quaternion.slerpQuaternions(_I, m.qSwing, anim.mainGearRetract);
        _d.copy(m.D);
        _d.y += c;
        const len = _d.length();
        _d.divideScalar(len);
        m.aim.quaternion.setFromUnitVectors(m.Dn, _d);
        m.inner.scale.y = len / m.Dlen;
        m.axle.position.copy(m.axleRel);
        m.axle.position.y += c;
        m.axle.quaternion.slerpQuaternions(_I, m.qMount, anim.mainGearRetract);
        const spd = Number.isFinite(rs[i + 1]) ? rs[i + 1] : 0;
        spinAngle[i + 1] = wrap(spinAngle[i + 1] - (spd / G.mainWheelRadius) * step);
        m.spin.rotation.x = spinAngle[i + 1];
      }
    },
  };
}
