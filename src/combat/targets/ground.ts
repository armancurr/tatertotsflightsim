/**
 * What the target range needs to know about the ground (PURE): height, slope, surface, water,
 * obstacles (trees/buildings) and keep-out zones (farm yards, roads). Built from the physics
 * environment in the browser, and in node/workers from the same pure heightfield, landcover,
 * vegetation placement and road network (see groundQuery.ts).
 */
import { CONFIG } from '../../config';
import type { SurfaceType, Vec3 } from '../../types';

export interface RangeGround {
  height(x: number, z: number): number;
  normal(x: number, z: number): Vec3;
  surface(x: number, z: number): SurfaceType;
  /** Water surface height, or null where there is no water. */
  water(x: number, z: number): number | null;
  /** Top (m MSL) of the tallest tree/building over (x, z), or −Infinity. */
  obstacle(x: number, z: number): number;
  /** 0 = free, 1 = road (may be crossed, never parked on), 2 = keep out (farm yard, town). */
  keepOut?(x: number, z: number): number;
}

export type RangeConfig = typeof CONFIG.combat.range;

const DEG = Math.PI / 180;

/** The environment interface the range reads (a subset of WorldEnvironment). */
export interface EnvLike {
  groundHeight(x: number, z: number): number;
  groundNormal(x: number, z: number): Vec3;
  surfaceAt(x: number, z: number): SurfaceType;
  waterLevel(x: number, z: number): number | null;
  obstacleTop?(x: number, z: number): number;
}

export function groundFromEnv(env: EnvLike, keepOut?: (x: number, z: number) => number): RangeGround {
  return {
    height: (x, z) => env.groundHeight(x, z),
    normal: (x, z) => env.groundNormal(x, z),
    surface: (x, z) => env.surfaceAt(x, z),
    water: (x, z) => env.waterLevel(x, z),
    obstacle: (x, z) => (env.obstacleTop ? env.obstacleTop(x, z) : -Infinity),
    keepOut,
  };
}

/** Slope of a unit normal, deg. */
export function slopeDeg(n: Vec3): number {
  const y = Math.max(-1, Math.min(1, n.y));
  return Math.acos(y) / DEG;
}

/** Open ground a vehicle could stand on (surface + slope + dry), ignoring obstacles. */
export function openAt(g: Pick<RangeGround, 'surface' | 'normal' | 'water'>, x: number, z: number, cfg: RangeConfig = CONFIG.combat.range): boolean {
  const s = g.surface(x, z);
  if (!cfg.ground.surfaces.includes(s)) return false;
  if (g.water(x, z) !== null) return false;
  return slopeDeg(g.normal(x, z)) <= cfg.ground.maxSlopeDeg;
}

/** Nothing (tree crown, roof) over this point within `lift` m above the ground. */
export function clearAt(g: RangeGround, x: number, z: number, lift = 0.3): boolean {
  const top = g.obstacle(x, z);
  return !(top > g.height(x, z) + lift);
}

/**
 * A hull footprint (length × width, heading) at (x, z) on valid ground: open ground at the
 * centre and the corners, no obstacle anywhere over the footprint grown by `clearance`, not in a
 * keep-out zone (roads count as keep-out unless `allowRoad`).
 */
export function footprintOk(
  g: RangeGround,
  x: number,
  z: number,
  headingDeg: number,
  length: number,
  width: number,
  clearance: number,
  cfg: RangeConfig = CONFIG.combat.range,
  allowRoad = false,
): boolean {
  const h = headingDeg * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = -fz;
  const rz = fx;
  const hl = length / 2;
  const hw = width / 2;
  // surface + slope at the centre and the four corners
  for (let k = 0; k < 5; k++) {
    const a = k === 0 ? 0 : k < 3 ? hl : -hl;
    const b = k === 0 ? 0 : k % 2 ? hw : -hw;
    const px = x + fx * a + rx * b;
    const pz = z + fz * a + rz * b;
    if (!openAt(g, px, pz, cfg)) return false;
    const ko = g.keepOut ? g.keepOut(px, pz) : 0;
    if (ko >= 2 || (ko >= 1 && !allowRoad)) return false;
  }
  // obstacles over the grown footprint (≤ 1.5 m grid; tree crowns are ≥ 1.5 m across)
  const L = hl + clearance;
  const W = hw + clearance;
  const nl = Math.max(1, Math.ceil((2 * L) / 1.5));
  const nw = Math.max(1, Math.ceil((2 * W) / 1.5));
  for (let i = 0; i <= nl; i++) {
    const a = -L + (2 * L * i) / nl;
    for (let j = 0; j <= nw; j++) {
      const b = -W + (2 * W * j) / nw;
      const px = x + fx * a + rx * b;
      const pz = z + fz * a + rz * b;
      if (!clearAt(g, px, pz)) return false;
      if (g.keepOut && g.keepOut(px, pz) >= 2) return false;
    }
  }
  return true;
}

/** Heading (deg, clockwise from north) of the direction (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  const h = Math.atan2(dx, -dz) / DEG;
  return ((h % 360) + 360) % 360;
}

/** Signed smallest difference a − b between two headings, deg in (−180, 180]. */
export function headingDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}
