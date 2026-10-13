/**
 * A driven hull's wake as a change of the sea surface (PURE, no three.js): the "wake field", for
 * ANY vessel — a 3 m jet ski, the 15.5 m Princess V50, a 270 m cruise ship or battleship — read
 * from its length L, beam B, speed U, planing fraction and propulsor load ("wash").
 *
 * The wake is rendered into a world-aligned wake map (src/world/water/wakeMap.ts) that the sea
 * shader samples: R = wake wave height (m, signed, additive), G = foam density (0..1: 1 = the
 * solid white of fresh propwash, lower = the lace it breaks into), B = aeration (bubbles in the
 * water column: the turquoise "bubble water" of the propwash lane, and the boil), A = slick (the
 * calm trail where the turbulence has flattened the small ripples). This module holds the physics
 * of that field — the same numbers as TS functions (tested) and as GLSL (`WAKE_FIELD_GLSL`,
 * drawn) — and builds the strip of track the map is rendered from (`buildWakeStrip`). The sea
 * shader (shaders.ts) turns the density into structure per pixel: a cellular foam pattern
 * thresholded by the density (`foamCoverage`) — solid white with dark holes when fresh, a lace of
 * filaments as it decays, broken threads, then nothing.
 *
 * The field is evaluated in TRACK coordinates: x = distance behind the bow along the hull's past
 * track (so the pattern bends with every turn) and y = lateral offset (+ starboard); world-fixed
 * features (streaks, patches) use s = distance travelled when the hull passed (fixed to the water,
 * so the foam stays where it was left and only spreads and decays — a Lagrangian foam field).
 *
 *  - Kelvin waves by stationary phase for a point source at speed U: at (x, y) inside the ±19.47°
 *    wedge, tan θ solves 2yτ² − xτ + y = 0 — the transverse (small θ) and the diverging (large θ)
 *    systems — with phase ψ = k₀ sec θ (x − yτ), k₀ = g/U², local wavenumber k = k₀ sec²θ
 *    (λ = 2πU²cos²θ/g), crests at ~35° to the track at the cusp. Amplitude ∝ B·f(Fr)·(L/(x+L))^½
 *    (f rises with the length Froude number: a ship crawling makes no waves), an Airy-like bump at
 *    the cusp line, evanescent outside it; a hull filter keeps what a hull of length L and draft d
 *    makes: long waves (kL ≲ 2) are weak (so the transverse waves and the wide part of the wedge fade
 *    as it planes and the visible wake narrows toward ~0.18/Fr — Rabaud & Moisy), very short ones
 *    decay as e^(−k d); and anything shorter than the map resolves is faded out. A planing hull's
 *    pressure patch sits aft (the source moves toward the transom); a displacement hull adds a weaker
 *    stern-wave system.
 *  - Behind the transom when planing: the two quarter waves rising off the chines, the hollow and
 *    the rooster hump on the centreline.
 *  - Foam: solid churned white at the transom opening out and breaking up with age into streaks and
 *    lace (track-aligned streaks and patches here; the fine lace per pixel in the sea shader); white
 *    on the quarter waves, on the steepest diverging crests near the hull, along a planing hull's
 *    chines and in a displacement hull's bow wave. Aeration outlives the white water: a ship's
 *    turquoise propwash lane is kilometres long.
 *  - Sizes: lifetimes and spreading scale with `wakeScale` (√(L·B) relative to the V50's), the draft
 *    of the short-wave filter too; the map's extent and the strip's reach grow with L.
 */

export const GRAVITY = 9.81;
/** tan²(19.47°) = 1/8: the Kelvin cusp. */
export const KELVIN_TAN2 = 1 / 8;
export const KELVIN_DEG = (Math.atan(Math.sqrt(KELVIN_TAN2)) * 180) / Math.PI;

/** Tunables of the field (shared by the TS mirror and the GLSL). Lifetimes are the V50's (scale 1). */
export const WAKE_FIELD = {
  /** Wave amplitude per metre of beam at full strength (m/m): a 4 m beam makes ~0.5 m waves (≈ 1 m crest to trough near the cusp). */
  ampPerBeam: 0.11,
  /** Wave-making vs length Froude number: none below frLo, full from frHi. */
  frLo: 0.08,
  frHi: 0.42,
  /** Hull filter: long-wave cutoff kL (≈ 2) and the effective draft for the short-wave decay (m, × scale^½). */
  lowKL: 2.5,
  draft: 0.28,
  /** Cusp: Airy bump (× amplitude) and its width in r = √(1 − 8y²/x²); evanescent decay outside. */
  cuspGain: 0.8,
  cuspWidth: 0.22,
  cuspDecay: 0.12,
  /** Planing gain on the amplitude (× at full planing): the hull filter drops the long waves, the short diverging ones carry the energy. */
  planingGain: 1.6,
  /** Planing: the wave source moves this far aft (× L); a displacement hull's stern system (× the bow's). */
  planingSourceAft: 0.55,
  sternSystem: 0.45,
  /** Waves fade with age (s): e-folding. */
  waveLife: 110,
  /** Quarter waves (m at full planing), their outward angle (deg) and width (m). */
  quarter: 0.34,
  quarterDeg: 9,
  /** Rooster hump and transom hollow (m at full planing). */
  rooster: 0.2,
  hollow: 0.14,
  /** Foam: white life (s), lace life (s), aeration (churn) and slick life (s); trail spreading time (s). */
  whiteLife: 3,
  laceLife: 16,
  churnLife: 32,
  slickLife: 140,
  spreadTime: 10,
  /** Mean of the streak modulation (the TS mirror's stand-in for the noise). */
  streakMean: 0.5,
  /** Propulsor load when the caller doesn't know it. */
  defaultWash: 0.7,
} as const;

