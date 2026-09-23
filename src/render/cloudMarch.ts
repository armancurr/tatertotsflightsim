/**
 * Raymarch math for the volumetric clouds — pure TypeScript mirror of the GLSL
 * in volumetricClouds.ts (the tests exercise these; keep both in step).
 *
 *  - The cloud layer is a horizontal slab [layerBottom, layerTop].
 *  - Steps grow with distance (screen-space-ish LOD): outside cloud columns
 *    dt = clamp(k·t, dtMin, dtMax); inside, dt = clamp(kIn·t, dtMin, dtMaxIn),
 *    so the near field (in-cloud whiteout, the aircraft 15 m ahead) is sampled
 *    finely while clouds 30 km away still fit in the step budget.
 *  - Lighting: dual-lobe Henyey–Greenstein phase (forward silver lining + some
 *    back-scatter), Beer–Lambert sun transmittance with the "powder" darkening
 *    of thin, sun-facing edges, and Wrenninge's multiple-scattering octaves
 *    (each octave: energy ×a, optical depth ×b, anisotropy ×c).
 */

export interface MarchParams {
  /** Step growth outside clouds (dt ≈ k·t). */
  k: number;
  /** Step growth inside clouds. */
  kIn: number;
  dtMin: number;
  dtMax: number;
  dtMaxIn: number;
  maxSteps: number;
  /** In-cloud steps grow by up to (1 + grow)× as the transmittance falls (little is left to see). */
  grow: number;
  /** Early exit: the ray is opaque below this transmittance. */
  tMin: number;
}

export const DEFAULT_MARCH: MarchParams = { k: 0.025, kIn: 0.004, dtMin: 8, dtMax: 900, dtMaxIn: 60, maxSteps: 192, grow: 1.5, tMin: 0.02 };

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Ray (origin height oy, direction y-component dy) against the slab [yMin, yMax]: entry/exit distances (t1 ≤ t0 = miss). */
export function intersectSlab(oy: number, dy: number, yMin: number, yMax: number, out: { t0: number; t1: number }) {
  if (Math.abs(dy) < 1e-9) {
    const inside = oy >= yMin && oy <= yMax;
    out.t0 = 0;
    out.t1 = inside ? Infinity : -1;
    return out;
  }
  const ta = (yMin - oy) / dy;
  const tb = (yMax - oy) / dy;
  out.t0 = Math.max(Math.min(ta, tb), 0);
  out.t1 = Math.max(ta, tb);
  if (out.t1 < 0) out.t1 = -1;
  return out;
}

/** Distance along a ray to where it enters the layer (0 when already inside, Infinity when it never does). */
export function layerEntryDistance(camY: number, dirY: number, base: number, top: number): number {
  if (camY >= base && camY <= top) return 0;
  if (camY < base) return dirY > 1e-9 ? (base - camY) / dirY : Infinity;
  return dirY < -1e-9 ? (camY - top) / -dirY : Infinity;
}

/** Step length at distance t outside clouds. */
export function nextStep(t: number, p: MarchParams): number {
  return clamp(t * p.k, p.dtMin, p.dtMax);
}

/** Step length at distance t inside a cloud column. */
export function nextStepIn(t: number, p: MarchParams): number {
  return clamp(t * p.kIn, p.dtMin, p.dtMaxIn);
}

/**
 * Sample positions for [t0, t1]: segments s_{i+1} = s_i + dt_i, one sample per
 * segment at s_i + jitter·dt_i, weight dt_i (the last segment is clipped to
 * t1). `inCloud(t)` chooses the fine step (default: never). Writes (t, dt)
 * pairs into `out` and returns the sample count (≤ maxSteps).
 */
export function marchSchedule(
  t0: number,
  t1: number,
  jitter: number,
  p: MarchParams,
  out: Float64Array,
  inCloud?: (t: number) => boolean,
): number {
  let s = t0;
  let n = 0;
  while (s < t1 && n < p.maxSteps) {
    let dt = inCloud && inCloud(s) ? nextStepIn(s, p) : nextStep(s, p);
    if (s + dt > t1) dt = t1 - s;
    out[n * 2] = s + jitter * dt;
    out[n * 2 + 1] = dt;
    n++;
    s += dt;
  }
  return n;
}

/** Coarse step at distance t near (but outside) a cloud column. */
export function stepOut(t: number, p: MarchParams): number {
  return nextStep(t, p);
}

/** Step inside a cloud column at distance t with transmittance T so far. */
export function stepIn(t: number, T: number, p: MarchParams): number {
  return nextStepIn(t, p) * (1 + p.grow * (1 - clamp(T, 0, 1)));
}

/**
 * Empty-space skip: with a horizontal clearance `free` (m) to the nearest cloud
 * column (from the weather distance field) the ray can advance free / |dir.xz|
 * without entering any column (horizontal distance is 1-Lipschitz along the
 * ray at rate |dir.xz|). 0 without clearance.
 */
export function skipDistance(free: number, hLen: number): number {
  if (!(free > 0)) return 0;
  const s = free / Math.max(Math.abs(hLen) || 0, 1e-3);
  return Math.min(s, 1e9);
}

/** Detail-noise weight: 1 near the camera, faded out between `near` and `far` (m). */
export function detailLod(t: number, near = 3000, far = 9000): number {
  const x = clamp((t - near) / (far - near), 0, 1);
  return 1 - x * x * (3 - 2 * x);
}

