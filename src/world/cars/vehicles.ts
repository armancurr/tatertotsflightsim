/**
 * Procedural vehicle models (no assets): sedan, hatchback, SUV, pickup, cargo
 * van, box truck, semi tractor + 53 ft trailer, bus and a farm tractor, each in
 * two levels of detail (0 = near, ≤ ~2,000 triangles; 1 = far, ≤ 300). Real
 * proportions from specs.ts.
 *
 * Model frame: +X right, +Y up, −Z front; origin on the ground midway between
 * the axles. A body is two sculpted lofts of cross-sections along the length,
 * each quad with its own material so every edge between paint, glass and trim
 * is crisp while the panels stay smoothly shaded:
 *   - the lower body: tucked-under sills, a door bulge, a shoulder crease, a
 *     crowned hood and deck; the plan and the profile round off at both ends;
 *     the lower edge rises over the wheel arches (dark well liners inside);
 *     a pick-up's bed is a recessed tub with a liner;
 *   - the glasshouse: a black belt seal, side windows between pillars (black
 *     B pillars, painted C/D pillars), the painted roof rail that is the A
 *     pillar, a windscreen and a rear window, a crowned roof.
 * Then lamps that wrap around the corners, grille, intake, plates, door shut
 * lines and handles, mirrors, and lathed wheels (tyre with a bulging sidewall,
 * a dished alloy or a steel truck rim).
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
  tyre: 0x161616,
  rim: 0xb5b9bd,
  truckRim: 0xcfd1d2,
  trim: 0x19191b,
  gloss: 0x0a0b0c,
  chrome: 0xd0d3d6,
  under: 0x0d0d0d,
  head: 0xd4d8db,
  tail: 0x5a0909,
  ind: 0xa3600d,
  plate: 0xe2e0d4,
  box: 0xe9e9e5,
  grille: 0x111213,
  wellLiner: 0x0a0a0a,
  liner: 0x1c1d1f,
  gap: 0x040404,
  disc: 0x2b2c2d,
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

/** A surface material: body paint, or a solid colour (roughness, metalness, lamp kind). */
export interface Mt {
  paint: boolean;
  hex: number;
  rough: number;
  metal: number;
  lamp: number;
}
const solidM = (hex: number, rough: number, metal = 0, lamp: number = LAMP.none): Mt => ({ paint: false, hex, rough, metal, lamp });
const PAINT: Mt = { paint: true, hex: 0xffffff, rough: 0.38, metal: 0, lamp: 0 };
const GLASS = solidM(HEX.glass, 0.05);
const TRIM = solidM(HEX.trim, 0.55);
const GLOSS = solidM(HEX.gloss, 0.22);
const LINER = solidM(HEX.liner, 0.88);
const CHROME = solidM(HEX.chrome, 0.16, 1);
const GAP = solidM(HEX.gap, 0.7);

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
  use(m: Mt): this {
    return m.paint ? this.painted(m.rough) : this.solid(m.hex, m.rough, m.metal, m.lamp);
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

  /**
   * A lofted surface with crisp materials. `rings[k]` (all the same length, open) are stations
   * along +z; each ring runs from the right (+x) bottom over the top to the left bottom, so a
   * quad's normal (ring tangent × loft tangent) faces out. Normals are smooth across ring
   * segments of the same smoothing group `grp(k, j)` (segment j joins points j and j + 1) and
   * along the loft except across crease stations. `pick(k, j)` is the material of the quad
   * between stations k, k + 1 and points j, j + 1 (null: leave the quad out). Every quad has its
   * own four vertices, so materials never bleed across an edge.
   */
  sculpt(rings: V3[][], grp: (k: number, j: number) => number, crease: (k: number) => boolean, pick: (k: number, j: number) => Mt | null): this {
    const nk = rings.length;
    const n = rings[0].length;
    const nv: number[] = [0, 0, 0];
    const normal = (k: number, j: number, kq: number, jq: number, fx: number, fy: number, fz: number): void => {
      let ja: number;
      let jb: number;
      if (j === jq) {
        ja = j > 0 && grp(k, j - 1) === grp(k, jq) ? j - 1 : j;
        jb = j + 1;
      } else {
        ja = jq;
        jb = j + 1 < n && grp(k, j) === grp(k, jq) ? j + 1 : j;
      }
      let ka: number;
      let kb: number;
      if (k === kq) {
        ka = k > 0 && !crease(k) ? k - 1 : k;
        kb = k + 1;
      } else {
        ka = kq;
        kb = k + 1 < nk && !crease(k) ? k + 1 : k;
      }
      const A = rings[k][ja];
      const B = rings[k][jb];
      const C = rings[ka][j];
      const D = rings[kb][j];
      const tx = B[0] - A[0];
      const ty = B[1] - A[1];
      const tz = B[2] - A[2];
      const ux = D[0] - C[0];
      const uy = D[1] - C[1];
      const uz = D[2] - C[2];
      let x = ty * uz - tz * uy;
      let y = tz * ux - tx * uz;
      let z = tx * uy - ty * ux;
      let l = Math.hypot(x, y, z);
      // degenerate (a collapsed ring edge) or folded back against the face: use the face normal
      if (l < 1e-9 || (x * fx + y * fy + z * fz) / l < 0.2) {
        x = fx;
        y = fy;
        z = fz;
        l = 1;
      }
      nv[0] = x / l;
      nv[1] = y / l;
      nv[2] = z / l;
    };
    for (let k = 0; k + 1 < nk; k++)
      for (let j = 0; j + 1 < n; j++) {
        const m = pick(k, j);
        if (!m) continue;
        const a = rings[k][j];
        const b = rings[k][j + 1];
        const c = rings[k + 1][j + 1];
        const d = rings[k + 1][j];
        // face normal (c − a) × (d − b)
        const px = c[0] - a[0];
        const py = c[1] - a[1];
        const pz = c[2] - a[2];
        const qx = d[0] - b[0];
        const qy = d[1] - b[1];
        const qz = d[2] - b[2];
        let fx = py * qz - pz * qy;
        let fy = pz * qx - px * qz;
        let fz = px * qy - py * qx;
        const fl = Math.hypot(fx, fy, fz);
        if (fl < 1e-9) continue;
        fx /= fl;
        fy /= fl;
        fz /= fl;
        this.use(m);
        const ids: number[] = [];
        for (const [kk, jj, p] of [
          [k, j, a],
          [k, j + 1, b],
          [k + 1, j + 1, c],
          [k + 1, j, d],
        ] as [number, number, V3][]) {
          normal(kk, jj, k, j, fx, fy, fz);
          ids.push(this.v(p[0], p[1], p[2], nv[0], nv[1], nv[2]));
        }
        this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
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
   * A wheel at hub (x, y, z): a lathed tyre (tread, shoulder, a sidewall that
   * bulges out and turns in to the rim) and on its outer face a dished alloy
   * (lip, dark barrel, `spokes` spokes, centre cap), a steel truck rim
   * (`spokes` = 0: a disc with hand-hole ring and hub) or, at detail 1, a disc.
   * side = +1 right (outer face +X), −1 left.
   */
  wheel(x: number, y: number, z: number, r: number, tw: number, side: number, front: boolean, detail: number, rimHex = HEX.rim, dual = false, spokes = 5): this {
    this.wheelOn(x, y, z, front ? -r : r);
    const seg = detail ? 6 : dual ? 10 : 12;
    const rimR = r * (spokes ? 0.66 : 0.6);
    const prof: Key[] = detail
      ? [
          [-tw / 2, r],
          [tw / 2, r],
        ]
      : [
          [-tw / 2, r],
          [tw / 2 - 0.03, r],
          [tw / 2 - 0.004, r * 0.955],
          [tw / 2 + 0.006, r * 0.83],
          [tw / 2 - 0.004, rimR * 1.05],
        ];
    const rings: V3[][] = prof.map(([xo, rr]) => {
      const out: V3[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        out.push([x + side * xo, y + Math.cos(a) * rr, z + Math.sin(a) * rr]);
      }
      return out;
    });
    this.solid(HEX.tyre, 0.9);
    this.loft(rings, true, (k) => [x + side * prof[k][0] - side * 0.3, y, z]);
    const disc = (rr: number, xx: number, n: number, a0 = 0.3): V3[] => {
      const out: V3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + a0;
        out.push([xx, y + Math.cos(a) * rr, z + Math.sin(a) * rr]);
      }
      return out;
    };
    const outN: V3 = [side, 0, 0];
    const fx = x + side * (tw / 2 - 0.004);
    if (detail) {
      this.solid(0x3a3c3e, 0.6, 0.3);
      this.poly(disc(r * 0.8, x + side * (tw / 2), seg), outN);
      this.wheelOff();
      return this;
    }
    // rim lip: a bright cone from the tyre bead in to the barrel
    this.solid(rimHex, 0.26, 0.85);
    this.loft([disc(rimR * 1.05, fx, seg), disc(rimR * 0.9, fx - side * 0.018, seg)], true, () => [fx - side * 0.5, y, z]);
    if (spokes) {
      // dark barrel with the brake disc behind the spokes
      this.solid(HEX.disc, 0.7, 0.4);
      this.poly(disc(rimR * 0.9, fx - side * (dual ? 0.03 : 0.07), seg), outN);
      // dished spokes: wide at the hub, raised toward the centre
      this.solid(rimHex, 0.26, 0.85);
      for (let k = 0; k < spokes; k++) {
        const a = (k / spokes) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const px = -sa;
        const pz = ca;
        const r0 = r * 0.17;
        const r1 = rimR * 0.9;
        const w0 = r * 0.1;
        const w1 = r * 0.065;
        const x0 = fx - side * 0.004;
        const x1 = fx - side * 0.02;
        this.quad([x0, y + ca * r0 + px * w0, z + sa * r0 + pz * w0], [x1, y + ca * r1 + px * w1, z + sa * r1 + pz * w1], [x1, y + ca * r1 - px * w1, z + sa * r1 - pz * w1], [x0, y + ca * r0 - px * w0, z + sa * r0 - pz * w0], outN);
      }
      this.solid(HEX.gloss, 0.3, 0.2);
      this.poly(disc(r * 0.17, fx - side * 0.002, 6), outN);
    } else {
      // steel truck wheel: a pressed disc, a dark ring of hand holes, a hub with the nut circle
      this.solid(rimHex, 0.35, 0.7);
      this.poly(disc(rimR * 0.9, fx - side * 0.03, seg), outN);
      this.solid(0x2a2b2c, 0.7, 0.3);
      this.loft([disc(rimR * 0.78, fx - side * 0.028, seg), disc(rimR * 0.62, fx - side * 0.028, seg)], true, () => [fx - side * 0.5, y, z]);
      this.solid(HEX.chrome, 0.25, 0.9);
      this.poly(disc(r * 0.24, fx - side * 0.012, 8), outN);
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

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** Quarter-circle rounding: 0 at the very end, 1 once `e` reaches 1. */
const circ = (e: number) => Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e)));

export interface BodyProfile {
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
  /** Glasshouse (windows, pillars, roof, a van's cargo box, a sleeper) over [gh0, gh1] up to `roof`. */
  gh: [number, number];
  roof: Key[];
  /** Inset of the window tops from the belt (tumblehome), m. */
  tumble: number;
  /** Side window openings along zf; gaps between them under 0.3 m are black pillars, wider ones painted. */
  windows: [number, number][];
  /** Windscreen from gh0 to `ws`, rear window from `bl` to gh1 (glass on top). */
  ws: number;
  bl: number;
  /** Painted band between the window tops and the roof edge, m (default 0.06). */
  railH?: number;
  /** Plan rounding lengths at the front / rear, and the width of the end faces (fraction). */
  roundF: number;
  roundR: number;
  endW?: number;
  /** Hood / deck crown, m. */
  crown?: number;
  /** Headlamp, tail lamp and grille bands (y0, y1). */
  headY: [number, number];
  tailY: [number, number];
  grilleY: [number, number];
  /** Unpainted (black plastic) bumpers; black cladding along the sills and arches. */
  darkBumpers?: boolean;
  /** Chrome bumper bars across both end faces (pick-ups). */
  chromeBumpers?: boolean;
  cladding?: boolean;
  /** Pick-up bed: zf from, zf to, floor height. */
  bed?: [number, number, number];
  /** Door shut lines along zf (handles just ahead of every line but the first). */
  doors?: number[];
  /** Painted glasshouse end faces (a van's rear doors, a cab's back wall, a bus front). */
  rimHex?: number;
  spokes?: number;
  /** Rear axle(s): offsets from the rear axle centre (tandems), default [0]. */
  rearAxles?: number[];
  dualRear?: boolean;
  /** Skip the rear lamps (the trailer carries them). */
  noTail?: boolean;
  /** Fewer stations around the wheel arches (big vehicles). */
  coarseArches?: boolean;
  roofRails?: boolean;
  /** Mirrors: 'car' (painted housings on the doors), 'truck' (tall black mirrors on arms). */
  mirrors?: 'car' | 'truck';
  /** Wrap length of the lamps around the corners, m. */
  wrap?: number;
}

/** Helpers for adding details on a body (the surface functions of the built lofts). */
export interface BodyFrame {
  P: BodyProfile;
  /** Model z of zf. */
  Z: (zf: number) => number;
  /** Top of the lower body (with the end rounding) and its bottom at zf. */
  top: (zf: number) => number;
  bottom: (zf: number) => number;
  /** Half width of the lower body at (zf, y). */
  sideX: (zf: number, y: number) => number;
  /** Roof height at zf (glasshouse). */
  roofAt: (zf: number) => number;
}

function body(b: Builder, P: BodyProfile, detail: number): BodyFrame {
  const hw0 = P.W / 2;
  const zOff = P.fo + P.wb / 2; // model z = zf − zOff
  const Z = (zf: number) => zf - zOff;
  const belt = table(P.belt);
  const roof = table(P.roof);
  const archR = P.r + 0.06;
  const rr = P.rr ?? P.r;
  const archRR = rr + 0.06;
  const zFront = P.fo;
  const rearAxles = P.rearAxles ?? [0];
  const zRears = rearAxles.map((o) => P.fo + P.wb + o);
  const endW = P.endW ?? 0.8;
  const soft = (1 - endW) / 0.2;
  const crown = P.crown ?? 0.04;
  const railH = P.railH ?? 0.06;
  const [gh0, gh1] = P.gh;
  const endE = (zf: number) => circ(clamp01(Math.min(zf / P.roundF, (P.L - zf) / P.roundR)));
  const halfW = (zf: number): number => hw0 * (endW + (1 - endW) * endE(zf));
  const bottom = (zf: number): number => {
    let y = P.sill + (zf < P.L / 2 ? 0.08 : 0.1) * soft * (1 - endE(zf));
    if (detail) return y;
    const dF = Math.abs(zf - zFront);
    if (dF < archR) y = Math.max(y, P.r + Math.sqrt(archR * archR - dF * dF));
    for (const zr of zRears) {
      const d = Math.abs(zf - zr);
      if (d < archRR) y = Math.max(y, rr + Math.sqrt(archRR * archRR - d * d));
    }
    return y;
  };
  const top = (zf: number): number => Math.max(bottom(zf) + 0.1, belt(zf) - (zf < P.L / 2 ? 0.05 : 0.07) * soft * (1 - endE(zf)));
  const bed = P.bed;
  const inBed = (zf: number) => !!bed && zf > bed[0] - 1e-6 && zf < bed[1] + 1e-6;
  const lowerHalf = (zf: number): [number, number][] => {
    const hw = halfW(zf);
    const yb = bottom(zf);
    const yt = top(zf);
    const h = yt - yb;
    const out: [number, number][] = [
      [hw * 0.92, yb],
      [hw, yb + 0.45 * h],
      [hw * 0.986, yt - Math.min(0.08, 0.2 * h)],
      [hw * 0.94, yt],
    ];
    if (inBed(zf)) out.push([hw * 0.885, yt + 0.004], [hw * 0.87, bed![2]], [0, bed![2]]);
    else out.push([hw * 0.72, yt + crown * 0.48], [hw * 0.38, yt + crown * 0.86], [0, yt + crown]);
    return out;
  };
  const sideX = (zf: number, y: number): number => {
    const h = lowerHalf(zf);
    if (y <= h[0][1]) return h[0][0];
    for (let i = 1; i < 4; i++) if (y <= h[i][1]) return h[i - 1][0] + ((h[i][0] - h[i - 1][0]) * (y - h[i - 1][1])) / Math.max(1e-6, h[i][1] - h[i - 1][1]);
    return h[3][0];
  };
  /** Full ring from a half section (right side up to the centre, then down the left). */
  const mirrorRing = (half: [number, number][], z: number, sel: readonly number[]): V3[] => {
    const hs = sel.map((i) => half[i]);
    const out: V3[] = hs.map(([x, y]) => [x, y, z] as V3);
    for (let i = hs.length - 2; i >= 0; i--) out.push([-hs[i][0], hs[i][1], z]);
    return out;
  };
  /** Half-segment index of ring segment j (ring of 2n − 1 points). */
  const halfSeg = (j: number, n: number) => (j < n - 1 ? j : 2 * n - 3 - j);

  // ── stations ──
  const wrapF = P.wrap ?? Math.min(0.3, P.roundF * 0.8);
  const wrapR = P.wrap ?? Math.min(0.28, P.roundR * 0.9);
  const st = new Set<number>();
  const step = detail ? Math.max(1.0, P.L / 5) : Math.max(P.coarseArches ? 0.6 : 0.42, P.L / 12);
  for (let z = 0; z <= P.L + 1e-6; z += step) st.add(Math.min(P.L, z));
  st.add(P.L);
  if (!detail) {
    for (const f of [0.18, 0.5]) {
      st.add(f * P.roundF);
      st.add(P.L - f * P.roundR);
    }
    for (const k of P.coarseArches ? [-1, -0.45, 0.45, 1] : [-1, -0.6, 0, 0.6, 1]) {
      st.add(zFront + k * archR);
      for (const zr of zRears) st.add(zr + k * archRR);
    }
    for (const [z] of P.belt) st.add(z);
    st.add(P.roundF);
    st.add(P.L - P.roundR);
    st.add(wrapF);
    st.add(P.L - wrapR);
  }
  const creaseZ = new Set<number>();
  if (bed) {
    for (const z of [bed[0] - 0.012, bed[0], bed[1], bed[1] + 0.012]) {
      st.add(z);
      creaseZ.add(Math.round(z * 1e4));
    }
  }
  const zs = [...st].filter((z) => z >= 0 && z <= P.L).sort((a, c) => a - c);
  // drop near-duplicates
  const zsU: number[] = [];
  for (const z of zs) {
    const crease = creaseZ.has(Math.round(z * 1e4));
    if (zsU.length && z - zsU[zsU.length - 1] < (detail ? 0.004 : 0.05) && !crease && z < P.L) continue;
    if (zsU.length && z === P.L && P.L - zsU[zsU.length - 1] < 0.05 && !creaseZ.has(Math.round(zsU[zsU.length - 1] * 1e4))) zsU.pop();
    zsU.push(z);
  }

  // ── the lower body ──
  const lowSel = detail ? [0, 1, 3, 6] : [0, 1, 2, 3, 4, 5, 6];
  const lowN = lowSel.length;
  const rings = zsU.map((zf) => mirrorRing(lowerHalf(zf), Z(zf), lowSel));
  const bumperZone = (zm: number) => zm < Math.min(0.3, P.fo * 0.4) || zm > P.L - 0.28;
  b.sculpt(
    rings,
    (k, j) => {
      const s = lowSel[halfSeg(j, lowN) + 1] - 1;
      if (s <= 1) return 1;
      if (s === 2) return 2;
      if (inBed(zsU[k])) return s + 1;
      return 3;
    },
    (k) => creaseZ.has(Math.round(zsU[k] * 1e4)),
    (k, j) => {
      const s = lowSel[halfSeg(j, lowN) + 1] - 1;
      const zm = (zsU[k] + zsU[k + 1]) / 2;
      if (s === 0 && (P.cladding || (P.darkBumpers && bumperZone(zm)))) return TRIM;
      if (s >= 4 && bed && zm > bed[0] - 0.02 && zm < bed[1] + 0.02) return LINER;
      return PAINT;
    },
  );
  // underside (dark), incl. the wheel-well liners
  const under = zsU.map((zf) => {
    const hw = halfW(zf) * 0.935;
    const z = Z(zf);
    return [[-hw, bottom(zf), z], [0, P.sill - 0.02, z], [hw, bottom(zf), z]] as V3[];
  });
  if (!detail) {
    b.solid(HEX.wellLiner, 1);
    b.loft(under, false, (k) => [0, top(zsU[k]), Z(zsU[k])]);
  }
  // end caps
  b.painted();
  const capRing = (k: number) => [...rings[k], [0, P.sill - 0.02, Z(zsU[k])] as V3];
  b.poly(capRing(0), [0, 0, -1]);
  b.poly(capRing(rings.length - 1), [0, 0, 1]);

  // ── the glasshouse ──
  const winGap = (zm: number): 'glass' | 'black' | 'paint' => {
    for (const [a, c] of P.windows) if (zm > a && zm < c) return 'glass';
    for (let i = 1; i < P.windows.length; i++) if (zm >= P.windows[i - 1][1] && zm <= P.windows[i][0] && P.windows[i][0] - P.windows[i - 1][1] < 0.3) return 'black';
    return 'paint';
  };
  const gs = new Set<number>();
  const gl = gh1 - gh0;
  const gstep = detail ? gl + 1 : Math.max(0.3, gl / 9);
  for (let z = gh0; z < gh1 - 1e-6; z += gstep) gs.add(z);
  gs.add(gh1);
  if (!detail) {
    for (const [z] of P.roof) if (z > gh0 && z < gh1) gs.add(z);
    for (const [a, c] of P.windows) {
      if (a > gh0 && a < gh1) gs.add(a);
      if (c > gh0 && c < gh1) gs.add(c);
    }
    if (P.ws > gh0 && P.ws < gh1) gs.add(P.ws);
    if (P.bl > gh0 && P.bl < gh1) gs.add(P.bl);
  }
  const gz: number[] = [];
  for (const z of [...gs].sort((a, c) => a - c)) if (!gz.length || z - gz[gz.length - 1] > 0.004) gz.push(z);
  const glassHalf = (zf: number): [number, number][] => {
    const hw = halfW(zf);
    const yt = top(zf);
    const rt = Math.max(yt + 0.001, roof(zf));
    const s = clamp01((rt - yt) / 0.25);
    const xb = hw * 0.94 - 0.004;
    const xt = xb - 0.012 - P.tumble * s;
    return [
      [xb, yt - 0.012],
      [xb - 0.012, yt + 0.03 * s],
      [xt, rt - railH * s],
      [xt - 0.07 * s - 0.004, rt - 0.012 * s],
      [0, rt + 0.026 * s],
    ];
  };
  const glSel = detail ? [0, 2, 3, 4] : [0, 1, 2, 3, 4];
  const glN = glSel.length;
  const gRings = gz.map((zf) => mirrorRing(glassHalf(zf), Z(zf), glSel));
  b.sculpt(
    gRings,
    (_k, j) => glSel[halfSeg(j, glN) + 1] - 1,
    () => false,
    (k, j) => {
      const s = glSel[halfSeg(j, glN) + 1] - 1;
      const zm = (gz[k] + gz[k + 1]) / 2;
      const w = winGap(zm);
      if (s === 0) return w === 'glass' ? GLOSS : PAINT;
      if (s === 1) return w === 'glass' ? GLASS : w === 'black' ? GLOSS : PAINT;
      if (s === 2) return PAINT;
      return zm < P.ws || zm > P.bl ? GLASS : PAINT;
    },
  );
  // glasshouse end faces where they stand up from the body (bus front, cab backs, van doors)
  const ghCap = (k: number, out: V3) => {
    const zf = gz[k];
    if (roof(zf) - top(zf) < 0.03) return;
    b.painted();
    b.poly([...gRings[k], [0, top(zf) - 0.012, Z(zf)]], out);
  };
  ghCap(0, [0, 0, -1]);
  ghCap(gz.length - 1, [0, 0, 1]);

  const F: BodyFrame = { P, Z, top, bottom, sideX, roofAt: roof };

  // ── lamps, grille, plates on the ends; shut lines, handles, mirrors on the sides ──
  const fz = Z(0) - 0.004;
  const rz = Z(P.L) + 0.004;
  const capX = (zf: number, y: number) => sideX(zf, y) - 0.012;
  const clampY = (zf: number, y: number) => Math.min(top(zf) - 0.014, Math.max(bottom(zf) + 0.01, y));
  /** Plan normal of the lower body's side at zf (right side; mirror x for the left). */
  const sideN = (zf: number, y: number): [number, number] => {
    const d = 0.01;
    const dx = (sideX(Math.min(P.L, zf + d), y) - sideX(Math.max(0, zf - d), y)) / (Math.min(P.L, zf + d) - Math.max(0, zf - d));
    const l = Math.hypot(1, dx);
    return [1 / l, -dx / l];
  };
  /** A band on the end face from x0 (fraction of the face) to the edge, and on round the corner over the loft's own stations up to `wrap`. */
  const lampBand = (rear: boolean, y0: number, y1: number, fx0: number, m: (s: number) => Mt, wrap: number) => {
    const zf0 = rear ? P.L : 0;
    const zc = rear ? rz : fz;
    const zw = zsU.filter((z) => (rear ? z >= P.L - wrap - 1e-6 : z <= wrap + 1e-6));
    if (rear) zw.reverse();
    for (const s of [-1, 1]) {
      b.use(m(s));
      const a0 = clampY(zf0, y0);
      const a1 = clampY(zf0, y1);
      if (a1 - a0 < 0.02) continue;
      const xi = halfW(zf0) * fx0;
      b.quad([s * xi, a0, zc], [s * (sideX(zf0, a0) - 0.002), a0, zc], [s * (sideX(zf0, a1) - 0.002), a1, zc], [s * xi, a1, zc], [0, 0, rear ? 1 : -1]);
      if (detail || wrap <= 0) continue;
      const p = (zf: number, y: number): V3 => {
        const yy = clampY(zf, y);
        const [nx, nz] = sideN(zf, yy);
        return [s * (sideX(zf, yy) + nx * 0.005), yy, Z(zf) + nz * 0.005 * (rear ? -1 : 1) * (rear ? -1 : 1)];
      };
      for (let i = 0; i + 1 < zw.length; i++) b.quad(p(zw[i], y0), p(zw[i + 1], y0), p(zw[i + 1], y1), p(zw[i], y1), [s, 0, rear ? 0.5 : -0.5]);
    }
  };
  const wrap = wrapF;
  const [h0, h1] = P.headY;
  lampBand(false, h0, h1, 0.5, () => solidM(HEX.head, 0.08, 0.4, LAMP.head), wrap);
  // amber indicators under the outer end of the head lamps
  const hi = Math.min(0.06, (h1 - h0) * 0.5);
  lampBand(false, h0 - hi - 0.012, h0 - 0.012, 0.74, (s) => solidM(HEX.ind, 0.2, 0, s < 0 ? LAMP.indL : LAMP.indR), detail ? 0 : wrap * 0.7);
  const [g0, g1] = P.grilleY;
  const hwF = halfW(0);
  b.use(solidM(HEX.grille, 0.6));
  const gy1 = Math.min(g1, top(0) - 0.02);
  b.poly([[-hwF * 0.36, g0, fz], [hwF * 0.36, g0, fz], [hwF * 0.46, (g0 + gy1) / 2, fz], [hwF * 0.44, gy1, fz], [-hwF * 0.44, gy1, fz], [-hwF * 0.46, (g0 + gy1) / 2, fz]], [0, 0, -1]);
  if (!detail) {
    // chrome/black surround bar on the grille, lower intake, bumper band
    b.use(P.darkBumpers ? TRIM : CHROME);
    b.quad([-hwF * 0.45, gy1 - 0.03, fz - 0.002], [hwF * 0.45, gy1 - 0.03, fz - 0.002], [hwF * 0.45, gy1 - 0.008, fz - 0.002], [-hwF * 0.45, gy1 - 0.008, fz - 0.002], [0, 0, -1]);
    const yb0 = bottom(0) + 0.03;
    if (P.darkBumpers || P.chromeBumpers) {
      b.use(P.chromeBumpers ? CHROME : TRIM);
      const y1b = Math.min(g0 - 0.01, yb0 + 0.3);
      b.quad([-capX(0, yb0), yb0, fz + 0.001], [capX(0, yb0), yb0, fz + 0.001], [capX(0, y1b), y1b, fz + 0.001], [-capX(0, y1b), y1b, fz + 0.001], [0, 0, -1]);
    } else if (g0 - yb0 > 0.12) {
      b.use(solidM(HEX.grille, 0.65));
      const iy1 = g0 - 0.06;
      b.quad([-hwF * 0.52, yb0 + 0.02, fz], [hwF * 0.52, yb0 + 0.02, fz], [hwF * 0.55, iy1, fz], [-hwF * 0.55, iy1, fz], [0, 0, -1]);
    }
    b.use(solidM(HEX.plate, 0.5));
    const py = Math.max(bottom(0) + 0.06, g0 - 0.2);
    b.quad([-0.17, py, fz - 0.003], [0.17, py, fz - 0.003], [0.17, py + 0.15, fz - 0.003], [-0.17, py + 0.15, fz - 0.003], [0, 0, -1]);
  }
  if (!P.noTail) {
    const [t0, t1] = P.tailY;
    lampBand(true, t0, t1, 0.6, (s) => solidM(HEX.tail, 0.16, 0, s < 0 ? LAMP.tailL : LAMP.tailR), wrapR);
    if (!detail) {
      const ybr = bottom(P.L) + 0.03;
      if (P.darkBumpers || P.chromeBumpers) {
        b.use(P.chromeBumpers ? CHROME : TRIM);
        const y1b = Math.min(t0 - 0.05, ybr + 0.28);
        if (y1b > ybr + 0.05) b.quad([-capX(P.L, ybr), ybr, rz - 0.001], [capX(P.L, ybr), ybr, rz - 0.001], [capX(P.L, y1b), y1b, rz - 0.001], [-capX(P.L, y1b), y1b, rz - 0.001], [0, 0, 1]);
      }
      b.use(solidM(HEX.plate, 0.5));
      const py = Math.max(bottom(P.L) + 0.12, t0 - 0.26);
      b.quad([-0.17, py, rz + 0.002], [0.17, py, rz + 0.002], [0.17, py + 0.15, rz + 0.002], [-0.17, py + 0.15, rz + 0.002], [0, 0, 1]);
      // red reflectors low on the bumper corners
      b.use(solidM(HEX.tail, 0.3));
      const ry = Math.max(bottom(P.L) + 0.06, py - 0.02);
      for (const s of [-1, 1]) b.quad([s * halfW(P.L) * 0.62, ry, rz + 0.002], [s * halfW(P.L) * 0.8, ry, rz + 0.002], [s * halfW(P.L) * 0.8, ry + 0.04, rz + 0.002], [s * halfW(P.L) * 0.62, ry + 0.04, rz + 0.002], [0, 0, 1]);
    }
  }
  if (!detail) {
    // door shut lines (following the side's curve) and handles
    const doors = P.doors ?? [];
    for (let i = 0; i < doors.length; i++) {
      const zc = doors[i];
      const y0 = bottom(zc) + 0.05;
      const y1 = top(zc) - 0.02;
      if (y1 - y0 < 0.1) continue;
      const ym = (y0 + y1) / 2;
      b.use(GAP);
      for (const s of [-1, 1]) {
        const p = (y: number, dz: number): V3 => [s * (sideX(zc, y) + 0.003), y, Z(zc) + dz];
        for (const [ya, yb] of [
          [y0, ym],
          [ym, y1],
        ])
          b.quad(p(ya, -0.006), p(ya, 0.006), p(yb, 0.006), p(yb, -0.006), [s, 0, 0]);
      }
      if (i > 0) {
        const hz = zc - 0.2;
        const hy = top(hz) - 0.13;
        b.use(solidM(0x6a6d70, 0.3, 0.8));
        for (const s of [-1, 1]) {
          const x = s * (sideX(hz, hy) + 0.008);
          b.quad([x, hy, Z(hz) - 0.08], [x, hy, Z(hz) + 0.08], [x, hy + 0.028, Z(hz) + 0.08], [x, hy + 0.028, Z(hz) - 0.08], [s, 0, 0]);
        }
      }
    }
    // mirrors
    const mzf = gh0 + Math.min(0.3, (P.ws - gh0) * 0.45);
    const mz = Z(mzf);
    const my = top(mzf) + 0.05;
    const hwm = sideX(mzf, top(mzf) - 0.02);
    for (const s of [-1, 1]) {
      if (P.mirrors === 'truck') {
        b.use(TRIM);
        const xa = s * (hwm + 0.1);
        const xb = s * (hwm + 0.16);
        b.box(Math.min(xa, xb), my + 0.1, mz - 0.04, Math.max(xa, xb), my + 0.52, mz + 0.05);
        b.box(Math.min(0, s) * (hwm + 0.1) + Math.max(0, s) * hwm, my + 0.28, mz - 0.015, Math.min(0, s) * hwm + Math.max(0, s) * (hwm + 0.1), my + 0.31, mz + 0.015);
      } else {
        const x0 = s < 0 ? -hwm - 0.17 : hwm + 0.02;
        const x1 = s < 0 ? -hwm - 0.02 : hwm + 0.17;
        b.painted();
        b.box(x0, my, mz - 0.05, x1, my + 0.11, mz + 0.03, 'b');
        b.use(solidM(0x9aa3aa, 0.05, 1));
        b.quad([x0, my + 0.01, mz + 0.03], [x0, my + 0.1, mz + 0.03], [x1, my + 0.1, mz + 0.03], [x1, my + 0.01, mz + 0.03], [0, 0, 1]);
        b.use(TRIM);
        b.box(s < 0 ? -hwm - 0.03 : hwm - 0.01, my - 0.04, mz - 0.03, s < 0 ? -hwm + 0.01 : hwm + 0.03, my + 0.01, mz + 0.02);
      }
    }
    if (P.roofRails) {
      b.use(TRIM);
      const z0 = P.ws + 0.15;
      const z1 = P.bl - 0.05;
      for (const s of [-1, 1]) {
        const x = s * (halfW((z0 + z1) / 2) * 0.94 - 0.1 - P.tumble);
        const y = roof((z0 + z1) / 2);
        b.box(x - 0.025, y - 0.01, Z(z0), x + 0.025, y + 0.05, Z(z1), 'd');
      }
    }
  }
  // wheels
  const rim = P.rimHex ?? HEX.rim;
  const spokes = P.spokes ?? 5;
  const xw = hw0 - P.tw / 2 - 0.035;
  for (const s of [-1, 1]) b.wheel(s * xw, P.r, Z(zFront), P.r, P.tw, s, true, detail, rim, false, spokes);
  const rtw = P.rtw ?? P.tw;
  const xr = hw0 - rtw / 2 - 0.035;
  for (const zr of zRears) for (const s of [-1, 1]) b.wheel(s * xr, rr, Z(zr), rr, rtw, s, false, detail, rim, P.dualRear, P.dualRear ? 0 : spokes);
  return F;
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
        belt: [[0, 0.76], [0.3, 0.82], [1.0, 0.9], [1.58, 0.96], [3.9, 1.02], [4.6, 1.01], [4.85, 0.95]],
        gh: [1.55, 4.18],
        roof: [[1.55, 0.95], [2.45, 1.4], [3.2, 1.44], [4.18, 1.03]],
        tumble: 0.17,
        windows: [[1.8, 2.8], [2.9, 3.64]],
        ws: 2.4,
        bl: 3.28,
        roundF: 0.42,
        roundR: 0.36,
        headY: [0.6, 0.7],
        tailY: [0.8, 0.93],
        grilleY: [0.42, 0.62],
        doors: [1.42, 2.85, 3.66],
        spokes: 5,
      };
    case VT.hatch:
      return {
        ...base,
        sill: 0.19,
        belt: [[0, 0.74], [0.28, 0.8], [0.9, 0.9], [1.4, 0.97], [3.9, 1.03], [4.2, 1.02], [4.3, 0.98]],
        gh: [1.36, 4.26],
        roof: [[1.36, 0.98], [2.2, 1.44], [3.72, 1.46], [4.26, 1.05]],
        tumble: 0.16,
        windows: [[1.58, 2.52], [2.62, 3.42]],
        ws: 2.18,
        bl: 3.74,
        roundF: 0.4,
        roundR: 0.22,
        headY: [0.6, 0.7],
        tailY: [0.82, 0.96],
        grilleY: [0.4, 0.6],
        doors: [1.3, 2.57, 3.44],
        spokes: 6,
      };
    case VT.suv:
      return {
        ...base,
        tw: 0.26,
        sill: 0.3,
        belt: [[0, 0.95], [0.3, 1.0], [1.0, 1.08], [1.5, 1.13], [4.5, 1.18], [4.78, 1.15]],
        gh: [1.5, 4.68],
        roof: [[1.5, 1.15], [2.3, 1.69], [4.45, 1.72], [4.68, 1.25]],
        tumble: 0.14,
        windows: [[1.74, 2.88], [2.98, 3.74], [3.84, 4.36]],
        ws: 2.28,
        bl: 4.44,
        roundF: 0.44,
        roundR: 0.28,
        headY: [0.8, 0.92],
        tailY: [0.95, 1.1],
        grilleY: [0.5, 0.78],
        cladding: true,
        roofRails: true,
        doors: [1.46, 2.93, 3.78],
        spokes: 6,
      };
    case VT.pickup:
      return {
        ...base,
        tw: 0.28,
        sill: 0.36,
        belt: [[0, 1.06], [0.3, 1.1], [1.3, 1.15], [1.95, 1.2], [5.72, 1.26], [5.85, 1.16]],
        gh: [1.95, 3.8],
        roof: [[1.95, 1.21], [2.66, 1.88], [3.58, 1.9], [3.8, 1.25]],
        tumble: 0.12,
        windows: [[2.16, 2.92], [3.02, 3.58]],
        ws: 2.62,
        bl: 3.66,
        roundF: 0.36,
        roundR: 0.1,
        endW: 0.86,
        crown: 0.03,
        headY: [0.9, 1.04],
        tailY: [0.86, 1.16],
        grilleY: [0.56, 0.96],
        rimHex: 0xc2c5c8,
        chromeBumpers: true,
        bed: [3.84, 5.74, 0.82],
        doors: [2.02, 2.97, 3.62],
        spokes: 6,
        wrap: 0.12,
      };
    case VT.van:
    default:
      return {
        ...base,
        tw: 0.25,
        sill: 0.3,
        belt: [[0, 1.0], [0.3, 1.04], [0.8, 1.1], [1.15, 1.12], [5.4, 1.14], [5.5, 1.12]],
        gh: [1.12, 5.5],
        roof: [[1.12, 1.13], [1.95, 2.34], [2.35, 2.43], [5.5, 2.45]],
        tumble: 0.07,
        railH: 0.08,
        windows: [[1.32, 2.22]],
        ws: 1.93,
        bl: 99,
        roundF: 0.42,
        roundR: 0.1,
        endW: 0.85,
        headY: [0.84, 0.97],
        tailY: [0.9, 1.3],
        grilleY: [0.58, 0.84],
        darkBumpers: true,
        rimHex: 0x9a9ea2,
        doors: [1.24, 2.3, 3.4],
        spokes: 5,
        wrap: 0.12,
      };
  }
}

