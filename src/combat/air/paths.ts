/**
 * Closed flight paths for the enemy aircraft (PURE): racetrack CAPs, the attack-pass pattern and
 * low circles, sampled as polylines with an altitude (MSL, or AGL for helicopters) and a speed at
 * every point; lookup by arc length (wrapping), nearest point, and pure-pursuit steering — the
 * turn rate that flies an arc through a point `lookahead` metres further along the path
 * (ω = 2·V·sin η / L), which gives smooth banked turns onto and around the path.
 */
import { wrapPi } from './flight';

const DEG = Math.PI / 180;

export interface FlightPath {
  x: Float64Array;
  z: Float64Array;
  /** Altitude at each point: m MSL, or m above the ground when `agl`. */
  alt: Float64Array;
  speed: Float64Array;
  /** Cumulative arc length at each point (s[0] = 0). */
  s: Float64Array;
  length: number;
  agl: boolean;
  /** Turning clockwise around the loop (seen from above). */
  clockwise: boolean;
}

export interface PathSample {
  x: number;
  z: number;
  alt: number;
  speed: number;
  /** Heading of the path there, rad clockwise from north. */
  heading: number;
}

export const newPathSample = (): PathSample => ({ x: 0, z: 0, alt: 0, speed: 0, heading: 0 });

interface RawPoint {
  x: number;
  z: number;
  alt: number;
  speed: number;
}

function build(points: RawPoint[], agl: boolean, clockwise: boolean): FlightPath {
  const n = points.length;
  const p: FlightPath = {
    x: new Float64Array(n), z: new Float64Array(n), alt: new Float64Array(n), speed: new Float64Array(n), s: new Float64Array(n), length: 0, agl, clockwise,
  };
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const q = points[i];
    p.x[i] = q.x;
    p.z[i] = q.z;
    p.alt[i] = q.alt;
    p.speed[i] = q.speed;
    if (i > 0) acc += Math.hypot(q.x - points[i - 1].x, q.z - points[i - 1].z);
    p.s[i] = acc;
  }
  acc += Math.hypot(points[0].x - points[n - 1].x, points[0].z - points[n - 1].z);
  p.length = acc;
  return p;
}

/** Unit vector for a heading (clockwise from north): east = sin, north = −z. */
const dirOf = (h: number) => ({ x: Math.sin(h), z: -Math.cos(h) });

/**
 * A racetrack: two straight legs of `leg` m joined by half circles of `radius`, centred on (cx, cz),
 * the first leg flown along `axisDeg`. `profile(u)` (u = 0..1 around the loop from the start of the
 * first leg) gives the altitude and speed. Turns clockwise (right-hand pattern) unless `left`.
 */
export function racetrack(cx: number, cz: number, axisDeg: number, leg: number, radius: number, profile: (u: number) => { alt: number; speed: number }, left = false, step = 60): FlightPath {
  const a = axisDeg * DEG;
  const f = dirOf(a);
  // Right of the axis (for a clockwise pattern the turn centres are on the right of leg 1).
  const side = left ? -1 : 1;
  const r = { x: -f.z * side, z: f.x * side };
  const half = leg / 2;
  const total = 2 * leg + 2 * Math.PI * radius;
  const pts: { x: number; z: number; d: number }[] = [];
  // Leg 1: from (c − f·half − r·radius) to (c + f·half − r·radius).
  const n1 = Math.max(2, Math.ceil(leg / step));
  const x0 = cx - r.x * radius, z0 = cz - r.z * radius;
  for (let i = 0; i < n1; i++) {
    const t = -half + (leg * i) / n1;
    pts.push({ x: x0 + f.x * t, z: z0 + f.z * t, d: (leg * i) / n1 });
  }
  // Turn 1 around (c + f·half), from −r to +r through +f.
  const nt = Math.max(6, Math.ceil((Math.PI * radius) / step));
  const t1x = cx + f.x * half, t1z = cz + f.z * half;
  for (let i = 0; i < nt; i++) {
    const th = (Math.PI * i) / nt;
    // start vector −r, rotate toward f
    const vx = -r.x * Math.cos(th) + f.x * Math.sin(th);
    const vz = -r.z * Math.cos(th) + f.z * Math.sin(th);
    pts.push({ x: t1x + vx * radius, z: t1z + vz * radius, d: leg + (Math.PI * radius * i) / nt });
  }
  // Leg 2: back along −f on the +r side.
  const x2 = cx + r.x * radius, z2 = cz + r.z * radius;
  for (let i = 0; i < n1; i++) {
    const t = half - (leg * i) / n1;
    pts.push({ x: x2 + f.x * t, z: z2 + f.z * t, d: leg + Math.PI * radius + (leg * i) / n1 });
  }
  // Turn 2 around (c − f·half), from +r to −r through −f.
  const t2x = cx - f.x * half, t2z = cz - f.z * half;
  for (let i = 0; i < nt; i++) {
    const th = (Math.PI * i) / nt;
    const vx = r.x * Math.cos(th) - f.x * Math.sin(th);
    const vz = r.z * Math.cos(th) - f.z * Math.sin(th);
    pts.push({ x: t2x + vx * radius, z: t2z + vz * radius, d: 2 * leg + Math.PI * radius + (Math.PI * radius * i) / nt });
  }
  const raw = pts.map((p) => {
    const pr = profile(p.d / total);
    return { x: p.x, z: p.z, alt: pr.alt, speed: pr.speed };
  });
  return build(raw, false, !left);
}

