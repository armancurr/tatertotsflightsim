/**
 * The drawn sea under an animal (PURE, no allocation per call): the water shader only displaces its
 * grid near the camera, with the trains its grid can carry, damped in shallow water — so an animal
 * that "sits on the waves" must use exactly those waves (src/world/traffic/buoyancy.ts
 * `waveWeights` / `hullWaveMotion`, the same model the traffic floats on). A body of length L
 * averages the ripples shorter than itself (a humpback ignores the chop a gull bobs on).
 */
import type { WaveSpectrum } from '../water/waves';
import { hullWaveMotion, newWaveMotion, shoalFactor, waveWeights, type WaveMotion } from '../traffic/buoyancy';
import { MAX_WAVE_TRAINS } from '../water/waves';

/** The water shader's displacement range (src/world/water/material.ts `uDispRange`). */
export const SEA_DISP_RANGE = 1500;

export interface SurfaceSampler {
  /** Camera position for the displacement fade (call once per frame). */
  setCamera(x: number, z: number): void;
  /**
   * Height (m, above the still level) and slope angles of the drawn sea over a body centred at
   * (x, z) of length L, beam B, heading (deg) at wave time t, over water `depth` m deep.
   */
  sample(x: number, z: number, t: number, headingDeg: number, L: number, B: number, depth: number): WaveMotion;
}

export function createSurfaceSampler(spec: WaveSpectrum, dispRange = SEA_DISP_RANGE): SurfaceSampler {
  const w = new Float64Array(MAX_WAVE_TRAINS);
  const out = newWaveMotion();
  let cx = 0;
  let cz = 0;
  return {
    setCamera(x, z) {
      cx = x;
      cz = z;
    },
    sample(x, z, t, headingDeg, L, B, depth) {
      const r = Math.hypot(x - cx, z - cz);
      const n = waveWeights(spec, r, dispRange, w);
      if (n === 0 || !Number.isFinite(depth)) {
        out.heave = 0;
        out.pitch = 0;
        out.roll = 0;
        return out;
      }
      return hullWaveMotion(spec, w, shoalFactor(Math.max(0, depth)), x, z, t, headingDeg, L, B, out, 4);
    },
  };
}
