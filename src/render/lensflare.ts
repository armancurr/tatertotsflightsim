/**
 * Subtle sun lens flare, drawn in the HDR output pass (post.ts).
 *
 * three's Lensflare addon cannot be used here: it copies the current
 * framebuffer with copyTexSubImage2D, which is illegal on the multisampled HDR
 * render target this renderer draws into. Instead the output pass:
 *   1. samples the resolved HDR image at the sun's screen position (a Vogel
 *      disc of 12 taps, in the vertex shader of the full-screen triangle, so it
 *      runs 3× per frame, not per pixel). The visible sun disc is ~10⁴× brighter
 *      than anything else, so the fraction of taps above threshold is the sun's
 *      visibility — occluded by terrain, the aircraft AND clouds (the addon's
 *      depth test cannot see clouds, which do not write depth);
 *   2. adds procedural glare (core + halo, a stand-in for bloom), a faint
 *      six-blade starburst and a few tinted ghosts along the sun→centre axis.
 */
import * as THREE from 'three';
import type { Vec3 } from '../types';

export interface SunScreen {
  /** Normalised device coordinates (-1..1 across the viewport). */
  x: number;
  y: number;
  /** False when the sun is behind the camera. */
  inFront: boolean;
}

const _d = new THREE.Vector3();
const _c = new THREE.Vector4();

/** Project the (infinitely distant) sun into NDC for a camera with up-to-date matrices. */
export function sunScreenPosition(sunDir: Vec3, camera: THREE.Camera, out: SunScreen): SunScreen {
  _d.set(sunDir.x, sunDir.y, sunDir.z).transformDirection(camera.matrixWorldInverse);
  out.inFront = _d.z < 0;
  _c.set(_d.x, _d.y, _d.z, 0).applyMatrix4(camera.projectionMatrix);
  const w = Math.abs(_c.w) > 1e-9 ? _c.w : 1e-9;
  out.x = _c.x / w;
  out.y = _c.y / w;
  return out;
}

/** Fade the flare out as the sun leaves the screen (NDC). */
export function flareEdgeFade(x: number, y: number): number {
  const m = Math.max(Math.abs(x), Math.abs(y));
  const t = Math.min(1, Math.max(0, (m - 0.85) / (1.4 - 0.85)));
  return 1 - t * t * (3 - 2 * t);
}

/** Vertex-shader part: sun visibility from the HDR image. Needs tHDR, uTexel. */
export const FLARE_VERTEX_GLSL = /* glsl */ `
uniform vec4 uFlareSun;          // xy sun uv, z enabled&in front, w edge fade
uniform float uFlareThreshold;   // HDR luminance of the unoccluded sun disc
uniform float uFlareSampleRadius;// pixels
varying float vSunVis;
float sunVisibility( sampler2D hdr, vec2 texel ) {
	if ( uFlareSun.z < 0.5 ) return 0.0;
	float acc = 0.0;
	for ( int i = 0; i < 12; i ++ ) {
		float a = float( i ) * 2.3999632;
		float r = sqrt( ( float( i ) + 0.5 ) / 12.0 ) * uFlareSampleRadius;
		vec2 uv = uFlareSun.xy + vec2( cos( a ), sin( a ) ) * r * texel;
		vec3 h = textureLod( hdr, uv, 0.0 ).rgb;
		acc += smoothstep( 0.15, 0.7, dot( h, vec3( 0.2126, 0.7152, 0.0722 ) ) / uFlareThreshold );
	}
	return acc / 12.0 * uFlareSun.w;
}
`;

/** Fragment-shader part: glare, starburst and ghosts. */
export const FLARE_FRAGMENT_GLSL = /* glsl */ `
uniform vec4 uFlareSun;
uniform vec3 uFlareColor;   // sun colour (HDR)
uniform vec4 uFlareParams;  // glare, ghosts, starburst, aspect
varying float vSunVis;
float flareGhost( vec2 p, vec2 s, float k, float size ) {
	float d = length( p - s * k );
	float disc = 1.0 - smoothstep( size * 0.75, size, d );
	return disc * ( 0.55 + 0.45 * smoothstep( size * 0.2, size * 0.95, d ) );
}
vec3 lensFlare( vec2 uv ) {
	if ( vSunVis <= 0.001 ) return vec3( 0.0 );
	vec2 asp = vec2( uFlareParams.w, 1.0 );
	vec2 s = ( uFlareSun.xy - 0.5 ) * asp;
	vec2 p = ( uv - 0.5 ) * asp;
	vec2 d = p - s;
	float r = length( d );
	// glare: tight core + small halo (what bloom would give the sun) + a faint veil
	vec3 c = uFlareColor * uFlareParams.x * ( 0.45 * exp( - r * 60.0 ) + 0.035 * exp( - r * 14.0 ) + 0.004 * exp( - r * 3.0 ) );
	float ang = atan( d.y, d.x );
	float star = pow( abs( cos( ang * 3.0 + 0.4 ) ), 80.0 ) + 0.5 * pow( abs( cos( ang * 3.0 + 1.45 ) ), 120.0 );
	c += uFlareColor * uFlareParams.z * star * exp( - r * 16.0 ) * smoothstep( 0.0, 0.015, r );
	vec3 g = vec3( 0.0 );
	g += vec3( 0.55, 0.75, 0.55 ) * flareGhost( p, s, -0.28, 0.035 );
	g += vec3( 0.85, 0.55, 0.35 ) * flareGhost( p, s, -0.62, 0.075 ) * 0.7;
	g += vec3( 0.35, 0.55, 0.95 ) * flareGhost( p, s, -1.05, 0.12 ) * 0.45;
	g += vec3( 0.7, 0.45, 0.85 ) * flareGhost( p, s, 0.42, 0.028 );
	g += vec3( 0.95, 0.8, 0.5 ) * flareGhost( p, s, -1.45, 0.05 ) * 0.8;
	// faint halo ring centred on the screen, brightest on the sun side
	float ring = exp( - pow( ( length( p + s * 0.15 ) - 0.52 ) * 26.0, 2.0 ) );
	g += vec3( 0.6, 0.75, 1.0 ) * ring * 0.25 * ( 0.5 + 0.5 * dot( normalize( p + 1e-4 ), normalize( s + 1e-4 ) ) );
	c += uFlareColor * uFlareParams.y * g;
	return c * vSunVis;
}
`;
