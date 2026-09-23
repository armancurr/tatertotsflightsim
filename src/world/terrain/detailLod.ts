/**
 * Level of detail of the terrain shader's small-scale features, by pixel footprint (PURE). The
 * GLSL in terrainShader.ts is built from these numbers, and the functions below are line-for-line
 * twins of its fade terms (tests/world/terrain/detailLod.test.ts fuzzes them): every fade is 1 up
 * close, falls monotonically with the footprint (i.e. with distance), reaches exactly 0 where the
 * feature would be sub-pixel — so the shader can skip the work there — and is finite for any input.
 *
 * Footprints: `gFw` is the pixel's footprint on the ground (m, sum of the two screen axes), `gFwD`
 * the geometric mean of the axes (grazing views are long in one axis only).
 */

export const DETAIL_LOD = {
  /** Hex-tiled near detail of a layer whose tile is S m: full below S·nearStart, gone beyond S·nearEnd (gFwD). */
  nearStart: 1 / 64,
  nearEnd: 1 / 9,
  /** Mid-scale detail: the same texture at S·midScale, full below S2·midStart, gone beyond S2·midEnd (gFwD). */
  midScale: 5.3,
  midStart: 1 / 64,
  midEnd: 1 / 8,
  /** Height-aware blend of the two strongest classes: full below blendStart m, plain linear beyond blendEnd (gFwD). */
  blendStart: 0.05,
  blendEnd: 0.6,
  /** Procedural bump (crop rows, bales, strata): full below bumpStart m, flat beyond bumpEnd (gFw). */
  bumpStart: 0.2,
  bumpEnd: 2.5,
  /** Periodic stripes (drill rows, furrows, mower passes): full below stripeStart periods per pixel, gone beyond stripeEnd. */
  stripeStart: 0.25,
  stripeEnd: 0.7,
} as const;

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** GLSL smoothstep (e0 < e1). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export interface DetailFades {
  /** Hex-tiled near detail weight (tDetail fNear before amt/uDetail). */
  near: number;
  /** Mid-scale detail weight (tDetail fMid before amt/uDetail). */
  mid: number;
  /** Height-aware blend strength (terrainAlbedo `fade`). */
  blend: number;
  /** Procedural bump scale (tBumpScale). */
  bump: number;
}

/** The detail fades for a pixel footprint (gFwD ≈ gFw for a pixel seen square-on) and a detail tile of `tileM` m. */
export function detailFades(footprintD: number, footprint: number, tileM: number, out: DetailFades = { near: 0, mid: 0, blend: 0, bump: 0 }): DetailFades {
  const L = DETAIL_LOD;
  const s2 = tileM * L.midScale;
  out.near = 1 - smoothstep(tileM * L.nearStart, tileM * L.nearEnd, footprintD);
  out.mid = 1 - smoothstep(s2 * L.midStart, s2 * L.midEnd, footprintD);
  out.blend = 1 - smoothstep(L.blendStart, L.blendEnd, footprintD);
  out.bump = 1 - smoothstep(L.bumpStart, L.bumpEnd, footprint);
  return out;
}

/** Twin of tStripes' fade: amplitude of a periodic stripe of `period` m under a footprint of `fw` m. */
export function stripeFade(period: number, fw: number): number {
  return 1 - smoothstep(period * DETAIL_LOD.stripeStart, period * DETAIL_LOD.stripeEnd, fw);
}

/** Twin of tBand: fraction of a pixel of footprint fw covered by a band of half-width w around d = 0. */
export function bandCover(d: number, w: number, fw: number): number {
  const c = 1 - smoothstep(w - 0.5 * fw, w + 0.5 * fw, d);
  return c * Math.min(1, (2 * w) / Math.max(fw, 1e-3) + 0.25);
}
