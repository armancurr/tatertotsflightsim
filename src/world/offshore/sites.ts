/**
 * Offshore scenery sites (PURE): where the oil platform, the wind farm and the jet-ski race course
 * stand, and the local ↔ world frame helpers they share. One place to move them — the tests in
 * tests/world/offshore*.test.ts check every site against the water depth, the traffic routes and
 * the islands (see docs/OFFSHORE.md).
 *
 * Frames: world +X east, +Z south, metres. A site's local frame is rotated about +Y so that local
 * +X points along the compass bearing `headingDeg` and local +Z 90° clockwise of it (bearing 90
 * = identity). In three.js that is `object.rotation.y = (90 − headingDeg)°`.
 */

export interface SiteFrame {
  x: number;
  z: number;
  /** Compass bearing of local +X, deg. */
  headingDeg: number;
  /** Cached: world direction of local +X (ux, uz) and of local +Z (wx, wz). */
  ux: number;
  uz: number;
  wx: number;
  wz: number;
}

const DEG = Math.PI / 180;

export function siteFrame(x: number, z: number, headingDeg: number): SiteFrame {
  const h = headingDeg * DEG;
  const ux = Math.sin(h);
  const uz = -Math.cos(h);
  return { x, z, headingDeg, ux, uz, wx: -uz, wz: ux };
}

/** Local (lx, lz) → world, written into `out`. */
export function localToWorld(f: SiteFrame, lx: number, lz: number, out: { x: number; z: number }): { x: number; z: number } {
  out.x = f.x + f.ux * lx + f.wx * lz;
  out.z = f.z + f.uz * lx + f.wz * lz;
  return out;
}

/** World (x, z) → local, written into `out`. */
export function worldToLocal(f: SiteFrame, x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
  const dx = x - f.x;
  const dz = z - f.z;
  out.x = dx * f.ux + dz * f.uz;
  out.z = dx * f.wx + dz * f.wz;
  return out;
}

/** three.js `rotation.y` (rad) of an object placed in this frame. */
export const frameRotationY = (f: SiteFrame): number => (90 - f.headingDeg) * DEG;

/**
 * "Tater Alpha", a fixed steel-jacket production platform in ~41 m of water, 5 km off the coast.
 * Long axis along the prevailing wind (from 215°): the living quarters and helideck on the upwind
 * (south-west) end, the flare boom downwind to the north-east. It sits 1.4 km from the tanker lane
 * (z 14,000) and from the fishing boats' circle round (2600, 12700) — as far as ≥ 40 m of water
 * allows near here (see the placement test).
 */
export const PLATFORM_SITE = { name: 'Tater Alpha', x: 4700, z: 12600, headingDeg: 35 } as const;

/**
 * The wind farm: a 4 × 4 grid (830 m × 680 m spacing, ~3.8 D × 3.1 D) east of Seal Rock in
 * 20–45 m of water, and its offshore substation in the middle.
 */
export const WIND_FARM_SITE = {
  name: 'Tater Bank wind farm',
  columnsX: [9400, 10230, 11060, 11890],
  rowsZ: [9800, 10480, 11160, 11840],
  substation: { x: 10645, z: 10820 },
} as const;

/** The jet-ski race course off the beach west of the river mouth (id is part of the saved best-lap key). */
export const RACE_SITE = { id: 'tater-beach', name: 'Tater Beach PWC', x: -2420, z: 8020 } as const;
