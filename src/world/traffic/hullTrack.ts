/**
 * The player's hull track for its wake and spray (PURE, no three.js, no allocation per frame).
 *
 * Traffic wakes are written from each route's past poses (`vesselTrack(route, t − age)`); a driven
 * boat has no route, so `HullTrack` records where its hull has been: a ring buffer of (time, hull
 * centre, heading, speed through the water, distance travelled), sampled every `minDt` s. `sample`
 * interpolates the pose `age` s ago into a `WakeSample` for wake.ts `writeWake`, so the player's
 * wake is the same foam trail and Kelvin arms as the traffic's, following every turn.
 *
 * Also the hull's size for the wake (from the station table) and the spray model: how much bow
 * spray, quarter-wave spray and slamming spray a hull throws at a given speed, planing fraction
 * and bow impact speed (`sprayRates`), and where the bow spray leaves the hull (`bowSprayOrigin`).
 */
import type { WakeSample } from './wake';

export interface HullSize {
  /** Waterline-ish length (stem to transom) and beam (2 × the widest deck half-breadth), m. */
  length: number;
  beam: number;
  /** Body z of the hull's middle (the CG is at 0; body −z is forward), m. */
  midZ: number;
  /** Body z of the stem and the transom. */
  stemZ: number;
  transomZ: number;
}

/** Hull size from a station table (src/config.ts HullStation: z ascending bow → stern). */
export function hullSize(stations: readonly { z: number; deckHalf: number }[]): HullSize {
  const stemZ = stations[0].z;
  const transomZ = stations[stations.length - 1].z;
  let half = 0;
  for (const s of stations) half = Math.max(half, s.deckHalf);
  return { length: transomZ - stemZ, beam: 2 * half, midZ: (stemZ + transomZ) / 2, stemZ, transomZ };
}

export class HullTrack {
  readonly capacity: number;
  readonly minDt: number;
  private readonly t: Float64Array;
  private readonly x: Float64Array;
  private readonly z: Float64Array;
  private readonly h: Float32Array;
  private readonly v: Float32Array;
  private readonly s: Float64Array;
  private readonly p: Float32Array;
  private readonly w: Float32Array;
  /** Index of the newest entry, and the number of entries. */
  private head = -1;
  private n = 0;
  /** Distance travelled so far (monotonic), m. */
  travelled = 0;

  /** `capacity` entries every `minDt` s cover `capacity × minDt` s of wake. */
  constructor(capacity = 640, minDt = 0.1) {
    this.capacity = capacity;
    this.minDt = minDt;
    this.t = new Float64Array(capacity);
    this.x = new Float64Array(capacity);
    this.z = new Float64Array(capacity);
    this.h = new Float32Array(capacity);
    this.v = new Float32Array(capacity);
    this.s = new Float64Array(capacity);
    this.p = new Float32Array(capacity);
    this.w = new Float32Array(capacity);
  }

  /** Distance travelled at the oldest entry held (m). */
  get oldestTravelled(): number {
    return this.n ? this.s[(this.head - this.n + 1 + this.capacity) % this.capacity] : this.travelled;
  }

  /**
   * The hull where it had travelled `sq` m (the FIRST time it got there), into `out` with `age` =
   * seconds since, and `planing` / `wash` if `out` has them. Clamped to the history held.
   */
  sampleAtDistance(sq: number, now: number, out: WakeSample & { planing?: number; wash?: number }): WakeSample {
    const C = this.capacity;
    if (this.n === 0) {
      out.speed = 0;
      out.age = 0;
      out.travelled = sq;
      return out;
    }
    const oldest = (this.head - this.n + 1 + C) % C;
    let i: number;
    let k = 0;
    if (sq <= this.s[oldest]) i = oldest;
    else if (sq >= this.s[this.head]) {
      // the first entry that reached the newest distance
      let lo = 0;
      let hi = this.n - 1;
      const top = this.s[this.head];
      while (hi > lo) {
        const mid = (lo + hi) >> 1;
        if (this.s[(oldest + mid) % C] >= top - 1e-9) hi = mid;
        else lo = mid + 1;
      }
      i = (oldest + lo) % C;
    } else {
      // first index with s ≥ sq, then interpolate from the one before
      let lo = 0;
      let hi = this.n - 1;
      while (hi > lo) {
        const mid = (lo + hi) >> 1;
        if (this.s[(oldest + mid) % C] >= sq) hi = mid;
        else lo = mid + 1;
      }
      const b = (oldest + lo) % C;
      const a = (oldest + lo - 1 + C) % C;
      const span = this.s[b] - this.s[a];
      k = span > 1e-9 ? (sq - this.s[a]) / span : 1;
      out.x = this.x[a] + (this.x[b] - this.x[a]) * k;
      out.z = this.z[a] + (this.z[b] - this.z[a]) * k;
      const dh = ((((this.h[b] - this.h[a]) % 360) + 540) % 360) - 180;
      out.course = (this.h[a] + dh * k + 360) % 360;
      out.speed = this.v[a] + (this.v[b] - this.v[a]) * k;
      out.travelled = sq;
      out.age = now - (this.t[a] + (this.t[b] - this.t[a]) * k);
      if ('planing' in out) out.planing = this.p[a] + (this.p[b] - this.p[a]) * k;
      if ('wash' in out) out.wash = this.w[a] + (this.w[b] - this.w[a]) * k;
      return out;
    }
    this.copy(i, out);
    out.age = now - this.t[i];
    if ('planing' in out) out.planing = this.p[i];
    if ('wash' in out) out.wash = this.w[i];
    return out;
  }

