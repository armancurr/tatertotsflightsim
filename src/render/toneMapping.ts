/**
 * "Filmic" tone mapping, installed as three.js CustomToneMapping.
 *
 * Built on Khronos PBR Neutral's idea — tone map the PEAK channel and scale the
 * colour with it, so hues survive (sky blue stays blue, golden hour stays
 * orange; ACES bleaches the sunset glow toward white/yellow, AgX flattens the
 * whole image) — with three photographic changes:
 *
 *  1. a gentle contrast S around middle grey (`pivot`), applied to the
 *     luminance as a hue-preserving scale: shadows a touch deeper, upper mids a
 *     touch brighter — the "print" contrast of a camera JPEG instead of the flat
 *     linear midtones of Neutral;
 *  2. an 8× smaller black-level toe than Neutral (its 0.04 offset crushes and
 *     oversaturates daylight shadows: sky-lit shadow ≈ 13 % of sunlit ground);
 *  3. a softer, earlier shoulder (`shoulderStart`): Neutral starts compressing
 *     at 0.8 and is ~0.99 by 2.5×, so sunlit cloud, white paint and snow all
 *     merge into flat white; this one keeps visible gradation up to ~6×.
 * Highlights then desaturate toward white as they compress (film-like).
 *
 * The parameters are baked into the GLSL as constants (the chunk is compiled
 * into every material that tone maps, so it cannot reference uniforms);
 * `filmicTone` is the exact TypeScript mirror for tests.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RGB } from './atmosphereModel';

export interface ToneParams {
  /** Log-space slope around the pivot (1 = linear midtones like Khronos Neutral). */
  contrast: number;
  /** Scene value (after exposure) the contrast pivots around. */
  pivot: number;
  /** Peak value where the highlight shoulder starts (Neutral: 0.8). */
  shoulderStart: number;
  /** Black-level toe (Neutral: 0.04). */
  toe: number;
  /** Highlight desaturation toward white as they compress (Neutral: 0.15). */
  desaturation: number;
}

export const DEFAULT_TONE: ToneParams = { ...CONFIG.render.tone };

const f = (x: number) => {
  const s = Number(x).toPrecision(6);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

/** GLSL for three's CustomToneMapping with these parameters baked in. */
export function filmicToneGlsl(p: ToneParams): string {
  return /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
	const float Contrast = ${f(p.contrast)};
	const float Pivot = ${f(p.pivot)};
	const float Toe = ${f(p.toe)};
	const float StartCompression = ${f(p.shoulderStart)} - Toe;
	const float Desaturation = ${f(p.desaturation)};
	color = max( color * toneMappingExposure, vec3( 0.0 ) );
	float lum = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	if ( lum > 1e-8 ) color *= pow( lum / Pivot, Contrast - 1.0 );
	float x = min( color.r, min( color.g, color.b ) );
	float offset = x < 2.0 * Toe ? x - x * x / ( 4.0 * Toe ) : Toe;
	color -= offset;
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak < StartCompression ) return color;
	float d = 1. - StartCompression;
	float newPeak = 1. - d * d / ( peak + d - StartCompression );
	color *= newPeak / peak;
	float g = 1. - 1. / ( Desaturation * ( peak - newPeak ) + 1. );
	return mix( color, vec3( newPeak ), g );
}
`;
}

export const FILMIC_NEUTRAL_GLSL = filmicToneGlsl(DEFAULT_TONE);

const DEFAULT_CUSTOM = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const CUSTOM_RE = /vec3 CustomToneMapping\( vec3 color \) \{[\s\S]*?\n\}/;

/** Replace three's pass-through CustomToneMapping with the filmic curve (re-installable with other parameters). */
export function installFilmicNeutral(p: ToneParams = DEFAULT_TONE): void {
  const chunks = THREE.ShaderChunk as Record<string, string>;
  const src = chunks.tonemapping_pars_fragment;
  const glsl = filmicToneGlsl(p).trim();
  if (src.includes(DEFAULT_CUSTOM)) chunks.tonemapping_pars_fragment = src.replace(DEFAULT_CUSTOM, glsl);
  else if (CUSTOM_RE.test(src)) chunks.tonemapping_pars_fragment = src.replace(CUSTOM_RE, glsl);
}

/** TypeScript mirror of the GLSL (tests). Non-finite or negative input channels count as 0. */
export function filmicTone(c: RGB, exposure: number, p: ToneParams, out: RGB): RGB {
  const clean = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  let r = clean(c.r * exposure);
  let g = clean(c.g * exposure);
  let b = clean(c.b * exposure);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > 1e-8) {
    const k = Math.pow(lum / p.pivot, p.contrast - 1);
    r *= k;
    g *= k;
    b *= k;
  }
  const toe = p.toe;
  const start = p.shoulderStart - toe;
  const x = Math.min(r, g, b);
  const offset = toe <= 0 ? 0 : x < 2 * toe ? x - (x * x) / (4 * toe) : toe;
  r -= offset;
  g -= offset;
  b -= offset;
  const peak = Math.max(r, g, b);
  if (peak < start) {
    out.r = r;
    out.g = g;
    out.b = b;
    return out;
  }
  const d = 1 - start;
  const newPeak = 1 - (d * d) / (peak + d - start);
  const k = newPeak / peak;
  r *= k;
  g *= k;
  b *= k;
  const m = 1 - 1 / (p.desaturation * (peak - newPeak) + 1);
  out.r = r + (newPeak - r) * m;
  out.g = g + (newPeak - g) * m;
  out.b = b + (newPeak - b) * m;
  return out;
}

/** The configured curve (kept under its old name for callers and tests). */
export function filmicNeutral(c: RGB, exposure: number, out: RGB): RGB {
  return filmicTone(c, exposure, DEFAULT_TONE, out);
}
