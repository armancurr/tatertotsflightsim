/**
 * PURE shading helpers for the particle shader, with their GLSL twins generated from the same
 * constants (so the tested JS and the shader cannot drift apart):
 *
 *   fireKelvin(T) / fireColor(T)   flame emission for a normalised temperature 0..1.5: the colour is
 *                                  a black body's (Planck/Wien at 605/545/465 nm) from ~700 K (dull
 *                                  red soot glow) to ~3,500 K (white-yellow core), the brightness
 *                                  rises steeply (T²·(1 + 2T)); red ≥ green ≥ blue always, so fire
 *                                  never turns pink or blue-white however bright it gets.
 *   screenCoverFade(…)             fades sprites that would cover more than `maxCover` of the screen.
 *   particleVariation(seed)        per-particle look from its random seed: mirror flip, a jitter,
 *                                  a noise-space offset (every flame/puff samples its own part of
 *                                  the animated noise) and an animation rate — no two alike.
 *   smokeErosion(d, n, age)        puffs fray with age: thin parts vanish first, noise-broken edges.
 *   selfShadow(d)                  sunlight reaching a texel through `d` of the puff toward the sun.
 *   pixelScale(px, minPx)          energy-conserving minimum sprite size (far flames/sparks stay
 *                                  visible as points; opacity × 1/scale² keeps the same energy).
 *   fireballTemperature(h, c, n)   rolling fireball: hot thick core, mottled by animated noise, so
 *                                  as the heat decays cool patches turn to soot first.
 *   flameTemperature(h, c, t)      a flame tongue: hottest low in the core, cooling to soot at the tip.
 */

/** Wavelengths (µm) standing in for the R, G, B channels, and the temperature map t → K. */
const LR = 0.605, LG = 0.545, LB = 0.465;
const K0 = 700, K1 = 1900;
/** Second radiation constant, µm·K. */
const C2 = 14388;
/** Brightness T²·(1 + BK·T). */
const BK = 2;
/** Wien ratios: channel/red = (λr/λc)^5 · exp(−C2/K · (1/λc − 1/λr)). */
const G_POW = (LR / LG) ** 5, B_POW = (LR / LB) ** 5;
const G_EXP = C2 * (1 / LG - 1 / LR), B_EXP = C2 * (1 / LB - 1 / LR);

/** Erosion: threshold E1·age², noise amplitude NA·(NA0 + age). */
const E1 = 0.5, NA = 1.0, NA0 = 0.3;
/** Self-shadow extinction. */
const SHADOW_K = 1.6;
/** Fireball temperature: heat · (FB0 + FB1·core) · (FN0 + FN1·noise). */
const FB0 = 0.3, FB1 = 0.9, FN0 = 0.55, FN1 = 0.9;
/** Flame temperature: heat · (FL0 + FL1·core) · (1 − FT·height^1.2). */
const FL0 = 0.35, FL1 = 0.75, FT = 0.55;
/** Variation hash multipliers/offsets: flip, jitter, ox, oy, rate. */
const VH = [
  [13.37, 0.5],
  [31.91, 0.29],
  [97.31, 0.13],
  [57.17, 0.71],
  [71.13, 0.37],
] as const;
const RATE0 = 0.75, RATE1 = 0.55;
const MAX_PIXEL_SCALE = 1e4;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const fract = (v: number) => v - Math.floor(v);

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Colour temperature (K) of a normalised fire temperature. */
export function fireKelvin(tIn: number): number {
  const t = Number.isFinite(tIn) ? Math.min(1.5, Math.max(0, tIn)) : 0;
  return K0 + K1 * t;
}

/** Flame emission (linear, before the fire-intensity scale) at temperature `t` (0 = no glow). */
export function fireColor(tIn: number, out: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  const t = Number.isFinite(tIn) ? Math.min(1.5, Math.max(0, tIn)) : 0;
  const k = fireKelvin(t);
  const i = t * t * (1 + BK * t);
  out.r = i;
  out.g = i * G_POW * Math.exp(-G_EXP / k);
  out.b = i * B_POW * Math.exp(-B_EXP / k);
  return out;
}

/**
 * Opacity factor 0..1 for a sprite of diameter `size` (m) at view depth `depth` (m) with the
 * projection's vertical scale `p11` (= 1/tan(fov/2)): 1 while it covers ≤ maxCover of the screen
 * height, then falling with the square of the excess.
 */
export function screenCoverFade(size: number, depth: number, p11: number, maxCover: number): number {
  const s = Number.isFinite(size) ? Math.max(0, size) : 0;
  const d = Number.isFinite(depth) ? Math.max(0.05, depth) : 1e9;
  const p = Number.isFinite(p11) && p11 > 0 ? p11 : 1.732;
  const m = Number.isFinite(maxCover) && maxCover > 0 ? maxCover : 0.4;
  const cover = (s * p) / (2 * d);
  if (!(cover > m)) return 1;
  const f = m / cover;
  return f * f;
}

export interface Variation {
  /** Mirror the sprite horizontally (±1). */
  flip: number;
  /** −1..1: a small extra rotation / lean / shape jitter. */
  jitter: number;
  /** 0..1 offsets into the animated noise. */
  ox: number;
  oy: number;
  /** Animation-rate multiplier 0.75..1.3. */
  rate: number;
}

