/**
 * Buoyancy (PURE): how a hull rides the drawn sea. The water shader displaces
 * its grid with the same Gerstner trains as `waterSurfaceAt` (src/world/water),
 * but only near the camera and only the trains its grid can carry
 * (`waveWeights` mirrors WATER_BEGIN_VERTEX exactly: a displacement range,
 * a per-train fade by grid spacing, and shoaling in shallow water). A boat
 * must bob with exactly those waves or the water clips through its hull.
 *
 * `hullWaveMotion` inverts the (weighted) horizontal Gerstner displacement at
 * the hull, then sums each train's heave and slope times a hull response
 * 1 / (1 + (k·Lₑ)²/24) — the small-argument sinc of averaging a sinusoid over
 * the hull's extent Lₑ along the wave: a dinghy follows every ripple, a 300 m
 * container ship ignores them. Pitch + = bow up, roll + = starboard down
 * (the vessel pose convention in sea.ts). No allocation per call.
 */
import type { WaveSpectrum } from '../water/waves';

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Per-train displacement weights of the sea shader at horizontal distance `r` (m) from the camera:
 * grid spacing max(0.6, 0.045 r), train weight smoothstep(2.5·spacing, 5·spacing, λ), all faded out
 * between 0.6 and 1 × `dispRange`. Returns the number of trains with a non-zero weight.
 */
export function waveWeights(spec: WaveSpectrum, r: number, dispRange: number, out: Float64Array): number {
  const spacing = Math.max(0.6, r * 0.045);
  const near = 1 - smoothstep(dispRange * 0.6, dispRange, r);
  let n = 0;
  for (let i = 0; i < spec.trains.length; i++) {
    const w = near > 0 ? smoothstep(2.5 * spacing, 5 * spacing, spec.trains[i].wavelength) * near : 0;
    out[i] = w;
    if (w > 0) n++;
  }
  return n;
}

/** The shader's shoaling factor for a water depth (m). */
export const shoalFactor = (depth: number): number => 0.3 + 0.7 * smoothstep(0.3, 8, depth);

export interface WaveMotion {
  /** Height of the hull's waterline above the still level, m. */
  heave: number;
  /** Bow-up pitch and starboard-down roll imposed by the wave slope, deg. */
  pitch: number;
  roll: number;
}

export const newWaveMotion = (): WaveMotion => ({ heave: 0, pitch: 0, roll: 0 });

const RAD = 180 / Math.PI;
const DEG = Math.PI / 180;

/**
 * Wave motion of a hull (length L, beam B, heading deg) centred at world (x, z) at wave time t.
 * `w` = per-train weights (waveWeights), `gain` = shoaling × any extra gain (0 = still water).
 */
export function hullWaveMotion(spec: WaveSpectrum, w: Float64Array, gain: number, x: number, z: number, t: number, headingDeg: number, L: number, B: number, out: WaveMotion, iterations = 6): WaveMotion {
  out.heave = 0;
  out.pitch = 0;
  out.roll = 0;
  if (!(gain > 0)) return out;
  const trains = spec.trains;
  const n = trains.length;
  let any = false;
  for (let i = 0; i < n; i++) if (w[i] > 0) any = true;
  if (!any) return out;
  // invert the horizontal displacement: find the undisplaced point whose displaced position is (x, z)
  let x0 = x;
  let z0 = z;
  for (let it = 0; it < iterations; it++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < n; i++) {
      const wi = w[i] * gain;
      if (wi <= 0) continue;
      const tr = trains[i];
      const c = Math.cos(tr.k * (tr.dirX * x0 + tr.dirZ * z0) - tr.omega * t + tr.phase);
      dx += wi * tr.chop * tr.dirX * c;
      dz += wi * tr.chop * tr.dirZ * c;
    }
    x0 = x - dx;
    z0 = z - dz;
  }
  const h = headingDeg * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  let y = 0;
  let nx = 0;
  let ny = 1;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i] * gain;
    if (wi <= 0) continue;
    const tr = trains[i];
    // hull extent along the wave direction → response (sinc envelope)
    const along = tr.dirX * fx + tr.dirZ * fz;
    const across = tr.dirX * -fz + tr.dirZ * fx;
    const le2 = L * L * along * along + B * B * across * across;
    const rho = wi / (1 + (tr.k * tr.k * le2) / 24);
    const th = tr.k * (tr.dirX * x0 + tr.dirZ * z0) - tr.omega * t + tr.phase;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const ka = tr.k * tr.amp * rho;
    y += tr.amp * rho * s;
    nx -= tr.dirX * ka * c;
    nz -= tr.dirZ * ka * c;
    ny -= tr.k * tr.chop * rho * s;
  }
  ny = Math.max(ny, 0.2);
  // slope (rise per metre) toward the bow and toward starboard (+x at heading 0 = (−fz, fx))
  const slopeF = -(nx * fx + nz * fz) / ny;
  const slopeS = -(nx * -fz + nz * fx) / ny;
  out.heave = y;
  out.pitch = Math.atan(slopeF) * RAD;
  out.roll = -Math.atan(slopeS) * RAD;
  return out;
}
