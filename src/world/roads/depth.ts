/**
 * Keeping roads (and what drives on them) visible on top of a coarse,
 * level-of-detail terrain mesh (PURE math, mirrored in the road/car shaders).
 *
 * The terrain draws tiles whose vertex spacing grows with distance: a leaf of
 * size S is drawn while the camera is ≥ S·splitFactor from its box and it
 * morphs toward its parent's grid (2S) by 2·S·splitFactor, with `res` quads
 * per side, so at a vertex distance d the mesh spacing is at most
 * Δ(d) = d·2/(0.72·2·splitFactor·res) (≈ d/73 with the defaults). Between its
 * vertices the mesh cuts corners: in a hollow it lies ABOVE the true surface
 * (the road) by up to ~0.1–0.2·Δ in rough terrain.
 *
 * Two corrections, applied per vertex in the shader:
 * 1. LOD lift (world space, up): y += k_kind·d. k is measured per road kind
 *    (tests/world/roads/depth.test.ts samples the real heightfield) so that
 *    k·d ≥ mesh error at Δ(d). On screen this moves the road by k·cos(elev)
 *    radians (< 3 px at k = 0.003) — invisible, while the coverage grows with d.
 * 2. Depth pull (view space, depth only): mvPosition.xyz *= (1 − pull). A
 *    uniform scale toward the eye leaves the screen position unchanged and
 *    moves the depth closer by pull·d, which covers pull·d·sin(elev) =
 *    pull·h of vertical error seen from height h — the steep views from high
 *    altitude. Everything on the road (markings, cars, bridges) gets the same
 *    lift and pull, so their mutual order is untouched.
 */
import type { NetKind } from './network';
import { CONFIG } from '../../config';

export type DepthConfig = Pick<typeof CONFIG.world.towns.roads, 'lodLift' | 'depthPull'>;
export type TerrainLodConfig = Pick<typeof CONFIG.world.terrain, 'lodSplitFactor' | 'chunkResolution' | 'minTileSize'>;

/** Worst-case terrain mesh vertex spacing at a (3D) distance d from the camera, m. */
export function terrainSpacingAt(d: number, t: TerrainLodConfig = CONFIG.world.terrain): number {
  // morph toward the parent (2S) starts at 0.72 of 2·S·split; there the spacing is 2S/res
  const s = Math.max(t.minTileSize / t.chunkResolution, (2 * d) / (0.72 * 2 * t.lodSplitFactor * t.chunkResolution));
  return s;
}

/** World-space LOD lift of a road vertex of this kind at camera distance d, m. */
export function lodLift(kind: NetKind, d: number, cfg: DepthConfig = CONFIG.world.towns.roads): number {
  return cfg.lodLift[kind] * d;
}

/** View-space depth after the pull (screen position unchanged). */
export function pulledDepth(viewDepth: number, cfg: DepthConfig = CONFIG.world.towns.roads): number {
  return viewDepth * (1 - cfg.depthPull);
}

/**
 * Vertical terrain error (mesh above the road) that the road still covers,
 * seen from height h above the road at distance d: lift + pull·h.
 */
export function coveredError(kind: NetKind, d: number, h: number, cfg: DepthConfig = CONFIG.world.towns.roads): number {
  return lodLift(kind, d, cfg) + cfg.depthPull * Math.max(0, h);
}

/** On-screen shift of the lifted road, radians (vertical lift seen at elevation angle `elev`). */
export function liftScreenShift(kind: NetKind, d: number, elevRad: number, cfg: DepthConfig = CONFIG.world.towns.roads): number {
  return d > 0 ? (lodLift(kind, d, cfg) * Math.cos(elevRad)) / d : 0;
}

/** The per-kind lift factors in KIND_ID order (shader uniform). */
export function lodLiftArray(cfg: DepthConfig = CONFIG.world.towns.roads): number[] {
  const k = cfg.lodLift;
  return [k.highway, k.road, k.access, k.lane, k.street, k.drive, k.street, k.street];
}

/** GLSL for the vertex stage: `roadLodLift(kindId, dist)` and `roadPull(mvPosition)`. */
export const DEPTH_GLSL = /* glsl */ `
uniform float uLodLift[ 8 ];
uniform float uDepthPull;
float roadLodLift( float kindId, float dist ) {
  int k = int( clamp( kindId, 0.0, 7.0 ) + 0.5 );
  return uLodLift[ k ] * dist;
}
vec4 roadPull( vec4 mv ) {
  return vec4( mv.xyz * ( 1.0 - uDepthPull ), 1.0 );
}
`;
