/**
 * Procedural low-poly vehicle models (no assets): sedan, hatchback, SUV,
 * pickup, cargo van, box truck, semi tractor + 53 ft trailer, bus and a farm
 * tractor, each in two levels of detail (0 = near, ~500–1,450 triangles; 1 =
 * far, ≤ 220). Real proportions from specs.ts.
 *
 * Model frame: +X right, +Y up, −Z front; origin on the ground midway between
 * the axles. Bodies are lofted cross-sections (smooth within a panel, crisp
 * between panels): a painted shell whose lower edge rises over the wheel
 * arches, a dark underside, a tinted glasshouse with a painted roof, lamps,
 * grille, plates, mirrors; wheels are lathed tyres with 5-spoke rims.
 *
 * Attributes (identical for every model, as BatchedMesh requires):
 *   position, normal
 *   color   linear RGB of unpainted parts
 *   aMat    (paint mask, roughness, metalness, lamp kind — LAMP)
 *   aWheel  (hub x, hub y, hub z, ±radius): wheel vertices spin about their
 *           hub in the shader (radius < 0: a steered front wheel), 0 = body
 */
import * as THREE from 'three';
import { SPECS, SEMI, VT, MODEL_TRAILER, TRAILER_WHEELBASE } from './specs';

export const LAMP = { none: 0, head: 1, tailL: 2, tailR: 3, indL: 4, indR: 5 } as const;

type V3 = [number, number, number];
type Key = [number, number];

const HEX = {
  glass: 0x0b0f13,
  tyre: 0x151515,
  rim: 0xb5b9bd,
  truckRim: 0xcfd1d2,
  trim: 0x19191b,
  chrome: 0xd0d3d6,
  under: 0x0d0d0d,
  head: 0xd4d8db,
  tail: 0x5a0909,
  ind: 0xa3600d,
  plate: 0xe2e0d4,
  box: 0xe9e9e5,
  grille: 0x111213,
  wellLiner: 0x0a0a0a,
};

const linear = (hex: number): [number, number, number] => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

interface Brush {
  col: [number, number, number];
  paint: number;
  rough: number;
  metal: number;
  lamp: number;
  wheel: [number, number, number, number];
}

