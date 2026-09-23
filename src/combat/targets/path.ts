/**
 * Polylines for the range (PURE): arc-length parameterised tracks (closed loops or open paths),
 * uniform resampling, Chaikin smoothing and allocation-free sampling (position + tangent + left
 * normal at an arc length).
 */
export interface XZ {
  x: number;
  z: number;
}

export interface TrackPath {
  readonly closed: boolean;
  readonly n: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** Arc length at each station; `length` is the total (back to station 0 when closed). */
  readonly s: Float64Array;
  readonly length: number;
}

export interface PathSample {
  x: number;
  z: number;
  /** Unit tangent (direction of travel). */
  tx: number;
  tz: number;
  /** Station index at or before the sample. */
  i: number;
}

export const newPathSample = (): PathSample => ({ x: 0, z: 0, tx: 0, tz: -1, i: 0 });

export function makePath(points: readonly XZ[], closed: boolean): TrackPath {
  // drop consecutive duplicates (and the closing duplicate)
  const pts: XZ[] = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > 1e-6) pts.push({ x: p.x, z: p.z });
  }
  if (closed && pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-6) pts.pop();
  const n = pts.length;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = pts[i].x;
    z[i] = pts[i].z;
    if (i > 0) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  }
  const length = n === 0 ? 0 : closed && n > 1 ? s[n - 1] + Math.hypot(x[0] - x[n - 1], z[0] - z[n - 1]) : s[n - 1];
  return { closed, n, x, z, s, length };
}

/** Wrap (closed) or clamp (open) an arc length onto the path. */
export function wrapS(p: TrackPath, s: number): number {
  if (!(p.length > 0) || !Number.isFinite(s)) return 0;
  if (p.closed) return ((s % p.length) + p.length) % p.length;
  return s < 0 ? 0 : s > p.length ? p.length : s;
}

/** Signed arc distance from a to b along the direction of travel (closed: in (−L/2, L/2]). */
export function arcDelta(p: TrackPath, a: number, b: number): number {
  let d = b - a;
  if (p.closed && p.length > 0) {
    d = ((d % p.length) + p.length) % p.length;
    if (d > p.length / 2) d -= p.length;
  }
  return d;
}

/** Position and tangent at arc length s. Writes into `out`. */
export function sampleAt(p: TrackPath, sIn: number, out: PathSample): PathSample {
  if (p.n === 0) {
    out.x = out.z = 0;
    out.tx = 0;
    out.tz = -1;
    out.i = 0;
    return out;
  }
  if (p.n === 1) {
    out.x = p.x[0];
    out.z = p.z[0];
    out.tx = 0;
    out.tz = -1;
    out.i = 0;
    return out;
  }
  const s = wrapS(p, sIn);
  // binary search: last station with s[i] <= s
  let lo = 0;
  let hi = p.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (p.s[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  let i = lo;
  let j = i + 1;
  if (j >= p.n) {
    if (p.closed) j = 0;
    else {
      i = p.n - 2;
      j = p.n - 1;
    }
  }
  const s0 = p.s[i];
  const s1 = j === 0 ? p.length : p.s[j];
  const seg = s1 - s0;
  const t = seg > 1e-9 ? Math.min(1, Math.max(0, (s - s0) / seg)) : 0;
  const dx = p.x[j] - p.x[i];
  const dz = p.z[j] - p.z[i];
  const l = Math.hypot(dx, dz) || 1;
  out.x = p.x[i] + dx * t;
  out.z = p.z[i] + dz * t;
  out.tx = dx / l;
  out.tz = dz / l;
  out.i = i;
  return out;
}

/** Uniform resampling at ~`spacing` m (keeps the ends of an open path). */
export function resample(points: readonly XZ[], spacing: number, closed: boolean): XZ[] {
  const p = makePath(points, closed);
  if (p.n < 2 || !(p.length > 0)) return points.map((q) => ({ x: q.x, z: q.z }));
  const count = Math.max(closed ? 3 : 2, Math.round(p.length / spacing));
  const out: XZ[] = [];
  const smp = newPathSample();
  const last = closed ? count - 1 : count;
  for (let k = 0; k <= last; k++) {
    sampleAt(p, (k / count) * p.length, smp);
    out.push({ x: smp.x, z: smp.z });
  }
  return out;
}

/** Chaikin corner cutting (one pass); open paths keep their ends. */
export function chaikin(points: readonly XZ[], closed: boolean): XZ[] {
  const n = points.length;
  if (n < 3) return points.map((q) => ({ x: q.x, z: q.z }));
  const out: XZ[] = [];
  if (!closed) out.push({ x: points[0].x, z: points[0].z });
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    out.push({ x: 0.75 * a.x + 0.25 * b.x, z: 0.75 * a.z + 0.25 * b.z });
    out.push({ x: 0.25 * a.x + 0.75 * b.x, z: 0.25 * a.z + 0.75 * b.z });
  }
  if (!closed) out.push({ x: points[n - 1].x, z: points[n - 1].z });
  return out;
}

/** Nearest point of the path to (x, z): its arc length and distance. */
export function nearestOnPath(p: TrackPath, x: number, z: number): { s: number; d: number } {
  let best = Infinity;
  let bestS = 0;
  const segs = p.closed ? p.n : p.n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % p.n;
    const ax = p.x[i];
    const az = p.z[i];
    const dx = p.x[j] - ax;
    const dz = p.z[j] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) {
      best = d;
      bestS = p.s[i] + t * Math.sqrt(l2);
    }
  }
  if (p.n === 1) return { s: 0, d: Math.hypot(p.x[0] - x, p.z[0] - z) };
  return { s: wrapS(p, bestS), d: best };
}