/** Light march toward the sun: tap positions (m along the sun ray) and the segment each stands for. */
export const LIGHT_TAPS: readonly { at: number; len: number }[] = [
  { at: 30, len: 60 },
  { at: 150, len: 180 },
  { at: 480, len: 480 },
];

/** Optical depth toward the sun from the 3 taps: Σ σ(at_i)·len_i. */
export function lightOpticalDepth(sigmaAt: (d: number) => number): number {
  let tau = 0;
  for (const tap of LIGHT_TAPS) tau += sigmaAt(tap.at) * tap.len;
  return tau;
}

/** What the march asks the cloud field along one ray (distances t along the ray). */
export interface MarchProbe {
  /** Length of the ray direction's horizontal component. */
  hLen: number;
  /** Conservative horizontal clearance to the nearest column (m); ≤ 0 near/inside one. */
  free(t: number): number;
  /** Is the point inside a cloud column (weather map)? */
  inColumn(t: number): boolean;
  /** Extinction (1/m) at the point. */
  sigma(t: number): number;
}

export interface MarchResult {
  /** Density samples taken (written as (t, dt) pairs). */
  samples: number;
  /** Loop iterations used (skips + coarse steps + samples) ≤ maxSteps. */
  iterations: number;
  /** Transmittance at the end. */
  transmittance: number;
}

/**
 * The GPU march loop (volumetricClouds.ts MARCH_FRAGMENT), step for step:
 * skip empty space with the distance field; coarse steps near clouds; when a
 * coarse step lands inside a column, back up to where the last step began
 * (never into skipped, guaranteed-empty space) and re-march finely; in-cloud
 * steps grow with distance and as the transmittance falls; stop when opaque.
 */
export function marchRay(t0: number, t1: number, jitter: number, p: MarchParams, probe: MarchProbe, out: Float64Array, res: MarchResult): MarchResult {
  res.samples = 0;
  res.iterations = 0;
  res.transmittance = 1;
  if (!(t1 > t0) || !Number.isFinite(t0)) return res;
  const jit = clamp(Number.isFinite(jitter) ? jitter : 0, 0, 1);
  let s = t0 + jit * stepOut(t0, p);
  let sPrev = t0;
  let wasIn = false;
  let fineUntil = -Infinity;
  let T = 1;
  for (let i = 0; i < p.maxSteps; i++) {
    if (s >= t1) break;
    res.iterations++;
    const fine = s < fineUntil;
    if (!fine) {
      const free = probe.free(s);
      if (free > 0) {
        const safe = skipDistance(free, probe.hLen);
        sPrev = s + safe;
        s += Math.max(safe, stepOut(s, p));
        wasIn = false;
        continue;
      }
    }
    const inCol = probe.inColumn(s);
    if (inCol && !wasIn && !fine && s - sPrev > p.dtMin * 2) {
      // a coarse step landed inside a column: back up, re-march that stretch finely
      fineUntil = s;
      s = sPrev + jit * stepIn(sPrev, T, p);
      continue;
    }
    wasIn = inCol;
    let dt = inCol || fine ? stepIn(s, T, p) : stepOut(s, p);
    const t = s;
    sPrev = s;
    s += dt;
    dt = Math.min(dt, t1 - t);
    if (!inCol) continue;
    if (res.samples * 2 + 1 < out.length) {
      out[res.samples * 2] = t;
      out[res.samples * 2 + 1] = dt;
    }
    res.samples++;
    const sg = probe.sigma(t);
    T *= Math.exp(-(Number.isFinite(sg) ? Math.max(0, sg) : 0) * dt);
    if (T < p.tMin) break;
  }
  res.transmittance = T;
  return res;
}

/** Henyey–Greenstein phase function (normalised over the sphere). */
export function henyeyGreenstein(mu: number, g: number): number {
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * mu), 1.5));
}

/** Dual-lobe phase: (1 − w)·HG(g1) + w·HG(g2). */
export function cloudPhase(mu: number, g1: number, g2: number, w: number): number {
  return (1 - w) * henyeyGreenstein(mu, g1) + w * henyeyGreenstein(mu, g2);
}

/**
 * Beer–Lambert transmittance to the sun × the powder term: a sample with
 * little cloud around it (local optical depth → 0) scatters little light back
 * (dark crevices / edges when not backlit).
 */
export function beerPowder(tauSun: number, localTau: number): number {
  return Math.exp(-tauSun) * (1 - Math.exp(-2 * localTau));
}

/**
 * Sun light scattered toward the viewer per unit scattering coefficient,
 * summed over multiple-scattering octaves (a = b = c = 0.5).
 */
export function multiScatterLight(tauSun: number, mu: number, g1: number, g2: number, w: number, octaves: number): number {
  let a = 1;
  let b = 1;
  let c = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += a * cloudPhase(mu, g1 * c, g2 * c, w) * Math.exp(-tauSun * b);
    a *= 0.5;
    b *= 0.5;
    c *= 0.5;
  }
  return sum;
}

export type DepthMode = 'reversed' | 'standard' | 'logarithmic';

/** View-space distance (positive, along −z) from a depth-buffer value. Infinity for the cleared sky. */
export function linearDepth(d: number, near: number, far: number, mode: DepthMode): number {
  if (mode === 'reversed') {
    if (d <= 0) return Infinity;
    return (near * far) / (d * (far - near) + near);
  }
  if (mode === 'logarithmic') {
    if (d >= 1) return Infinity;
    return Math.pow(2, d * Math.log2(far + 1)) - 1;
  }
  if (d >= 1) return Infinity;
  const ndc = d * 2 - 1;
  return (2 * near * far) / (far + near - ndc * (far - near));
}
