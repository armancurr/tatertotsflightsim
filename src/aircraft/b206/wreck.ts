/**
 * The JetRanger after a crash (PURE point deformations and rigid transforms, three.js math only).
 * The model applies them lazily to clones of its static geometry while `crashed` is set:
 *   - the nose and the chin crumple aft and down, the belly is pushed in, dents everywhere;
 *   - the tail boom is bent down and to the right just aft of the joint (the tail rotor goes with it);
 *   - one main blade folds down and back where it struck the ground, the other is broken off
 *     half-way; the rotor head is tipped over on its mast;
 *   - the skids splay (gear.ts).
 */
import * as THREE from 'three';
import { Z_JOINT } from './shape';

const DEG = Math.PI / 180;

export const B206_WRECK = {
  /** Nose crumple ahead of noseZ: shortening and droop at the tip. */
  noseZ: -1.95,
  noseShorten: 0.2,
  noseDroop: 0.08,
  /** Belly pushed in by up to this much (m). */
  bellyPush: 0.07,
  /** Tail boom bend about a pivot just aft of the joint. */
  boomPivot: { y: 0.2, z: Z_JOINT + 0.35 },
  boomYawDeg: -11,
  boomSagDeg: 7,
  boomRollDeg: 6,
  /** Rotor head tipped over (tip-path-plane frame rotation, rad). */
  headTilt: { x: 0.2, z: -0.28 },
  dent: 0.02,
} as const;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function dentNoise(x: number, y: number, z: number): number {
  return Math.sin(7.3 * x + 3.1 * y + 1.3) * Math.sin(5.7 * z + 2.3 * x - 0.6) * 0.6 + Math.sin(12.9 * z - 8.7 * y + 4.1 * x) * 0.4;
}

/** Where a body-frame point of the cabin/fuselage ends up on the wreck. */
export function crumpleFuselagePoint(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(p);
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return out;
  const W = B206_WRECK;
  const t = W.noseZ - p.z;
  if (t > 0) {
    const k = Math.min(t, 0.7) / 0.7;
    out.z += W.noseShorten * k;
    out.y -= W.noseDroop * k * k;
    const d = W.dent * 2 * k;
    out.x += d * dentNoise(p.y, p.z, p.x);
    out.y += d * dentNoise(p.z, p.x, p.y);
  }
  // Belly pushed up (a hard, level-ish impact), strongest under the cabin.
  const b = smoothstep(-0.5, -0.8, p.y) * smoothstep(1.2, 0.2, p.z) * smoothstep(-2.6, -1.8, p.z);
  if (b > 0) out.y += W.bellyPush * b * (0.7 + 0.3 * dentNoise(p.x, p.z, 0.3));
  // Small dents over the whole cabin.
  const e = W.dent * 0.5 * smoothstep(2, 0, p.z);
  out.x += e * dentNoise(p.x * 1.7, p.y, p.z);
  out.y += e * dentNoise(p.z, p.x * 1.3, p.y) * 0.5;
  return out;
}

/** Rigid transform of the tail boom (and the tail rotor) on the wreck. */
export function boomBendTransform(): THREE.Matrix4 {
  const W = B206_WRECK;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-W.boomSagDeg * DEG, W.boomYawDeg * DEG, W.boomRollDeg * DEG, 'YXZ'));
  const P = new THREE.Vector3(0, W.boomPivot.y, W.boomPivot.z);
  return new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(q)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
}

/**
 * Main blades on the wreck (blade frame: span +x, trailing edge +z). Blade 0 folded down and back
 * outboard of ~1.3 m; blade 1 broken off at ~2.4 m with a bent, splintered stub.
 */
export function wreckBladePoint(blade: 0 | 1, p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  out.copy(p);
  const r = p.x;
  if (blade === 0) {
    const f = smoothstep(1.1, 4.8, r);
    const a = 55 * DEG * f;
    // Fold about a line at r = 1.2: down and aft.
    const d = Math.max(0, r - 1.2);
    out.x = 1.2 + (r > 1.2 ? d * Math.cos(a) : r - 1.2);
    out.y = p.y - d * Math.sin(a) * 0.75;
    out.z = p.z + d * Math.sin(a) * 0.55 + 0.03 * Math.sin(r * 3.1);
    if (r <= 1.2) out.x = r;
  } else {
    const cut = 2.4;
    if (r > cut) {
      out.x = cut + (r - cut) * 0.015;
      out.y = p.y * 0.4 + 0.02 * Math.sin(p.z * 40);
      out.z = p.z * 0.9;
    }
    const f = smoothstep(0.9, cut, Math.min(r, cut));
    out.y += 0.18 * f * f;
    out.z -= 0.12 * f * f;
  }
  return out;
}

/** Deform a (cloned) geometry in place with a point function and recompute its normals. */
export function deformGeometry(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, out: THREE.Vector3) => THREE.Vector3): THREE.BufferGeometry {
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