/** Collects indexed geometry with the vehicle attributes. */
class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  mat: number[] = [];
  whl: number[] = [];
  idx: number[] = [];
  private b: Brush = { col: [1, 1, 1], paint: 0, rough: 0.5, metal: 0, lamp: 0, wheel: [0, 0, 0, 0] };

  painted(rough = 0.38): this {
    this.b = { ...this.b, col: [1, 1, 1], paint: 1, rough, metal: 0, lamp: 0 };
    return this;
  }
  solid(hex: number, rough: number, metal = 0, lamp: number = LAMP.none): this {
    this.b = { ...this.b, col: linear(hex), paint: 0, rough, metal, lamp };
    return this;
  }
  wheelOn(x: number, y: number, z: number, r: number): this {
    this.b.wheel = [x, y, z, r];
    return this;
  }
  wheelOff(): this {
    this.b.wheel = [0, 0, 0, 0];
    return this;
  }

  private v(x: number, y: number, z: number, nx = 0, ny = 1, nz = 0): number {
    const b = this.b;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(b.col[0], b.col[1], b.col[2]);
    this.mat.push(b.paint, b.rough, b.metal, b.lamp);
    this.whl.push(b.wheel[0], b.wheel[1], b.wheel[2], b.wheel[3]);
    return this.pos.length / 3 - 1;
  }

  /**
   * Quads between consecutive rings (equal lengths); `closed` joins each ring's
   * last point to its first. Normals are smooth within the strip and face away
   * from each ring's centroid (or from `inside` if given).
   */
  loft(rings: V3[][], closed: boolean, inside?: (k: number) => V3): this {
    const n = rings[0].length;
    const base = this.pos.length / 3;
    for (const r of rings) for (const p of r) this.v(p[0], p[1], p[2], 0, 0, 0);
    const acc = new Float64Array(rings.length * n * 3);
    const cen = rings.map((r, k) => {
      if (inside) return inside(k);
      let x = 0;
      let y = 0;
      let z = 0;
      for (const p of r) {
        x += p[0];
        y += p[1];
        z += p[2];
      }
      return [x / n, y / n, z / n] as V3;
    });
    const P = (k: number, j: number) => rings[k][j];
    const segs = closed ? n : n - 1;
    for (let k = 0; k + 1 < rings.length; k++)
      for (let j = 0; j < segs; j++) {
        const j2 = (j + 1) % n;
        const a = P(k, j);
        const b = P(k + 1, j);
        const c = P(k + 1, j2);
        const d = P(k, j2);
        // normal of the quad (a, b, c, d)
        let nx = (c[1] - a[1]) * (d[2] - b[2]) - (c[2] - a[2]) * (d[1] - b[1]);
        let ny = (c[2] - a[2]) * (d[0] - b[0]) - (c[0] - a[0]) * (d[2] - b[2]);
        let nz = (c[0] - a[0]) * (d[1] - b[1]) - (c[1] - a[1]) * (d[0] - b[0]);
        const l = Math.hypot(nx, ny, nz);
        if (l < 1e-12) continue;
        nx /= l;
        ny /= l;
        nz /= l;
        const mx = (a[0] + b[0] + c[0] + d[0]) / 4 - (cen[k][0] + cen[k + 1][0]) / 2;
        const my = (a[1] + b[1] + c[1] + d[1]) / 4 - (cen[k][1] + cen[k + 1][1]) / 2;
        const mz = (a[2] + b[2] + c[2] + d[2]) / 4 - (cen[k][2] + cen[k + 1][2]) / 2;
        const ia = base + k * n + j;
        const ib = base + (k + 1) * n + j;
        const ic = base + (k + 1) * n + j2;
        const id = base + k * n + j2;
        if (nx * mx + ny * my + nz * mz < 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
          this.idx.push(ia, id, ic, ia, ic, ib);
        } else this.idx.push(ia, ib, ic, ia, ic, id);
        for (const q of [ia, ib, ic, id]) {
          const o = (q - base) * 3;
          acc[o] += nx;
          acc[o + 1] += ny;
          acc[o + 2] += nz;
        }
      }
    for (let q = 0; q < rings.length * n; q++) {
      let x = acc[q * 3];
      let y = acc[q * 3 + 1];
      let z = acc[q * 3 + 2];
      const l = Math.hypot(x, y, z);
      if (l < 1e-9) {
        x = 0;
        y = 1;
        z = 0;
      } else {
        x /= l;
        y /= l;
        z /= l;
      }
      const o = (base + q) * 3;
      this.nrm[o] = x;
      this.nrm[o + 1] = y;
      this.nrm[o + 2] = z;
    }
    return this;
  }

  /** A flat polygon (fan from its centroid), facing `out`. */
  poly(pts: readonly V3[], out: V3): this {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of pts) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    cx /= pts.length;
    cy /= pts.length;
    cz /= pts.length;
    // Newell normal
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const c = this.v(cx, cy, cz, nx, ny, nz);
    const first = this.pos.length / 3;
    for (const p of pts) this.v(p[0], p[1], p[2], nx, ny, nz);
    for (let i = 0; i < pts.length; i++) {
      const a = first + i;
      const b = first + ((i + 1) % pts.length);
      if (flip) this.idx.push(c, b, a);
      else this.idx.push(c, a, b);
    }
    return this;
  }

  /** A quad from four corners (in order), facing `out`. */
  quad(a: V3, b: V3, c: V3, d: V3, out: V3): this {
    let nx = (c[1] - a[1]) * (d[2] - b[2]) - (c[2] - a[2]) * (d[1] - b[1]);
    let ny = (c[2] - a[2]) * (d[0] - b[0]) - (c[0] - a[0]) * (d[2] - b[2]);
    let nz = (c[0] - a[0]) * (d[1] - b[1]) - (c[1] - a[1]) * (d[0] - b[0]);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const flip = nx * out[0] + ny * out[1] + nz * out[2] < 0;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const i = this.v(a[0], a[1], a[2], nx, ny, nz);
    this.v(b[0], b[1], b[2], nx, ny, nz);
    this.v(c[0], c[1], c[2], nx, ny, nz);
    this.v(d[0], d[1], d[2], nx, ny, nz);
    if (flip) this.idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
    else this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    return this;
  }

  /** Axis-aligned box; `skip` lists faces to omit: x- x+ y- y+ z- z+ as 'l r d u f b'. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip = ''): this {
    if (!skip.includes('l')) this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
    if (!skip.includes('r')) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0]);
    if (!skip.includes('d')) this.quad([x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [0, -1, 0]);
    if (!skip.includes('u')) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
    if (!skip.includes('f')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    if (!skip.includes('b')) this.quad([x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [0, 0, 1]);
    return this;
  }

  /** Cylinder along an axis through c (length len, radius r). */
  cylinder(axis: 'x' | 'y' | 'z', c: V3, r: number, len: number, seg: number, caps = true): this {
    const ring = (t: number): V3[] => {
      const out: V3[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const u = Math.cos(a) * r;
        const w = Math.sin(a) * r;
        if (axis === 'x') out.push([c[0] + t, c[1] + u, c[2] + w]);
        else if (axis === 'y') out.push([c[0] + u, c[1] + t, c[2] + w]);
        else out.push([c[0] + u, c[1] + w, c[2] + t]);
      }
      return out;
    };
    const r0 = ring(-len / 2);
    const r1 = ring(len / 2);
    this.loft([r0, r1], true, (k) => (axis === 'x' ? [c[0] + (k ? len / 2 : -len / 2), c[1], c[2]] : axis === 'y' ? [c[0], c[1] + (k ? len / 2 : -len / 2), c[2]] : [c[0], c[1], c[2] + (k ? len / 2 : -len / 2)]));
    if (caps) {
      const d: V3 = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
      this.poly(r1, d);
      this.poly(r0, [-d[0], -d[1], -d[2]]);
    }
    return this;
  }

  /**
   * A wheel at hub (x, y, z): lathed tyre (outer half and tread), and on its
   * outer face a 5-spoke rim (detail 0) or a plain disc (detail 1).
   * side = +1 right (outer face +X), −1 left.
   */
  wheel(x: number, y: number, z: number, r: number, tw: number, side: number, front: boolean, detail: number, rimHex = HEX.rim, dual = false): this {
    this.wheelOn(x, y, z, front ? -r : r);
    const seg = detail ? 6 : dual ? 8 : 10;
    const prof: Key[] = detail
      ? [
          [-tw / 2, r],
          [tw / 2, r],
        ]
      : [
          [-tw / 2, r],
          [tw / 2 - 0.035, r],
          [tw / 2, r * 0.93],
          [tw / 2, r * 0.68],
        ];
    const rings: V3[][] = prof.map(([xo, rr]) => {
      const out: V3[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        out.push([x + side * xo, y + Math.cos(a) * rr, z + Math.sin(a) * rr]);
      }
      return out;
    });
    this.solid(HEX.tyre, 0.92);
    this.loft(rings, true, (k) => [x + side * prof[k][0] - side * 0.3, y, z]);
    const fx = x + side * (tw / 2 - 0.012);
    const disc = (rr: number, xx: number, n: number): V3[] => {
      const out: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + 0.3;
        out.push([xx, y + Math.cos(a) * rr, z + Math.sin(a) * rr]);
      }
      return out;
    };
    const outN: V3 = [side, 0, 0];
    if (detail) {
      this.solid(0x3a3c3e, 0.6, 0.3);
      this.poly(disc(r, x + side * (tw / 2), seg), outN);
    } else {
      const rimR = r * 0.68;
      // rim lip
      this.solid(rimHex, 0.28, 0.85);
      this.loft([disc(rimR, fx, seg), disc(rimR * 0.88, fx - side * 0.005, seg)], true, () => [fx - side * 0.5, y, z]);
      // dark recess behind the spokes
      this.solid(HEX.grille, 0.8);
      this.poly(disc(rimR * 0.9, fx - side * (dual ? 0.02 : 0.05), seg), outN);
      // 5 spokes and the centre cap
      this.solid(rimHex, 0.28, 0.85);
      const sw = r * 0.085;
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const px = -sa;
        const pz = ca;
        const r0 = r * 0.16;
        const r1 = rimR * 0.9;
        const xs = fx - side * 0.012;
        this.quad([xs, y + ca * r0 + px * sw, z + sa * r0 + pz * sw], [xs, y + ca * r1 + px * sw, z + sa * r1 + pz * sw], [xs, y + ca * r1 - px * sw, z + sa * r1 - pz * sw], [xs, y + ca * r0 - px * sw, z + sa * r0 - pz * sw], outN);
      }
      this.poly(disc(r * 0.2, fx - side * 0.008, 6), outN);
    }
    this.wheelOff();
    return this;
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    g.setAttribute('aWheel', new THREE.Float32BufferAttribute(this.whl, 4));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ─── the generic body ─────────────────────────────────────────────────────────

