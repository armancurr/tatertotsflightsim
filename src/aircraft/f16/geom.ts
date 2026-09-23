/**
 * Small geometry helpers for the F-16 builders: tubes, boxes, lathes, airfoil pieces, mirroring,
 * and moving a geometry into a hinge's local frame.
 */
import * as THREE from 'three';

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);

/** Cylinder / cone from a to b (radius r0 at a, r1 at b). */
export function tube(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, segs = 10, open = false): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), segs, 1, open);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Box centred at c, optionally rotated (Euler XYZ, radians). */
export function box(w: number, h: number, d: number, c: THREE.Vector3, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(c.x, c.y, c.z);
  return g;
}

/** Ellipsoid centred at c with radii (rx, ry, rz). */
export function ellipsoid(c: THREE.Vector3, rx: number, ry: number, rz: number, ws = 16, hs = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(c.x, c.y, c.z);
  return g;
}

/** Lathe about the local X axis (a wheel/tyre: profile [radius, x] pairs), centred at c. */
export function wheelLathe(profile: [number, number][], segs: number, c: THREE.Vector3): THREE.BufferGeometry {
  const pts = profile.map(([r, x]) => new THREE.Vector2(r, x));
  const g = new THREE.LatheGeometry(pts, segs);
  // Lathe axis is +Y: turn it to +X.
  g.rotateZ(-Math.PI / 2);
  g.translate(c.x, c.y, c.z);
  return g;
}

/**
 * 2D airfoil piece between chord fractions a..b (0 = LE, 1 = TE), flat cuts where a > 0 or b < 1.
 * Ring order: upper surface a→b, cut down, lower surface b→a, cut up. Flat [x, y, …].
 */
export function airfoilPiece(t: number, m: number, p: number, a: number, b: number, n: number, thicknessScale = 1): number[] {
  const thick = (x: number) =>
    5 * t * thicknessScale * (0.2969 * Math.sqrt(Math.max(0, x)) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const camber = (x: number) => (m === 0 ? 0 : x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x));
  const xs: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = k / (n - 1);
    // Dense at the leading edge (cosine) when the piece includes it, else uniform-ish.
    const f = a === 0 ? 0.5 - 0.5 * Math.cos(s * Math.PI) : s;
    xs.push(a + (b - a) * f);
  }
  const out: number[] = [];
  const minHalf = 0.0012;
  const up = (x: number) => camber(x) + Math.max(minHalf, thick(x));
  const lo = (x: number) => camber(x) - Math.max(minHalf, thick(x));
  for (let k = 0; k < n; k++) out.push(xs[k], up(xs[k]));
  if (b < 1) out.push(b, up(b), b, lo(b));
  for (let k = n - 1; k >= (a === 0 ? 1 : 0); k--) out.push(xs[k], lo(xs[k]));
  if (a > 0) out.push(a, lo(a), a, up(a));
  return out;
}

/** Mirror a geometry across x = 0 (positions, normals and winding). */
export function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.clone();
  g.scale(-1, 1, 1);
  const idx = g.getIndex();
  if (idx) {
    const a = idx.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  return g;
}

/** Express a geometry given in body coordinates in a hinge frame at `pos` with orientation `quat`. */
export function toLocal(g: THREE.BufferGeometry, pos: THREE.Vector3, quat: THREE.Quaternion): THREE.BufferGeometry {
  g.translate(-pos.x, -pos.y, -pos.z);
  g.applyQuaternion(quat.clone().invert());
  return g;
}

/** Quaternion whose local +X runs along `axis` and local +Y is as close to `up` as possible. */
export function hingeFrame(axis: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)): THREE.Quaternion {
  const x = axis.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Pivot → rotating child, positioned/oriented in body coordinates. */
export function makeHinge(name: string, pos: THREE.Vector3, quat: THREE.Quaternion): { pivot: THREE.Group; rot: THREE.Group } {
  const pivot = new THREE.Group();
  pivot.name = `${name}.pivot`;
  pivot.position.copy(pos);
  pivot.quaternion.copy(quat);
  const rot = new THREE.Group();
  rot.name = name;
  pivot.add(rot);
  return { pivot, rot };
}

/** Recompute smooth normals, keeping only position/normal/uv, and ensure an index. */
export function finish(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color', 'rm'].includes(name)) g.deleteAttribute(name);
  if (!g.index) {
    const n = g.getAttribute('position').count;
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}
