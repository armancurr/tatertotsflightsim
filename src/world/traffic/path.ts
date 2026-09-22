/**
 * Paths for traffic: dense 3D polylines with arc-length and time tables, so a
 * vehicle's pose is a pure function of the distance travelled (or of time).
 *
 *  - `smoothLoop` / `smoothLine`: Catmull-Rom curves through control points.
 *  - `filletPath`: straight legs joined by circular arcs of a given radius
 *    (aircraft circuits, taxi routes) with heights/speeds per waypoint.
 *  - `createPath`: resamples any polyline at uniform spacing and builds the
 *    tables; `samplePath(s)` / `samplePathAtTime(t)` fill a reusable sample.
 *
 * Frame: +X east, +Y up, +Z south; heading clockwise from north (−Z). PURE.
 */

export interface P3 {
  x: number;
  y: number;
  z: number;
}

export interface PathSample {
  x: number;
  y: number;
  z: number;
  /** Heading of travel, deg 0..360 clockwise from north. */
  heading: number;
  /** Signed horizontal curvature, 1/m (+ = turning right). */
  curvature: number;
  /** Climb gradient dy/ds. */
  grade: number;
  /** Speed at this point, m/s (from the path's speed table; 0 if none). */
  speed: number;
  /** Arc length at this point, m. */
  s: number;
}

export function newPathSample(): PathSample {
  return { x: 0, y: 0, z: 0, heading: 0, curvature: 0, grade: 0, speed: 0, s: 0 };
}

export interface Path {
  readonly closed: boolean;
  /** Total arc length (horizontal), m. */
  readonly length: number;
  /** Total traversal time with the speed table, s (Infinity if some speed is 0). */
  readonly duration: number;
  readonly n: number;
  readonly s: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** Unwrapped heading (rad) per sample, continuous. */
  readonly psi: Float64Array;
  readonly v: Float64Array;
  /** Cumulative time per sample, s. */
  readonly t: Float64Array;
}

const TAU = Math.PI * 2;
const RAD = 180 / Math.PI;

export const headingOf = (dx: number, dz: number): number => {
  const h = Math.atan2(dx, -dz) * RAD;
  const w = h < 0 ? h + 360 : h;
  return w >= 360 ? w - 360 : w;
};

/**
 * Resamples `pts` at ~`spacing` m and builds the tables. `speed(i, p)` gives the speed at each
 * resampled point (default: the interpolated `speed` field of the input points, else 1 m/s).
 */
export function createPath(pts: (P3 & { v?: number })[], closed: boolean, spacing = 5): Path {
  if (pts.length < 2) throw new Error('path needs ≥ 2 points');
  const src = closed ? [...pts, pts[0]] : pts;
  // cumulative horizontal length of the input
  const cs = [0];
  for (let i = 1; i < src.length; i++) cs.push(cs[i - 1] + Math.hypot(src[i].x - src[i - 1].x, src[i].z - src[i - 1].z));
  const total = cs[cs.length - 1];
  const count = Math.max(2, Math.round(total / spacing));
  const n = closed ? count : count + 1;
  const s = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const v = new Float64Array(n);
  let j = 1;
  for (let i = 0; i < n; i++) {
    const target = (i / count) * total;
    while (j < src.length - 1 && cs[j] < target) j++;
    const a = src[j - 1];
    const b = src[j];
    const seg = cs[j] - cs[j - 1];
    const f = seg > 1e-9 ? Math.min(1, Math.max(0, (target - cs[j - 1]) / seg)) : 0;
    s[i] = target;
    x[i] = a.x + (b.x - a.x) * f;
    y[i] = a.y + (b.y - a.y) * f;
    z[i] = a.z + (b.z - a.z) * f;
    // v² linear in s = constant acceleration between input points
    const va = a.v ?? 1;
    const vb = b.v ?? 1;
    v[i] = Math.sqrt(Math.max(0, va * va + (vb * vb - va * va) * f));
  }
  // headings (central differences), unwrapped
  const psi = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let i0 = i - 1;
    let i1 = i + 1;
    if (closed) {
      i0 = (i0 + n) % n;
      i1 = i1 % n;
    } else {
      i0 = Math.max(0, i0);
      i1 = Math.min(n - 1, i1);
    }
    psi[i] = Math.atan2(x[i1] - x[i0], -(z[i1] - z[i0]));
  }
  for (let i = 1; i < n; i++) {
    let d = psi[i] - psi[i - 1];
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    psi[i] = psi[i - 1] + d;
  }
  // time table
  const t = new Float64Array(n);
  let dur = 0;
  for (let i = 1; i < n; i++) {
    const ds = s[i] - s[i - 1];
    const vm = (v[i] + v[i - 1]) / 2;
    dur += vm > 1e-6 ? ds / vm : Infinity;
    t[i] = dur;
  }
  if (closed) {
    const ds = total - s[n - 1];
    const vm = (v[n - 1] + v[0]) / 2;
    dur += vm > 1e-6 ? ds / vm : Infinity;
  }
  return { closed, length: total, duration: dur, n, s, x, y, z, psi, v, t };
}

