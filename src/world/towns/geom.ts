/**
 * Small, allocation-light 2D geometry for towns and roads: oriented building
 * footprints (SAT overlap, point tests, distance to segments), a uniform-grid
 * segment index (nearest road segment, footprint clearance) and a rect hash
 * (building-vs-building overlap). PURE (no three.js).
 *
 * Frame: +X east, +Z south, headings clockwise from north. A footprint's
 * `f` axis is its front (the way its door faces), `a` its width axis
 * (`a` = front rotated 90° clockwise, i.e. the right-hand side seen from outside
 * looking at the building… or equivalently heading + 90°).
 */
import type { XZ } from '../polyline';

export type { XZ } from '../polyline';

const DEG = Math.PI / 180;

/** Unit (x, z) vector of a compass heading (0 = north = −Z, 90 = east = +X). */
export function frontVector(headingDeg: number): XZ {
  const h = headingDeg * DEG;
  return { x: Math.sin(h), z: -Math.cos(h) };
}

/** Compass heading (deg, 0..360) of a direction (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  return ((((Math.atan2(dx, -dz) / DEG) % 360) + 360) % 360);
}

/** An oriented rectangle (building footprint). */
export interface Rect {
  x: number;
  z: number;
  /** Half extents along `a` (width) and `f` (depth). */
  hw: number;
  hd: number;
  /** Unit width axis. */
  ax: number;
  az: number;
  /** Unit front axis. */
  fx: number;
  fz: number;
}

export function makeRect(x: number, z: number, headingDeg: number, width: number, depth: number): Rect {
  const h = headingDeg * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  return { x, z, hw: width / 2, hd: depth / 2, ax: -fz, az: fx, fx, fz };
}

export function rectCorners(r: Rect): XZ[] {
  const out: XZ[] = [];
  for (const [u, v] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ])
    out.push({ x: r.x + r.ax * r.hw * u + r.fx * r.hd * v, z: r.z + r.az * r.hw * u + r.fz * r.hd * v });
  return out;
}

/** Local coordinates of a world point: u along the width axis, v along the front axis. */
export function rectLocalU(r: Rect, x: number, z: number): number {
  return (x - r.x) * r.ax + (z - r.z) * r.az;
}
export function rectLocalV(r: Rect, x: number, z: number): number {
  return (x - r.x) * r.fx + (z - r.z) * r.fz;
}

/** True if (x, z) is inside the rect grown by `pad` (negative pad shrinks it). */
export function pointInRect(r: Rect, x: number, z: number, pad = 0): boolean {
  const dx = x - r.x;
  const dz = z - r.z;
  return Math.abs(dx * r.ax + dz * r.az) <= r.hw + pad && Math.abs(dx * r.fx + dz * r.fz) <= r.hd + pad;
}

/** Radius of the rect's circumscribed circle. */
export function rectRadius(r: Rect): number {
  return Math.hypot(r.hw, r.hd);
}

function projRadius(r: Rect, nx: number, nz: number): number {
  return r.hw * Math.abs(r.ax * nx + r.az * nz) + r.hd * Math.abs(r.fx * nx + r.fz * nz);
}

/**
 * Separating-axis test. True if the rects overlap or are closer than `gap`
 * along every one of their four face axes (i.e. the rects grown by gap/2 overlap).
 */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  // axes: a.a, a.f, b.a, b.f
  let nx = a.ax;
  let nz = a.az;
  if (Math.abs(dx * nx + dz * nz) >= a.hw + projRadius(b, nx, nz) + gap) return false;
  nx = a.fx;
  nz = a.fz;
  if (Math.abs(dx * nx + dz * nz) >= a.hd + projRadius(b, nx, nz) + gap) return false;
  nx = b.ax;
  nz = b.az;
  if (Math.abs(dx * nx + dz * nz) >= b.hw + projRadius(a, nx, nz) + gap) return false;
  nx = b.fx;
  nz = b.fz;
  if (Math.abs(dx * nx + dz * nz) >= b.hd + projRadius(a, nx, nz) + gap) return false;
  return true;
}

export function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 1e-12 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