/** Smooth interpolation through keys (x ascending). */
const table =
  (keys: readonly Key[]) =>
  (x: number): number => {
    if (x <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++)
      if (x <= keys[i][0]) {
        const t = (x - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
        const s = t * t * (3 - 2 * t);
        return keys[i - 1][1] + (keys[i][1] - keys[i - 1][1]) * s;
      }
    return keys[keys.length - 1][1];
  };

interface BodyProfile {
  /** Overall length/width, wheelbase, front overhang, wheel radius and tyre width (m). */
  L: number;
  W: number;
  wb: number;
  fo: number;
  r: number;
  tw: number;
  /** Rear wheel radius / tyre width if different. */
  rr?: number;
  rtw?: number;
  /** Bottom of the body sides between the arches. */
  sill: number;
  /** Top of the lower body (bumper, hood, belt line, deck) along zf (0 = front bumper). */
  belt: Key[];
  /** Glass from the belt line up to `roof` over [gh0, gh1]. */
  gh: [number, number];
  roof: Key[];
  /** Inset of the roof edge from the body side. */
  tumble: number;
  /** Painted upper body (cargo box, sleeper, a bus roof above its windows) over [z0, z1] from `base` (default the belt) up to `top`. */
  upper?: { z0: number; z1: number; top: Key[]; base?: number };
  /** Plan rounding length at the front / rear. */
  roundF: number;
  roundR: number;
  /** Headlamp and tail lamp band heights (y0, y1), and the grille (y0, y1). */
  headY: [number, number];
  tailY: [number, number];
  grilleY: [number, number];
  /** Unpainted (black plastic) bumpers. */
  darkBumpers?: boolean;
  /** Door pillar (dark) at this zf, if any. */
  bPillar?: number;
  rimHex?: number;
  /** Rear axle(s): offsets from the rear axle centre (tandems), default [0]. */
  rearAxles?: number[];
  dualRear?: boolean;
  /** Skip the rear face lamps (the trailer carries them). */
  noTail?: boolean;
  /** Fewer stations around the wheel arches (big vehicles). */
  coarseArches?: boolean;
}

function body(b: Builder, P: BodyProfile, detail: number): void {
  const hw0 = P.W / 2;
  const zOff = P.fo + P.wb / 2; // model z = zf − zOff
  const belt = table(P.belt);
  const roof = table(P.roof);
  const archR = P.r + 0.07;
  const rr = P.rr ?? P.r;
  const archRR = rr + 0.07;
  const zFront = P.fo;
  const rearAxles = P.rearAxles ?? [0];
  const zRears = rearAxles.map((o) => P.fo + P.wb + o);
  const halfW = (zf: number): number => {
    const ef = Math.min(1, zf / P.roundF);
    const er = Math.min(1, (P.L - zf) / P.roundR);
    const e = Math.min(ef, er);
    return hw0 * (0.87 + 0.13 * Math.sqrt(Math.max(0, e)));
  };
  const bottom = (zf: number): number => {
    let y = P.sill;
    if (detail) return y;
    const dF = Math.abs(zf - zFront);
    if (dF < archR) y = Math.max(y, P.r + Math.sqrt(archR * archR - dF * dF));
    for (const zr of zRears) {
      const d = Math.abs(zf - zr);
      if (d < archRR) y = Math.max(y, rr + Math.sqrt(archRR * archRR - d * d));
    }
    return y;
  };
  // stations: uniform + around the arches
  const st = new Set<number>();
  const step = detail ? Math.max(1.2, P.L / 5) : Math.max(P.coarseArches ? 0.62 : 0.46, P.L / 11);
  for (let z = 0; z <= P.L + 1e-6; z += step) st.add(Math.min(P.L, z));
  st.add(P.L);
  if (!detail) {
    st.add(0.06);
    st.add(P.L - 0.06);
    for (const k of P.coarseArches ? [-1, -0.6, 0, 0.6, 1] : [-1, -0.8, -0.45, 0, 0.45, 0.8, 1]) {
      st.add(zFront + k * archR);
      for (const zr of zRears) st.add(zr + k * archRR);
    }
  }
  for (const [z] of P.belt) if (z > 0 && z < P.L) st.add(z);
  const zs = [...st].filter((z) => z >= 0 && z <= P.L).sort((a, c) => a - c);
  const Z = (zf: number) => zf - zOff;
  // painted shell (open at the bottom)
  const shellRing = (zf: number): V3[] => {
    const hw = halfW(zf);
    const bot = bottom(zf);
    const top = Math.max(bot + 0.08, belt(zf));
    const z = Z(zf);
    const half: [number, number][] = detail
      ? [
          [hw * 0.97, bot],
          [hw, top - 0.12],
          [hw * 0.86, top],
        ]
      : [
          [hw * 0.96, bot],
          [hw, bot + Math.min(0.12, (top - bot) * 0.3)],
          [hw, top - 0.15],
          [hw * 0.97, top - 0.035],
          [hw * 0.85, top],
        ];
    const out: V3[] = [];
    for (const [x, y] of half) out.push([-x, y, z]);
    out.push([0, top + 0.015, z]);
    for (let i = half.length - 1; i >= 0; i--) out.push([half[i][0], half[i][1], z]);
    return out;
  };
  const rings = zs.map(shellRing);
  b.painted();
  b.loft(rings, false, (k) => [0, (bottom(zs[k]) + belt(zs[k])) / 2, Z(zs[k])]);
  // bumpers: dark plastic lower band at both ends
  // underside (dark), incl. the wheel-well liners
  const under = zs.map((zf) => {
    const hw = halfW(zf);
    const z = Z(zf);
    return [[-hw * (detail ? 0.97 : 0.96), bottom(zf), z], [0, P.sill - 0.02, z], [hw * (detail ? 0.97 : 0.96), bottom(zf), z]] as V3[];
  });
  if (!detail) {
    b.solid(HEX.wellLiner, 1);
    b.loft(under, false, (k) => [0, belt(zs[k]), Z(zs[k])]);
  }
  // end caps
  const cap = (k: number, out: V3) => {
    const ring = rings[k];
    const pts: V3[] = [...ring, under[k][1]];
    b.poly(pts, out);
  };
  if (P.darkBumpers) b.solid(HEX.trim, 0.6);
  else b.painted();
  cap(0, [0, 0, -1]);
  cap(rings.length - 1, [0, 0, 1]);
  // glasshouse
  const ghs: number[] = [];
  const gl = P.gh[1] - P.gh[0];
  const gstep = detail ? gl + 1 : Math.max(0.32, gl / 9);
  for (let z = P.gh[0]; z < P.gh[1] - 1e-6; z += gstep) ghs.push(z);
  ghs.push(P.gh[1]);
  for (const [z] of P.roof) if (z > P.gh[0] && z < P.gh[1]) ghs.push(z);
  ghs.sort((a, c) => a - c);
  const ghRing = (zf: number): V3[] => {
    const hwB = halfW(zf) - 0.04;
    const hwT = hwB - P.tumble;
    const base = belt(zf) - 0.01;
    const top = Math.max(base + 0.02, roof(zf));
    const z = Z(zf);
    return [
      [-hwB, base, z],
      [-hwT, top - 0.06, z],
      [-hwT + 0.12, top, z],
      [hwT - 0.12, top, z],
      [hwT, top - 0.06, z],
      [hwB, base, z],
    ];
  };
  const gRings = ghs.map(ghRing);
  b.solid(HEX.glass, 0.05, 0);
  b.loft(gRings, false, (k) => [0, belt(ghs[k]) - 0.3, Z(ghs[k])]);
  // painted roof panel over the flat part of the roof
  const roofTop = Math.max(...ghs.map(roof));
  const flat = ghs.filter((z) => roof(z) > roofTop - (P.roof.length > 3 ? 0.07 : 0.2));
  if (flat.length >= 2) {
    const rr2 = flat.map((zf) => {
      const hwT = halfW(zf) - 0.04 - P.tumble;
      const y = roof(zf) + 0.012;
      const z = Z(zf);
      return [
        [-hwT + 0.02, y - 0.05, z],
        [-hwT + 0.13, y, z],
        [hwT - 0.13, y, z],
        [hwT - 0.02, y - 0.05, z],
      ] as V3[];
    });
    b.painted();
    b.loft(rr2, false, (k) => [0, roof(flat[k]) - 1, Z(flat[k])]);
  }
  // the glasshouse ends (a thin cap where it meets a painted upper or ends vertically)
  // painted upper body (cargo box / sleeper), same section as the glasshouse
  if (P.upper) {
    const top = table(P.upper.top);
    const us: number[] = [];
    const ul = P.upper.z1 - P.upper.z0;
    for (let z = P.upper.z0; z < P.upper.z1 - 1e-6; z += detail ? ul + 1 : Math.max(0.5, ul / 6)) us.push(z);
    for (const [z] of P.upper.top) if (z > P.upper.z0 && z < P.upper.z1) us.push(z);
    us.sort((a, c) => a - c);
    us.push(P.upper.z1);
    const uRing = (zf: number): V3[] => {
      const hwB = halfW(zf) - 0.02;
      const hwT = hwB - P.tumble * 0.5;
      const base = P.upper!.base ?? belt(zf) - 0.01;
      const t = Math.max(base + 0.05, top(zf));
      const z = Z(zf);
      return [
        [-hwB, base, z],
        [-hwT, t - 0.08, z],
        [-hwT + 0.1, t, z],
        [hwT - 0.1, t, z],
        [hwT, t - 0.08, z],
        [hwB, base, z],
      ];
    };
    const uRings = us.map(uRing);
    b.painted();
    b.loft(uRings, false, (k) => [0, belt(us[k]) - 0.5, Z(us[k])]);
    b.poly(uRings[uRings.length - 1], [0, 0, 1]);
    // front face of the upper where it rises above the glasshouse roof
    b.poly(uRings[0], [0, 0, -1]);
  }
  // B pillar
  if (P.bPillar !== undefined && !detail) {
    const zf = P.bPillar;
    const hwB = halfW(zf) - 0.035;
    const hwT = hwB - P.tumble;
    const base = belt(zf);
    const top = roof(zf) - 0.05;
    const z = Z(zf);
    b.solid(HEX.trim, 0.5);
    for (const s of [-1, 1]) b.quad([s * (hwB + 0.004), base, z - 0.06], [s * (hwT + 0.004), top, z - 0.05], [s * (hwT + 0.004), top, z + 0.05], [s * (hwB + 0.004), base, z + 0.06], [s, 0.2, 0]);
  }
  // lamps, grille and plates on the end faces
  const fz = Z(0) - 0.004;
  const rz = Z(P.L) + 0.004;
  const hwF = halfW(0.02);
  const hwR = halfW(P.L - 0.02);
  const [h0, h1] = P.headY;
  b.solid(HEX.head, 0.1, 0.4, LAMP.head);
  for (const s of [-1, 1]) b.quad([s * hwF * 0.5, h0, fz], [s * hwF * 0.86, h0, fz], [s * hwF * 0.86, h1, fz], [s * hwF * 0.5, h1, fz], [0, 0, -1]);
  for (const s of [-1, 1]) {
    b.solid(HEX.ind, 0.2, 0, s < 0 ? LAMP.indL : LAMP.indR);
    b.quad([s * hwF * 0.87, h0, fz], [s * hwF * 0.96, h0, fz], [s * hwF * 0.96, h1, fz], [s * hwF * 0.87, h1, fz], [0, 0, -1]);
  }
  const [g0, g1] = P.grilleY;
  b.solid(HEX.grille, 0.6);
  b.quad([-hwF * 0.45, g0, fz], [hwF * 0.45, g0, fz], [hwF * 0.45, g1, fz], [-hwF * 0.45, g1, fz], [0, 0, -1]);
  if (!P.noTail) {
    const [t0, t1] = P.tailY;
    for (const s of [-1, 1]) {
      b.solid(HEX.tail, 0.18, 0, s < 0 ? LAMP.tailL : LAMP.tailR);
      b.quad([s * hwR * 0.62, t0, rz], [s * hwR * 0.95, t0, rz], [s * hwR * 0.95, t1, rz], [s * hwR * 0.62, t1, rz], [0, 0, 1]);
    }
    if (!detail) {
      b.solid(HEX.plate, 0.5);
      const py = Math.max(P.sill + 0.12, t0 - 0.28);
      b.quad([-0.16, py, rz], [0.16, py, rz], [0.16, py + 0.16, rz], [-0.16, py + 0.16, rz], [0, 0, 1]);
    }
  }
  if (!detail) {
    b.solid(HEX.plate, 0.5);
    const py = Math.max(P.sill + 0.05, g0 - 0.2);
    b.quad([-0.16, py, fz - 0.002], [0.16, py, fz - 0.002], [0.16, py + 0.16, fz - 0.002], [-0.16, py + 0.16, fz - 0.002], [0, 0, -1]);
    // mirrors at the base of the A pillars
    const mz = Z(P.gh[0] + 0.25);
    const my = belt(P.gh[0] + 0.25) + 0.08;
    const hwm = halfW(P.gh[0] + 0.25);
    b.solid(HEX.trim, 0.5);
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -hwm - 0.14 : hwm;
      const x1 = s < 0 ? -hwm : hwm + 0.14;
      b.box(x0, my, mz - 0.05, x1, my + 0.13, mz + 0.07);
    }
  }
  // wheels
  const rim = P.rimHex ?? HEX.rim;
  const xw = hw0 - P.tw / 2 - 0.02;
  for (const s of [-1, 1]) b.wheel(s * xw, P.r, Z(zFront), P.r, P.tw, s, true, detail, rim);
  const rtw = P.rtw ?? P.tw;
  const xr = hw0 - rtw / 2 - 0.02;
  for (const zr of zRears) for (const s of [-1, 1]) b.wheel(s * xr, rr, Z(zr), rr, rtw, s, false, detail, rim, P.dualRear);
}

