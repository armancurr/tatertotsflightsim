/**
 * A small procedural mesh builder for the enemy aircraft: lofted fuselages (superellipse cross
 * sections), tapered airfoil-section wings and fins, cylinders/cones, ellipsoids, boxes and flat
 * decal quads. Every vertex carries position, normal, linear colour, an atlas uv (plain surfaces use
 * the atlas' white texel) and `aSurf` = (paint code, roughness, metalness, glow):
 *   paint 0 = the vertex colour as is, 1 = camouflage (shader), 2/3 = tens/ones digit decal
 *   (the shader shifts the uv to the instance's number), 4 = other decal (star).
 * Triangles are wound outward (a hint direction per primitive), so the material can cull back faces.
 */
import * as THREE from 'three';

export interface Surf {
  /** Linear RGB. */
  c: [number, number, number];
  paint: number;
  rough: number;
  metal: number;
  glow?: number;
}

const _c = new THREE.Color();
/** sRGB hex → linear triple. */
export const lin = (hex: number): [number, number, number] => {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
};
export const surf = (hex: number, paint: number, rough: number, metal = 0, glow = 0): Surf => ({ c: lin(hex), paint, rough, metal, glow });

export interface Station {
  z: number;
  /** Centre height. */
  y: number;
  /** Half width. */
  w: number;
  /** Half heights above and below the centre. */
  ht: number;
  hb: number;
  /** Superellipse exponent (2 = ellipse, 3–4 = boxier). */
  n?: number;
  /** Centre x (default 0). */
  x?: number;
}

/** UV of the atlas' white texel (plain surfaces). */
export const WHITE_UV: [number, number] = [136 / 512, 8 / 128];

const _v = new THREE.Vector3();
const _h = new THREE.Vector3();

export class Geo {
  readonly P: number[] = [];
  readonly C: number[] = [];
  readonly U: number[] = [];
  readonly S: number[] = [];
  readonly I: number[] = [];
  private m: THREE.Matrix4 | null = null;
  private nm = new THREE.Matrix3();

  get triangles(): number {
    return this.I.length / 3;
  }

  /** Run `fn` with a transform applied to everything it adds. */
  with(m: THREE.Matrix4, fn: () => void): this {
    const prev = this.m;
    this.m = prev ? prev.clone().multiply(m) : m.clone();
    this.nm.getNormalMatrix(this.m);
    fn();
    this.m = prev;
    if (prev) this.nm.getNormalMatrix(prev);
    return this;
  }

  vert(x: number, y: number, z: number, s: Surf, u = WHITE_UV[0], v = WHITE_UV[1]): number {
    _v.set(x, y, z);
    if (this.m) _v.applyMatrix4(this.m);
    this.P.push(_v.x, _v.y, _v.z);
    this.C.push(s.c[0], s.c[1], s.c[2]);
    this.U.push(u, v);
    this.S.push(s.paint, s.rough, s.metal, s.glow ?? 0);
    return this.P.length / 3 - 1;
  }

  /** Triangle wound so its normal points along the hint (local frame). */
  tri(a: number, b: number, c: number, hx: number, hy: number, hz: number): void {
    const P = this.P;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    _h.set(hx, hy, hz);
    if (this.m) _h.applyMatrix3(this.nm);
    if (nx * _h.x + ny * _h.y + nz * _h.z >= 0) this.I.push(a, b, c);
    else this.I.push(a, c, b);
  }