  get length(): number {
    return this.n;
  }

  /** Seconds of history held. */
  get span(): number {
    return this.n ? this.t[this.head] - this.t[(this.head - this.n + 1 + this.capacity) % this.capacity] : 0;
  }

  reset(): void {
    this.head = -1;
    this.n = 0;
    this.travelled = 0;
  }

  /**
   * Records the hull at time `time` (s, monotonic; a step back in time clears the track): hull
   * centre (x, z), heading (deg) and speed through the water (m/s, |·| is used). Returns true when
   * a new entry was stored (at most one per `minDt`). `planing` 0..1 and `wash` (the propulsors'
   * load, 0..1+: how hard the propellers / jet churn the water) ride along for the wake field.
   */
  push(time: number, x: number, z: number, headingDeg: number, speed: number, planing = 0, wash = 0.7): boolean {
    if (this.n > 0) {
      const lt = this.t[this.head];
      if (time < lt - 1e-6) this.reset();
      else if (time - lt < this.minDt - 1e-6) return false;
    }
    if (this.n > 0) {
      const d = Math.hypot(x - this.x[this.head], z - this.z[this.head]);
      // (a teleport is not a wake)
      if (d > 200) this.reset();
      else this.travelled += d;
    }
    this.head = (this.head + 1) % this.capacity;
    this.t[this.head] = time;
    this.x[this.head] = x;
    this.z[this.head] = z;
    this.h[this.head] = headingDeg;
    this.v[this.head] = Math.abs(speed);
    this.s[this.head] = this.travelled;
    this.p[this.head] = planing;
    this.w[this.head] = Number.isFinite(wash) ? wash : 0.7;
    this.n = Math.min(this.capacity, this.n + 1);
    return true;
  }

  /**
   * The hull `age` s before `now` into `out` (the live pose for age 0 is the caller's). Beyond the
   * recorded history the oldest entry is returned with speed 0 (the wake has faded there).
   */
  sample(now: number, age: number, out: WakeSample): WakeSample {
    out.age = age;
    if (this.n === 0) {
      out.speed = 0;
      return out;
    }
    const tq = now - age;
    const C = this.capacity;
    const oldest = (this.head - this.n + 1 + C) % C;
    if (tq >= this.t[this.head]) return this.copy(this.head, out);
    if (tq <= this.t[oldest]) {
      this.copy(oldest, out);
      out.speed = tq < this.t[oldest] - this.minDt ? 0 : out.speed;
      return out;
    }
    // binary search over the ring (entries ascend in time from oldest to head)
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.t[(oldest + mid) % C] <= tq) lo = mid;
      else hi = mid;
    }
    const a = (oldest + lo) % C;
    const b = (oldest + hi) % C;
    const k = (tq - this.t[a]) / Math.max(1e-9, this.t[b] - this.t[a]);
    out.x = this.x[a] + (this.x[b] - this.x[a]) * k;
    out.z = this.z[a] + (this.z[b] - this.z[a]) * k;
    const dh = ((((this.h[b] - this.h[a]) % 360) + 540) % 360) - 180;
    out.course = (this.h[a] + dh * k + 360) % 360;
    out.speed = this.v[a] + (this.v[b] - this.v[a]) * k;
    out.travelled = this.s[a] + (this.s[b] - this.s[a]) * k;
    return out;
  }

  private copy(i: number, out: WakeSample): WakeSample {
    out.x = this.x[i];
    out.z = this.z[i];
    out.course = this.h[i];
    out.speed = this.v[i];
    out.travelled = this.s[i];
    return out;
  }
}

export interface SprayRates {
  /** Particles per second: the bow's spray sheets (both sides), the quarter waves off the transom, a slam burst. */
  bow: number;
  quarter: number;
  slam: number;
}

/**
 * Spray from a planing hull: bow sheets once it is fast (from ~8 kt, full at ~25 kt), the quarter
 * waves / rooster tail when planing, and a burst when the bow falls onto the water faster than
 * ~1.5 m/s (pitching into a wave). `speed` m/s, `planing` 0..1, `bowImpact` = downward speed of the
 * bow relative to the surface, m/s (≥ 0). Zero when not moving.
 */
export function sprayRates(speed: number, planing: number, bowImpact: number, out: SprayRates = { bow: 0, quarter: 0, slam: 0 }): SprayRates {
  const v = Math.abs(speed);
  const fast = clamp01((v - 4) / 9);
  out.bow = 110 * fast;
  out.quarter = 70 * clamp01(planing) * clamp01((v - 6) / 6);
  out.slam = bowImpact > 1.5 ? 260 * clamp01((bowImpact - 1.5) / 3) * (0.4 + 0.6 * clamp01(v / 8)) : 0;
  return out;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Where the bow spray leaves the hull (body frame): the spray root moves aft as the hull rises onto
 * the plane (≈ 25 % of the length abaft the stem at rest → 45 % planing), at the chine, just above
 * the water. `side` ±1 (starboard +).
 */
export function bowSprayOrigin(size: HullSize, planing: number, side: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const f = 0.25 + 0.2 * clamp01(planing);
  out.z = size.stemZ + f * size.length;
  out.x = side * size.beam * 0.45;
  out.y = 0;
  return out;
}