/** Normal slopes from the wake map: over this many texels, clamped (the "paper water" fix, 5d92507). */
export const WAKE_SLOPE = { spanTexels: 2, clamp: 0.8 } as const;

export interface WakeFieldInput {
  /** Behind the bow along the track (m), lateral (m, + starboard), world-fixed along-track coordinate (m). */
  x: number;
  y: number;
  s: number;
  /** Hull speed when it passed (m/s), seconds since, planing 0..1. */
  U: number;
  age: number;
  planing: number;
  /** Hull length and beam (m). */
  L: number;
  B: number;
  /** Largest wavenumber the map resolves (1/m). */
  kMax: number;
  /** Propulsor load when it passed (0..1+: the propeller / jet wash); default WAKE_FIELD.defaultWash. */
  wash?: number;
}

export interface WakeFieldOut {
  height: number;
  foam: number;
  churn: number;
  slick: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const sat = (x: number): number => Math.min(1, Math.max(0, x));

/** Size factor of a hull's wake: √(L·B) relative to the V50's (14.2 × 4.11 m) — 1 for the V50, ~0.3 for a jet ski, ~12 for a 265 m ship. */
export const wakeScale = (L: number, B: number): number => Math.min(14, Math.max(0.2, Math.sqrt(Math.max(0, L * B) / (14.2 * 4.11))));

export interface WakeLifetimes {
  /** Solid white (s), lace (s), aeration (s), slick (s), waves (s), trail spreading time (s). */
  white: number;
  lace: number;
  churn: number;
  slick: number;
  wave: number;
  spread: number;
}

/** How long each part of the wake lasts for a hull of length L and beam B (bigger wakes last longer). */
export function wakeLifetimes(L: number, B: number, out?: WakeLifetimes): WakeLifetimes {
  const sc = wakeScale(L, B);
  const o = out ?? { white: 0, lace: 0, churn: 0, slick: 0, wave: 0, spread: 0 };
  const a = sc ** 0.7;
  o.white = WAKE_FIELD.whiteLife * a;
  o.lace = WAKE_FIELD.laceLife * a;
  o.churn = WAKE_FIELD.churnLife * sc ** 0.75;
  o.slick = WAKE_FIELD.slickLife * sc ** 0.6;
  o.wave = WAKE_FIELD.waveLife * sc ** 0.5;
  o.spread = WAKE_FIELD.spreadTime * a;
  return o;
}

/** Size (m) of the sea shader's foam cells (the boils between which the lace gathers) for a hull: ~1.3 m for the V50. */
export const wakeFoamCell = (L: number, B: number): number => Math.min(4.5, Math.max(0.6, 1.3 * Math.sqrt(wakeScale(L, B))));

/** World extent (m) of the wake map for a hull of length L: 520 m up to ~58 m hulls, ~9 L beyond (capped). */
export const wakeMapExtent = (L: number): number => Math.min(2600, Math.max(520, 9 * L));

/** Length Froude number U/√(gL). */
export const wakeFroude = (U: number, L: number): number => Math.abs(U) / Math.sqrt(GRAVITY * Math.max(0.5, L));

/** Half-angle of the Kelvin wedge (rad) — 19.47°, independent of speed. */
export const kelvinHalfAngle = (): number => Math.atan(Math.sqrt(KELVIN_TAN2));

/** Wavelength (m) of the Kelvin wave travelling at θ (rad) to the track behind a source at U (m/s): 2πU²cos²θ/g. */
export const kelvinWavelength = (U: number, thetaRad: number): number => (2 * Math.PI * U * U * Math.cos(thetaRad) ** 2) / GRAVITY;

/** Apparent (amplitude-peak) wake angle of a hull at length Froude number Fr (Rabaud & Moisy): the Kelvin angle below Fr ≈ 0.5, ≈ 0.18/Fr above. */
export const apparentWakeAngle = (U: number, L: number): number => {
  const fr = U / Math.sqrt(GRAVITY * Math.max(1, L));
  return Math.min(kelvinHalfAngle(), 0.18 / Math.max(1e-3, fr));
};

/** The two stationary-phase roots τ = tan θ at (x, y): transverse (small) and diverging (large); null outside the wedge. */
export function kelvinRoots(x: number, y: number): { transverse: number; diverging: number; r: number } | null {
  const Y = Math.max(Math.abs(y), 1e-3);
  if (x <= 0) return null;
  const d = 1 - (8 * Y * Y) / (x * x);
  if (d < 0) return null;
  const r = Math.sqrt(d);
  return { transverse: (x * (1 - r)) / (4 * Y), diverging: (x * (1 + r)) / (4 * Y), r };
}

/** Effective draft (m) of the short-wave filter for a hull of length L and beam B. */
export const filterDraft = (L: number, B: number): number => WAKE_FIELD.draft * Math.sqrt(wakeScale(L, B));

/** Hull filter on a wave of wavenumber k (1/m): weak long waves (kL ≲ 2), e^(−k·d) short-wave decay, faded above kMax. */
export function hullFilter(k: number, L: number, kMax: number, draft: number = WAKE_FIELD.draft): number {
  const kl = (k * L) / WAKE_FIELD.lowKL;
  const lo = 1 - Math.exp(-(kl * kl));
  const hi = Math.exp(-k * draft);
  const res = 1 - smoothstep(0.5 * kMax, kMax, k);
  return lo * hi * res;
}

/**
 * Overall wave amplitude (m) for a hull of beam B and length L at speed U (m/s) and planing fraction:
 * ∝ B, rising with the Froude number (a slow ship makes almost no waves), a little lower on the plane.
 */
export const wakeAmplitude = (U: number, B: number, planing: number, L: number = 3.45 * B): number =>
  WAKE_FIELD.ampPerBeam * waveBeam(L, B) * smoothstep(WAKE_FIELD.frLo, WAKE_FIELD.frHi, wakeFroude(U, L)) * smoothstep(0.2, 1.5, U) * (1 + (WAKE_FIELD.planingGain - 1) * sat(planing));

/** The beam the wave amplitude scales with: the beam, but slender big ships make proportionally smaller waves (≤ 4.11 m · √scale). */
export const waveBeam = (L: number, B: number): number => Math.min(B, 4.11 * Math.sqrt(wakeScale(L, B)));

/** One Kelvin system (m) from a point source at track coordinates (x behind the source, y lateral), amplitude A. */
function kelvinSystem(x: number, y: number, U: number, L: number, A: number, kMax: number, draft: number): number {
  if (x <= 0 || U < 0.3 || A <= 0) return 0;
  const k0 = GRAVITY / (U * U);
  const Y = Math.max(Math.abs(y), 1e-3);
  const q = (8 * Y * Y) / (x * x) - 1;
  const branch = (tau: number, gain: number) => {
    const sec2 = 1 + tau * tau;
    const k = k0 * sec2;
    const f = hullFilter(k, L, kMax, draft);
    if (f <= 1e-5) return 0;
    const psi = k0 * Math.sqrt(sec2) * (x - Y * tau);
    // second-order Stokes: sharper crests, flatter troughs (ka capped)
    const ka = Math.min(0.45, 1.5 * A * gain * f * k);
    return A * gain * f * (Math.cos(psi) + ka * Math.cos(2 * psi));
  };
  if (q <= 0) {
    const r = Math.sqrt(-q);
    const cusp = 1 + WAKE_FIELD.cuspGain * Math.exp(-r / WAKE_FIELD.cuspWidth);
    const tt = (x * (1 - r)) / (4 * Y);
    const td = (x * (1 + r)) / (4 * Y);
    return branch(tt, cusp) + branch(td, cusp);
  }
  // outside the cusp line: the merged wave, dying away
  const tc = x / (4 * Y);
  return branch(tc, 2 * (1 + WAKE_FIELD.cuspGain) * Math.exp(-q / WAKE_FIELD.cuspDecay));
}

/**
 * The Kelvin pattern (m) at track coordinates (x behind the bow, y lateral): the main system (its
 * source moving aft as the hull planes) plus, for a displacement hull, the weaker stern system.
 */
export function kelvinHeight(x: number, y: number, U: number, L: number, B: number, planing: number, kMax: number): number {
  if (x <= 0 || U < 0.3) return 0;
  const pl = sat(planing);
  const draft = filterDraft(L, B);
  const A0 = wakeAmplitude(U, B, pl, L);
  const x0 = WAKE_FIELD.planingSourceAft * L * pl;
  const xm = x - x0;
  let h = 0;
  if (xm > 0) h += kelvinSystem(xm, y, U, L, A0 * Math.sqrt(L / (xm + L)) * smoothstep(0, 0.4 * L, xm), kMax, draft);
  const sg = WAKE_FIELD.sternSystem * (1 - pl);
  const xs = x - 0.95 * L;
  if (sg > 0.01 && xs > 0) h -= kelvinSystem(xs, y, U, L, sg * A0 * Math.sqrt(L / (xs + L)) * smoothstep(0, 0.4 * L, xs), kMax, draft);
  return h;
}

/** Behind the transom when planing: quarter waves, hollow, rooster (m). */
export function sternHeight(x: number, y: number, U: number, L: number, B: number, planing: number): number {
  const p = Math.min(1, Math.max(0, planing)) * smoothstep(3, 9, U);
  if (p <= 0) return 0;
  const xs = x - L;
  const ay = Math.abs(y);
  const tq = Math.tan((WAKE_FIELD.quarterDeg * Math.PI) / 180);
  const yq = 0.45 * B + Math.max(xs, 0) * tq;
  const sq = 0.55 * (B / 4.11) + 0.06 * Math.max(xs, 0);
  const along = smoothstep(-0.15 * L, 0.35 * L, xs) * Math.exp(-Math.max(xs, 0) / (2.5 * L));
  const quarter = WAKE_FIELD.quarter * along * Math.exp(-((ay - yq) ** 2) / (2 * sq * sq)) * (B / 4.11);
  const rooster = WAKE_FIELD.rooster * (B / 4.11) * Math.exp(-(((xs - 0.9 * L) / (0.6 * L)) ** 2)) * Math.exp(-(y * y) / (2 * (0.3 * B) ** 2));
  const hollow = -WAKE_FIELD.hollow * (B / 4.11) * Math.exp(-(((xs - 0.15 * L) / (0.35 * L)) ** 2)) * Math.exp(-(y * y) / (2 * (0.45 * B) ** 2));
  return p * (quarter + rooster + hollow);
}

/** Half-width (m) of the turbulent trail at `age` s behind a hull of beam B (spreading time `spread` s). */
export const trailHalfWidth = (age: number, B: number, spread: number = WAKE_FIELD.spreadTime): number =>
  0.5 * B * (0.75 + 0.9 * Math.sqrt(Math.max(age, 0) / Math.max(spread, 1e-3)));

/** Where the transom's white water starts (smooth ramp just ahead of the transom, m of x). */
const behindRamp = (L: number): number => 0.08 * Math.min(L, 25);

/** Bow-wave white water beside a displacement hull (0..1 before the streaks): x behind the bow, |y|. */
export function bowFoam(x: number, ay: number, U: number, L: number, B: number, planing: number): number {
  const fr = wakeFroude(U, L);
  const g = smoothstep(0.12, 0.3, fr) * (1 - smoothstep(0.6, 0.95, fr)) * (1 - sat(planing)) * (0.25 + 0.75 * smoothstep(0.5, 3, wakeScale(L, B)));
  if (g <= 0) return 0;
  const yb = 0.5 * B * Math.sqrt(sat(x / (0.15 * L))) + 0.06 * Math.max(x, 0);
  const wb = 0.1 * B + 0.8;
  const along = smoothstep(-0.01 * L, 0.03 * L, x) * Math.exp(-Math.max(x, 0) / (0.5 * L));
  return g * along * Math.exp(-(((ay - yb) / wb) ** 2));
}

const _life: WakeLifetimes = { white: 0, lace: 0, churn: 0, slick: 0, wave: 0, spread: 0 };

/**
 * The field at a point (the TS mirror of the GLSL, with the streak noise replaced by its mean and
 * without the crest / quarter-wave / chine white water): height (m), foam density, aeration, slick (0..1).
 */
export function wakeField(i: WakeFieldInput, out: WakeFieldOut = { height: 0, foam: 0, churn: 0, slick: 0 }): WakeFieldOut {
  const { x, y, U, L, B, planing, kMax } = i;
  const wash = Math.max(0, Math.min(1.3, i.wash ?? WAKE_FIELD.defaultWash));
  const age = Math.max(0, i.age);
  const lt = wakeLifetimes(L, B, _life);
  const life = Math.exp(-age / lt.wave);
  let h = (kelvinHeight(x, y, U, L, B, planing, kMax) + sternHeight(x, y, U, L, B, planing)) * life;
  // nothing lifts the water inside the hull's own footprint
  const ay = Math.abs(y);
  const inHull = (1 - smoothstep(0.85 * L, 1.0 * L, x)) * (1 - smoothstep(0.4 * B, 0.55 * B, ay));
  h = h > 0 ? h * (1 - inHull) : h;
  const dL = behindRamp(L);
  const behind = smoothstep(L - dL, L + 0.25 * dL, x);
  const pl = sat(planing);
  const fI = smoothstep(1.2, 5.5, U) * (0.45 + 0.55 * Math.min(1, wash)) * (0.9 + 0.1 * pl);
  const cI = smoothstep(1.0, 4.5, U) * (0.5 + 0.5 * Math.min(1, wash));
  const wf = trailHalfWidth(age, B, lt.spread);
  const prof = 1 - smoothstep(0.7 * wf, 1.15 * wf, ay);
  const st = WAKE_FIELD.streakMean;
  const white = Math.exp(-age / lt.white);
  // the boil right behind the transom (the first second or so) is solid white
  const boil = Math.exp(-age / (0.3 * lt.white)) * (0.4 + 0.3 * Math.min(1, wash));
  const density = boil + white * (0.8 + 0.45 * st) + (1 - white) * (0.2 + 0.6 * st) * Math.exp(-age / lt.lace);
  const foamTrail = fI * prof * density * behind;
  const foamBow = bowFoam(x, ay, U, L, B, pl) * (0.5 + 0.8 * st);
  out.height = Number.isFinite(h) ? h : 0;
  out.foam = sat(Math.max(foamTrail, foamBow));
  out.churn = sat(cI * (1 - smoothstep(0.9 * wf, 1.4 * wf, ay)) * Math.max(white, Math.exp(-age / lt.churn)) * behind);
  out.slick = sat(smoothstep(1, 4, U) * (1 - smoothstep(1.2 * wf, 1.8 * wf, ay)) * Math.exp(-age / lt.slick) * behind);
  return out;
}

/** The wake's vertex lift (m) for a wake height h and churn: half the height, none in the churned wash (5d92507). */
export const wakeLift = (h: number, churn: number): number => h * 0.5 * (1 - 0.85 * sat(churn));

/**
 * Foam coverage (0..1) the sea shader draws at a point of its cellular foam pattern for a foam
 * density d: `edge` = how deep the point is inside a boil of upwelling clear water (the pattern's
 * uniformised measure exp(−π F1²/r²): 1 at a boil's centre, → 0 between boils). Fresh foam (d ≈ 1)
 * covers nearly everything but the boils' centres — the dark holes; as it decays the holes grow
 * until only the walls between them stay white (lace), then broken threads, then nothing. `soft` = the edge's antialiasing half-width.
 */
export function foamCoverage(d: number, edge: number, soft = 0.06): number {
  const k = foamThreshold(d);
  return smoothstep(0, 0.08, d) * (1 - smoothstep(k - soft, k + soft, edge));
}
/** The coverage threshold for a density d: 0.9 d^0.9. */
export const foamThreshold = (d: number): number => 0.9 * Math.max(0, d) ** 0.9;
/** Mean coverage of a density d over a uniformly distributed edge (the far-field value). */
export const foamMeanCoverage = (d: number): number => smoothstep(0, 0.08, d) * sat(foamThreshold(d));

// ─── The map's frame ────────────────────────────────────────────────────────────────────────────

export interface WakeMapFrame {
  /** World x, z of the map's (0, 0) corner, snapped to whole texels (never swims). */
  x0: number;
  z0: number;
  extent: number;
  res: number;
  texel: number;
}

/**
 * The map's frame for a boat at (bx, bz) heading `headingDeg`: centred `lead` × extent behind the
 * boat (the wake is behind it), the corner snapped to whole texels.
 */
export function wakeMapFrame(bx: number, bz: number, headingDeg: number, extent: number, res: number, lead = 0.3, out?: WakeMapFrame): WakeMapFrame {
  const h = (headingDeg * Math.PI) / 180;
  const cx = bx - Math.sin(h) * lead * extent;
  const cz = bz + Math.cos(h) * lead * extent;
  const texel = extent / res;
  const o = out ?? { x0: 0, z0: 0, extent, res, texel };
  o.x0 = Math.round((cx - extent / 2) / texel) * texel;
  o.z0 = Math.round((cz - extent / 2) / texel) * texel;
  o.extent = extent;
  o.res = res;
  o.texel = texel;
  return o;
}

// ─── The strip of track the map is drawn from ─────────────────────────────────────────────────

/** What the strip builder needs of the hull's track (src/world/traffic/hullTrack.ts HullTrack). */
export interface TrackSource {
  readonly travelled: number;
  readonly oldestTravelled: number;
  sampleAtDistance(s: number, now: number, out: { x: number; z: number; course: number; speed: number; travelled: number; age: number; planing?: number; wash?: number }): unknown;
}

/** Along-track spacing bands (m) for the V50-sized map: [until distance behind, spacing]; × the map's scale for bigger hulls. Each band's samples sit on its own fixed grid of s. */
export const STRIP_BANDS: readonly (readonly [number, number])[] = [
  [160, 2],
  [420, 5],
  [900, 12],
];
/** Samples ahead of the hull's centre (to the bow and a little beyond it: the bow wave). */
export const STRIP_AHEAD = 22;
/** Most samples a strip can hold. */
export const STRIP_MAX = 2 + STRIP_AHEAD + STRIP_BANDS.reduce((n, [end, step], i) => n + Math.ceil((end - (i ? STRIP_BANDS[i - 1][0] : 0)) / step) + 1, 0);
/** Vertices across the strip (port edge, centre, starboard edge). */
export const STRIP_ACROSS = 3;

export interface WakeStrip {
  /** Per vertex: world x, z. */
  xz: Float32Array;
  /** Per vertex: s (m, world-fixed along-track), y (m, lateral), age (s), U (m/s). */
  track: Float32Array;
  /** Per vertex: planing, half-width W (m), wash (propulsor load), −. */
  extra: Float32Array;
  /** Per vertex: the track's direction of travel (unit x, z) — the map's second target, so the sea shader can streak the foam along the track. */
  dir: Float32Array;
  /** Samples written (vertices = count × STRIP_ACROSS). */
  count: number;
}

export function newWakeStrip(): WakeStrip {
  const n = STRIP_MAX * STRIP_ACROSS;
  return { xz: new Float32Array(n * 2), track: new Float32Array(n * 4), extra: new Float32Array(n * 4), dir: new Float32Array(n * 2), count: 0 };
}

/** Index buffer for a strip of STRIP_MAX samples × STRIP_ACROSS. */
export function wakeStripIndices(): Uint32Array {
  const out: number[] = [];
  for (let j = 0; j < STRIP_MAX - 1; j++)
    for (let a = 0; a < STRIP_ACROSS - 1; a++) {
      const p = j * STRIP_ACROSS + a;
      const q = p + STRIP_ACROSS;
      out.push(p, q, p + 1, p + 1, q, q + 1);
    }
  return new Uint32Array(out);
}

const _smp = { x: 0, z: 0, course: 0, speed: 0, travelled: 0, age: 0, planing: 0, wash: 0 };
const _ss = new Float64Array(STRIP_MAX);
const _hx = new Float64Array(STRIP_MAX);
const _hz = new Float64Array(STRIP_MAX);
const _hc = new Float64Array(STRIP_MAX);

/**
 * Samples the track on fixed grids of s (dense near the boat, coarser behind: vertices don't slide
 * over the water as the boat moves, so the foam stays put) and writes the strip: per sample a line
 * across the track, as wide as the Kelvin wedge there (+ margin, feathered in the shader), narrowed
 * in tight turns so the strip never folds over itself. Speed, planing and wash are the hull's when
 * it passed; L is the hull length (the bow is L/2 ahead of the track's hull centre — the strip is
 * extrapolated along the heading to just ahead of the bow). `scale` stretches the bands (bigger
 * hulls: a bigger map, a longer wake). No allocation.
 */
export function buildWakeStrip(track: TrackSource, now: number, L: number, B: number, out: WakeStrip, scale = 1): WakeStrip {
  const sNow = track.travelled;
  const sc = Math.max(0.25, scale);
  const sMin = Math.max(track.oldestTravelled, sNow - STRIP_BANDS[STRIP_BANDS.length - 1][0] * sc);
  // s values: ahead of the hull centre to just past the bow, now, then each band's grid
  let n = 0;
  const reach = 0.5 * L + 0.06 * L + 1.5;
  const aStep = Math.max(STRIP_BANDS[0][1] * sc, reach / (STRIP_AHEAD - 1));
  for (let a = reach; a > 1e-3 && n < STRIP_AHEAD; a -= aStep) _ss[n++] = sNow + a;
  _ss[n++] = sNow;
  let start = 0;
  for (const [end0, step0] of STRIP_BANDS) {
    const end = end0 * sc;
    const step = step0 * sc;
    let s = Math.floor((sNow - start) / step) * step;
    if (s >= sNow - 1e-6) s -= step;
    for (; s > sNow - end - 1e-6 && n < STRIP_MAX - 1; s -= step) {
      if (s < sMin) break;
      if (s < _ss[n - 1] - 1e-6) _ss[n++] = s;
    }
    start = end;
  }
  if (n < STRIP_MAX && sMin < _ss[n - 1] - 1e-3) _ss[n++] = sMin;
  if (n < 2 || !(sNow > sMin)) {
    out.count = 0;
    return out;
  }
  for (let j = 0; j < n; j++) {
    _smp.planing = 0;
    _smp.wash = WAKE_FIELD.defaultWash;
    const ahead = _ss[j] - sNow;
    track.sampleAtDistance(Math.min(_ss[j], sNow), now, _smp);
    let x = _smp.x;
    let z = _smp.z;
    if (ahead > 0) {
      // extrapolated along the heading (the hull's forebody and its bow wave)
      const h = (_smp.course * Math.PI) / 180;
      x += Math.sin(h) * ahead;
      z -= Math.cos(h) * ahead;
      _smp.age = 0;
    }
    _hx[j] = x;
    _hz[j] = z;
    _hc[j] = _smp.course;
    const v = j * STRIP_ACROSS;
    for (let a = 0; a < STRIP_ACROSS; a++) {
      out.track[(v + a) * 4] = _ss[j];
      out.track[(v + a) * 4 + 2] = Math.max(0, _smp.age);
      out.track[(v + a) * 4 + 3] = _smp.speed;
      out.extra[(v + a) * 4] = _smp.planing;
      out.extra[(v + a) * 4 + 2] = _smp.wash;
      out.extra[(v + a) * 4 + 3] = 0;
    }
  }
  const DEG = Math.PI / 180;
  for (let j = 0; j < n; j++) {
    const x = sNow - _ss[j] + L / 2; // behind the bow
    let W = Math.max(0, x) * 0.42 + B + 4;
    // tight turns: no wider than ~85 % of the local turn radius (from the neighbours' headings)
    const a = Math.max(0, j - 2);
    const b = Math.min(n - 1, j + 2);
    const ds = Math.abs(_ss[a] - _ss[b]);
    const dh = Math.abs(((((_hc[a] - _hc[b]) % 360) + 540) % 360) - 180) * DEG;
    if (dh > 1e-4 && ds > 0) W = Math.min(W, Math.max(B + 4, (0.85 * ds) / dh));
    const h = _hc[j] * DEG;
    // starboard of the heading: (cos h, sin h)
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const v = j * STRIP_ACROSS;
    for (let k = 0; k < STRIP_ACROSS; k++) {
      const y = (k / (STRIP_ACROSS - 1) * 2 - 1) * W;
      out.xz[(v + k) * 2] = _hx[j] + rx * y;
      out.xz[(v + k) * 2 + 1] = _hz[j] + rz * y;
      out.dir[(v + k) * 2] = rz; // forward = (sin h, −cos h)
      out.dir[(v + k) * 2 + 1] = -rx;
      out.track[(v + k) * 4 + 1] = y;
      out.extra[(v + k) * 4 + 1] = W;
    }
  }
  out.count = n;
  return out;
}

// ─── GLSL ───────────────────────────────────────────────────────────────────────────────────────

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * The wake field in GLSL: `vec4 wakeField( x, y, s, U, age, planing, W, L, B, kMax, wash )` →
 * (height, foam density, aeration, slick). Mirrors the TS above; the streaks and patches are value
 * noise in (s, y), stretched along the track and widening as the trail spreads. Every pow() is
 * written as exp( a · log( b ) ) of a guarded base; sqrt() arguments are clamped (the RECORD lesson).
 */
export const WAKE_FIELD_GLSL = /* glsl */ `
const float WK_G = ${f(GRAVITY)};
float wkSmooth( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }
float wkHash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
float wkNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 u = fract( p ); u = u * u * ( 3.0 - 2.0 * u );
  return mix( mix( wkHash( i ), wkHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wkHash( i + vec2( 0.0, 1.0 ) ), wkHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
// wakeScale(): √(L·B) relative to the V50's
float wkScale( float L, float B ) { return clamp( sqrt( max( L * B, 0.0 ) / ${f(14.2 * 4.11)} ), 0.2, 14.0 ); }
float wkFilter( float k, float L, float kMax, float draft ) {
  float kl = k * L / ${f(WAKE_FIELD.lowKL)};
  return ( 1.0 - exp( - kl * kl ) ) * exp( - k * draft ) * ( 1.0 - wkSmooth( 0.5 * kMax, kMax, k ) );
}
float wkBranch( float x, float Y, float tau, float k0, float L, float kMax, float Ag, float draft ) {
  float sec2 = 1.0 + tau * tau;
  float k = k0 * sec2;
  float fl = wkFilter( k, L, kMax, draft );
  if ( fl < 1e-5 ) return 0.0;
  float psi = k0 * sqrt( sec2 ) * ( x - Y * tau );
  // second-order Stokes: sharper crests, flatter troughs (ka capped)
  float ka = min( 0.45, 1.5 * Ag * fl * k );
  return Ag * fl * ( cos( psi ) + ka * cos( 2.0 * psi ) );
}
// one Kelvin system from a point source (x behind it), amplitude A
float wkSystem( float x, float y, float U, float L, float A, float kMax, float draft ) {
  if ( x <= 0.0 || A <= 0.0 ) return 0.0;
  float k0 = WK_G / ( U * U );
  float Y = max( abs( y ), 1e-3 );
  float q = 8.0 * Y * Y / ( x * x ) - 1.0;
  if ( q <= 0.0 ) {
    float r = sqrt( max( - q, 0.0 ) );
    float cusp = 1.0 + ${f(WAKE_FIELD.cuspGain)} * exp( - r / ${f(WAKE_FIELD.cuspWidth)} );
    float tt = x * ( 1.0 - r ) / ( 4.0 * Y );
    float td = x * ( 1.0 + r ) / ( 4.0 * Y );
    return wkBranch( x, Y, tt, k0, L, kMax, A * cusp, draft ) + wkBranch( x, Y, td, k0, L, kMax, A * cusp, draft );
  }
  float tc = x / ( 4.0 * Y );
  return wkBranch( x, Y, tc, k0, L, kMax, A * 2.0 * ( 1.0 + ${f(WAKE_FIELD.cuspGain)} ) * exp( - q / ${f(WAKE_FIELD.cuspDecay)} ), draft );
}
float wkAmp( float U, float L, float B, float pl ) {
  float fr = U / sqrt( WK_G * max( 0.5, L ) );
  float bw = min( B, 4.11 * sqrt( wkScale( L, B ) ) );
  return ${f(WAKE_FIELD.ampPerBeam)} * bw * wkSmooth( ${f(WAKE_FIELD.frLo)}, ${f(WAKE_FIELD.frHi)}, fr ) * wkSmooth( 0.2, 1.5, U ) * ( 1.0 + ${f(WAKE_FIELD.planingGain - 1)} * pl );
}
float wkKelvin( float x, float y, float U, float L, float B, float planing, float kMax ) {
  if ( x <= 0.0 || U < 0.3 ) return 0.0;
  float pl = clamp( planing, 0.0, 1.0 );
  float draft = ${f(WAKE_FIELD.draft)} * sqrt( wkScale( L, B ) );
  float A0 = wkAmp( U, L, B, pl );
  float h = 0.0;
  // the main system: its source moves aft as the hull planes
  float xm = x - ${f(WAKE_FIELD.planingSourceAft)} * L * pl;
  if ( xm > 0.0 ) h += wkSystem( xm, y, U, L, A0 * sqrt( L / ( xm + L ) ) * wkSmooth( 0.0, 0.4 * L, xm ), kMax, draft );
  // a displacement hull's stern-wave system
  float sg = ${f(WAKE_FIELD.sternSystem)} * ( 1.0 - pl );
  float xs = x - 0.95 * L;
  if ( sg > 0.01 && xs > 0.0 ) h -= wkSystem( xs, y, U, L, sg * A0 * sqrt( L / ( xs + L ) ) * wkSmooth( 0.0, 0.4 * L, xs ), kMax, draft );
  return h;
}
float wkStern( float x, float y, float U, float L, float B, float planing ) {
  float p = clamp( planing, 0.0, 1.0 ) * wkSmooth( 3.0, 9.0, U );
  if ( p <= 0.0 ) return 0.0;
  float bs = B / 4.11;
  float xs = x - L;
  float ay = abs( y );
  float yq = 0.45 * B + max( xs, 0.0 ) * ${f(Math.tan((WAKE_FIELD.quarterDeg * Math.PI) / 180))};
  float sq = 0.55 * bs + 0.06 * max( xs, 0.0 );
  float along = wkSmooth( -0.15 * L, 0.35 * L, xs ) * exp( - max( xs, 0.0 ) / ( 2.5 * L ) );
  float dq = ay - yq;
  float quarter = ${f(WAKE_FIELD.quarter)} * along * exp( - dq * dq / ( 2.0 * sq * sq ) ) * bs;
  float xr = ( xs - 0.9 * L ) / ( 0.6 * L );
  float rooster = ${f(WAKE_FIELD.rooster)} * bs * exp( - xr * xr ) * exp( - y * y / ( 2.0 * 0.09 * B * B ) );
  float xh = ( xs - 0.15 * L ) / ( 0.35 * L );
  float hollow = - ${f(WAKE_FIELD.hollow)} * bs * exp( - xh * xh ) * exp( - y * y / ( 2.0 * 0.2025 * B * B ) );
  return p * ( quarter + rooster + hollow );
}
// streaks along the track and patches (0..1, mean ≈ 0.5), widening as the trail spreads
float wkStreaks( float s, float y, float grow, float rs ) {
  float yy = y / ( rs * grow );
  float ss = s / rs;
  float n1 = wkNoise( vec2( ss / 11.0, yy / 0.9 ) );
  float n2 = wkNoise( vec2( ss / 4.5, yy / 0.6 ) + 7.3 );
  float n3 = wkNoise( vec2( ss / 26.0, yy / 2.4 ) - 3.1 );
  return wkSmooth( 0.22, 0.78, n1 * 0.45 + n2 * 0.25 + n3 * 0.3 );
}
// bowFoam(): the white bow wave beside a displacement hull
float wkBowFoam( float x, float ay, float U, float L, float B, float pl, float sc ) {
  float fr = U / sqrt( WK_G * max( 0.5, L ) );
  float g = wkSmooth( 0.12, 0.3, fr ) * ( 1.0 - wkSmooth( 0.6, 0.95, fr ) ) * ( 1.0 - pl ) * ( 0.25 + 0.75 * wkSmooth( 0.5, 3.0, sc ) );
  if ( g <= 0.0 ) return 0.0;
  float yb = 0.5 * B * sqrt( clamp( x / ( 0.15 * L ), 0.0, 1.0 ) ) + 0.06 * max( x, 0.0 );
  float wb = 0.1 * B + 0.8;
  float along = wkSmooth( -0.01 * L, 0.03 * L, x ) * exp( - max( x, 0.0 ) / ( 0.5 * L ) );
  float d = ( ay - yb ) / wb;
  return g * along * exp( - d * d );
}
// the map's second target: the track direction (weighted, it adds up where strips overlap) and the
// white water's freshness (how new the foam is: the boil and the brightness in the sea shader)
vec4 wakeAux( vec2 dir, float y, float W, float age, float L, float B ) {
  float lWhite = ${f(WAKE_FIELD.whiteLife)} * exp( 0.7 * log( wkScale( L, B ) ) );
  float w = 1.0 - wkSmooth( 0.8 * W, W, abs( y ) );
  return vec4( dir * w, exp( - max( age, 0.0 ) / lWhite ) * w, 0.0 );
}
vec4 wakeField( float x, float y, float s, float U, float age, float planing, float W, float L, float B, float kMax, float wash ) {
  age = max( age, 0.0 );
  wash = clamp( wash, 0.0, 1.3 );
  float pl = clamp( planing, 0.0, 1.0 );
  // lifetimes (wakeLifetimes)
  float sc = wkScale( L, B );
  float lsc = log( sc );
  float a7 = exp( 0.7 * lsc );
  float lWhite = ${f(WAKE_FIELD.whiteLife)} * a7;
  float lLace = ${f(WAKE_FIELD.laceLife)} * a7;
  float lChurn = ${f(WAKE_FIELD.churnLife)} * exp( 0.75 * lsc );
  float lSlick = ${f(WAKE_FIELD.slickLife)} * exp( 0.6 * lsc );
  float lWave = ${f(WAKE_FIELD.waveLife)} * sqrt( sc );
  float spread = ${f(WAKE_FIELD.spreadTime)} * a7;
  float rs = sqrt( sc );
  float life = exp( - age / lWave );
  float kel = wkKelvin( x, y, U, L, B, pl, kMax );
  float stn = wkStern( x, y, U, L, B, pl );
  float h = ( kel + stn ) * life;
  float ay = abs( y );
  float inHull = ( 1.0 - wkSmooth( 0.85 * L, L, x ) ) * ( 1.0 - wkSmooth( 0.4 * B, 0.55 * B, ay ) );
  h = h > 0.0 ? h * ( 1.0 - inHull ) : h;
  // feather the strip's own edge
  h *= 1.0 - wkSmooth( 0.8 * W, W, ay );
  float dL = 0.08 * min( L, 25.0 );
  float behind = wkSmooth( L - dL, L + 0.25 * dL, x );
  float fI = wkSmooth( 1.2, 5.5, U ) * ( 0.45 + 0.55 * min( wash, 1.0 ) ) * ( 0.9 + 0.1 * pl );
  float cI = wkSmooth( 1.0, 4.5, U ) * ( 0.5 + 0.5 * min( wash, 1.0 ) );
  float sq = sqrt( age / spread );
  float wf = 0.5 * B * ( 0.75 + 0.9 * sq );
  // ragged, meandering trail edges
  float edgeN = ( wkNoise( vec2( s / ( 7.0 * rs ), sign( y ) * 5.0 ) ) - 0.5 ) * 0.35 + ( wkNoise( vec2( s / ( 2.6 * rs ), sign( y ) * 9.0 + 3.0 ) ) - 0.5 ) * 0.18;
  float ragged = ay + edgeN * wf;
  float prof = 1.0 - wkSmooth( 0.7 * wf, 1.15 * wf, ragged );
  float st = wkStreaks( s, y, 1.0 + 0.6 * sq, rs );
  float white = exp( - age / lWhite );
  // the churned white core (the propeller / jet wash, about a beam wide), opening out and breaking
  // into streaks and lace with age; the sea shader draws the lace itself from this density
  float core = 1.0 - wkSmooth( 0.35 * wf, 0.8 * wf, ragged );
  // the boil right behind the transom (the first second or so) is solid white
  float boil = exp( - age / ( 0.3 * lWhite ) ) * ( 0.4 + 0.3 * min( wash, 1.0 ) ) * core;
  float dens = boil + white * mix( 0.7, 1.0, core ) * ( 0.8 + 0.45 * st ) + ( 1.0 - white ) * ( 0.2 + 0.6 * st ) * exp( - age / lLace ) * ( 0.6 + 0.4 * core );
  float foam = fI * prof * dens * behind;
  // white water breaking on the quarter waves
  float xa = max( x - L, 0.0 );
  foam = max( foam, wkSmooth( 0.1 * B / 4.11, 0.28 * B / 4.11, stn ) * ( 0.5 + 0.6 * st ) * exp( - xa / ( 1.6 * L ) ) );
  // a planing hull's chines: the spray root's white water streaming aft along the sides
  float chine = pl * wkSmooth( 4.0, 10.0, U ) * wkSmooth( 0.3 * L, 0.5 * L, x ) * exp( - xa / ( 0.5 * L ) );
  float dc = ( ay - 0.5 * B - 0.25 - 0.04 * xa ) / ( 0.12 * B + 0.25 );
  foam = max( foam, chine * exp( - dc * dc ) * ( 0.45 + 0.6 * st ) );
  // a displacement hull's bow wave
  foam = max( foam, wkBowFoam( x, ay, U, L, B, pl, sc ) * ( 0.5 + 0.8 * st ) );
  // whitecaps on the steepest diverging crests beside and behind the hull: broken lines of foam
  // along each sharp crest (streaked along the crest, which runs nearly with the track)
  float A0 = wkAmp( U, L, B, pl ) * sqrt( L / ( max( x, 0.0 ) + L ) );
  float crestN = kel / max( A0, 1e-3 );
  float crestStreak = wkSmooth( 0.3, 0.8, wkNoise( vec2( s / ( 9.0 * rs ), y / ( 0.9 * rs ) ) ) ) * ( 0.5 + 0.5 * st );
  foam = max( foam, wkSmooth( 0.45, 0.95, crestN ) * exp( - xa / ( 5.0 * L ) ) * crestStreak * wkSmooth( 0.2, 0.5, U / sqrt( WK_G * max( 0.5, L ) ) ) * 0.8 * life );
  float churn = cI * ( 1.0 - wkSmooth( 0.9 * wf, 1.4 * wf, ragged ) ) * max( white, exp( - age / lChurn ) ) * ( 0.8 + 0.4 * st ) * behind;
  float slick = wkSmooth( 1.0, 4.0, U ) * ( 1.0 - wkSmooth( 1.2 * wf, 1.8 * wf, ay ) ) * exp( - age / lSlick ) * behind;
  // tight turns narrow the strip: feather everything at its edge (never a cut)
  float edge = 1.0 - wkSmooth( 0.75 * W, W, ay );
  return vec4( h, clamp( foam * edge, 0.0, 1.0 ), clamp( churn * edge, 0.0, 1.0 ), clamp( slick * edge, 0.0, 1.0 ) );
}
`;