/** Distance from a point to the (filled) rect; 0 inside. */
function pointRectDistance(r: Rect, x: number, z: number): number {
  const u = Math.abs(rectLocalU(r, x, z)) - r.hw;
  const v = Math.abs(rectLocalV(r, x, z)) - r.hd;
  const ou = u > 0 ? u : 0;
  const ov = v > 0 ? v : 0;
  return Math.hypot(ou, ov);
}

function segsIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const _cx = new Float64Array(4);
const _cz = new Float64Array(4);
const CU = [-1, 1, 1, -1];
const CV = [-1, -1, 1, 1];

/** Exact distance between a (filled) rect and a segment; 0 when they touch or intersect. */
export function rectSegmentDistance(r: Rect, ax: number, az: number, bx: number, bz: number): number {
  let d = Math.min(pointRectDistance(r, ax, az), pointRectDistance(r, bx, bz));
  if (d === 0) return 0;
  for (let i = 0; i < 4; i++) {
    _cx[i] = r.x + r.ax * r.hw * CU[i] + r.fx * r.hd * CV[i];
    _cz[i] = r.z + r.az * r.hw * CU[i] + r.fz * r.hd * CV[i];
  }
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3;
    if (segsIntersect(ax, az, bx, bz, _cx[i], _cz[i], _cx[j], _cz[j])) return 0;
    const e = pointSegmentDistance(_cx[i], _cz[i], ax, az, bx, bz);
    if (e < d) d = e;
  }
  return d;
}

// ─── Segment grid ─────────────────────────────────────────────────────────────

export interface SegQuery {
  /** Distance to the nearest segment centreline, m. */
  d: number;
  /** Nearest segment index (insertion order) and its id / half width. */
  seg: number;
  id: number;
  halfWidth: number;
  /** Closest point on it and its unit direction. */
  px: number;
  pz: number;
  dx: number;
  dz: number;
}

/**
 * Uniform-grid index of line segments (roads, river reaches) with a half width
 * each. Build once (add… then build()), then query without allocating.
 */
export class SegmentGrid {
  readonly cell: number;
  private ax: number[] = [];
  private az: number[] = [];
  private bx: number[] = [];
  private bz: number[] = [];
  private hw: number[] = [];
  private ids: number[] = [];
  private minX = 0;
  private minZ = 0;
  private nx = 1;
  private nz = 1;
  private start: Int32Array = new Int32Array(2);
  private items: Int32Array = new Int32Array(0);
  private stamp: Int32Array = new Int32Array(0);
  private epoch = 1;
  private maxHalfWidth = 0;

  constructor(cellSize: number) {
    this.cell = cellSize;
  }

  get size(): number {
    return this.ax.length;
  }

  add(ax: number, az: number, bx: number, bz: number, halfWidth: number, id: number): void {
    this.ax.push(ax);
    this.az.push(az);
    this.bx.push(bx);
    this.bz.push(bz);
    this.hw.push(halfWidth);
    this.ids.push(id);
    if (halfWidth > this.maxHalfWidth) this.maxHalfWidth = halfWidth;
  }

  /** Adds every segment of a polyline. */
  addPolyline(pts: XZ[], halfWidth: number, id: number): void {
    for (let i = 1; i < pts.length; i++) this.add(pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z, halfWidth, id);
  }

