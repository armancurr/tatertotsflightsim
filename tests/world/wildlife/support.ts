/** Shared fixtures for the wildlife tests: the default world's water, layout and marina. */
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import { portMarina } from '../../../src/world/port';
import type { WaterWorld } from '../../../src/world/traffic/sea';
import type { ZoneContext } from '../../../src/world/wildlife/zones';

const hf = getHeightfield();
export const water: WaterWorld = { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) };
export const layout = getLayout();
export const marina = portMarina(layout);
export const zoneCtx: ZoneContext = { layout, marina };
export const DEG = Math.PI / 180;

/** Vessel body (bx + starboard, bz along, bow −z) of a world point. */
export function toBody(x: number, z: number, vx: number, vz: number, headingDeg: number): { bx: number; bz: number } {
  const h = headingDeg * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const dx = x - vx;
  const dz = z - vz;
  return { bx: dx * -fz + dz * fx, bz: -(dx * fx + dz * fz) };
}