/** The look of one particle from its seed (0..1): deterministic, decorrelated channels. */
export function particleVariation(seedIn: number, out: Variation = { flip: 1, jitter: 0, ox: 0, oy: 0, rate: 1 }): Variation {
  const s = Number.isFinite(seedIn) ? fract(seedIn) : 0;
  const h = (k: number) => {
    const v = fract(s * VH[k][0] + VH[k][1]);
    return Number.isFinite(v) ? v : 0;
  };
  out.flip = h(0) < 0.5 ? -1 : 1;
  out.jitter = h(1) * 2 - 1;
  out.ox = h(2);
  out.oy = h(3);
  out.rate = RATE0 + RATE1 * h(4);
  return out;
}

/** Density `d` (0..1) of a puff texel after age erosion, with the animated noise `n` (0..1) at that texel; age = life fraction. */
export function smokeErosion(dIn: number, nIn: number, ageIn: number): number {
  const d = clamp01(dIn), n = clamp01(nIn), a = clamp01(ageIn);
  if (d <= 0) return 0;
  const e = E1 * a * a;
  const x = d * (1 + (n - 0.5) * NA * (NA0 + a));
  return clamp01((x - e) / (1 - e));
}

/** Fraction of sunlight reaching a texel through puff density `d` toward the sun. */
export function selfShadow(dIn: number): number {
  const d = Number.isFinite(dIn) ? Math.max(0, dIn) : 0;
  return Math.exp(-SHADOW_K * d);
}

/** Scale (≥ 1) that grows a sprite of `px` pixels to at least `minPx`; draw it with opacity × 1/scale². */
export function pixelScale(px: number, minPx: number): number {
  if (!(px > 0) || !Number.isFinite(px) || !(minPx > 0)) return 1;
  return Math.min(MAX_PIXEL_SCALE, Math.max(1, minPx / px));
}

/** Local temperature of a fireball puff: heat × thick-core weighting × animated noise mottling. */
export function fireballTemperature(hIn: number, cIn: number, nIn: number): number {
  const h = Number.isFinite(hIn) ? Math.max(0, hIn) : 0;
  return h * (FB0 + FB1 * clamp01(cIn)) * (FN0 + FN1 * clamp01(nIn));
}

/** Local temperature of a flame tongue: heat × core weighting × cooling toward the tip (height 0 base → 1 tip). */
export function flameTemperature(hIn: number, cIn: number, tIn: number): number {
  const h = Number.isFinite(hIn) ? Math.max(0, hIn) : 0;
  const t = clamp01(tIn);
  return h * (FL0 + FL1 * clamp01(cIn)) * (1 - FT * Math.pow(t, 1.2));
}

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));

/** GLSL twins of everything above. */
export const FIRE_GLSL = /* glsl */ `
float fireKelvin(float t) {
  return ${f(K0)} + ${f(K1)} * clamp(t, 0.0, 1.5);
}
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.5);
  float k = fireKelvin(t);
  float i = t * t * (1.0 + ${f(BK)} * t);
  return vec3(1.0, ${f(G_POW)} * exp(-${f(G_EXP)} / k), ${f(B_POW)} * exp(-${f(B_EXP)} / k)) * i;
}
float coverFade(float size, float depth, float p11, float maxCover) {
  float cover = size * p11 / (2.0 * max(depth, 0.05));
  float k = min(1.0, maxCover / max(cover, 1e-6));
  return k * k;
}
// (flip ±1, jitter −1..1, noise offset x, y)
vec4 variation(float s) {
  s = fract(s);
  return vec4(
    fract(s * ${f(VH[0][0])} + ${f(VH[0][1])}) < 0.5 ? -1.0 : 1.0,
    fract(s * ${f(VH[1][0])} + ${f(VH[1][1])}) * 2.0 - 1.0,
    fract(s * ${f(VH[2][0])} + ${f(VH[2][1])}),
    fract(s * ${f(VH[3][0])} + ${f(VH[3][1])}));
}
float variationRate(float s) {
  return ${f(RATE0)} + ${f(RATE1)} * fract(fract(s) * ${f(VH[4][0])} + ${f(VH[4][1])});
}
float smokeErosion(float d, float n, float a) {
  if (d <= 0.0) return 0.0;
  float e = ${f(E1)} * a * a;
  float x = d * (1.0 + (n - 0.5) * ${f(NA)} * (${f(NA0)} + a));
  return clamp((x - e) / (1.0 - e), 0.0, 1.0);
}
float selfShadow(float d) {
  return exp(-${f(SHADOW_K)} * max(d, 0.0));
}
float pixelScale(float px, float minPx) {
  return px > 0.0 ? clamp(minPx / px, 1.0, ${f(MAX_PIXEL_SCALE)}) : 1.0;
}
float fireballTemperature(float h, float c, float n) {
  return max(h, 0.0) * (${f(FB0)} + ${f(FB1)} * clamp(c, 0.0, 1.0)) * (${f(FN0)} + ${f(FN1)} * clamp(n, 0.0, 1.0));
}
float flameTemperature(float h, float c, float t) {
  return max(h, 0.0) * (${f(FL0)} + ${f(FL1)} * clamp(c, 0.0, 1.0)) * (1.0 - ${f(FT)} * pow(clamp(t, 0.0, 1.0), 1.2));
}
`;