// ─── the models ───────────────────────────────────────────────────────────────

function carProfile(t: number): BodyProfile {
  const s = SPECS[t];
  const base = { L: s.length, W: s.width, wb: s.wheelbase, fo: s.frontOverhang, r: s.wheelR, tw: 0.24 };
  switch (t) {
    case VT.sedan:
      return {
        ...base,
        sill: 0.2,
        belt: [[0, 0.6], [0.1, 0.73], [0.9, 0.84], [1.75, 0.92], [3.95, 0.97], [4.7, 0.95], [4.85, 0.8]],
        gh: [1.72, 4.02],
        roof: [[1.72, 0.93], [2.5, 1.42], [3.35, 1.44], [4.02, 0.98]],
        tumble: 0.16,
        roundF: 0.4,
        roundR: 0.35,
        headY: [0.56, 0.66],
        tailY: [0.74, 0.88],
        grilleY: [0.32, 0.52],
        bPillar: 2.9,
      };
    case VT.hatch:
      return {
        ...base,
        sill: 0.19,
        belt: [[0, 0.58], [0.1, 0.72], [0.75, 0.84], [1.45, 0.93], [3.95, 1.0], [4.22, 0.98], [4.3, 0.8]],
        gh: [1.42, 4.22],
        roof: [[1.42, 0.94], [2.2, 1.44], [3.75, 1.46], [4.22, 1.04]],
        tumble: 0.15,
        roundF: 0.38,
        roundR: 0.25,
        headY: [0.56, 0.67],
        tailY: [0.84, 1.0],
        grilleY: [0.3, 0.5],
        bPillar: 2.6,
      };
    case VT.suv:
      return {
        ...base,
        tw: 0.26,
        sill: 0.3,
        belt: [[0, 0.7], [0.12, 0.88], [0.9, 1.02], [1.55, 1.08], [4.55, 1.12], [4.78, 0.96]],
        gh: [1.52, 4.62],
        roof: [[1.52, 1.09], [2.25, 1.7], [4.4, 1.72], [4.62, 1.14]],
        tumble: 0.13,
        roundF: 0.4,
        roundR: 0.3,
        headY: [0.78, 0.9],
        tailY: [0.95, 1.1],
        grilleY: [0.45, 0.76],
        darkBumpers: false,
        bPillar: 2.95,
      };
    case VT.pickup:
      return {
        ...base,
        tw: 0.28,
        sill: 0.36,
        belt: [[0, 0.78], [0.14, 1.0], [1.3, 1.12], [1.95, 1.2], [5.72, 1.26], [5.85, 1.14]],
        gh: [1.95, 3.72],
        roof: [[1.95, 1.21], [2.6, 1.88], [3.55, 1.9], [3.72, 1.24]],
        tumble: 0.12,
        roundF: 0.35,
        roundR: 0.12,
        headY: [0.95, 1.08],
        tailY: [0.85, 1.15],
        grilleY: [0.55, 0.95],
        darkBumpers: false,
        rimHex: 0xc2c5c8,
        bPillar: 2.95,
      };
    case VT.van:
    default:
      return {
        ...base,
        tw: 0.25,
        sill: 0.3,
        belt: [[0, 0.72], [0.12, 0.92], [0.8, 1.08], [1.15, 1.12], [5.4, 1.14], [5.5, 1.0]],
        gh: [1.12, 2.3],
        roof: [[1.12, 1.13], [1.95, 2.36], [2.3, 2.42]],
        tumble: 0.08,
        upper: { z0: 2.3, z1: 5.48, top: [[2.3, 2.42], [5.48, 2.45]] },
        roundF: 0.4,
        roundR: 0.12,
        headY: [0.9, 1.04],
        tailY: [0.9, 1.3],
        grilleY: [0.5, 0.86],
        darkBumpers: true,
        rimHex: 0x9a9ea2,
      };
  }
}

