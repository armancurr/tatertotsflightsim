/**
 * The JetRanger's skid gear: two aluminium skid tubes with upturned toes and wear shoes, two arched
 * cross tubes clamped under the belly, saddles and the boarding steps. The skids' bottoms sit
 * exactly on rotorcraft.skids.points (y = −1.25 unloaded).
 *
 * The gear deflects as one mesh (CPU, only when the loads change): each vertex rises by
 * weight(|x|) × the skid lift at its station, where the lift runs linearly (a rigid skid tube)
 * from the front contact (wheelCompression[0]) to the rear contact of its side ([1] left, [2]
 * right). The cross tubes bend: their weight fades to 0 at the belly clamps. A wreck splays the
 * skids outward and flattens the cross tubes.
 */
import * as THREE from 'three';
import { merge, tint } from '../materials';
import { box, tube, V } from '../f16/geom';
import { SKID, fuselageSection, smoothstep } from './shape';

const ALU = 0xc3c7ca;

/** Planar skid tube path at x (toe curling up ahead of SKID.toeZ). */
function skidPath(x: number): THREE.CurvePath<THREE.Vector3> {
  const yc = SKID.y + SKID.tube;
  const path = new THREE.CurvePath<THREE.Vector3>();
  path.add(new THREE.LineCurve3(V(x, yc, SKID.tailZ), V(x, yc, SKID.toeZ)));
  // Toe: a 0.36 m radius bend through 68°, then a short straight.
  const R = 0.36;
  const cz = SKID.toeZ;
  const cy = yc + R;
  const pts: THREE.Vector3[] = [];
  const A = 68 * (Math.PI / 180);
  for (let k = 0; k <= 12; k++) {
    const a = (A * k) / 12;
    pts.push(V(x, cy - R * Math.cos(a), cz - R * Math.sin(a)));
  }
  path.add(new THREE.CatmullRomCurve3(pts, false, 'centripetal'));
  const end = pts[pts.length - 1];
  const dir = V(0, Math.sin(A), -Math.cos(A)).multiplyScalar(0.1);
  path.add(new THREE.LineCurve3(end, end.clone().add(dir)));
  return path;
}

function crossTube(z: number): THREE.BufferGeometry {
  const belly = fuselageSection(z).bottom;
  const x0 = SKID.track;
  const yTop = SKID.y + 2 * SKID.tube;
  const yb = belly - 0.035;
  const pts = [
    V(-x0, yTop - 0.01, z),
    V(-x0 + 0.02, yTop + 0.16, z),
    V(-x0 + 0.1, yb - 0.08, z),
    V(-x0 + 0.3, yb - 0.005, z),
    V(-0.35, yb, z),
    V(0.35, yb, z),
    V(x0 - 0.3, yb - 0.005, z),
    V(x0 - 0.1, yb - 0.08, z),
    V(x0 - 0.02, yTop + 0.16, z),
    V(x0, yTop - 0.01, z),
  ];
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5), 64, 0.043, 12, false);
}

export interface SkidRig {
  mesh: THREE.Mesh;
  /** Lift the skids by the loads (m): front contact, left rear, right rear; `wreck` splays them. */
  update(front: number, left: number, right: number, wreck: boolean): void;
}

export function buildSkidGear(material: THREE.Material, name: string): SkidRig {
  const g: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const x = s * SKID.track;
    g.push(tint(new THREE.TubeGeometry(skidPath(x), 120, SKID.tube, 12, false), ALU, 0.35, 0.6));
    // End plug at the aft end, a rounded cap on the toe.
    g.push(tint(tube(V(x, SKID.y + SKID.tube, SKID.tailZ), V(x, SKID.y + SKID.tube, SKID.tailZ + 0.012), SKID.tube, SKID.tube * 0.8, 12), 0x3a3c3f, 0.6, 0.3));
    // Wear shoes under the contact areas (flush with the tube's bottom).
    for (const z of [SKID.zFront, SKID.zRear]) g.push(tint(box(0.03, 0.01, 0.5, V(x, SKID.y + 0.012, z)), 0x8a8e91, 0.55, 0.6));
    // Saddles where the cross tubes sit on the skids, and the boarding steps.
    for (const z of [SKID.crossFront, SKID.crossRear]) {
      g.push(tint(box(0.1, 0.05, 0.11, V(x, SKID.y + 2 * SKID.tube + 0.005, z)), 0x9aa0a3, 0.45, 0.55));
    }
    g.push(tint(box(0.26, 0.018, 0.13, V(s * (SKID.track - 0.17), SKID.y + 0.25, SKID.crossFront + 0.1)), 0x2b2c2f, 0.8, 0.2));
    g.push(tint(tube(V(s * (SKID.track - 0.04), SKID.y + 0.2, SKID.crossFront + 0.02), V(s * (SKID.track - 0.28), SKID.y + 0.25, SKID.crossFront + 0.1), 0.012, 0.012, 6), ALU, 0.4, 0.6));
    // Belly clamps.
    for (const z of [SKID.crossFront, SKID.crossRear]) {
      const belly = fuselageSection(z).bottom;
      g.push(tint(box(0.1, 0.05, 0.12, V(s * 0.42, belly - 0.02, z)), 0x55595d, 0.5, 0.5));
    }
  }
  for (const z of [SKID.crossFront, SKID.crossRear]) g.push(tint(crossTube(z), ALU, 0.35, 0.6));
  const geo = merge(g);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const base = new Float32Array(pos.array as Float32Array);
  // Per-vertex deflection weight: 1 on the skids, fading to 0 up the cross tubes to the belly.
  const w = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) w[i] = smoothstep(0.5, SKID.track - 0.03, Math.abs(base[i * 3]));
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  geo.computeBoundingSphere();
  geo.boundingSphere!.radius += 0.4;
  let last = [NaN, NaN, NaN, NaN];
  let prevWreck = 0;
  const span = SKID.zRear - SKID.zFront;
  return {
    mesh,
    update(front, left, right, wreck) {
      const f = Number.isFinite(front) ? front : 0;
      const l = Number.isFinite(left) ? left : 0;
      const r = Number.isFinite(right) ? right : 0;
      const k = wreck ? 1 : 0;
      if (f === last[0] && l === last[1] && r === last[2] && k === last[3]) return;
      last = [f, l, r, k];
      const a = pos.array as Float32Array;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        const y = base[i * 3 + 1];
        const z = base[i * 3 + 2];
        const t = (z - SKID.zFront) / span;
        const rear = x < 0 ? l : r;
        let lift = w[i] * (f + (rear - f) * t);
        let dx = 0;
        if (wreck) {
          // Splayed: the cross tubes flattened, the skids spread and the left one twisted.
          lift += w[i] * (0.2 + (x < 0 ? 0.06 * t : 0));
          dx = Math.sign(x) * w[i] * 0.16;
        }
        a[i * 3] = x + dx;
        a[i * 3 + 1] = y + lift;
        a[i * 3 + 2] = z;
      }
      pos.needsUpdate = true;
      // Normals only when the shape really changes (the wreck); a few cm of deflection needs none.
      if (k !== prevWreck) geo.computeVertexNormals();
      prevWreck = k;
    },
  };
}