/** Index i with s[i] ≤ q < s[i+1] (binary search). */
function findSeg(arr: Float64Array, n: number, q: number): number {
  let lo = 0;
  let hi = n - 1;
  if (q <= arr[0]) return 0;
  if (q >= arr[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= q) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Samples the path at arc length `sq` (wrapped for closed paths, clamped for open ones). */
export function samplePath(p: Path, sq: number, out: PathSample): PathSample {
  const L = p.length;
  let q = sq;
  if (p.closed) {
    q = ((q % L) + L) % L;
  } else {
    q = q < 0 ? 0 : q > L ? L : q;
  }
  const n = p.n;
  const i = findSeg(p.s, n, q);
  let i1 = i + 1;
  let s1: number;
  if (i1 >= n) {
    if (p.closed) {
      i1 = 0;
      s1 = L;
    } else {
      i1 = n - 1;
      s1 = p.s[n - 1];
    }
  } else s1 = p.s[i1];
  const s0 = p.s[i];
  const f = s1 - s0 > 1e-9 ? (q - s0) / (s1 - s0) : 0;
  out.x = p.x[i] + (p.x[i1] - p.x[i]) * f;
  out.y = p.y[i] + (p.y[i1] - p.y[i]) * f;
  out.z = p.z[i] + (p.z[i1] - p.z[i]) * f;
  let pa = p.psi[i];
  let pb = p.psi[i1];
  if (i1 === 0 && p.closed) {
    // wrap the unwrapped heading back near pa
    while (pb - pa > Math.PI) pb -= TAU;
    while (pb - pa < -Math.PI) pb += TAU;
  }
  const psi = pa + (pb - pa) * f;
  let h = (psi * RAD) % 360;
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  out.heading = h;
  const ds = s1 - s0;
  out.curvature = ds > 1e-9 ? (pb - pa) / ds : 0;
  out.grade = ds > 1e-9 ? (p.y[i1] - p.y[i]) / ds : 0;
  out.speed = p.v[i] + (p.v[i1] - p.v[i]) * f;
  out.s = q;
  return out;
}

/** Arc length reached `time` seconds after the start of the path (wrapped for closed paths). */
export function arcAtTime(p: Path, time: number): number {
  const D = p.duration;
  let tq = time;
  if (p.closed && Number.isFinite(D) && D > 0) tq = ((tq % D) + D) % D;
  const n = p.n;
  if (tq <= 0) return 0;
  if (tq >= p.t[n - 1]) {
    if (!p.closed) return p.length;
    // last (closing) segment
    const ds = p.length - p.s[n - 1];
    const dt = D - p.t[n - 1];
    return p.s[n - 1] + (dt > 1e-9 ? ((tq - p.t[n - 1]) / dt) * ds : 0);
  }
  const i = findSeg(p.t, n, tq);
  const t0 = p.t[i];
  const t1 = p.t[i + 1];
  const v0 = p.v[i];
  const v1 = p.v[i + 1];
  const ds = p.s[i + 1] - p.s[i];
  const dt = t1 - t0;
  if (dt <= 1e-9) return p.s[i];
  // constant acceleration within the segment: s = v0 τ + ½ a τ²
  const tau = tq - t0;
  const a = (v1 - v0) / dt;
  const sl = v0 * tau + 0.5 * a * tau * tau;
  return p.s[i] + Math.min(ds, Math.max(0, sl));
}

export function samplePathAtTime(p: Path, time: number, out: PathSample): PathSample {
  return samplePath(p, arcAtTime(p, time), out);
}

// ─── Curve constructors ──────────────────────────────────────────────────────

interface CtrlPoint {
  x: number;
  z: number;
  y?: number;
  v?: number;
}

/** Centripetal-ish uniform Catmull-Rom through the control points (closed loop). */
export function smoothLoop(ctrl: CtrlPoint[], perSeg = 20): (P3 & { v: number })[] {
  const n = ctrl.length;
  const out: (P3 & { v: number })[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n];
    const p3 = ctrl[(i + 2) % n];
    for (let k = 0; k < perSeg; k++) out.push(cr(p0, p1, p2, p3, k / perSeg));
  }
  return out;
}

/** Catmull-Rom through the control points (open, ends clamped). */
export function smoothLine(ctrl: CtrlPoint[], perSeg = 20): (P3 & { v: number })[] {
  const n = ctrl.length;
  const out: (P3 & { v: number })[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let k = 0; k < perSeg; k++) out.push(cr(p0, p1, p2, p3, k / perSeg));
  }
  const e = ctrl[n - 1];
  out.push({ x: e.x, y: e.y ?? 0, z: e.z, v: e.v ?? 1 });
  return out;
}

