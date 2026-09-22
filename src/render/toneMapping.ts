/**
 * "Filmic Neutral" tone mapping, installed as three.js CustomToneMapping.
 *
 * Khronos PBR Neutral keeps hues (sky blue stays blue, golden hour stays
 * orange — ACES bleaches the sunset glow toward white/yellow, AgX flattens the
 * whole image), but its black-level toe subtracts up to 0.04 from every
 * channel, which crushes and oversaturates daylight shadows (sky-lit shadow
 * ≈ 13% of sunlit ground). This variant keeps Neutral's hue-preserving
 * highlight shoulder and desaturation but uses an 8× smaller toe.
 */
import * as THREE from 'three';
import type { RGB } from './atmosphereModel';

export const FILMIC_NEUTRAL_GLSL = /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
	const float Toe = 0.005;
	const float StartCompression = 0.8 - Toe;
	const float Desaturation = 0.15;
	color *= toneMappingExposure;
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

const DEFAULT_CUSTOM = 'vec3 CustomToneMapping( vec3 color ) { return color; }';

/** Replace three's pass-through CustomToneMapping with Filmic Neutral. Idempotent. */
export function installFilmicNeutral(): void {
  const chunks = THREE.ShaderChunk as Record<string, string>;
  const src = chunks.tonemapping_pars_fragment;
  if (src.includes(DEFAULT_CUSTOM)) chunks.tonemapping_pars_fragment = src.replace(DEFAULT_CUSTOM, FILMIC_NEUTRAL_GLSL.trim());
}

/** TypeScript mirror of the GLSL (tests). */
export function filmicNeutral(c: RGB, exposure: number, out: RGB): RGB {
  const toe = 0.005;
  const start = 0.8 - toe;
  const desat = 0.15;
  let r = c.r * exposure;
  let g = c.g * exposure;
  let b = c.b * exposure;
  const x = Math.min(r, g, b);
  const offset = x < 2 * toe ? x - (x * x) / (4 * toe) : toe;
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
  const m = 1 - 1 / (desat * (peak - newPeak) + 1);
  out.r = r + (newPeak - r) * m;
  out.g = g + (newPeak - g) * m;
  out.b = b + (newPeak - b) * m;
  return out;
}
