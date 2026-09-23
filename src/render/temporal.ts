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

// ─── Checkerboard (quarter-pixel) updates ────────────────────────────────────
// The cloud march renders one pixel of every 2×2 block of the cloud buffer per
// frame, in Bayer order, into a half-size "march" buffer; the resolve pass
// (volumetricClouds.ts, mirrored here) rebuilds the full buffer: a freshly
// marched pixel blends its new sample into the reprojected history with weight
// `freshAlpha`; the other three carry their reprojected history, clamped to the
// range of the fresh march samples around them (so a moving occluder or a
// changed cloud can't leave a ghost); pixels without usable history (off
// screen, disoccluded, teleport) take the depth-aware upsampled fresh samples.

export interface PixelOffset {
  x: number;
  y: number;
}

/** Bayer 2×2 visiting order of the marched pixel inside each block. */
export const CHECKER_ORDER: readonly number[] = [0, 0, 1, 1, 1, 0, 0, 1];

/** Pixel offset (0/1, 0/1) inside each 2×2 block marched on `frame`. */
export function checkerOffset(frame: number, out: PixelOffset): PixelOffset {
  const f = Number.isFinite(frame) ? Math.floor(frame) : 0;
  const i = ((f % 4) + 4) % 4;
  out.x = CHECKER_ORDER[i * 2];
  out.y = CHECKER_ORDER[i * 2 + 1];
  return out;
}

/** Size of the march buffer for a w × h cloud buffer. */
export function marchBufferSize(w: number, h: number): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(w / 2)), height: Math.max(1, Math.ceil(h / 2)) };
}

/** Was full-buffer pixel (x, y) marched this frame? */
export function isFreshPixel(x: number, y: number, o: PixelOffset): boolean {
  return (x & 1) === o.x && (y & 1) === o.y;
}

/** Continuous march-buffer coordinate (texel centres at integers) of full-buffer pixel (x, y). */
export function marchCoord(x: number, y: number, o: PixelOffset, out: PixelOffset): PixelOffset {
  out.x = (x - o.x) / 2;
  out.y = (y - o.y) / 2;
  return out;
}

/** How much clamping (in value units) makes the fresh estimate take over completely. */
export const CLAMP_TAKEOVER = 0.25;

/**
 * Weight of the fresh estimate in the resolve (the rest is clamped history).
 * `clampDistance` = how far the neighbourhood clamp had to move the history:
 * history that disagrees with the fresh samples around it (a misprojected
 * edge during a fast camera orbit) gives way to the smooth fresh estimate
 * instead of leaving a 2×2 checker pattern.
 */
export function resolveNewWeight(fresh: boolean, historyOk: boolean, freshAlpha: number, clampDistance = 0): number {
  if (!historyOk) return 1;
  const base = fresh ? Math.min(1, Math.max(0, freshAlpha)) : 0;
  const c = Number.isFinite(clampDistance) ? Math.min(1, Math.max(0, Math.abs(clampDistance) / CLAMP_TAKEOVER)) : 0;
  return Math.max(base, c);
}

/**
 * The history is clamped to [lo − pad, hi + pad] of the fresh 3×3 march
 * neighbourhood, pad = HISTORY_BOX_PAD·(hi − lo): loose enough that smooth
 * cloud gradients and the per-frame jitter noise don't flicker, tight enough
 * that stale history (a changed cloud, a parallax error) is pulled back.
 */
export const HISTORY_BOX_PAD = 0.25;

export function clampToRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Similarity (0..1) of two scene clip distances: the weight a cloud sample
 * marched against clip distance `a` gets for a pixel whose scene lies at `b`
 * (depth-aware upsampling: the aircraft's pixels don't borrow the sky's clouds).
 */
export function clipSimilarity(a: number, b: number): number {
  const rel = Math.abs(a - b) / Math.max(1e-4, Math.min(a, b));
  const s = Math.exp(-rel * 25);
  return Number.isFinite(s) ? s : 0;
}
