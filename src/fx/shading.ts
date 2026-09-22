/**
 * PURE shading helpers for the particle shader, with their GLSL twins generated from the same
 * constants (so the tested JS and the shader cannot drift apart):
 *
 *   fireColor(T)        blackbody-like flame emission for a temperature 0..~1.3: dim dark red →
 *                       orange → yellow, brightness rising steeply; red ≥ green ≥ blue always, so
 *                       fire never turns pink or blue-white however bright it gets.
 *   screenCoverFade(…)  opacity factor that fades sprites which would cover more than `maxCover`
 *                       of the screen height (a fireball or smoke puff next to the camera), so
 *                       effects never swamp the view.
 */

/** Green rises from G0 to G1 (to G_MAX), blue from B0 to B1 (to B_MAX); intensity T²·(1 + K·T). */
const G0 = 0.15, G1 = 0.95, G_MAX = 0.78;
const B0 = 0.7, B1 = 1.3, B_MAX = 0.4;
const K = 2;

const ss = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Flame emission (linear, before the fire-intensity scale) at temperature `t` (0 = no glow). */
export function fireColor(tIn: number, out: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  const t = Number.isFinite(tIn) ? Math.min(1.5, Math.max(0, tIn)) : 0;
  const i = t * t * (1 + K * t);
  out.r = i;
  out.g = G_MAX * ss(G0, G1, t) * i;
  out.b = B_MAX * ss(B0, B1, t) * i;
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

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));

/** GLSL: vec3 fireRamp(float t) and float coverFade(float size, float depth, float p11, float maxCover). */
export const FIRE_GLSL = /* glsl */ `
vec3 fireRamp(float t) {
  t = clamp(t, 0.0, 1.5);
  float i = t * t * (1.0 + ${f(K)} * t);
  return vec3(1.0, ${f(G_MAX)} * smoothstep(${f(G0)}, ${f(G1)}, t), ${f(B_MAX)} * smoothstep(${f(B0)}, ${f(B1)}, t)) * i;
}
float coverFade(float size, float depth, float p11, float maxCover) {
  float cover = size * p11 / (2.0 * max(depth, 0.05));
  float k = min(1.0, maxCover / max(cover, 1e-6));
  return k * k;
}
`;