function cr(p0: CtrlPoint, p1: CtrlPoint, p2: CtrlPoint, p3: CtrlPoint, t: number): P3 & { v: number } {
  const t2 = t * t;
  const t3 = t2 * t;
  const c = (a: number, b: number, c2: number, d: number) => 0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3);
  const lin = (a: number | undefined, b: number | undefined, d: number) => (a ?? d) + ((b ?? d) - (a ?? d)) * t;
  return { x: c(p0.x, p1.x, p2.x, p3.x), z: c(p0.z, p1.z, p2.z, p3.z), y: lin(p1.y, p2.y, 0), v: lin(p1.v, p2.v, 1) };
}

export interface Waypoint {
  x: number;
  z: number;
  /** Height at this waypoint (m MSL); interpolated along arc length between waypoints. */
  y: number;
  /** Speed at this waypoint, m/s; interpolated along arc length. */
  v: number;
  /** Turn radius used to round the corner at this waypoint (m); 0 = sharp. */
  r?: number;
  /**
   * Height profile of the segment arriving at this waypoint: 'smooth' (default, level at both ends),
   * 'linear' (constant gradient), 'out' (steepest at the start, levels off: a flare / level-off),
   * 'in' (level at the start, steepest at the end: a lift-off).
   */
  ease?: 'smooth' | 'linear' | 'in' | 'out';
}

/**
 * Straight legs through the waypoints with each interior corner rounded by an arc of radius `r`
 * (clamped so neighbouring arcs never overlap). Heights and speeds are interpolated linearly in
 * arc length between the waypoints' positions projected onto the rounded path.
 */
