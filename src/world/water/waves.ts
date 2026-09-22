/**
 * Analytic ocean waves: a handful of Gerstner (trochoidal) wave trains drawn
 * from a Pierson–Moskowitz spectrum for the configured wind, spread around the
 * wind direction. PURE and deterministic — the water shader receives exactly
 * these trains (packWaveUniforms), so a boat bobbing on `waterSurfaceAt` sits
 * on the waves you see.
 *
 * Gerstner surface for an undisplaced point P0 = (x0, z0) at time t:
 *   θ_i = k_i (D_i · P0) − ω_i t + φ_i
 *   X = x0 + Σ s_i D_ix cos θ_i,   Z = z0 + Σ s_i D_iz cos θ_i,   Y = Σ A_i sin θ_i
 * with deep-water dispersion ω² = g k, horizontal amplitudes s_i chosen so that
 * Σ k_i s_i = choppiness ≤ 1 (sharper crests, never loops), and the normal
 *   N = ( −Σ D_x k A cos θ,  1 − Σ k s sin θ,  −Σ D_z k A cos θ ).
 * Frame: world +X east, +Z south, heading clockwise from north (types.ts).
 */
import { CONFIG, type Config } from '../../config';

export const GRAVITY = 9.81;
/** Maximum trains the shader accepts (uniform array length). */
export const MAX_WAVE_TRAINS = 16;
const KT = 0.514444;

export interface WaveTrain {
  /** Unit travel direction (world x, z). */
  dirX: number;
  dirZ: number;
  wavelength: number;
  /** Wavenumber 2π/λ (rad/m) and angular frequency √(g k) (rad/s). */
  k: number;
  omega: number;
  /** Vertical amplitude (m), horizontal (Gerstner) amplitude (m), phase (rad). */
  amp: number;
  chop: number;
  phase: number;
}

export interface WaveSpectrum {
  trains: WaveTrain[];
  /** Wind speed (m/s) and the unit direction the waves travel (downwind). */
  windMs: number;
  windDirX: number;
  windDirZ: number;
  /** Pierson–Moskowitz peak wavelength for the wind (m), before wavelengthScale. */
  peakWavelength: number;
  /** Σ amplitudes: |height| never exceeds this (m). */
  maxHeight: number;
  /** Mean-square slope carried by the trains (Σ ½ (k A)²). */
  slopeVariance: number;
  choppiness: number;
}

export interface WaveSpectrumOptions {
  windKt: number;
  /** Direction the wind blows FROM, degrees true. */
  windFromDeg: number;
  count: number;
  seed: number;
  /** 0 = sine waves … 1 = sharpest crests without loops. */
  choppiness: number;
  /** Scale every wavelength (and amplitude, keeping steepness) — sheltered water has short fetch. */
  wavelengthScale?: number;
  /** Extra amplitude factor. */
  heightScale?: number;
}

/** mulberry32: tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pierson–Moskowitz spectral density S(ω) for wind speed U (m/s). */
function piersonMoskowitz(omega: number, U: number): number {
  const w0 = GRAVITY / U;
  return (8.1e-3 * GRAVITY * GRAVITY) / Math.pow(omega, 5) * Math.exp(-0.74 * Math.pow(w0 / omega, 4));
}

export function createWaveSpectrum(o: WaveSpectrumOptions): WaveSpectrum {
  const U = Math.max(0, o.windKt) * KT;
  const n = Math.max(1, Math.min(MAX_WAVE_TRAINS, Math.floor(o.count)));
  const ls = o.wavelengthScale ?? 1;
  const hsc = o.heightScale ?? 1;
  const ch = Math.max(0, Math.min(1, o.choppiness));
  const toH = ((o.windFromDeg + 180) * Math.PI) / 180;
  const windDirX = Math.sin(toH);
  const windDirZ = -Math.cos(toH);
  const Ueff = Math.max(U, 0.5); // shapes the wavelengths even when calm (amplitudes are 0 then)
  const wp = (0.877 * GRAVITY) / Ueff;
  const peakWavelength = (2 * Math.PI * GRAVITY) / (wp * wp);
  // wavelengths: log-spaced from 1.6·λp down to max(2.2 m, λp/14), jittered inside their bins
  const lMax = 1.6 * peakWavelength;
  const lMin = Math.min(lMax * 0.5, Math.max(2.2, peakWavelength / 14));
  const rnd = mulberry32((o.seed * 2654435761) ^ 0x9e3779b9);
  const trains: WaveTrain[] = [];
  const logStep = n > 1 ? Math.log(lMax / lMin) / (n - 1) : 0;
  let prevOff = 0;
  for (let i = 0; i < n; i++) {
    const jitter = n > 1 ? (rnd() - 0.5) * 0.7 * logStep : 0;
    const lambda0 = lMax * Math.exp(-i * logStep + jitter);
    const k0 = (2 * Math.PI) / lambda0;
    const w = Math.sqrt(GRAVITY * k0);
    // frequency bin width (log spacing: Δω = ω · Δln ω = ω · ½ Δln k)
    const dw = n > 1 ? w * 0.5 * logStep : w * 0.5;
    const amp0 = U > 0 ? Math.sqrt(2 * piersonMoskowitz(w, U) * dw) : 0;
    // directional spread: cos^(2s) with s narrower near the peak, rejection-sampled
    const sExp = 1.5 + 4 * Math.exp(-Math.pow(Math.log(lambda0 / peakWavelength), 2) * 2);
    let off = 0;
    for (let tries = 0; tries < 64; tries++) {
      const a = (rnd() - 0.5) * Math.PI * 0.83; // ±75°
      if (rnd() <= Math.pow(Math.cos(a), 2 * sExp)) {
        off = a;
        break;
      }
    }
    // alternate sides of the wind so the mean direction stays downwind
    if (i % 2 === 1 && off * prevOff > 0) off = -off;
    prevOff = off;
    const h = toH + off;
    const lambda = lambda0 * ls;
    const k = (2 * Math.PI) / lambda;
    trains.push({
      dirX: Math.sin(h),
      dirZ: -Math.cos(h),
      wavelength: lambda,
      k,
      omega: Math.sqrt(GRAVITY * k),
      amp: amp0 * ls * hsc,
      chop: 0,
      phase: rnd() * Math.PI * 2,
    });
  }
  let sumKA = 0;
  let maxHeight = 0;
  let slopeVariance = 0;
  for (const t of trains) {
    sumKA += t.k * t.amp;
    maxHeight += t.amp;
    slopeVariance += 0.5 * (t.k * t.amp) ** 2;
  }
  for (const t of trains) t.chop = sumKA > 0 ? (ch * t.amp) / sumKA : 0;
  return { trains, windMs: U, windDirX, windDirZ, peakWavelength, maxHeight, slopeVariance, choppiness: ch };
}