function vanExtras(b: Builder, F: BodyFrame): void {
  // rear doors: two windows, the centre seam; the sliding door's track
  const rz = F.Z(F.P.L) + 0.006;
  b.use(GLASS);
  for (const s of [-1, 1]) b.quad([s * 0.08, 1.55, rz], [s * 0.78, 1.55, rz], [s * 0.78, 2.1, rz], [s * 0.08, 2.1, rz], [0, 0, 1]);
  b.use(GAP);
  b.quad([-0.006, 0.4, rz + 0.001], [0.006, 0.4, rz + 0.001], [0.006, 2.3, rz + 0.001], [-0.006, 2.3, rz + 0.001], [0, 0, 1]);
  const hw = F.P.W / 2;
  for (const s of [-1, 1]) {
    const x = s * (hw + 0.004);
    b.quad([x, 2.02, F.Z(2.4)], [x, 2.02, F.Z(3.4)], [x, 2.04, F.Z(3.4)], [x, 2.04, F.Z(2.4)], [s, 0, 0]);
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
      belt: [[0, 1.3], [0.3, 1.35], [0.9, 1.4], [1.0, 1.42], [cabL, 1.42]],
      gh: [0.98, cabL],
      roof: [[0.98, 1.43], [1.5, 2.7], [2.05, 2.76], [cabL, 2.76]],
      tumble: 0.1,
      railH: 0.12,
      windows: [[1.5, 2.12]],
      ws: 1.48,
      bl: 99,
      roundF: 0.3,
      roundR: 0.05,
      endW: 0.9,
      headY: [1.0, 1.16],
      tailY: [0, 0],
      grilleY: [0.95, 1.22],
      darkBumpers: true,
      rimHex: HEX.truckRim,
      noTail: true,
      dualRear: true,
      coarseArches: true,
      mirrors: 'truck',
      doors: [1.4, 2.2],
      wrap: 0.1,
    },
    detail,
  );
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const Z = (zf: number) => zf - zOff;
  const hw = s.width / 2;
  // chassis rails and the box body
  b.solid(HEX.trim, 0.7);
  b.box(-0.5, 0.55, Z(cabL - 0.05), 0.5, 0.95, Z(s.length - 0.1));
  b.solid(HEX.box, 0.5);
  const bz0 = Z(cabL + 0.18);
  const bz1 = Z(s.length);
  b.box(-hw, 1.02, bz0, hw, s.height, bz1);
  if (!detail) {
    // corner posts and rails, roll-up door slats and the frame, side marker lamps
    b.solid(0xa9acae, 0.4, 0.6);
    for (const sd of [-1, 1]) {
      const x = sd * (hw + 0.006);
      b.quad([x, 1.02, bz0], [x, 1.02, bz1], [x, 1.14, bz1], [x, 1.14, bz0], [sd, 0, 0]);
      b.quad([x, s.height - 0.08, bz0], [x, s.height - 0.08, bz1], [x, s.height, bz1], [x, s.height, bz0], [sd, 0, 0]);
      for (const z of [bz0 + 0.02, bz1 - 0.08]) b.quad([x, 1.02, z], [x, 1.02, z + 0.06], [x, s.height, z + 0.06], [x, s.height, z], [sd, 0, 0]);
    }
    b.solid(0xb8b8b4, 0.6);
    for (let k = 1; k < 7; k++) {
      const y = 1.1 + k * 0.32;
      b.quad([-hw + 0.1, y, bz1 + 0.005], [hw - 0.1, y, bz1 + 0.005], [hw - 0.1, y + 0.025, bz1 + 0.005], [-hw + 0.1, y + 0.025, bz1 + 0.005], [0, 0, 1]);
    }
    b.solid(HEX.trim, 0.6);
    b.box(-hw, 0.62, bz1 - 0.15, hw, 0.8, bz1 + 0.05);
    // wheel guards behind the rear axle
    for (const sd of [-1, 1]) b.box(sd > 0 ? hw - 0.6 : -hw, 0.95, Z(s.frontOverhang + s.wheelbase + 0.55), sd > 0 ? hw : -hw + 0.6, 1.02, Z(s.frontOverhang + s.wheelbase + 0.7));
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
      belt: [[0, 1.42], [0.4, 1.47], [1.9, 1.55], [2.1, 1.66], [cabEnd, 1.66]],
      gh: [2.1, cabEnd],
      roof: [[2.1, 1.67], [2.42, 2.9], [3.3, 3.02], [3.75, 3.92], [cabEnd, 4.0]],
      tumble: 0.14,
      railH: 0.1,
      windows: [[2.5, 3.25]],
      ws: 2.4,
      bl: 99,
      roundF: 0.55,
      roundR: 0.1,
      endW: 0.84,
      crown: 0.06,
      headY: [1.06, 1.22],
      tailY: [0, 0],
      grilleY: [0.8, 1.3],
      rimHex: HEX.truckRim,
      noTail: true,
      rearAxles: [-tandem, tandem],
      dualRear: true,
      coarseArches: true,
      mirrors: 'truck',
      doors: [2.35, 3.3],
      wrap: 0.25,
    },
    detail,
  );
  const zOff = s.frontOverhang + s.wheelbase / 2;
  const Z = (zf: number) => zf - zOff;
  // chrome grille over the painted nose, bumper, frame, fifth wheel
  b.solid(HEX.chrome, 0.2, 1);
  if (!detail) {
    b.quad([-0.52, 0.8, Z(0) - 0.012], [0.52, 0.8, Z(0) - 0.012], [0.52, 1.33, Z(0) - 0.012], [-0.52, 1.33, Z(0) - 0.012], [0, 0, -1]);
    b.box(-s.width / 2 + 0.05, 0.5, Z(0) - 0.12, s.width / 2 - 0.05, 0.78, Z(0) + 0.05);
    // grille bars
    b.solid(HEX.grille, 0.6);
    for (let k = 0; k < 5; k++) {
      const y = 0.86 + k * 0.09;
      b.quad([-0.46, y, Z(0) - 0.014], [0.46, y, Z(0) - 0.014], [0.46, y + 0.045, Z(0) - 0.014], [-0.46, y + 0.045, Z(0) - 0.014], [0, 0, -1]);
    }
  }
  b.solid(HEX.trim, 0.7);
  b.box(-0.5, 0.75, Z(cabEnd - 0.1), 0.5, 1.05, Z(L), detail ? 'df' : '');
  b.solid(0x202224, 0.5, 0.4);
  b.box(-0.65, 1.05, Z(cabEnd + 0.1), 0.65, 1.14, Z(L - 0.2), detail ? 'dlrfb' : '');
  // fuel tanks, steps, exhaust stacks, air cleaners
  b.solid(HEX.chrome, 0.18, 1);
  if (!detail) {
    for (const sd of [-1, 1]) b.cylinder('z', [sd * (s.width / 2 - 0.32), 0.78, Z(2.75)], 0.3, 1.3, 9, true);
    for (const sd of [-1, 1]) b.cylinder('y', [sd * 0.95, 2.95, Z(cabEnd + 0.08)], 0.085, 2.3, 6, false);
    for (const sd of [-1, 1]) b.cylinder('y', [sd * (s.width / 2 - 0.05), 1.9, Z(1.95)], 0.2, 0.9, 7, true);
    b.solid(HEX.trim, 0.6);
    for (const sd of [-1, 1]) b.box(sd > 0 ? s.width / 2 - 0.62 : -s.width / 2 + 0.02, 0.4, Z(3.45), sd > 0 ? s.width / 2 - 0.02 : -s.width / 2 + 0.62, 0.46, Z(4.6));
    // cab/sleeper side extenders (fairing behind the sleeper)
    b.painted();
    for (const sd of [-1, 1]) b.box(sd > 0 ? s.width / 2 - 0.06 : -s.width / 2, 1.2, Z(cabEnd - 0.02), sd > 0 ? s.width / 2 : -s.width / 2 + 0.06, 3.9, Z(cabEnd + 0.45));
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
    // door hinges and lock rods
    b.solid(0x9a9ea2, 0.35, 0.8);
    for (const x of [-0.75, -0.55, 0.55, 0.75]) b.quad([x - 0.012, y0 + 0.15, zR + 0.008], [x + 0.012, y0 + 0.15, zR + 0.008], [x + 0.012, y1 - 0.15, zR + 0.008], [x - 0.012, y1 - 0.15, zR + 0.008], [0, 0, 1]);
    // landing gear
    b.solid(HEX.trim, 0.7);
    for (const sd of [-1, 1]) b.box(sd * 0.95 - 0.07, 0.25, zF + 3.6, sd * 0.95 + 0.07, y0, zF + 3.75);
    // underride guard, side skirts and chassis
    b.box(-hw + 0.1, 0.45, zR - 0.4, hw - 0.1, 0.62, zR - 0.28);
    b.solid(0xc9cbcc, 0.5, 0.2);
    for (const sd of [-1, 1]) b.quad([sd * (hw - 0.04), 0.5, zF + 4.2], [sd * (hw - 0.04), 0.5, wb / 2 - 1.3], [sd * (hw - 0.04), y0, wb / 2 - 1.3], [sd * (hw - 0.04), y0, zF + 4.2], [sd, 0, 0]);
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
  for (const o of [-0.65, 0.65]) for (const sd of [-1, 1]) b.wheel(sd * (hw - 0.3), r, wb / 2 + o, r, 0.56, sd, false, detail, HEX.truckRim, true, 0);
}