export function filletPath(wps: Waypoint[], step = 4): (P3 & { v: number })[] {
  const n = wps.length;
  if (n < 2) throw new Error('filletPath needs ≥ 2 waypoints');
  // corner geometry
  type Corner = { tx0: number; tz0: number; tx1: number; tz1: number; cx: number; cz: number; r: number; a0: number; da: number; ok: boolean };
  const corners: (Corner | null)[] = wps.map(() => null);
  const legLen: number[] = [];
  for (let i = 0; i < n - 1; i++) legLen.push(Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].z - wps[i].z));
  for (let i = 1; i < n - 1; i++) {
    const r0 = wps[i].r ?? 0;
    if (r0 <= 0) continue;
    const ax = wps[i].x - wps[i - 1].x;
    const az = wps[i].z - wps[i - 1].z;
    const bx = wps[i + 1].x - wps[i].x;
    const bz = wps[i + 1].z - wps[i].z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ux = ax / la;
    const uz = az / la;
    const wx = bx / lb;
    const wz = bz / lb;
    const cos = Math.max(-1, Math.min(1, ux * wx + uz * wz));
    const theta = Math.acos(cos); // turn angle
    if (theta < 1e-4) continue;
    let r = r0;
    let d = r * Math.tan(theta / 2);
    const maxD = Math.min(la, lb) * 0.49;
    if (d > maxD) {
      d = maxD;
      r = d / Math.tan(theta / 2);
    }
    const cross = ux * wz - uz * wx; // + → turning right? (x east, z south): right turn has cross > 0
    const tx0 = wps[i].x - ux * d;
    const tz0 = wps[i].z - uz * d;
    const tx1 = wps[i].x + wx * d;
    const tz1 = wps[i].z + wz * d;
    // centre: perpendicular from tx0 toward the inside of the turn
    const side = cross > 0 ? 1 : -1;
    const px = -uz * side;
    const pz = ux * side;
    const cx = tx0 + px * r;
    const cz = tz0 + pz * r;
    const a0 = Math.atan2(tz0 - cz, tx0 - cx);
    const da = side * theta;
    corners[i] = { tx0, tz0, tx1, tz1, cx, cz, r, a0, da, ok: true };
  }
  // walk: collect points with the waypoint index "progress" to interpolate y and v
  const raw: { x: number; z: number; k: number }[] = [];
  const push = (x: number, z: number, k: number) => raw.push({ x, z, k });
  push(wps[0].x, wps[0].z, 0);
  for (let i = 1; i < n; i++) {
    const c = corners[i];
    const endX = c ? c.tx0 : wps[i].x;
    const endZ = c ? c.tz0 : wps[i].z;
    const last = raw[raw.length - 1];
    const L = Math.hypot(endX - last.x, endZ - last.z);
    const m = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= m; k++) push(last.x + ((endX - last.x) * k) / m, last.z + ((endZ - last.z) * k) / m, i - 1 + 0.999 * (k / m));
    if (c) {
      const arcLen = Math.abs(c.da) * c.r;
      const m2 = Math.max(2, Math.ceil(arcLen / step));
      for (let k = 1; k <= m2; k++) {
        const a = c.a0 + (c.da * k) / m2;
        push(c.cx + Math.cos(a) * c.r, c.cz + Math.sin(a) * c.r, i);
      }
    }
  }
  // arc lengths; y / v interpolate between waypoint anchors (first sample where k reaches an integer)
  const s = [0];
  for (let i = 1; i < raw.length; i++) s.push(s[i - 1] + Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z));
  const anchorS: number[] = new Array(n).fill(0);
  let wi = 0;
  for (let i = 0; i < raw.length; i++) {
    while (wi < n && raw[i].k >= wi) {
      // the waypoint's arc-length anchor: middle of its corner arc, or the vertex itself
      anchorS[wi] = s[i];
      wi++;
    }
  }
  for (; wi < n; wi++) anchorS[wi] = s[s.length - 1];
  // corners: anchor at the arc middle
  for (let i = 1; i < n - 1; i++) {
    const c = corners[i];
    if (!c) continue;
    anchorS[i] += (Math.abs(c.da) * c.r) / 2;
  }
  anchorS[n - 1] = s[s.length - 1];
  return raw.map((p, i) => {
    let k = 0;
    while (k < n - 2 && s[i] > anchorS[k + 1]) k++;
    const span = anchorS[k + 1] - anchorS[k];
    const f = span > 1e-9 ? Math.min(1, Math.max(0, (s[i] - anchorS[k]) / span)) : 1;
    const e = wps[k + 1].ease ?? 'smooth';
    const fy = e === 'linear' ? f : e === 'out' ? 1 - (1 - f) * (1 - f) : e === 'in' ? f * f : f * f * (3 - 2 * f);
    const va = wps[k].v;
    const vb = wps[k + 1].v;
    return { x: p.x, z: p.z, y: wps[k].y + (wps[k + 1].y - wps[k].y) * fy, v: Math.sqrt(Math.max(0, va * va + (vb * vb - va * va) * f)) };
  });
}

/** Minimum over samples every `step` m of `fn(x, z)` along a path. */
export function minAlong(p: Path, step: number, fn: (x: number, z: number, heading: number) => number): number {
  const smp = newPathSample();
  let lo = Infinity;
  const m = Math.max(1, Math.ceil(p.length / step));
  for (let i = 0; i <= m; i++) {
    samplePath(p, (i / m) * p.length, smp);
    const v = fn(smp.x, smp.z, smp.heading);
    if (v < lo) lo = v;
  }
  return lo;
}
