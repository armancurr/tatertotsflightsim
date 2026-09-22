/**
 * A small merged-geometry builder for the airport's static meshes (structures,
 * parked aircraft, cars). Every primitive is emitted in the builder's current
 * local frame (a transform stack), with per-vertex colour, material id, UV in
 * metres, livery accent flag, roughness/metalness and a part id — the
 * attributes the airport materials read. `toGeometry()` keeps only the ones a
 * mesh needs.
 *
 * Triangles are oriented automatically: every triangle is wound so that its
 * geometric normal agrees with the (supplied) vertex normals, so primitives
 * never come out inside-out whatever order their corners were listed in.
 */
import * as THREE from 'three';

export type V3 = readonly [number, number, number];
export type V2 = readonly [number, number];
export type AttrName = 'color' | 'mat' | 'uv' | 'accent' | 'rm' | 'part';

export interface BrushState {
  color: number;
  mat: number;
  accent: number;
  rough: number;
  metal: number;
  part: number;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();

export class MeshBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly mat: number[] = [];
  readonly uv: number[] = [];
  readonly acc: number[] = [];
  readonly rm: number[] = [];
  readonly part: number[] = [];
  readonly idx: number[] = [];

  private r = 1;
  private g = 1;
  private b = 1;
  private state: BrushState = { color: 0xffffff, mat: 0, accent: 0, rough: 0.6, metal: 0, part: 0 };
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private stack: THREE.Matrix4[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }
  get triangleCount(): number {
    return this.idx.length / 3;
  }

  /** Set brush properties (colour hex in sRGB, material id, accent flag, roughness, metalness, part id). */
  set(o: Partial<BrushState>): this {
    Object.assign(this.state, o);
    if (o.color !== undefined) {
      _c.setHex(o.color); // three converts sRGB hex → linear working space
      this.r = _c.r;
      this.g = _c.g;
      this.b = _c.b;
    }
    return this;
  }
  get brush(): Readonly<BrushState> {
    return this.state;
  }

  /** Multiply a transform onto the current frame (until the matching pop). */
  push(m: THREE.Matrix4): this {
    this.stack.push(this.m.clone());
    this.m.multiply(m);
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  pop(): this {
    const m = this.stack.pop();
    if (!m) throw new Error('MeshBuilder: pop without push');
    this.m.copy(m);
    this.nm.getNormalMatrix(this.m);
    return this;
  }
  /** Convenience: translate (x, y, z) then rotate about +Y by `rotY` radians. */
  pushTR(x: number, y: number, z: number, rotY = 0): this {
    return this.push(new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z));
  }