  build(): void {
    const n = this.ax.length;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let s = 0; s < n; s++) {
      minX = Math.min(minX, this.ax[s], this.bx[s]);
      maxX = Math.max(maxX, this.ax[s], this.bx[s]);
      minZ = Math.min(minZ, this.az[s], this.bz[s]);
      maxZ = Math.max(maxZ, this.az[s], this.bz[s]);
    }
    if (n === 0) minX = minZ = maxX = maxZ = 0;
    const c = this.cell;
    this.minX = minX - c;
    this.minZ = minZ - c;
    this.nx = Math.max(1, Math.ceil((maxX + c - this.minX) / c) + 1);
    this.nz = Math.max(1, Math.ceil((maxZ + c - this.minZ) / c) + 1);
    const counts = new Int32Array(this.nx * this.nz + 1);
    const visit = (s: number, fn: (cell: number) => void) => {
      const i0 = Math.floor((Math.min(this.ax[s], this.bx[s]) - this.minX) / c);
      const i1 = Math.floor((Math.max(this.ax[s], this.bx[s]) - this.minX) / c);
      const j0 = Math.floor((Math.min(this.az[s], this.bz[s]) - this.minZ) / c);
      const j1 = Math.floor((Math.max(this.az[s], this.bz[s]) - this.minZ) / c);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.nx + i);
    };
    for (let s = 0; s < n; s++) visit(s, (cc) => counts[cc + 1]++);
    for (let k = 0; k < this.nx * this.nz; k++) counts[k + 1] += counts[k];
    this.start = counts;
    this.items = new Int32Array(counts[this.nx * this.nz]);
    const fill = counts.slice(0, this.nx * this.nz);
    for (let s = 0; s < n; s++) visit(s, (cc) => (this.items[fill[cc]++] = s));
    this.stamp = new Int32Array(n);
  }

  newQuery(): SegQuery {
    return { d: Infinity, seg: -1, id: -1, halfWidth: 0, px: 0, pz: 0, dx: 1, dz: 0 };
  }

  /** Visits every segment whose bbox cell range intersects the square (x±r, z±r), each once. */
  private forEachNear(x0: number, z0: number, x1: number, z1: number, fn: (s: number) => void): void {
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x0 - this.minX) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x1 - this.minX) / c));
    const j0 = Math.max(0, Math.floor((z0 - this.minZ) / c));
    const j1 = Math.min(this.nz - 1, Math.floor((z1 - this.minZ) / c));
    if (i0 > i1 || j0 > j1) return;
    const ep = ++this.epoch;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cc = j * this.nx + i;
        for (let p = this.start[cc]; p < this.start[cc + 1]; p++) {
          const s = this.items[p];
          if (this.stamp[s] === ep) continue;
          this.stamp[s] = ep;
          fn(s);
        }
      }
  }

  /** Nearest segment centreline within maxR of (x, z). */
  nearest(x: number, z: number, maxR: number, out: SegQuery): boolean {
    let best = maxR;
    let bestS = -1;
    let bt = 0;
    this.forEachNear(x - maxR, z - maxR, x + maxR, z + maxR, (s) => {
      const vx = this.bx[s] - this.ax[s];
      const vz = this.bz[s] - this.az[s];
      const l2 = vx * vx + vz * vz;
      let t = l2 > 1e-12 ? ((x - this.ax[s]) * vx + (z - this.az[s]) * vz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - this.ax[s] - vx * t, z - this.az[s] - vz * t);
      if (d < best || (d === best && bestS < 0)) {
        best = d;
        bestS = s;
        bt = t;
      }
    });
    if (bestS < 0) return false;
    const vx = this.bx[bestS] - this.ax[bestS];
    const vz = this.bz[bestS] - this.az[bestS];
    const l = Math.hypot(vx, vz) || 1;
    out.d = best;
    out.seg = bestS;
    out.id = this.ids[bestS];
    out.halfWidth = this.hw[bestS];
    out.px = this.ax[bestS] + vx * bt;
    out.pz = this.az[bestS] + vz * bt;
    out.dx = vx / l;
    out.dz = vz / l;
    return true;
  }

  /**
   * Smallest (distance from the rect to a segment centreline − that segment's
   * half width) over segments within maxR of the rect; +Infinity if none.
   * Negative = the rect intrudes into the road/river.
   */
  clearance(r: Rect, maxR: number): number {
    const reach = rectRadius(r) + maxR + this.maxHalfWidth;
    let best = Infinity;
    this.forEachNear(r.x - reach, r.z - reach, r.x + reach, r.z + reach, (s) => {
      const d = rectSegmentDistance(r, this.ax[s], this.az[s], this.bx[s], this.bz[s]) - this.hw[s];
      if (d < best) best = d;
    });
    return best;
  }

  /**
   * True if (x, z) lies within (half width + margin) of a segment whose id is
   * below `maxId` (roads processed earlier). Allocation-free.
   */
  coveredBy(x: number, z: number, margin: number, maxId: number): boolean {
    const reach = margin + this.maxHalfWidth;
    const c = this.cell;
    const i0 = Math.max(0, Math.floor((x - reach - this.minX) / c));
    const i1 = Math.min(this.nx - 1, Math.floor((x + reach - this.minX) / c));
    const j0 = Math.max(0, Math.floor((z - reach - this.minZ) / c));
    const j1 = Math.min(this.nz - 1, Math.floor((z + reach - this.minZ) / c));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const cc = j * this.nx + i;
        for (let p = this.start[cc]; p < this.start[cc + 1]; p++) {
          const s = this.items[p];
          if (this.ids[s] >= maxId) continue;
          const vx = this.bx[s] - this.ax[s];
          const vz = this.bz[s] - this.az[s];
          const l2 = vx * vx + vz * vz;
          let t = l2 > 1e-12 ? ((x - this.ax[s]) * vx + (z - this.az[s]) * vz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = x - this.ax[s] - vx * t;
          const ez = z - this.az[s] - vz * t;
          const r = this.hw[s] + margin;
          if (ex * ex + ez * ez < r * r) return true;
        }
      }
    return false;
  }

  /** Smallest (distance from the point to a segment − half width) within maxR; +Infinity if none. */
  pointClearance(x: number, z: number, maxR: number): number {
    const reach = maxR + this.maxHalfWidth;
    let best = Infinity;
    this.forEachNear(x - reach, z - reach, x + reach, z + reach, (s) => {
      const d = pointSegmentDistance(x, z, this.ax[s], this.az[s], this.bx[s], this.bz[s]) - this.hw[s];
      if (d < best) best = d;
    });
    return best;
  }
}

