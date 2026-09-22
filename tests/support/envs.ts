/**
 * Test worlds (physics `Environment`s) for the functional and fuzz layers.
 *
 *   RUNWAY_FLAT_ENV — flat at y = 0; the real runway rectangle is 'runway', the rest 'grass'.
 *   HILLY_ENV       — the airport plateau at the real field elevation (runway 36/18 from config),
 *                     sine-hill countryside around it, a ridge rising to ~400–500 m to the WEST
 *                     (x < −2.5 km) and a lake to the EAST (centre x 4.5 km, z −1.5 km). The final
 *                     approach corridor (x ≈ 0, south of the field) stays low and clear.
 */
import type { Environment, SurfaceType, Vec3 } from '../../src/types';
import { CONFIG } from '../../src/config';
import { isOnRunway } from '../../src/world/runway';

export const FIELD_ELEV = CONFIG.world.airport.elevation;

const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export const RUNWAY_FLAT_ENV: Environment = Object.freeze({
  groundHeight: () => 0,
  surfaceAt: (x: number, z: number): SurfaceType => (isOnRunway(x, z) ? 'runway' : 'grass'),
  waterLevel: () => null,
  obstacleTop: () => -Infinity,
});

/** Lake: centre, radius of the water surface, water level (m MSL). */
export const LAKE = Object.freeze({ x: 4500, z: -1500, r: 1200, level: FIELD_ELEV - 2 });
/** The ridge starts rising at RIDGE.startX and is at full height west of RIDGE.fullX. */
export const RIDGE = Object.freeze({ startX: -2500, fullX: -4500, height: 380, swell: 120 });
/** Radius of the flat airport plateau and the blend band around it. */
const PLATEAU = { flat: 1300, blend: 900 };

export function hillyHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const offField = smoothstep(PLATEAU.flat, PLATEAU.flat + PLATEAU.blend, r);
  const rolling = 12 * (Math.sin(x / 700) * Math.cos(z / 900) + 1); // 0..24 m sine hills
  const ridge = smoothstep(RIDGE.startX, RIDGE.fullX, x) * (RIDGE.height + RIDGE.swell * Math.sin(z / 800));
  let h = FIELD_ELEV + offField * (rolling + ridge);
  const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (dl < LAKE.r + 300) {
    const bed = LAKE.level - 8;
    h = bed + (h - bed) * smoothstep(LAKE.r - 100, LAKE.r + 300, dl);
  }
  return h;
}

function hillyNormal(x: number, z: number): Vec3 {
  const e = 1;
  const gx = (hillyHeight(x + e, z) - hillyHeight(x - e, z)) / (2 * e);
  const gz = (hillyHeight(x, z + e) - hillyHeight(x, z - e)) / (2 * e);
  const l = Math.hypot(gx, 1, gz);
  return { x: -gx / l, y: 1 / l, z: -gz / l };
}

const inLake = (x: number, z: number) => Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r;

export const HILLY_ENV: Environment = Object.freeze({
  groundHeight: hillyHeight,
  groundNormal: hillyNormal,
  surfaceAt(x: number, z: number): SurfaceType {
    if (isOnRunway(x, z)) return 'runway';
    if (inLake(x, z)) return 'water';
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 60) return 'sand';
    if (Math.hypot(x, z) < PLATEAU.flat) return 'grass';
    return hillyHeight(x, z) > FIELD_ELEV + 200 ? 'rock' : 'field';
  },
  waterLevel: (x: number, z: number) => (inLake(x, z) ? LAKE.level : null),
  obstacleTop: () => -Infinity,
});
