/**
 * Water shading model, PURE: the constants and functions the GLSL in
 * shaders.ts mirrors (the numbers are interpolated into the shader source from
 * here, so the two can't drift apart). Everything a test can check on the CPU:
 *
 *  - landTone / landSurface: what the reflection pass sees of the land around
 *    the water — terrain + tree canopy height and a 0..1 "tone" (forest → grass
 *    → field/sand → rock → snow), baked into the bathymetry clipmap.
 *  - landAlbedo(tone): the reflected land's albedo.
 *  - marchReflection: the reflected ray marched over that height field
 *    (geometric steps, soft silhouette from the maximum elevation angle).
 *  - riverProfile: the channel cross-section — deep thalweg pushed to the
 *    outer bank of a bend, a gravel/sand point bar on the inner bank, irregular
 *    edges — and where the bed is dry.
 *  - riverOptics: absorption, body colour and bed colour from turbidity
 *    (clear mountain water upstream, olive-brown sediment in the plains).
 *  - riverWhitewater: rapids foam from standing-wave and advected-streak noise.
 */

export type RGB = [number, number, number];

const sat = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = sat((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mix3 = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

// ── land seen in reflections ─────────────────────────────────────────────────

/** Albedos of the land classes the reflection shows (linear). Trees are darkened by their self-shadowing. */
export const LAND = {
  forest: [0.04, 0.06, 0.028] as RGB,
  grass: [0.13, 0.17, 0.06] as RGB,
  field: [0.21, 0.19, 0.1] as RGB,
  rock: [0.2, 0.19, 0.17] as RGB,
  snow: [0.72, 0.75, 0.8] as RGB,
  /** Canopy height of a closed stand (m) and at the tree line. */
  treeHeight: 17,
  treeHeightAlpine: 7,
  /** Built-up areas read as a low roof layer (m). */
  urbanHeight: 8,
  /** Tone stops: forest 0, grass 0.25, field 0.45, rock 0.7, snow 1. */
  toneGrass: 0.25,
  toneField: 0.45,
  toneRock: 0.7,
};

export interface LandWeights {
  forest: number;
  field: number;
  grass: number;
  rock: number;
  snow: number;
  sand: number;
  urban: number;
  water: number;
}

/** Tree cover 0..1 from the landcover tree density (riparian strips ≈ 0.55 → closed). */
export function treeCover(density: number): number {
  return smoothstep(0.06, 0.4, density);
}

/** 0..1 tone of the land (see LAND) from landcover weights and tree cover. */
export function landTone(w: LandWeights, cover: number): number {
  const sum = w.forest + w.field + w.grass + w.rock + w.snow + w.sand + w.urban;
  let t = 0;
  if (sum > 1e-6) {
    t = (w.forest * 0.05 + w.grass * LAND.toneGrass + w.field * LAND.toneField + w.sand * 0.55 + w.urban * 0.6 + w.rock * LAND.toneRock + w.snow * 1) / sum;
  } else t = LAND.toneGrass;
  t = mix(t, 0, sat(cover));
  return sat(t);
}

/** Height of the land's top surface (m): ground + canopy + roofs. */
export function landSurface(ground: number, cover: number, urban: number): number {
  const treeH = mix(LAND.treeHeight, LAND.treeHeightAlpine, smoothstep(1250, 1750, ground));
  return ground + sat(cover) * treeH + sat(urban) * LAND.urbanHeight;
}

/** Albedo of the reflected land for a tone (piecewise linear through the stops). */
export function landAlbedo(tone: number): RGB {
  const t = sat(Number.isFinite(tone) ? tone : 0);
  if (t < LAND.toneGrass) return mix3(LAND.forest, LAND.grass, t / LAND.toneGrass);
  if (t < LAND.toneField) return mix3(LAND.grass, LAND.field, (t - LAND.toneGrass) / (LAND.toneField - LAND.toneGrass));
  if (t < LAND.toneRock) return mix3(LAND.field, LAND.rock, (t - LAND.toneField) / (LAND.toneRock - LAND.toneField));
  return mix3(LAND.rock, LAND.snow, (t - LAND.toneRock) / (1 - LAND.toneRock));
}

// ── the reflection march ─────────────────────────────────────────────────────

export const MARCH = {
  steps: 32,
  /** First step (m) and geometric growth: 5 m … ≈ 17 km. */
  t0: 5,
  growth: 1.3,
  /** Stop once the ray is above every summit (m). */
  ceiling: 3400,
  /** Extra samples around the steepest one, as factors of its distance. */
  refine: [0.84, 0.92, 1.09, 1.19],
};

export interface MarchHit {
  /** 0..1 coverage of the land in the reflection (soft silhouette). */
  cover: number;
  /** Distance along the ray to the land (m) and its tone. */
  t: number;
  tone: number;
}

/**
 * March the reflected ray P + R·t over the land surface `land(x, z) → [height, tone]`
 * from t0: the steepest elevation (land − ray)/t found decides the coverage, softened
 * by `soft` (≈ the angular blur of a rough surface). Stops at the first solid hit.
 */
export function marchReflection(
  land: (x: number, z: number) => [number, number],
  P: [number, number, number],
  R: [number, number, number],
  soft: number,
  t0 = MARCH.t0,
): MarchHit {
  let t = Math.max(t0, 1e-3);
  let best = -1;
  let bt = 0;
  let btone = 0;
  const s = Math.max(soft, 1e-4);
  for (let i = 0; i < MARCH.steps; i++) {
    const y = P[1] + R[1] * t;
    if (y > MARCH.ceiling) break;
    const [h, tone] = land(P[0] + R[0] * t, P[2] + R[2] * t);
    const e = (h - y) / t;
    if (e > best) {
      best = e;
      bt = t;
      btone = tone;
    }
    if (e > s) break;
    t *= MARCH.growth;
  }
  // refine around the steepest sample (the silhouette would otherwise step with the march)
  if (best > -s && bt > 0) {
    for (const f of MARCH.refine) {
      const tt = bt * f;
      const y = P[1] + R[1] * tt;
      const [h, tone] = land(P[0] + R[0] * tt, P[2] + R[2] * tt);
      const e = (h - y) / tt;
      if (e > best) {
        best = e;
        btone = tone;
      }
    }
  }
  return { cover: smoothstep(-s, s, best), t: bt, tone: btone };
}

// ── rivers ───────────────────────────────────────────────────────────────────

/** Bend strength from curvature (1/m) and half-width: κ·hw·gain, clamped to ±1 (+ = the inner bank is on the +across side). */
export const BEND_GAIN = 14;
export function bendStrength(curvature: number, halfWidth: number): number {
  const b = curvature * halfWidth * BEND_GAIN;
  return Number.isFinite(b) ? Math.max(-1, Math.min(1, b)) : 0;
}

export const PROFILE = {
  /** Thalweg shift toward the outer bank (fraction of the half-width at |bend| = 1). */
  thalweg: 0.45,
  /** Point bar: height of the inner-bank rise (fraction of the depth at |bend| = 1). */
  bar: 0.08,
  /** Irregular edges: extra rise near the banks where the edge noise is high. */
  edge: 0.2,
};

export interface RiverSection {
  /** Depth below the water surface (m; negative = dry bar above the waterline). */
  depth: number;
  /** 0..1 dry (exposed gravel / sand / mud). */
  dry: number;
}

/**
 * Channel cross-section at u = across / halfWidth (−1 … 1), bend b (−1 … 1, + = inner bank at u > 0),
 * maximum depth D (m) and a 0..1 edge noise (irregular banks).
 */
export function riverProfile(u: number, b: number, D: number, edgeNoise: number): RiverSection {
  const uu = Math.max(-1.2, Math.min(1.2, Number.isFinite(u) ? u : 0));
  const bb = Math.max(-1, Math.min(1, Number.isFinite(b) ? b : 0));
  const ab = Math.abs(bb);
  const u0 = -PROFILE.thalweg * bb;
  const inner = (uu - u0) * bb > 0;
  const x = sat(uu >= u0 ? (uu - u0) / Math.max(1 - u0, 1e-3) : (u0 - uu) / Math.max(1 + u0, 1e-3));
  const prof = inner ? Math.pow(1 - x, 1 + 0.8 * ab) : 1 - Math.pow(x, 2 + 1.5 * ab);
  const lift = (inner ? PROFILE.bar * ab : 0) + PROFILE.edge * smoothstep(0.5, 0.9, sat(edgeNoise)) * smoothstep(0.55, 1, Math.abs(uu));
  const depth = Math.max(0, D) * (prof - lift) + 0.05;
  return { depth, dry: smoothstep(0.02, -0.12, depth) };
}

export interface RiverOpticsOut {
  /** Absorption + scattering extinction (1/m). */
  absorb: RGB;
  /** Colour of optically deep water (albedo). */
  deep: RGB;
  /** Bed colour (albedo) and the colour of exposed bars. */
  bed: RGB;
  bar: RGB;
}

export const RIVER_OPTICS = {
  clearAbsorb: [0.36, 0.16, 0.2] as RGB,
  turbidAbsorb: [1.6, 1.15, 1.3] as RGB,
  clearDeep: [0.01, 0.03, 0.028] as RGB,
  turbidDeep: [0.058, 0.06, 0.034] as RGB,
  gravelBed: [0.2, 0.19, 0.16] as RGB,
  mudBed: [0.16, 0.14, 0.1] as RGB,
  gravelBar: [0.25, 0.24, 0.21] as RGB,
  sandBar: [0.3, 0.26, 0.19] as RGB,
};

/** Optics from turbidity 0 (clear mountain stream) … 1 (sediment-laden lowland river). */
export function riverOptics(turbidity: number): RiverOpticsOut {
  const t = sat(Number.isFinite(turbidity) ? turbidity : 0);
  const O = RIVER_OPTICS;
  return { absorb: mix3(O.clearAbsorb, O.turbidAbsorb, t), deep: mix3(O.clearDeep, O.turbidDeep, t), bed: mix3(O.gravelBed, O.mudBed, t), bar: mix3(O.gravelBar, O.sandBar, t) };
}

/** Turbidity along the river: clear in the mountains, turbid in the plains (f = s / length). */
export function riverTurbidity(f: number, slope: number, rapidsSlope: number): number {
  const down = smoothstep(0.12, 0.7, sat(f));
  const steep = smoothstep(rapidsSlope * 0.5, rapidsSlope * 4, Math.max(0, slope));
  return sat(0.12 + 0.78 * down - 0.35 * steep);
}

/**
 * Colour of the water column over a bed seen from above: bed·T + deep·(1 − e^{−k·path}),
 * path = depth·(1 + 1/cosθt). All inputs finite → output finite, within [0, max(bed, deep)].
 */
export function waterBody(depth: number, cosT: number, absorb: RGB, deep: RGB, bed: RGB): RGB {
  const d = Math.max(0, Number.isFinite(depth) ? depth : 0);
  const c = Math.max(0.05, Math.min(1, Number.isFinite(cosT) ? cosT : 1));
  const path = d * (1 + 1 / c);
  const k = absorb[1] + 0.05;
  const s = 1 - Math.exp(-k * path * 0.7);
  return [0, 1, 2].map((i) => bed[i] * Math.exp(-absorb[i] * path) + deep[i] * s) as RGB;
}

/**
 * Whitewater 0..1 in a step-pool reach: `phase` 0..1 is the position within a step (0 = the drop),
 * foam boils below each drop and trails off into the pool; `standing` and `streak` (0..1 noises:
 * stationary standing waves, streaks advected with the flow) break it up across the channel.
 */
export function riverWhitewater(rapids: number, phase: number, standing: number, streak: number): number {
  const r = sat(rapids);
  const ph = sat(phase);
  const drop = Math.exp(-ph / (0.1 + 0.18 * r));
  const w = drop * (0.3 + 0.7 * standing) + streak * 0.3 * r;
  const thr = 0.72 - 0.25 * r;
  return smoothstep(thr, thr + 0.3, w) * smoothstep(0.05, 0.3, r);
}

/** GLSL vec3 literal. */
export const glsl3 = (c: RGB): string => `vec3( ${c.map((v) => v.toFixed(4)).join(', ')} )`;
/** GLSL float literal. */
export const glslF = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