function bus(b: Builder, detail: number): void {
  const s = SPECS[VT.bus];
  const L = s.length;
  const F = body(
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
      belt: [[0, 1.08], [0.12, 1.16], [L - 0.12, 1.2], [L, 1.14]],
      gh: [0.04, L - 0.04],
      roof: [[0.04, 2.95], [0.35, 3.17], [L - 0.35, s.height], [L - 0.04, 3.0]],
      tumble: 0.03,
      railH: 0.62,
      windows: [[1.55, L - 0.5]],
      ws: 0,
      bl: 99,
      roundF: 0.3,
      roundR: 0.25,
      endW: 0.93,
      crown: 0.02,
      headY: [0.7, 0.86],
      tailY: [0.82, 1.06],
      grilleY: [0.45, 0.66],
      darkBumpers: true,
      rimHex: HEX.truckRim,
      dualRear: true,
      coarseArches: true,
      mirrors: 'truck',
      wrap: 0.08,
    },
    detail,
  );
  const Z = F.Z;
  const hw = s.width / 2;
  // windscreen, destination sign, rear window, entry door, rub rails, window pillars
  const fz = Z(0.04) - 0.006;
  b.use(GLASS);
  b.quad([-hw + 0.14, 1.2, fz], [hw - 0.14, 1.2, fz], [hw - 0.16, 2.6, fz], [-hw + 0.16, 2.6, fz], [0, 0, -1]);
  b.use(GLOSS);
  b.quad([-hw + 0.3, 2.66, fz], [hw - 0.3, 2.66, fz], [hw - 0.3, 2.9, fz], [-hw + 0.3, 2.9, fz], [0, 0, -1]);
  b.solid(0x5a4a10, 0.3, 0, LAMP.none);
  b.quad([-hw + 0.4, 2.7, fz - 0.002], [hw - 0.4, 2.7, fz - 0.002], [hw - 0.4, 2.86, fz - 0.002], [-hw + 0.4, 2.86, fz - 0.002], [0, 0, -1]);
  const rzz = Z(L - 0.04) + 0.006;
  b.use(GLASS);
  b.quad([-hw + 0.3, 1.9, rzz], [hw - 0.3, 1.9, rzz], [hw - 0.3, 2.5, rzz], [-hw + 0.3, 2.5, rzz], [0, 0, 1]);
  b.use(GLASS);
  b.quad([hw + 0.01, 0.5, Z(0.35)], [hw + 0.01, 0.5, Z(1.45)], [hw + 0.01, 2.55, Z(1.45)], [hw + 0.01, 2.55, Z(0.35)], [1, 0, 0]);
  if (!detail) {
    b.use(GLOSS);
    b.quad([hw + 0.012, 0.5, Z(0.88)], [hw + 0.012, 0.5, Z(0.92)], [hw + 0.012, 2.55, Z(0.92)], [hw + 0.012, 2.55, Z(0.88)], [1, 0, 0]);
    b.use(GLOSS);
    for (const sd of [-1, 1])
      for (const y of [0.62, 0.92, 1.18])
        b.quad([sd * (hw + 0.006), y, Z(sd > 0 ? 1.5 : 0.3)], [sd * (hw + 0.006), y, Z(L - 0.25)], [sd * (hw + 0.006), y + 0.05, Z(L - 0.25)], [sd * (hw + 0.006), y + 0.05, Z(sd > 0 ? 1.5 : 0.3)], [sd, 0, 0]);
    // window pillars (painted) and the black frame line under the windows
    for (const sd of [-1, 1])
      for (let z = 1.55 + 1.22; z < L - 0.7; z += 1.22) {
        const x = sd * (F.sideX(z, 1.2) - 0.02);
        b.painted();
        b.quad([x, 1.2, Z(z - 0.06)], [x, 1.2, Z(z + 0.06)], [x, 2.6, Z(z + 0.06)], [x, 2.6, Z(z - 0.06)], [sd, 0, 0]);
      }
  }
}