function pickupBed(b: Builder, detail: number): void {
  const s = SPECS[VT.pickup];
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const z0 = 3.8 - zOff;
  const z1 = 5.72 - zOff;
  const hw = s.width / 2 - 0.12;
  // the open bed seen from above: a dark liner inside the painted rails
  const y = 1.3;
  b.solid(0x1c1d1f, 0.85);
  b.quad([-hw + 0.02, y, z0], [hw - 0.02, y, z0], [hw - 0.02, y, z1], [-hw + 0.02, y, z1], [0, 1, 0]);
  if (!detail) {
    b.solid(0x0c0c0d, 0.9);
    b.quad([-hw + 0.1, y + 0.003, z0 + 0.08], [hw - 0.1, y + 0.003, z0 + 0.08], [hw - 0.1, y + 0.003, z1 - 0.08], [-hw + 0.1, y + 0.003, z1 - 0.08], [0, 1, 0]);
  }
}

function boxTruck(b: Builder, detail: number): void {
  const s = SPECS[VT.box];
  const cabL = 2.35;
  body(
    b,
    {
      L: cabL,
      W: 2.3,
      wb: s.wheelbase,
      fo: s.frontOverhang,
      r: s.wheelR,
      tw: 0.3,
      rtw: 0.52,
      sill: 0.62,
      belt: [[0, 0.95], [0.12, 1.2], [0.75, 1.36], [1.0, 1.42], [cabL, 1.42]],
      gh: [0.98, 2.05],
      roof: [[0.98, 1.43], [1.5, 2.72], [2.05, 2.76]],
      tumble: 0.1,
      upper: { z0: 2.05, z1: cabL, top: [[2.05, 2.76], [cabL, 2.76]] },
      roundF: 0.3,
      roundR: 0.05,
      headY: [1.0, 1.16],
      tailY: [0, 0],
      grilleY: [0.62, 0.95],
      darkBumpers: true,
      rimHex: HEX.truckRim,
      noTail: true,
      dualRear: true,
    },
    detail,
  );
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const Z = (zf: number) => zf - zOff;
  const hw = s.width / 2;
  // chassis rails and the box body
  b.solid(HEX.trim, 0.7);
  b.box(-0.5, 0.55, Z(cabL - 0.05), 0.5, 0.95, Z(s.length - 0.1));
  b.solid(HEX.box, 0.55);
  const bz0 = Z(cabL + 0.18);
  const bz1 = Z(s.length);
  b.box(-hw, 1.02, bz0, hw, s.height, bz1);
  if (!detail) {
    // roll-up door slats and the frame
    b.solid(0xb8b8b4, 0.6);
    for (let k = 1; k < 7; k++) {
      const y = 1.1 + k * 0.32;
      b.quad([-hw + 0.1, y, bz1 + 0.005], [hw - 0.1, y, bz1 + 0.005], [hw - 0.1, y + 0.025, bz1 + 0.005], [-hw + 0.1, y + 0.025, bz1 + 0.005], [0, 0, 1]);
    }
    b.solid(HEX.trim, 0.6);
    b.box(-hw, 0.62, bz1 - 0.15, hw, 0.8, bz1 + 0.05);
  }
  for (const sd of [-1, 1]) {
    b.solid(HEX.tail, 0.18, 0, sd < 0 ? LAMP.tailL : LAMP.tailR);
    b.quad([sd * (hw - 0.3), 1.05, bz1 + 0.01], [sd * (hw - 0.05), 1.05, bz1 + 0.01], [sd * (hw - 0.05), 1.3, bz1 + 0.01], [sd * (hw - 0.3), 1.3, bz1 + 0.01], [0, 0, 1]);
  }
}

