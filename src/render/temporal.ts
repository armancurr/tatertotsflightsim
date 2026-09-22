/**
 * Temporal reprojection helpers for the low-resolution cloud buffer (pure;
 * mirrored in the cloud GLSL in volumetricClouds.ts).
 *
 * Each frame the cloud march writes, per pixel, the transmittance-weighted
 * distance to the clouds it saw. That world point is projected with LAST
 * frame's view-projection matrix to find where the same cloud was in the
 * history buffer; the history is blended in with weight (1 − alpha) unless it
 * is off screen or was rendered against a different occluder (the scene depth
 * the ray was clipped to changed a lot → disocclusion, e.g. the aircraft moved
 * across the clouds) — then the new sample is used alone.
 */

export interface UvResult {
  u: number;
  v: number;
  /** False when the point is behind the camera (or the projection degenerates). */
  valid: boolean;
}

/** Project a world point with a column-major 4×4 view-projection matrix into [0,1]² screen uv. */
export function projectToUv(m: ArrayLike<number>, x: number, y: number, z: number, out: UvResult): UvResult {
  const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
  const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(cw > 1e-6) || !Number.isFinite(cx) || !Number.isFinite(cy)) {
    out.u = -1;
    out.v = -1;
    out.valid = false;
    return out;
  }
  const u = (cx / cw) * 0.5 + 0.5;
  const v = (cy / cw) * 0.5 + 0.5;
  out.valid = Number.isFinite(u) && Number.isFinite(v);
  out.u = out.valid ? u : -1;
  out.v = out.valid ? v : -1;
  return out;
}

/**
 * Weight of the history sample (0 = reject). `clipNow`/`clipPrev` are the scene
 * distances the current and the history ray were clipped to; a relative change
 * larger than `depthTolerance` means a different surface → reject.
 */
export function historyWeight(u: number, v: number, valid: boolean, clipNow: number, clipPrev: number, alpha: number, depthTolerance = 0.1): number {
  if (!valid || !(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return 0;
  const rel = Math.abs(clipNow - clipPrev) / Math.max(1e-3, Math.min(clipNow, clipPrev));
  if (!(rel <= depthTolerance)) return 0;
  return 1 - Math.min(1, Math.max(0, alpha));
}

/** Per-frame scalar jitter (golden-ratio additive recurrence): added to the blue-noise ray offset. */
export function frameJitter(frame: number): number {
  const g = 0.6180339887498949;
  const v = (frame * g) % 1;
  return v < 0 ? v + 1 : v;
}
