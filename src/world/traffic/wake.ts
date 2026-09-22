/**
 * Wake geometry (PURE, typed arrays, no allocation per call): for a moving
 * hull, three ribbons on the water written from the hull's past track —
 *
 *  - the turbulent foam trail straight behind the stern (widening, fading),
 *  - the two Kelvin arms: cusp lines leaving the bow at ±19.47° from the track
 *    (narrower for fast planing hulls, α ≈ 0.18/Fr), built from where the bow
 *    was `a` seconds ago, offset sideways by (distance travelled since)·tan α.
 *
 * Because every sample comes from the route (pose at t − a), wakes follow
 * turns exactly, fade with age and vanish when the hull stops.
 *
 * Per vertex: position (x, y, z) and `aWake` = (along m, across −1..1,
 * age 0..1, intensity 0..1) plus `aType` (0 foam, 1 Kelvin arm).
 */

export interface WakeSample {
  x: number;
  z: number;
  /** Direction of travel, deg. */
  course: number;
  speed: number;
  /** Monotonic distance travelled along the route, m. */
  travelled: number;
  /** Seconds since the hull was here. */
  age: number;
}

export interface WakeSpec {
  length: number;
  beam: number;
  /** Seconds after which the wake has faded out. */
  maxAge: number;
  /** Speed (m/s) at which the wake is at full strength. */
  fullSpeed: number;
  /** Strength of the Kelvin arms relative to the foam (0..1). */
  kelvin: number;
  /** Water surface height. */
  level: number;
}

/** Vertices per wake sample: foam (2) + two arms (2 + 2). */
export const WAKE_VERTS_PER_SAMPLE = 6;

export interface WakeBuffers {
  position: Float32Array;
  data: Float32Array;
  type: Float32Array;
}

const DEG = Math.PI / 180;
const KELVIN = 19.47 * DEG;

/** Half-angle of the Kelvin wedge for a hull of length L at speed v (m/s), radians. */
export function kelvinAngle(speed: number, length: number): number {
  const fr = speed / Math.sqrt(9.81 * Math.max(1, length));
  if (fr <= 0.55) return KELVIN;
  return Math.max(6 * DEG, Math.min(KELVIN, 0.18 / fr));
}

/** Sample ages (s) for a wake: dense near the hull. */
export function wakeAges(count: number, maxAge: number, out: Float32Array | number[]): void {
  for (let j = 0; j < count; j++) out[j] = maxAge * Math.pow(j / (count - 1), 1.55);
}

/**
 * Writes the three ribbons for `samples[0..count)` (samples[0] = now) starting at vertex `v0`.
 * Ribbon layout (so a static index buffer can stitch it): foam verts at v0 + 2j (+0 left, +1 right),
 * left arm at v0 + 2count + 2j, right arm at v0 + 4count + 2j. Returns the vertex count written.
 */
export function writeWake(buf: WakeBuffers, v0: number, samples: readonly WakeSample[], count: number, spec: WakeSpec): number {
  const P = buf.position;
  const D = buf.data;
  const T = buf.type;
  const now = samples[0];
  const halfL = spec.length / 2;
  const halfB = spec.beam / 2;
  const y = spec.level + 0.06;
  for (let j = 0; j < count; j++) {
    const s = samples[j];
    const h = s.course * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    // right-hand perpendicular (starboard of travel): (−fz, fx)
    const rx = -fz;
    const rz = fx;
    const age01 = Math.min(1, s.age / spec.maxAge);
    const vf = Math.min(1, s.speed / spec.fullSpeed);
    const strength = Math.pow(vf, 0.8) * Math.pow(1 - age01, 1.35);
    // ── foam trail from the stern ──
    const sx = s.x - fx * halfL * 0.92;
    const sz = s.z - fz * halfL * 0.92;
    const fw = halfB * (0.62 + 1.9 * Math.pow(age01, 0.6)) * (0.55 + 0.45 * vf);
    let k = v0 + 2 * j;
    for (let side = -1; side <= 1; side += 2, k++) {
      P[k * 3] = sx + rx * fw * side;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = sz + rz * fw * side;
      D[k * 4] = s.travelled;
      D[k * 4 + 1] = side;
      D[k * 4 + 2] = age01;
      D[k * 4 + 3] = strength;
      T[k] = 0;
    }
    // ── Kelvin arms from the bow ──
    const bx = s.x + fx * halfL * 0.86;
    const bz = s.z + fz * halfL * 0.86;
    const dist = Math.max(0, now.travelled - s.travelled);
    const alpha = kelvinAngle(s.speed, spec.length);
    const off = halfB * 0.85 + dist * Math.tan(alpha);
    const hw = 0.35 + halfB * 0.12 + 0.018 * dist;
    const armStrength = strength * spec.kelvin;
    for (let arm = 0; arm < 2; arm++) {
      const sgn = arm === 0 ? -1 : 1;
      const cx = bx + rx * off * sgn;
      const cz = bz + rz * off * sgn;
      let q = v0 + (2 + 2 * arm) * count + 2 * j;
      for (let e = -1; e <= 1; e += 2, q++) {
        // e = −1 inner edge (toward the track), +1 outer edge
        P[q * 3] = cx + rx * hw * e * sgn;
        P[q * 3 + 1] = y;
        P[q * 3 + 2] = cz + rz * hw * e * sgn;
        D[q * 4] = dist;
        D[q * 4 + 1] = e;
        D[q * 4 + 2] = age01;
        D[q * 4 + 3] = armStrength;
        T[q] = 1;
      }
    }
  }
  return WAKE_VERTS_PER_SAMPLE * count;
}

/** Index buffer stitching `vessels` wake blocks of `count` samples each (3 strips per block). */
export function wakeIndices(vessels: number, count: number): Uint32Array {
  const per = 3 * (count - 1) * 6;
  const idx = new Uint32Array(vessels * per);
  let o = 0;
  for (let v = 0; v < vessels; v++) {
    const base = v * WAKE_VERTS_PER_SAMPLE * count;
    for (let r = 0; r < 3; r++) {
      const rb = base + r * 2 * count;
      for (let j = 0; j < count - 1; j++) {
        const a = rb + 2 * j;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        idx[o++] = a;
        idx[o++] = c;
        idx[o++] = b;
        idx[o++] = b;
        idx[o++] = c;
        idx[o++] = d;
      }
    }
  }
  return idx;
}