function semiTractor(b: Builder, detail: number): void {
  const s = SPECS[VT.semi];
  const L = 6.3;
  const cabEnd = 4.85;
  const tandem = 0.66;
  body(
    b,
    {
      L: cabEnd,
      W: s.width,
      wb: s.wheelbase,
      fo: s.frontOverhang,
      r: s.wheelR,
      tw: 0.32,
      rtw: 0.56,
      sill: 0.72,
      belt: [[0, 0.95], [0.14, 1.28], [1.9, 1.5], [2.1, 1.66], [cabEnd, 1.66]],
      gh: [2.1, 3.3],
      roof: [[2.1, 1.67], [2.4, 2.92], [3.3, 3.02]],
      tumble: 0.14,
      upper: { z0: 3.3, z1: cabEnd, top: [[3.3, 3.05], [3.55, 3.95], [cabEnd, 4.0]] },
      roundF: 0.5,
      roundR: 0.1,
      headY: [1.05, 1.22],
      tailY: [0, 0],
      grilleY: [0.75, 1.42],
      darkBumpers: false,
      rimHex: HEX.truckRim,
      noTail: true,
      rearAxles: [-tandem, tandem],
      dualRear: true,
      coarseArches: true,
    },
    detail,
  );
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const Z = (zf: number) => zf - zOff;
  // chrome grille over the painted nose, frame, fifth wheel
  b.solid(HEX.chrome, 0.2, 1);
  if (!detail) b.quad([-0.55, 0.78, Z(0) - 0.01], [0.55, 0.78, Z(0) - 0.01], [0.55, 1.38, Z(0) - 0.01], [-0.55, 1.38, Z(0) - 0.01], [0, 0, -1]);
  b.solid(HEX.trim, 0.7);
  b.box(-0.5, 0.75, Z(cabEnd - 0.1), 0.5, 1.05, Z(L), detail ? 'df' : '');
  b.solid(0x202224, 0.5, 0.4);
  b.box(-0.65, 1.05, Z(cabEnd + 0.1), 0.65, 1.14, Z(L - 0.2), detail ? 'dlrfb' : '');
  // fuel tanks and exhaust stacks
  b.solid(HEX.chrome, 0.18, 1);
  if (!detail) {
    for (const sd of [-1, 1]) b.cylinder('z', [sd * (s.width / 2 - 0.32), 0.78, Z(2.75)], 0.3, 1.3, 8, true);
    for (const sd of [-1, 1]) b.cylinder('y', [sd * 0.95, 2.95, Z(cabEnd + 0.08)], 0.085, 2.3, 6, false);
  }
  // mud flaps
  if (!detail) {
    b.solid(HEX.trim, 0.8);
    for (const sd of [-1, 1]) b.box(sd * (s.width / 2 - 0.55) - 0.28, 0.2, Z(L - 0.1), sd * (s.width / 2 - 0.55) + 0.28, 0.85, Z(L - 0.07));
  }
}