/** A circle of `radius` around (cx, cz) at `agl` m above the ground, clockwise unless `left`. */
export function circlePath(cx: number, cz: number, radius: number, agl: number, speed: number, left = false, step = 40): FlightPath {
  const n = Math.max(12, Math.ceil((2 * Math.PI * radius) / step));
  const raw: RawPoint[] = [];
  for (let i = 0; i < n; i++) {
    // clockwise seen from above = increasing heading: position angle measured as a heading
    const th = ((left ? -1 : 1) * 2 * Math.PI * i) / n;
    raw.push({ x: cx + Math.sin(th) * radius, z: cz - Math.cos(th) * radius, alt: agl, speed });
  }
  return build(raw, true, !left);
}

/** Arc length wrapped to 0..length. */
export function wrapS(p: FlightPath, s: number): number {
  if (!Number.isFinite(s) || p.length <= 0) return 0;
  const r = s % p.length;
  return r < 0 ? r + p.length : r;
}

/** Signed along-path difference a − b, wrapped to −L/2..L/2. */
export function deltaS(p: FlightPath, a: number, b: number): number {
  let d = wrapS(p, a - b);
  if (d > p.length / 2) d -= p.length;
  return d;
}

/** Index of the segment containing arc length s (binary search). */
function segmentAt(p: FlightPath, s: number): number {
  let lo = 0;
  let hi = p.s.length - 1;
  if (s >= p.s[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.s[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The point at arc length s (wrapping), with the path's heading there. */
export function samplePath(p: FlightPath, sIn: number, out: PathSample): PathSample {
  const s = wrapS(p, sIn);
  const n = p.x.length;
  const i = segmentAt(p, s);
  const j = (i + 1) % n;
  const s0 = p.s[i];
  const s1 = j === 0 ? p.length : p.s[j];
  const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  const dx = p.x[j] - p.x[i];
  const dz = p.z[j] - p.z[i];
  out.x = p.x[i] + dx * t;
  out.z = p.z[i] + dz * t;
  out.alt = p.alt[i] + (p.alt[j] - p.alt[i]) * t;
  out.speed = p.speed[i] + (p.speed[j] - p.speed[i]) * t;
  out.heading = Math.atan2(dx, -dz);
  return out;
}

/**
 * Arc length of the point on the path nearest (x, z). With a `hint`, only within
 * [hint − back, hint + ahead] (cheap, keeps the follower from jumping across the loop).
 */
export function nearestS(p: FlightPath, x: number, z: number, hint?: number, back = 400, ahead = 1600): number {
  const n = p.x.length;
  let best = Infinity;
  let bestS = 0;
  const test = (i: number) => {
    const j = (i + 1) % n;
    const ax = p.x[i], az = p.z[i];
    const dx = p.x[j] - ax, dz = p.z[j] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const px = ax + dx * t, pz = az + dz * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) {
      best = d2;
      const s1 = j === 0 ? p.length : p.s[j];
      bestS = p.s[i] + (s1 - p.s[i]) * t;
    }
  };
  if (hint === undefined || !Number.isFinite(hint)) {
    for (let i = 0; i < n; i++) test(i);
  } else {
    const s0 = hint - back;
    let i = segmentAt(p, wrapS(p, s0));
    let covered = 0;
    const span = back + ahead;
    for (let k = 0; k < n && covered <= span; k++) {
      test(i);
      const j = (i + 1) % n;
      covered += (j === 0 ? p.length : p.s[j]) - p.s[i];
      i = j;
    }
  }
  return wrapS(p, bestS);
}

/**
 * Pure-pursuit turn rate toward (tx, tz) from (x, z) flying `heading` at `speed`:
 * the arc through the target point, ω = 2·V·sin η / L.
 */
export function pursuitTurnRate(x: number, z: number, heading: number, speed: number, tx: number, tz: number): number {
  const dx = tx - x;
  const dz = tz - z;
  const L = Math.hypot(dx, dz);
  if (!(L > 1e-3)) return 0;
  const eta = wrapPi(Math.atan2(dx, -dz) - heading);
  // Behind: turn the shorter way at the full rate (sin η saturates at ±1).
  const k = Math.abs(eta) > Math.PI / 2 ? Math.sign(eta) : Math.sin(eta);
  return (2 * speed * k) / Math.max(L, 1);
}

/** Heading (rad) from (x, z) to (tx, tz). */
export const bearingTo = (x: number, z: number, tx: number, tz: number): number => Math.atan2(tx - x, -(tz - z));
