/**
 * The default physics environment: flat ground at y = 0 everywhere, all
 * runway, no water, no obstacles, no wind. Lets tests run without a world.
 */
import type { Environment, Vec3 } from '../types';

const UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });

export const FLAT_ENV: Environment = Object.freeze({
  groundHeight: () => 0,
  groundNormal: () => UP,
  surfaceAt: () => 'runway' as const,
  waterLevel: () => null,
  obstacleTop: () => -Infinity,
});