function trailer(b: Builder, detail: number): void {
  const wb = TRAILER_WHEELBASE;
  const zF = -wb / 2 - (SEMI.kingpin - SEMI.trailerFront);
  const zR = wb / 2 + (SEMI.trailerRear - SEMI.trailerAxle);
  const hw = SEMI.trailerWidth / 2;
  const y0 = 1.25;
  const y1 = SEMI.trailerHeight;
  // the box: painted sides and roof, a darker front, rear doors
  b.painted(0.5);
  b.quad([-hw, y0, zF], [-hw, y0, zR], [-hw, y1, zR], [-hw, y1, zF], [-1, 0, 0]);
  b.quad([hw, y0, zF], [hw, y0, zR], [hw, y1, zR], [hw, y1, zF], [1, 0, 0]);
  b.quad([-hw, y1, zF], [hw, y1, zF], [hw, y1, zR], [-hw, y1, zR], [0, 1, 0]);
  b.quad([-hw, y0, zF], [hw, y0, zF], [hw, y1, zF], [-hw, y1, zF], [0, 0, -1]);
  b.solid(0xd6d6d2, 0.55);
  b.quad([-hw, y0, zR], [hw, y0, zR], [hw, y1, zR], [-hw, y1, zR], [0, 0, 1]);
  b.solid(0x3a3b3d, 0.7);
  b.quad([-hw, y0, zF], [hw, y0, zF], [hw, y0, zR], [-hw, y0, zR], [0, -1, 0]);
  // rails, corner posts, logistics posts, door seam
  b.solid(0x8d9093, 0.4, 0.6);
  for (const sd of [-1, 1]) {
    const x = sd * (hw + 0.012);
    b.quad([x, y0, zF], [x, y0, zR], [x, y0 + 0.14, zR], [x, y0 + 0.14, zF], [sd, 0, 0]);
    b.quad([x, y1 - 0.1, zF], [x, y1 - 0.1, zR], [x, y1, zR], [x, y1, zF], [sd, 0, 0]);
    if (!detail) {
      for (let z = zF + 1.2; z < zR - 0.5; z += 1.22) b.quad([x, y0 + 0.14, z - 0.035], [x, y0 + 0.14, z + 0.035], [x, y1 - 0.1, z + 0.035], [x, y1 - 0.1, z - 0.035], [sd, 0, 0]);
    }
  }
  if (!detail) {
    b.solid(0x55585b, 0.5, 0.5);
    b.quad([-0.02, y0 + 0.1, zR + 0.006], [0.02, y0 + 0.1, zR + 0.006], [0.02, y1 - 0.1, zR + 0.006], [-0.02, y1 - 0.1, zR + 0.006], [0, 0, 1]);
    // landing gear
    b.solid(HEX.trim, 0.7);
    for (const sd of [-1, 1]) b.box(sd * 0.95 - 0.07, 0.25, zF + 3.6, sd * 0.95 + 0.07, y0, zF + 3.75);
    // underride guard and chassis
    b.box(-hw + 0.1, 0.45, zR - 0.4, hw - 0.1, 0.62, zR - 0.28);
  }
  b.solid(HEX.trim, 0.7);
  b.box(-0.55, 0.9, wb / 2 - 1.6, 0.55, y0, wb / 2 + 1.6);
  // tail lamps
  for (const sd of [-1, 1]) {
    b.solid(HEX.tail, 0.18, 0, sd < 0 ? LAMP.tailL : LAMP.tailR);
    b.quad([sd * (hw - 0.45), y0 + 0.02, zR + 0.012], [sd * (hw - 0.08), y0 + 0.02, zR + 0.012], [sd * (hw - 0.08), y0 + 0.2, zR + 0.012], [sd * (hw - 0.45), y0 + 0.2, zR + 0.012], [0, 0, 1]);
  }
  // tandem axles, dual wheels
  const r = SEMI.trailerWheelR;
  for (const o of [-0.65, 0.65]) for (const sd of [-1, 1]) b.wheel(sd * (hw - 0.3), r, wb / 2 + o, r, 0.56, sd, false, detail, HEX.truckRim, true);
}

function bus(b: Builder, detail: number): void {
  const s = SPECS[VT.bus];
  const L = s.length;
  body(
    b,
    {
      L,
      W: s.width,
      wb: s.wheelbase,
      fo: s.frontOverhang,
      r: s.wheelR,
      tw: 0.3,
      rtw: 0.52,
      sill: 0.42,
      belt: [[0, 1.0], [0.1, 1.16], [L - 0.1, 1.2], [L, 1.12]],
      gh: [0.06, L - 0.06],
      roof: [[0.06, 1.2], [0.15, 2.5], [L - 0.15, 2.5], [L - 0.06, 1.25]],
      tumble: 0.02,
      upper: { z0: 0.06, z1: L - 0.06, top: [[0.06, 2.55], [0.4, s.height], [L - 0.4, s.height], [L - 0.06, 2.55]], base: 2.45 },
      roundF: 0.25,
      roundR: 0.2,
      headY: [0.7, 0.86],
      tailY: [0.8, 1.05],
      grilleY: [0.45, 0.66],
      darkBumpers: true,
      rimHex: HEX.truckRim,
      dualRear: true,
    },
    detail,
  );
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const Z = (zf: number) => zf - zOff;
  const hw = s.width / 2;
  // windscreen, door, rub rails
  b.solid(HEX.glass, 0.04);
  b.quad([-hw + 0.12, 1.15, Z(0) - 0.01], [hw - 0.12, 1.15, Z(0) - 0.01], [hw - 0.12, 2.75, Z(0) - 0.01], [-hw + 0.12, 2.75, Z(0) - 0.01], [0, 0, -1]);
  b.solid(0x151617, 0.4);
  b.quad([hw + 0.005, 0.45, Z(0.35)], [hw + 0.005, 0.45, Z(1.45)], [hw + 0.005, 2.45, Z(1.45)], [hw + 0.005, 2.45, Z(0.35)], [1, 0, 0]);
  if (!detail) {
    b.solid(HEX.trim, 0.5);
    for (const sd of [-1, 1])
      for (const y of [0.62, 0.9])
        b.quad([sd * (hw + 0.006), y, Z(sd > 0 ? 1.5 : 0.3)], [sd * (hw + 0.006), y, Z(L - 0.2)], [sd * (hw + 0.006), y + 0.05, Z(L - 0.2)], [sd * (hw + 0.006), y + 0.05, Z(sd > 0 ? 1.5 : 0.3)], [sd, 0, 0]);
    // window pillars
    for (const sd of [-1, 1])
      for (let z = 2.0; z < L - 0.8; z += 1.25) b.quad([sd * (hw - 0.01), 1.22, Z(z - 0.05)], [sd * (hw - 0.01), 1.22, Z(z + 0.05)], [sd * (hw - 0.01), 2.45, Z(z + 0.05)], [sd * (hw - 0.01), 2.45, Z(z - 0.05)], [sd, 0, 0]);
  }
}