  /** Emit one vertex (local coordinates) and return its index. */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, w = 0): number {
    _v.set(x, y, z).applyMatrix4(this.m);
    _n.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
    this.pos.push(_v.x, _v.y, _v.z);
    this.nrm.push(_n.x, _n.y, _n.z);
    this.col.push(this.r, this.g, this.b);
    this.mat.push(this.state.mat);
    this.uv.push(u, w);
    this.acc.push(this.state.accent);
    this.rm.push(this.state.rough, this.state.metal);
    this.part.push(this.state.part);
    return this.pos.length / 3 - 1;
  }

  /** Triangle, wound to face along the average of its vertex normals. */
  tri(a: number, b: number, c: number): this {
    const P = this.pos;
    const N = this.nrm;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    const nx = N[a * 3] + N[b * 3] + N[c * 3];
    const ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (gx * nx + gy * ny + gz * nz < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
    return this;
  }
  quad(a: number, b: number, c: number, d: number): this {
    return this.tri(a, b, c).tri(a, c, d);
  }

  /**
   * Flat convex polygon (local points, in order around the outline) facing `n`.
   * UVs: u along `uAxis` (default: the first edge), v along n × u — or, when
   * `wallUV` is set, u along the horizontal and v = local height y (walls).
   */
  poly(pts: readonly V3[], n: V3, opts: { wallUV?: boolean; uAxis?: V3 } = {}): this {
    const [nx, ny, nz] = n;
    let ux: number, uy: number, uz: number;
    if (opts.wallUV) {
      // horizontal direction in the wall plane: up × n
      ux = nz;
      uy = 0;
      uz = -nx;
      const l = Math.hypot(ux, uz);
      if (l < 1e-6) {
        ux = 1;
        uz = 0;
      } else {
        ux /= l;
        uz /= l;
      }
    } else if (opts.uAxis) {
      [ux, uy, uz] = opts.uAxis;
    } else {
      ux = pts[1][0] - pts[0][0];
      uy = pts[1][1] - pts[0][1];
      uz = pts[1][2] - pts[0][2];
      const l = Math.hypot(ux, uy, uz) || 1;
      ux /= l;
      uy /= l;
      uz /= l;
    }
    // w axis = n × u
    const wx = ny * uz - nz * uy;
    const wy = nz * ux - nx * uz;
    const wz = nx * uy - ny * ux;
    const base = this.vertexCount;
    for (const p of pts) {
      const u = p[0] * ux + p[1] * uy + p[2] * uz;
      const w = opts.wallUV ? p[1] : p[0] * wx + p[1] * wy + p[2] * wz;
      this.v(p[0], p[1], p[2], nx, ny, nz, u, w);
    }
    for (let i = 1; i < pts.length - 1; i++) this.tri(base, base + i, base + i + 1);
    return this;
  }

  /** Axis-aligned box in local coordinates. `faces` omits faces (e.g. 'b' = no bottom). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip = ''): this {
    if (!skip.includes('x')) this.poly([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], { wallUV: true });
    if (!skip.includes('X')) this.poly([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], { wallUV: true });
    if (!skip.includes('z')) this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], { wallUV: true });
    if (!skip.includes('Z')) this.poly([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], { wallUV: true });
    if (!skip.includes('t')) this.poly([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], [0, 1, 0], { uAxis: [1, 0, 0] });
    if (!skip.includes('b')) this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], { uAxis: [1, 0, 0] });
    return this;
  }

  /** Box given by centre and size. */
  boxC(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, skip = ''): this {
    return this.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, skip);
  }

  /**
   * Surface of revolution about the local +Y axis through (cx, cz): `profile` = [radius, y] from bottom
   * to top. Smooth normals; a radius of 0 closes the end. `caps` adds flat discs at open ends.
   */
  lathe(profile: readonly V2[], seg: number, cx = 0, cz = 0, caps = false, phase = 0): this {
    const n = profile.length;
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const [r, y] = profile[i];
      // profile tangent → normal (dr, dy) rotated
      const p0 = profile[Math.max(0, i - 1)];
      const p1 = profile[Math.min(n - 1, i + 1)];
      let tr = p1[0] - p0[0];
      let ty = p1[1] - p0[1];
      const tl = Math.hypot(tr, ty) || 1;
      tr /= tl;
      ty /= tl;
      const nr = ty; // normal in (r, y): rotate tangent by −90°
      const ny = -tr;
      const row: number[] = [];
      for (let k = 0; k <= seg; k++) {
        const a = phase + (k / seg) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        row.push(this.v(cx + r * ca, y, cz + r * sa, nr * ca, ny, nr * sa, (k / seg) * Math.PI * 2 * Math.max(r, 0.05), y));
      }
      rows.push(row);
    }
    for (let i = 0; i < n - 1; i++)
      for (let k = 0; k < seg; k++) {
        const a = rows[i][k], b = rows[i][k + 1], c = rows[i + 1][k + 1], d = rows[i + 1][k];
        if (profile[i][0] < 1e-6) this.tri(a, c, d);
        else if (profile[i + 1][0] < 1e-6) this.tri(a, b, c);
        else this.quad(a, b, c, d);
      }
    if (caps) {
      for (const [end, dir] of [[0, -1], [n - 1, 1]] as const) {
        const [r, y] = profile[end];
        if (r < 1e-6) continue;
        const ring: V3[] = [];
        for (let k = 0; k < seg; k++) {
          const a = phase + (k / seg) * Math.PI * 2;
          ring.push([cx + r * Math.cos(a), y, cz + r * Math.sin(a)]);
        }
        this.poly(ring, [0, dir, 0], { uAxis: [1, 0, 0] });
      }
    }
    return this;
  }

  /** Vertical cylinder. */
  cylinder(cx: number, y0: number, cz: number, r: number, h: number, seg = 12, caps = true): this {
    return this.lathe([[r, y0], [r, y0 + h]], seg, cx, cz, caps);
  }

  /** Round tube from p0 to p1 (radii r0 → r1), open ends unless `caps`. */
  tube(p0: V3, p1: V3, r0: number, r1 = r0, seg = 6, caps = false): this {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return this;
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(p0[0], p0[1], p0[2]), q, new THREE.Vector3(1, 1, 1));
    this.push(m);
    this.lathe([[r0, 0], [r1, len]], seg, 0, 0, caps);
    this.pop();
    return this;
  }

  /**
   * Extrude a closed 2D profile (x, y in the local XY plane) along Z from z0 to z1.
   * `smooth` shares normals between neighbouring side faces (curved shells); caps are fanned
   * (convex profiles only).
   */
  prismZ(profile: readonly V2[], z0: number, z1: number, opts: { smooth?: boolean; caps?: boolean; closed?: boolean } = {}): this {
    const n = profile.length;
    const closed = opts.closed ?? true;
    // signed area → outward direction
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = profile[i];
      const b = profile[(i + 1) % n];
      area += a[0] * b[1] - b[0] * a[1];
    }
    const ccw = area > 0;
    const edgeN = (i: number): V2 => {
      const a = profile[i];
      const b = profile[(i + 1) % n];
      let ex = b[0] - a[0];
      let ey = b[1] - a[1];
      const l = Math.hypot(ex, ey) || 1;
      ex /= l;
      ey /= l;
      return ccw ? [ey, -ex] : [-ey, ex];
    };
    const segs = closed ? n : n - 1;
    let u0 = 0;
    for (let i = 0; i < segs; i++) {
      const a = profile[i];
      const b = profile[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let na = edgeN(i);
      let nb = na;
      if (opts.smooth) {
        const prev = i > 0 || closed ? edgeN((i - 1 + n) % n) : na;
        const next = i < segs - 1 || closed ? edgeN((i + 1) % n) : na;
        const avg = (p: V2, q: V2): V2 => {
          const x = p[0] + q[0];
          const y = p[1] + q[1];
          const l = Math.hypot(x, y) || 1;
          return [x / l, y / l];
        };
        na = avg(prev, na);
        nb = avg(edgeN(i), next);
      }
      const i0 = this.v(a[0], a[1], z0, na[0], na[1], 0, u0, z0);
      const i1 = this.v(b[0], b[1], z0, nb[0], nb[1], 0, u0 + len, z0);
      const i2 = this.v(b[0], b[1], z1, nb[0], nb[1], 0, u0 + len, z1);
      const i3 = this.v(a[0], a[1], z1, na[0], na[1], 0, u0, z1);
      this.quad(i0, i1, i2, i3);
      u0 += len;
    }
    if (opts.caps ?? true) {
      this.poly(profile.map((p) => [p[0], p[1], z1] as V3), [0, 0, 1], { wallUV: true });
      this.poly(profile.map((p) => [p[0], p[1], z0] as V3), [0, 0, -1], { wallUV: true });
    }
    return this;
  }

  /**
   * Loft through rings of equal length (each ring = points around a section). Normals by central
   * differences. `closed` joins the last point of each ring to its first.
   */
  loft(rings: readonly (readonly V3[])[], closed = true, uvScale: V2 = [1, 1]): this {
    const R = rings.length;
    const K = rings[0].length;
    const idx: number[][] = [];
    const at = (i: number, k: number) => rings[Math.max(0, Math.min(R - 1, i))][closed ? ((k % K) + K) % K : Math.max(0, Math.min(K - 1, k))];
    for (let i = 0; i < R; i++) {
      const row: number[] = [];
      for (let k = 0; k < K; k++) {
        const p = rings[i][k];
        const a = at(i + 1, k), b = at(i - 1, k), c = at(i, k + 1), d = at(i, k - 1);
        const tx = a[0] - b[0], ty = a[1] - b[1], tz = a[2] - b[2];
        const sx = c[0] - d[0], sy = c[1] - d[1], sz = c[2] - d[2];
        let nx = ty * sz - tz * sy;
        let ny = tz * sx - tx * sz;
        let nz = tx * sy - ty * sx;
        // orient outward: away from the ring centroid
        let cx = 0, cy = 0, cz = 0;
        for (const q of rings[i]) {
          cx += q[0];
          cy += q[1];
          cz += q[2];
        }
        cx /= K;
        cy /= K;
        cz /= K;
        if (nx * (p[0] - cx) + ny * (p[1] - cy) + nz * (p[2] - cz) < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
        }
        const l = Math.hypot(nx, ny, nz) || 1;
        row.push(this.v(p[0], p[1], p[2], nx / l, ny / l, nz / l, (k / K) * uvScale[0], (i / (R - 1)) * uvScale[1]));
      }
      idx.push(row);
    }
    const kk = closed ? K : K - 1;
    for (let i = 0; i < R - 1; i++)
      for (let k = 0; k < kk; k++) {
        const k1 = (k + 1) % K;
        this.quad(idx[i][k], idx[i][k1], idx[i + 1][k1], idx[i + 1][k]);
      }
    return this;
  }

  /** Close a ring with a flat fan toward `centre` (normal `n`). */
  capRing(ring: readonly V3[], centre: V3, n: V3): this {
    const c = this.v(centre[0], centre[1], centre[2], n[0], n[1], n[2]);
    const ids = ring.map((p) => this.v(p[0], p[1], p[2], n[0], n[1], n[2]));
    for (let k = 0; k < ids.length; k++) this.tri(c, ids[k], ids[(k + 1) % ids.length]);
    return this;
  }

  /** Append another builder's output (already in world/local space of that builder). */
  append(o: MeshBuilder): this {
    const base = this.vertexCount;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.col.push(...o.col);
    this.mat.push(...o.mat);
    this.uv.push(...o.uv);
    this.acc.push(...o.acc);
    this.rm.push(...o.rm);
    this.part.push(...o.part);
    for (const i of o.idx) this.idx.push(i + base);
    return this;
  }

  toGeometry(attrs: readonly AttrName[] = ['color', 'mat', 'uv']): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (attrs.includes('color')) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (attrs.includes('mat')) g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    if (attrs.includes('uv')) g.setAttribute('aUvM', new THREE.Float32BufferAttribute(this.uv, 2));
    if (attrs.includes('accent')) g.setAttribute('aAccent', new THREE.Float32BufferAttribute(this.acc, 1));
    if (attrs.includes('rm')) g.setAttribute('aRM', new THREE.Float32BufferAttribute(this.rm, 2));
    if (attrs.includes('part')) g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    const n = this.vertexCount;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
