/**
 * NaN/Inf containment for the HDR post stack. One bad texel in the scene target (a shader taking
 * pow() of a negative, a normalize() of zero…) must stay one bad pixel: the bloom chain's blurs
 * would spread it into whole mip texels — stair-stepped black blocks — and a NaN reaching the eye
 * adaptation's feedback loop would black out the frame for good. Bloom and metering pass every
 * scene sample through hdrSafe(); the adaptation step rejects a bad trim.
 *
 * The test is on the bits (exponent all ones = NaN or ±Inf), because GPU compilers with fast-math
 * (ANGLE → Metal, some D3D paths) may fold isnan()/isinf() and NaN comparisons to false.
 */

/** GLSL (WebGL2 / GLSL ES 3.00): hdrBad(x), hdrSafe(float), hdrSafe(vec3). */
export const HDR_SAFE_GLSL = /* glsl */ `
bool hdrBad( float x ) { return ( floatBitsToUint( x ) & 0x7F800000u ) == 0x7F800000u; }
float hdrSafe( float x ) { return hdrBad( x ) ? 0.0 : max( x, 0.0 ); }
vec3 hdrSafe( vec3 c ) { return ( hdrBad( c.r ) || hdrBad( c.g ) || hdrBad( c.b ) ) ? vec3( 0.0 ) : max( c, vec3( 0.0 ) ); }
`;

/** TS twin of hdrBad: NaN or ±Infinity. */
export function hdrBad(x: number): boolean {
  return !Number.isFinite(x);
}

/** TS twin of hdrSafe(float): NaN/Inf and negatives → 0. */
export function hdrSafe(x: number): number {
  return hdrBad(x) || x < 0 ? 0 : x;
}

/** TS twin of hdrSafe(vec3): a bad channel zeroes the texel; negatives → 0. */
export function hdrSafe3(c: readonly [number, number, number] | number[]): [number, number, number] {
  if (hdrBad(c[0]) || hdrBad(c[1]) || hdrBad(c[2])) return [0, 0, 0];
  return [Math.max(c[0], 0), Math.max(c[1], 0), Math.max(c[2], 0)];
}