function farmTractor(b: Builder, detail: number): void {
  const s = SPECS[VT.tractor];
  const zF = -s.wheelbase / 2;
  const zR = s.wheelbase / 2;
  const front = zF - s.frontOverhang;
  const back = zR + (s.length - s.frontOverhang - s.wheelbase);
  // frame and hood
  b.solid(HEX.trim, 0.7);
  b.box(-0.35, 0.45, front + 0.1, 0.35, 0.85, zR);
  b.painted(0.42);
  b.box(-0.42, 0.85, front + 0.05, 0.42, 1.52, zR - 1.05);
  b.solid(HEX.grille, 0.7);
  b.quad([-0.36, 0.9, front + 0.04], [0.36, 0.9, front + 0.04], [0.36, 1.45, front + 0.04], [-0.36, 1.45, front + 0.04], [0, 0, -1]);
  b.solid(HEX.head, 0.1, 0.4, LAMP.head);
  for (const sd of [-1, 1]) b.quad([sd * 0.2 - 0.07, 1.3, front + 0.035], [sd * 0.2 + 0.07, 1.3, front + 0.035], [sd * 0.2 + 0.07, 1.4, front + 0.035], [sd * 0.2 - 0.07, 1.4, front + 0.035], [0, 0, -1]);
  // cab: glass box with dark posts and a painted roof
  const c0 = zR - 1.15;
  const c1 = back - 0.2;
  const cw = 0.72;
  b.solid(HEX.glass, 0.05);
  b.box(-cw, 1.5, c0, cw, 2.78, c1, 'd');
  b.solid(HEX.trim, 0.6);
  for (const x of [-cw - 0.01, cw - 0.05]) for (const z of [c0 - 0.01, c1 - 0.05]) b.box(x, 1.5, z, x + 0.06, 2.78, z + 0.06);
  b.painted(0.45);
  b.box(-cw - 0.06, 2.78, c0 - 0.08, cw + 0.06, s.height, c1 + 0.08);
  // rear fenders, seat base, exhaust
  for (const sd of [-1, 1]) b.box(sd > 0 ? cw : -1.2, 1.52, zR - 0.95, sd > 0 ? 1.2 : -cw, 1.6, zR + 0.85);
  b.solid(HEX.trim, 0.7);
  b.box(-cw, 0.95, c0, cw, 1.5, c1);
  b.cylinder('y', [0.3, 2.2, zF + 0.4], 0.05, 1.4, detail ? 5 : 8, false);
  // tail lamps on the fenders
  for (const sd of [-1, 1]) {
    b.solid(HEX.tail, 0.2, 0, sd < 0 ? LAMP.tailL : LAMP.tailR);
    b.quad([sd * 1.18 - 0.08, 1.45, zR + 0.86], [sd * 1.18 + 0.02, 1.45, zR + 0.86], [sd * 1.18 + 0.02, 1.55, zR + 0.86], [sd * 1.18 - 0.08, 1.55, zR + 0.86], [0, 0, 1]);
  }
  // wheels: small steered fronts, big rears
  const rimT = 0xc9c3b0;
  for (const sd of [-1, 1]) b.wheel(sd * 0.78, s.wheelR, zF, s.wheelR, 0.3, sd, true, detail, rimT);
  for (const sd of [-1, 1]) b.wheel(sd * (s.width / 2 - 0.23), s.wheelRRear, zR, s.wheelRRear, 0.46, sd, false, detail, rimT);
}

/** Geometry of model m (VT id, or MODEL_TRAILER) at level of detail 0 (near) or 1 (far). */
export function buildVehicleGeometry(m: number, detail: number): THREE.BufferGeometry {
  const b = new Builder();
  switch (m) {
    case VT.box:
      boxTruck(b, detail);
      break;
    case VT.semi:
      semiTractor(b, detail);
      break;
    case MODEL_TRAILER:
      trailer(b, detail);
      break;
    case VT.bus:
      bus(b, detail);
      break;
    case VT.tractor:
      farmTractor(b, detail);
      break;
    default:
      body(b, carProfile(m), detail);
      if (m === VT.pickup) pickupBed(b, detail);
  }
  return b.toGeometry();
}

/** Lamp positions in the model frame for the glow sprites: heads (front, ±x) and tails (rear, ±x). */
export function lampAnchors(m: number): { head: V3 | null; tail: V3 } {
  if (m === MODEL_TRAILER) {
    const zR = TRAILER_WHEELBASE / 2 + (SEMI.trailerRear - SEMI.trailerAxle);
    return { head: null, tail: [SEMI.trailerWidth / 2 - 0.27, 1.36, zR + 0.05] };
  }
  const s = SPECS[m];
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const zFront = -zOff - 0.05;
  const zRear = s.length - zOff + 0.05;
  switch (m) {
    case VT.box:
      return { head: [0.78, 1.08, zFront], tail: [1.02, 1.18, SPECS[VT.box].length - zOff + 0.05] };
    case VT.semi:
      return { head: [0.9, 1.14, zFront], tail: [0, 0, 0] };
    case VT.bus:
      return { head: [0.95, 0.78, zFront], tail: [1.05, 0.92, zRear] };
    case VT.tractor:
      return { head: [0.2, 1.35, -s.wheelbase / 2 - s.frontOverhang], tail: [1.15, 1.5, s.wheelbase / 2 + 0.9] };
    default: {
      const P = carProfile(m);
      return { head: [(s.width / 2) * 0.68 * 0.9, (P.headY[0] + P.headY[1]) / 2, zFront], tail: [(s.width / 2) * 0.78 * 0.9, (P.tailY[0] + P.tailY[1]) / 2, zRear] };
    }
  }
}