function farmTractor(b: Builder, detail: number): void {
  const s = SPECS[VT.tractor];
  const zF = -s.wheelbase / 2;
  const zR = s.wheelbase / 2;
  const front = zF - s.frontOverhang;
  const back = zR + (s.length - s.frontOverhang - s.wheelbase);
  // frame and a rounded hood (lofted), grille, head lamps
  b.solid(HEX.trim, 0.7);
  b.box(-0.35, 0.45, front + 0.1, 0.35, 0.85, zR);
  const hood = (z: number, f: number): V3[] => {
    const half: [number, number][] = detail
      ? [
          [0.42, 0.85],
          [0.4, 1.45],
          [0, 1.53],
        ]
      : [
          [0.42, 0.85],
          [0.42, 1.3],
          [0.37, 1.46],
          [0.2, 1.52],
          [0, 1.53],
        ];
    const out: V3[] = half.map(([x, y]) => [x * f, 0.85 + (y - 0.85) * (0.9 + 0.1 * f), z] as V3);
    for (let i = half.length - 2; i >= 0; i--) out.push([-out[i][0], out[i][1], z]);
    return out;
  };
  const hz0 = front + 0.05;
  const hz1 = zR - 1.05;
  b.painted(0.42);
  b.loft([hood(hz0, 0.9), hood(hz0 + 0.12, 1), hood(hz1, 1)], false, (k) => [0, 0.9, [hz0, hz0 + 0.12, hz1][k]]);
  b.poly([...hood(hz0, 0.9), [0, 0.85, hz0]], [0, 0, -1]);
  b.solid(HEX.grille, 0.7);
  b.quad([-0.3, 0.9, front + 0.04], [0.3, 0.9, front + 0.04], [0.3, 1.38, front + 0.04], [-0.3, 1.38, front + 0.04], [0, 0, -1]);
  b.solid(HEX.head, 0.1, 0.4, LAMP.head);
  for (const sd of [-1, 1]) b.quad([sd * 0.2 - 0.07, 1.26, front + 0.035], [sd * 0.2 + 0.07, 1.26, front + 0.035], [sd * 0.2 + 0.07, 1.34, front + 0.035], [sd * 0.2 - 0.07, 1.34, front + 0.035], [0, 0, -1]);
  // cab: glass box with dark posts and a painted roof
  const c0 = zR - 1.15;
  const c1 = back - 0.2;
  const cw = 0.72;
  b.solid(HEX.glass, 0.05);
  b.box(-cw, 1.5, c0, cw, 2.78, c1, 'd');
  b.solid(HEX.trim, 0.6);
  for (const x of [-cw - 0.01, cw - 0.05]) for (const z of [c0 - 0.01, c1 - 0.05]) b.box(x, 1.5, z, x + 0.06, 2.78, z + 0.06);
  if (!detail) for (const x of [-cw - 0.012, cw + 0.002]) b.box(x, 1.5, c0 - 0.01, x + 0.01, 1.58, c1 + 0.01);
  b.painted(0.45);
  b.box(-cw - 0.06, 2.78, c0 - 0.08, cw + 0.06, s.height, c1 + 0.08);
  // rear fenders, steps, seat base, exhaust
  for (const sd of [-1, 1]) b.box(sd > 0 ? cw : -1.2, 1.52, zR - 0.95, sd > 0 ? 1.2 : -cw, 1.6, zR + 0.85);
  if (!detail) for (const sd of [-1, 1]) b.box(sd > 0 ? 1.12 : -1.2, 1.1, zR - 0.95, sd > 0 ? 1.2 : -1.12, 1.52, zR - 0.55);
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
  for (const sd of [-1, 1]) b.wheel(sd * 0.78, s.wheelR, zF, s.wheelR, 0.3, sd, true, detail, rimT, false, 0);
  for (const sd of [-1, 1]) {
    const x = sd * (s.width / 2 - 0.23);
    const R = s.wheelRRear;
    b.wheel(x, R, zR, R, 0.46, sd, false, detail, rimT, false, 0);
  }
}

