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
}

export const DEFAULT_MARCH: MarchParams = { k: 0.06, kIn: 0.015, dtMin: 8, dtMax: 900, dtMaxIn: 250, maxSteps: 128 };

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