let seaCache: WaveSpectrum | null = null;
/** The open-sea spectrum for the default CONFIG (built once). */
export function getSeaSpectrum(cfg: Config = CONFIG): WaveSpectrum {
  if (cfg === CONFIG && seaCache) return seaCache;
  const w = cfg.world.water;
  const s = createWaveSpectrum({ windKt: w.windKt, windFromDeg: w.windFromDeg, count: w.waveCount, seed: w.waveSeed, choppiness: w.choppiness });
  if (cfg === CONFIG) seaCache = s;
  return s;
}

/**
 * Pack the trains for the shader: A[i] = (Dx·k, Dz·k, ω, φ), B[i] = (A, s, k·A, λ).
 * Unused slots are zeroed (amplitude 0 ⇒ no contribution).
 */
export function packWaveUniforms(s: WaveSpectrum, A: Float32Array, B: Float32Array): void {
  A.fill(0);
  B.fill(0);
  const n = Math.min(s.trains.length, Math.floor(A.length / 4), Math.floor(B.length / 4));
  for (let i = 0; i < n; i++) {
    const w = s.trains[i];
    A[i * 4] = w.dirX * w.k;
    A[i * 4 + 1] = w.dirZ * w.k;
    A[i * 4 + 2] = w.omega;
    A[i * 4 + 3] = w.phase;
    B[i * 4] = w.amp;
    B[i * 4 + 1] = w.chop;
    B[i * 4 + 2] = w.k * w.amp;
    B[i * 4 + 3] = w.wavelength;
  }
}

/** The displaced surface point of the undisplaced point (x0, z0) at time t. */
export function gerstnerDisplace(x0: number, z0: number, t: number, s: WaveSpectrum, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  let x = x0;
  let y = 0;
  let z = z0;
  for (const w of s.trains) {
    const th = w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * t + w.phase;
    const c = Math.cos(th);
    x += w.chop * w.dirX * c;
    z += w.chop * w.dirZ * c;
    y += w.amp * Math.sin(th);
  }
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export interface WaterSurfaceSample {
  /** Surface height relative to the still water level (m). */
  height: number;
  /** Unit surface normal (world). */
  normal: { x: number; y: number; z: number };
  /** The undisplaced (Lagrangian) point whose displaced position lies above (x, z). */
  sourceX: number;
  sourceZ: number;
}

export function newWaterSurfaceSample(): WaterSurfaceSample {
  return { height: 0, normal: { x: 0, y: 1, z: 0 }, sourceX: 0, sourceZ: 0 };
}

const _p = { x: 0, y: 0, z: 0 };

/**
 * Height (relative to the still level) and unit normal of the wave surface
 * exactly above world (x, z) at time t (s). Inverts the Gerstner horizontal
 * displacement by fixed-point iteration (a contraction: Σ k s ≤ choppiness).
 * Pure; writes into `out` (allocation-free when one is passed).
 */
export function waterSurfaceAt(x: number, z: number, time: number, spectrum: WaveSpectrum = getSeaSpectrum(), out: WaterSurfaceSample = newWaterSurfaceSample()): WaterSurfaceSample {
  let x0 = x;
  let z0 = z;
  if (spectrum.choppiness > 0) {
    for (let it = 0; it < 24; it++) {
      gerstnerDisplace(x0, z0, time, spectrum, _p);
      const ex = x - _p.x;
      const ez = z - _p.z;
      x0 += ex;
      z0 += ez;
      if (ex * ex + ez * ez < 1e-12) break;
    }
  }
  let y = 0;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  for (const w of spectrum.trains) {
    const th = w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * time + w.phase;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const ka = w.k * w.amp;
    y += w.amp * sn;
    nx -= w.dirX * ka * c;
    nz -= w.dirZ * ka * c;
    ny -= w.k * w.chop * sn;
  }
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  out.height = y;
  out.normal.x = nx / l + 0; // +0: never −0
  out.normal.y = ny / l;
  out.normal.z = nz / l + 0;
  out.sourceX = x0;
  out.sourceZ = z0;
  return out;
}