/** The body alone from a profile (tests / previews): geometry and its surface frame. */
export function buildBodyGeometry(P: BodyProfile, detail: number): { geometry: THREE.BufferGeometry; frame: BodyFrame } {
  const b = new Builder();
  const frame = body(b, P, detail);
  return { geometry: b.toGeometry(), frame };
}

/** A car's body profile (VT.sedan … VT.van). */
export function carBodyProfile(t: number): BodyProfile {
  return carProfile(t);
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
    default: {
      const F = body(b, carProfile(m), detail);
      if (m === VT.van && !detail) vanExtras(b, F);
    }
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
      return { head: [0.78, 1.1, zFront], tail: [1.02, 1.18, SPECS[VT.box].length - zOff + 0.05] };
    case VT.semi:
      return { head: [0.9, 1.14, zFront], tail: [0, 0, 0] };
    case VT.bus:
      return { head: [0.95, 0.78, zFront], tail: [1.05, 0.94, zRear] };
    case VT.tractor:
      return { head: [0.2, 1.3, -s.wheelbase / 2 - s.frontOverhang], tail: [1.15, 1.5, s.wheelbase / 2 + 0.9] };
    default: {
      const P = carProfile(m);
      return { head: [(s.width / 2) * 0.68 * 0.9, (P.headY[0] + P.headY[1]) / 2, zFront], tail: [(s.width / 2) * 0.78 * 0.9, (P.tailY[0] + P.tailY[1]) / 2, zRear] };
    }
  }
}
