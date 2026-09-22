/**
 * Wreck: how the airframe is bent after a crash. PURE point deformations in the
 * body frame (three.js math only) — the model applies them once, lazily, to
 * clones of the static geometries it swaps in while `crashed` is set, plus the
 * matching rigid transforms for the hinged parts:
 *   - the left outer wing folds down (and twists) at the strut attachment,
 *   - the nose/cowling crumples aft and droops (the prop hub goes with it),
 *   - the tailcone bends: the empennage is skewed sideways and sags,
 *   - small dents everywhere in the damaged zones,
 *   - the propeller blades curl aft.
 * The paint chars progressively from the engine back (see `charProgress` and the
 * soot shader hook in materials.ts).
 */
import * as THREE from 'three';
import { wingLEy } from './shape';

const DEG = Math.PI / 180;

export const WRECK = {
  /** Left wing breaks here (|x|, m) and folds tip-down by foldDeg, leading edge twisted down by twistDeg. */
  wingBreak: 2.56,
  foldDeg: 28,
  twistDeg: 9,
  /** Width (m) over which the fold ramps in (a torn, bent zone rather than a hinge). */
  foldBand: 0.12,
  /** Nose crumple: everything ahead of noseZ shortens by noseShorten and droops by noseDroop at the spinner. */
  noseZ: -1.25,
  noseShorten: 0.22,
  noseDroop: 0.1,
  /** Tailcone bend from tailZ0 (starts) to tailZ1 (full): yaw and sag of the empennage. */
  tailZ0: 2.8,
  tailZ1: 4.3,
  tailYawDeg: 13,
  tailSagDeg: 5,
  /** Seconds for the soot to spread over the airframe. */
  charSeconds: 7,
  dent: 0.022,
} as const;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Smooth pseudo-random dent field (continuous, |n| ≤ 1). */
function dentNoise(x: number, y: number, z: number): number {
  return Math.sin(7.1 * x + 3.3 * y + 1.7) * Math.sin(5.3 * z + 2.1 * x - 0.4) * 0.6 + Math.sin(13.7 * z - 9.1 * y + 4.4 * x) * 0.4;
}

const HINGE = new THREE.Vector3(-WRECK.wingBreak, wingLEy(WRECK.wingBreak) + 0.06, 0.3);
const TAIL_PIVOT = new THREE.Vector3(0, 0.1, WRECK.tailZ0);

function foldQuat(a: number, out: THREE.Quaternion): THREE.Quaternion {
  // Tip down on the left wing = rotation about +Z; twist the leading edge down = about −X.
  return out.setFromEuler(_e.set(-WRECK.twistDeg * DEG * a, 0, WRECK.foldDeg * DEG * a, 'ZXY'));
}
function tailQuat(a: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(_e.set(WRECK.tailSagDeg * DEG * a, WRECK.tailYawDeg * DEG * a, 0, 'YXZ'));
}
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Rigid transform of the left outer wing beyond the torn band (for the aileron pivot). */
export function wingFoldTransform(): THREE.Matrix4 {
  const q = foldQuat(1, new THREE.Quaternion());
  return new THREE.Matrix4().makeTranslation(HINGE.x, HINGE.y, HINGE.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-HINGE.x, -HINGE.y, -HINGE.z));
}

/** Rigid transform of the empennage aft of the bend (for the tail groups and hinged surfaces). */
export function tailSkewTransform(): THREE.Matrix4 {
  const q = tailQuat(1, new THREE.Quaternion());
  const P = TAIL_PIVOT;
  return new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
}

/** Where a body-frame airframe point ends up on the wreck (writes `out`, returns it). */
export function deformWreckPoint(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(p);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return out;
  // Left outer wing: fold/twist ramping in across the torn band.
  const fa = smoothstep(WRECK.wingBreak, WRECK.wingBreak + WRECK.foldBand, -p.x);
  if (fa > 0) {
    foldQuat(fa, _q);
    out.sub(HINGE).applyQuaternion(_q).add(HINGE);
    const d = WRECK.dent * fa * smoothstep(WRECK.wingBreak, WRECK.wingBreak + 0.8, -p.x);
    out.y += d * dentNoise(p.x, p.y, p.z);
  }
  // Nose: shorten and droop ahead of the firewall, with dents.
  const t = WRECK.noseZ - p.z;
  if (t > 0) {
    const k = Math.min(t, 1.2);
    out.z += WRECK.noseShorten * k;
    const f = k / 0.75;
    out.y -= WRECK.noseDroop * f * f;
    const d = WRECK.dent * 1.3 * Math.min(1, f);
    out.x += d * dentNoise(p.y, p.z, p.x);
    out.y += d * dentNoise(p.z, p.x, p.y);
  }
  // Tail: bend about the pivot, ramping from tailZ0 to tailZ1 (rigid beyond).
  const ta = smoothstep(WRECK.tailZ0, WRECK.tailZ1, p.z);
  if (ta > 0) {
    tailQuat(ta, _q);
    out.sub(TAIL_PIVOT).applyQuaternion(_q).add(TAIL_PIVOT);
    const d = WRECK.dent * 0.8 * ta * (1 - ta) * 4;
    _v.set(dentNoise(p.z, p.y, p.x), dentNoise(p.x, p.z, p.y), 0).multiplyScalar(d);
    out.add(_v);
  }
  return out;
}

/** Deform a (cloned) body-frame geometry in place and recompute its normals. */
export function deformWreckGeometry(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3 = deformWreckPoint): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const q = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    fn(p.fromBufferAttribute(pos, i), q);
    pos.setXYZ(i, q.x, q.y, q.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * Propeller blades after a ground strike (hub frame: blades along ±Y, −Z forward):
 * one blade curls hard aft, the other bends back less and twists.
 */
export function bendBladePoint(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(p);
  const rho = Math.abs(p.y);
  const f = smoothstep(0.28, 0.96, rho);
  if (f <= 0) return out;
  if (p.y > 0) {
    out.z += 0.34 * f * f;
    out.y -= 0.12 * f * f;
    out.x += 0.05 * f;
  } else {
    out.z += 0.14 * f * f;
    out.y += 0.04 * f * f;
    out.x -= 0.09 * f * f;
  }
  return out;
}

/** Soot coverage progress 0 → 1 over WRECK.charSeconds after the crash. */
export function charProgress(crashAge: number): number {
  if (Number.isNaN(crashAge)) return 0;
  const t = Math.min(1, Math.max(0, crashAge / WRECK.charSeconds));
  return t * t * (3 - 2 * t);
}
