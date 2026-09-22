/**
 * A small procedural mesh builder for traffic models. Every vertex carries
 * position, normal, linear colour and `aPbr` = (roughness, metalness, tint
 * mask, luff weight) so ONE PBR material (instanced via BatchedMesh) can draw
 * every hull, sail, deck, window and fuselage in a single call:
 *   - tint 1 → the colour is multiplied by the instance colour (livery / hull paint),
 *   - luff > 0 → the vertex flutters along its normal (sails).
 * A transform stack positions parts. Output: an indexed BufferGeometry.
 */
import * as THREE from 'three';

export interface Mat {
  /** Linear RGB. */
  c: [number, number, number];
  r: number;
  m: number;
  /** 1 = multiplied by the instance colour. */
  t?: number;
  /** Sail flutter weight. */
  l?: number;
}

const _c = new THREE.Color();
/** sRGB hex → linear RGB triple. */
export const lin = (hex: number): [number, number, number] => {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
};
export const mat = (hex: number, r: number, m = 0, t = 0, l = 0): Mat => ({ c: lin(hex), r, m, t, l });

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class MeshBuilder {
  readonly P: number[] = [];
  readonly N: number[] = [];
  readonly C: number[] = [];
  readonly A: number[] = [];
  readonly I: number[] = [];
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  private nstack: THREE.Matrix3[] = [new THREE.Matrix3()];

  get vertexCount(): number {
    return this.P.length / 3;
  }

  get triangleCount(): number {
    return this.I.length / 3;
  }

  /** Pushes a transform (composed with the current one). */
  push(m: THREE.Matrix4): this {
    const top = this.stack[this.stack.length - 1].clone().multiply(m);
    this.stack.push(top);
    this.nstack.push(new THREE.Matrix3().getNormalMatrix(top));
    return this;
  }

  pop(): this {
    if (this.stack.length > 1) {
      this.stack.pop();
      this.nstack.pop();
    }
    return this;
  }

  /** Runs `fn` with a translation/rotation(YXZ, deg)/scale pushed. */
  with(pos: [number, number, number], rotDeg: [number, number, number] | null, fn: () => void, scale?: [number, number, number]): this {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(...pos),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(((rotDeg?.[0] ?? 0) * Math.PI) / 180, ((rotDeg?.[1] ?? 0) * Math.PI) / 180, ((rotDeg?.[2] ?? 0) * Math.PI) / 180, 'YXZ')),
      new THREE.Vector3(...(scale ?? [1, 1, 1])),
    );
    this.push(m);
    fn();
    this.pop();
    return this;
  }

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, m: Mat, luff = m.l ?? 0): number {
    _v.set(x, y, z).applyMatrix4(this.stack[this.stack.length - 1]);
    _n.set(nx, ny, nz).applyMatrix3(this.nstack[this.nstack.length - 1]).normalize();
    this.P.push(_v.x, _v.y, _v.z);
    this.N.push(_n.x, _n.y, _n.z);
    this.C.push(m.c[0], m.c[1], m.c[2]);
    this.A.push(m.r, m.m, m.t ?? 0, luff);
    return this.P.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): this {
    this.I.push(a, b, c);
    return this;
  }

  quad(a: number, b: number, c: number, d: number): this {
    this.I.push(a, b, c, a, c, d);
    return this;
  }

  /** A flat polygon (convex, counter-clockwise seen from the normal side). */
  poly(pts: [number, number, number][], m: Mat): this {
    const a = new THREE.Vector3(...pts[0]);
    const b = new THREE.Vector3(...pts[1]);
    const c = new THREE.Vector3(...pts[2]);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    const ids = pts.map((p) => this.vertex(p[0], p[1], p[2], n.x, n.y, n.z, m));
    for (let i = 1; i < ids.length - 1; i++) this.tri(ids[0], ids[i], ids[i + 1]);
    return this;
  }

  /** Axis-aligned box centred at (cx, cy, cz). Faces can be skipped (e.g. hidden bottoms). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, m: Mat, skip: { top?: boolean; bottom?: boolean; front?: boolean; back?: boolean } = {}): this {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const f = (p: [number, number, number][], n: [number, number, number]) => {
      const ids = p.map((q) => this.vertex(q[0], q[1], q[2], n[0], n[1], n[2], m));
      this.quad(ids[0], ids[1], ids[2], ids[3]);
    };
    f([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]);
    f([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]);
    if (!skip.top) f([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]);
    if (!skip.bottom) f([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]);
    if (!skip.back) f([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]);
    if (!skip.front) f([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]);
    return this;
  }

  /**
   * A tapered block from y0 to y1: bottom footprint (w0 × d0) centred at (cx, cz), top footprint
   * (w1 × d1) shifted by `dz` along z (a raked front/back). Sides flat-shaded; top closed.
   */
  prism(cx: number, cz: number, y0: number, y1: number, w0: number, d0: number, w1: number, d1: number, m: Mat, dz = 0, top = true): this {
    const b: [number, number, number][] = [
      [cx - w0 / 2, y0, cz + d0 / 2],
      [cx + w0 / 2, y0, cz + d0 / 2],
      [cx + w0 / 2, y0, cz - d0 / 2],
      [cx - w0 / 2, y0, cz - d0 / 2],
    ];
    const t: [number, number, number][] = [
      [cx - w1 / 2, y1, cz + dz + d1 / 2],
      [cx + w1 / 2, y1, cz + dz + d1 / 2],
      [cx + w1 / 2, y1, cz + dz - d1 / 2],
      [cx - w1 / 2, y1, cz + dz - d1 / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.poly([b[i], b[j], t[j], t[i]], m);
    }
    if (top) this.poly([t[0], t[1], t[2], t[3]], m);
    return this;
  }

  /** Cylinder / cone frustum from A to B (smooth sides). */
  cylinder(a: [number, number, number], b: [number, number, number], r0: number, r1: number, segs: number, m: Mat, caps = true): this {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const axis = B.clone().sub(A);
    const len = axis.length();
    if (len < 1e-6) return this;
    axis.normalize();
    const u = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(axis).normalize() : new THREE.Vector3(1, 0, 0).cross(axis).normalize();
    const v = axis.clone().cross(u).normalize();
    const slope = (r0 - r1) / len;
    const ring0: number[] = [];
    const ring1: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * Math.PI * 2;
      const dx = Math.cos(t);
      const dy = Math.sin(t);
      const nx = u.x * dx + v.x * dy + axis.x * slope;
      const ny = u.y * dx + v.y * dy + axis.y * slope;
      const nz = u.z * dx + v.z * dy + axis.z * slope;
      const nl = Math.hypot(nx, ny, nz) || 1;
      ring0.push(this.vertex(A.x + (u.x * dx + v.x * dy) * r0, A.y + (u.y * dx + v.y * dy) * r0, A.z + (u.z * dx + v.z * dy) * r0, nx / nl, ny / nl, nz / nl, m));
      ring1.push(this.vertex(B.x + (u.x * dx + v.x * dy) * r1, B.y + (u.y * dx + v.y * dy) * r1, B.z + (u.z * dx + v.z * dy) * r1, nx / nl, ny / nl, nz / nl, m));
    }
    for (let i = 0; i < segs; i++) this.quad(ring0[i], ring0[i + 1], ring1[i + 1], ring1[i]);
    if (caps) {
      if (r1 > 1e-4) {
        const c = this.vertex(B.x, B.y, B.z, axis.x, axis.y, axis.z, m);
        const ids: number[] = [];
        for (let i = 0; i <= segs; i++) {
          const t = (i / segs) * Math.PI * 2;
          ids.push(this.vertex(B.x + (u.x * Math.cos(t) + v.x * Math.sin(t)) * r1, B.y + (u.y * Math.cos(t) + v.y * Math.sin(t)) * r1, B.z + (u.z * Math.cos(t) + v.z * Math.sin(t)) * r1, axis.x, axis.y, axis.z, m));
        }
        for (let i = 0; i < segs; i++) this.tri(c, ids[i], ids[i + 1]);
      }
      if (r0 > 1e-4) {
        const c = this.vertex(A.x, A.y, A.z, -axis.x, -axis.y, -axis.z, m);
        const ids: number[] = [];
        for (let i = 0; i <= segs; i++) {
          const t = (i / segs) * Math.PI * 2;
          ids.push(this.vertex(A.x + (u.x * Math.cos(t) + v.x * Math.sin(t)) * r0, A.y + (u.y * Math.cos(t) + v.y * Math.sin(t)) * r0, A.z + (u.z * Math.cos(t) + v.z * Math.sin(t)) * r0, -axis.x, -axis.y, -axis.z, m));
        }
        for (let i = 0; i < segs; i++) this.tri(c, ids[i + 1], ids[i]);
      }
    }
    return this;
  }

  /**
   * A lofted surface through rings of points (all rings the same length, each ring ordered
   * counter-clockwise when looking along the loft direction from its start so normals face out).
   * Smooth normals from the grid; `matAt(i, j)` picks the material of quad (ring i, point j).
   * `closed` connects the last point of each ring back to the first.
   */
  loft(rings: [number, number, number][][], matAt: (i: number, j: number) => Mat, closed = true, flip = false): this {
    const nr = rings.length;
    const np = rings[0].length;
    const pos = (i: number, j: number) => rings[Math.max(0, Math.min(nr - 1, i))][closed ? ((j % np) + np) % np : Math.max(0, Math.min(np - 1, j))];
    const normals: THREE.Vector3[][] = [];
    const du = new THREE.Vector3();
    const dv = new THREE.Vector3();
    for (let i = 0; i < nr; i++) {
      normals.push([]);
      for (let j = 0; j < np; j++) {
        const a = pos(i + 1, j);
        const b = pos(i - 1, j);
        const c = pos(i, j + 1);
        const d = pos(i, j - 1);
        du.set(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        dv.set(c[0] - d[0], c[1] - d[1], c[2] - d[2]);
        // same orientation as the quad winding (i→i+1 then j→j+1): du × dv
        const n = du.clone().cross(dv);
        if (n.lengthSq() < 1e-12) {
          // degenerate (e.g. a pointed nose ring): use the radial direction from the ring centre
          const ring = rings[i];
          const cx = ring.reduce((s, p) => s + p[0], 0) / np;
          const cy = ring.reduce((s, p) => s + p[1], 0) / np;
          const cz = ring.reduce((s, p) => s + p[2], 0) / np;
          n.set(ring[j][0] - cx, ring[j][1] - cy, ring[j][2] - cz);
          if (n.lengthSq() < 1e-12) n.copy(du).normalize().multiplyScalar(i === 0 ? -1 : 1);
        }
        n.normalize();
        if (flip) n.negate();
        normals[i].push(n);
      }
    }
    const jmax = closed ? np : np - 1;
    for (let i = 0; i < nr - 1; i++)
      for (let j = 0; j < jmax; j++) {
        const j1 = (j + 1) % np;
        const m = matAt(i, j);
        const q = [
          [i, j],
          [i + 1, j],
          [i + 1, j1],
          [i, j1],
        ].map(([a, b]) => {
          const p = rings[a][b];
          const n = normals[a][b];
          return this.vertex(p[0], p[1], p[2], n.x, n.y, n.z, m);
        });
        if (flip) this.quad(q[0], q[3], q[2], q[1]);
        else this.quad(q[0], q[1], q[2], q[3]);
      }
    return this;
  }

  /** Appends another builder's output (already in its own coordinates, transformed by the current stack). */
  append(o: MeshBuilder): this {
    const base = this.vertexCount;
    for (let k = 0; k < o.P.length / 3; k++) {
      const a = o.A;
      this.vertex(o.P[k * 3], o.P[k * 3 + 1], o.P[k * 3 + 2], o.N[k * 3], o.N[k * 3 + 1], o.N[k * 3 + 2], { c: [o.C[k * 3], o.C[k * 3 + 1], o.C[k * 3 + 2]], r: a[k * 4], m: a[k * 4 + 1], t: a[k * 4 + 2] }, a[k * 4 + 3]);
    }
    for (const i of o.I) this.I.push(base + i);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aPbr', new THREE.Float32BufferAttribute(this.A, 4));
    g.setIndex(this.I);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