  /** Lofted body through cross sections (front to back), `seg` around; caps the ends. */
  loft(st: Station[], seg: number, s: Surf, capFront = true, capBack = true): this {
    const rings: number[][] = [];
    for (const q of st) {
      const n = q.n ?? 2;
      const e = 2 / n;
      const ring: number[] = [];
      const cx = q.x ?? 0;
      for (let i = 0; i < seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        const c = Math.cos(t), sn = Math.sin(t);
        const x = cx + q.w * Math.sign(c) * Math.abs(c) ** e;
        const y = q.y + (sn >= 0 ? q.ht : q.hb) * Math.sign(sn) * Math.abs(sn) ** e;
        ring.push(this.vert(x, y, q.z, s));
      }
      rings.push(ring);
    }
    for (let k = 0; k + 1 < rings.length; k++) {
      const r0 = rings[k], r1 = rings[k + 1];
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        // outward hint in the local frame: radial from the section centre (approx.)
        const q0 = st[k], q1 = st[k + 1];
        const t = (i / seg) * Math.PI * 2;
        const hx = Math.cos(t) * (q0.w + q1.w), hy = Math.sin(t) * (q0.ht + q1.ht + q0.hb + q1.hb);
        this.tri(r0[i], r1[i], r1[j], hx, hy, 0);
        this.tri(r0[i], r1[j], r0[j], hx, hy, 0);
      }
    }
    if (capFront && st.length) this.cap(rings[0], st[0], -1, s);
    if (capBack && st.length) this.cap(rings[rings.length - 1], st[st.length - 1], 1, s);
    return this;
  }

  private cap(ring: number[], q: Station, dir: number, s: Surf): void {
    if (q.w < 1e-4 && q.ht < 1e-4 && q.hb < 1e-4) return;
    const c = this.vert(q.x ?? 0, q.y, q.z, s);
    for (let i = 0; i < ring.length; i++) this.tri(c, ring[i], ring[(i + 1) % ring.length], 0, 0, dir);
  }

  /**
   * A tapered wing / fin panel with an airfoil section. Root and tip leading edges (local points),
   * chords run along +Z; `up` is the thickness direction at the root (the panel's "top").
   * t = thickness/chord at root and tip. Closed (root and tip caps).
   */
  wing(root: [number, number, number], tip: [number, number, number], chordRoot: number, chordTip: number, up: [number, number, number], tRoot: number, tTip: number, s: Surf, chordSteps = 6, spanSteps = 1): this {
    const fr = [0, 0.04, 0.12, 0.25, 0.42, 0.6, 0.8, 1];
    const cs = chordSteps >= 7 ? fr : chordSteps >= 4 ? [0, 0.1, 0.3, 0.6, 1] : [0, 0.35, 1];
    const half = (x: number) => 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4) * 0.5 + 0.004;
    const top: number[][] = [];
    const bot: number[][] = [];
    const sx = tip[0] - root[0], sy = tip[1] - root[1], sz = tip[2] - root[2];
    for (let j = 0; j <= spanSteps; j++) {
      const u = j / spanSteps;
      const lx = root[0] + sx * u, ly = root[1] + sy * u, lz = root[2] + sz * u;
      const ch = chordRoot + (chordTip - chordRoot) * u;
      const th = tRoot + (tTip - tRoot) * u;
      const rt: number[] = [], rb: number[] = [];
      for (const f of cs) {
        const h = half(f) * th * ch * (f >= 1 ? 0.15 : 1);
        rt.push(this.vert(lx + up[0] * h, ly + up[1] * h, lz + ch * f + up[2] * h, s));
        rb.push(this.vert(lx - up[0] * h, ly - up[1] * h, lz + ch * f - up[2] * h, s));
      }
      top.push(rt);
      bot.push(rb);
    }
    const n = cs.length;
    for (let j = 0; j < spanSteps; j++) {
      for (let i = 0; i + 1 < n; i++) {
        this.tri(top[j][i], top[j + 1][i], top[j + 1][i + 1], up[0], up[1], up[2]);
        this.tri(top[j][i], top[j + 1][i + 1], top[j][i + 1], up[0], up[1], up[2]);
        this.tri(bot[j][i], bot[j + 1][i], bot[j + 1][i + 1], -up[0], -up[1], -up[2]);
        this.tri(bot[j][i], bot[j + 1][i + 1], bot[j][i + 1], -up[0], -up[1], -up[2]);
      }
      // trailing edge strip
      this.tri(top[j][n - 1], top[j + 1][n - 1], bot[j + 1][n - 1], 0, 0, 1);
      this.tri(top[j][n - 1], bot[j + 1][n - 1], bot[j][n - 1], 0, 0, 1);
    }
    // caps at root and tip (outward along ∓span)
    for (const [j, d] of [[0, -1], [spanSteps, 1]] as const) {
      for (let i = 0; i + 1 < n; i++) {
        this.tri(top[j][i], top[j][i + 1], bot[j][i + 1], sx * d, sy * d, sz * d);
        this.tri(top[j][i], bot[j][i + 1], bot[j][i], sx * d, sy * d, sz * d);
      }
    }
    return this;
  }

  /** A body of revolution along +Z from z0 to z1 (radii r0 → r1) centred at (x, y); optional caps. */
  tube(x: number, y: number, z0: number, z1: number, r0: number, r1: number, seg: number, s: Surf, cap0 = true, cap1 = true, capSurf?: Surf): this {
    return this.loft([{ z: z0, y, x, w: r0, ht: r0, hb: r0 }, { z: z1, y, x, w: r1, ht: r1, hb: r1 }], seg, s, false, false).capsOf(x, y, z0, z1, r0, r1, seg, capSurf ?? s, cap0, cap1);
  }

  private capsOf(x: number, y: number, z0: number, z1: number, r0: number, r1: number, seg: number, s: Surf, c0: boolean, c1: boolean): this {
    const disc = (z: number, r: number, d: number) => {
      if (r <= 0) return;
      const c = this.vert(x, y, z, s);
      const ring: number[] = [];
      for (let i = 0; i < seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        ring.push(this.vert(x + Math.cos(t) * r, y + Math.sin(t) * r, z, s));
      }
      for (let i = 0; i < seg; i++) this.tri(c, ring[i], ring[(i + 1) % seg], 0, 0, d);
    };
    if (c0) disc(z0, r0, -1);
    if (c1) disc(z1, r1, 1);
    return this;
  }

  /** Ellipsoid (half sizes) at a centre; `lower` = false keeps only the upper half (a canopy). */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, s: Surf, seg = 12, rings = 6, lower = true): this {
    const rows: number[][] = [];
    const r0 = lower ? -rings : 0;
    for (let k = r0; k <= rings; k++) {
      const phi = (k / rings) * (Math.PI / 2);
      const row: number[] = [];
      for (let i = 0; i < seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        row.push(this.vert(cx + Math.cos(t) * Math.cos(phi) * rx, cy + Math.sin(phi) * ry, cz + Math.sin(t) * Math.cos(phi) * rz, s));
      }
      rows.push(row);
    }
    for (let k = 0; k + 1 < rows.length; k++) {
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        const t = (i / seg) * Math.PI * 2;
        const phi = ((k + r0 + 0.5) / rings) * (Math.PI / 2);
        const hx = Math.cos(t) * Math.cos(phi), hy = Math.sin(phi), hz = Math.sin(t) * Math.cos(phi);
        this.tri(rows[k][i], rows[k + 1][i], rows[k + 1][j], hx, hy, hz);
        this.tri(rows[k][i], rows[k + 1][j], rows[k][j], hx, hy, hz);
      }
    }
    return this;
  }

  /** Axis-aligned box (half sizes) at a centre. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, s: Surf): this {
    const v = (x: number, y: number, z: number) => this.vert(cx + x * hx, cy + y * hy, cz + z * hz, s);
    const faces: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [nx, ny, nz] of faces) {
      const t1 = nx ? [0, 1, 0] : [1, 0, 0];
      const t2 = nz ? [0, 1, 0] : [0, 0, 1];
      const c = (s1: number, s2: number) => v(nx + t1[0] * s1 + t2[0] * s2, ny + t1[1] * s1 + t2[1] * s2, nz + t1[2] * s1 + t2[2] * s2);
      const a = c(-1, -1), b = c(1, -1), d = c(1, 1), e = c(-1, 1);
      this.tri(a, b, d, nx, ny, nz);
      this.tri(a, d, e, nx, ny, nz);
    }
    return this;
  }

  /** A flat quad (decal) centred at c on a surface with normal n and "up" u (unit), w × h m, atlas rect (u0,v0)-(u1,v1). */
  decal(c: [number, number, number], n: [number, number, number], u: [number, number, number], w: number, h: number, uv: [number, number, number, number], s: Surf, lift = 0.03): this {
    const rx = u[1] * n[2] - u[2] * n[1], ry = u[2] * n[0] - u[0] * n[2], rz = u[0] * n[1] - u[1] * n[0];
    const cx = c[0] + n[0] * lift, cy = c[1] + n[1] * lift, cz = c[2] + n[2] * lift;
    const p = (sx: number, sy: number, uu: number, vv: number) =>
      this.vert(cx + rx * sx * w * 0.5 + u[0] * sy * h * 0.5, cy + ry * sx * w * 0.5 + u[1] * sy * h * 0.5, cz + rz * sx * w * 0.5 + u[2] * sy * h * 0.5, s, uu, vv);
    const [u0, v0, u1, v1] = uv;
    const a = p(-1, -1, u0, v0), b = p(1, -1, u1, v0), d = p(1, 1, u1, v1), e = p(-1, 1, u0, v1);
    this.tri(a, b, d, n[0], n[1], n[2]);
    this.tri(a, d, e, n[0], n[1], n[2]);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.S, 4));
    g.setIndex(this.I);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