// ─── Rect hash ────────────────────────────────────────────────────────────────

/** Spatial hash of placed footprints for overlap tests (incremental). */
export class RectHash {
  readonly cell: number;
  private map = new Map<number, number[]>();
  readonly rects: Rect[] = [];

  constructor(cellSize: number) {
    this.cell = cellSize;
  }

  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }

  add(r: Rect, _id?: number): void {
    const idx = this.rects.length;
    this.rects.push(r);
    const rad = rectRadius(r);
    const c = this.cell;
    const i0 = Math.floor((r.x - rad) / c);
    const i1 = Math.floor((r.x + rad) / c);
    const j0 = Math.floor((r.z - rad) / c);
    const j1 = Math.floor((r.z + rad) / c);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = this.key(i, j);
        let list = this.map.get(k);
        if (!list) this.map.set(k, (list = []));
        list.push(idx);
      }
  }

  anyOverlap(r: Rect, gap: number): boolean {
    const rad = rectRadius(r) + gap;
    const c = this.cell;
    const i0 = Math.floor((r.x - rad) / c);
    const i1 = Math.floor((r.x + rad) / c);
    const j0 = Math.floor((r.z - rad) / c);
    const j1 = Math.floor((r.z + rad) / c);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const list = this.map.get(this.key(i, j));
        if (!list) continue;
        for (const idx of list) if (rectsOverlap(this.rects[idx], r, gap)) return true;
      }
    return false;
  }
}

// ─── Polylines ────────────────────────────────────────────────────────────────

export function polylineLength(pts: XZ[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return s;
}

/**
 * Catmull-Rom through the points, resampled at (at most) `spacing` along the
 * arc, keeping both ends exactly. Straight inputs stay straight.
 */
export function resampleSmooth(pts: XZ[], spacing: number): XZ[] {
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, z: p.z }));
  // dense Catmull-Rom (8 sub-steps per input segment)
  const dense: XZ[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const sub = Math.max(1, Math.min(16, Math.ceil(segLen / spacing)));
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const t2 = t * t;
      const t3 = t2 * t;
      dense.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  dense.push({ x: pts[n - 1].x, z: pts[n - 1].z });
  // arc-length resample
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z));
  const total = cum[cum.length - 1];
  const m = Math.max(1, Math.ceil(total / spacing - 1e-9));
  const out: XZ[] = [];
  let j = 1;
  for (let i = 0; i <= m; i++) {
    const target = (i / m) * total;
    while (j < dense.length - 1 && cum[j] < target) j++;
    const a = dense[j - 1];
    const b = dense[j];
    const seg = cum[j] - cum[j - 1];
    const t = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j - 1]) / seg)) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  out[0] = { x: pts[0].x, z: pts[0].z };
  out[out.length - 1] = { x: pts[n - 1].x, z: pts[n - 1].z };
  return out;
}

/** Cumulative arc length at each vertex. */
export function cumulativeLength(pts: XZ[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return s;
}
