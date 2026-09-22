/**
 * The physics' view of the world (types.ts `Environment`), built from the same
 * pure heightfield and landcover the terrain mesh is drawn from — what you see
 * is what you hit. Wave 2 registers obstacle sources (trees, buildings, towers).
 */
import type { Environment, SurfaceType, Vec3 } from '../types';
import { getHeightfield, type Heightfield } from './heightfield';
import { getLandcover, type Landcover } from './landcover';

export type ObstacleSource = (x: number, z: number) => number;

export interface WorldEnvironment extends Environment {
  groundNormal(x: number, z: number): Vec3;
  obstacleTop(x: number, z: number): number;
  /** Adds a source of obstacle tops (m MSL, or −Infinity where there is none). */
  registerObstacleSource(fn: ObstacleSource): void;
}

export function createEnvironment(hf: Heightfield = getHeightfield(), lc: Landcover = getLandcover()): WorldEnvironment {
  const sources: ObstacleSource[] = [];
  return {
    groundHeight: (x: number, z: number): number => hf.height(x, z),
    groundNormal: (x: number, z: number): Vec3 => hf.normal(x, z),
    surfaceAt: (x: number, z: number): SurfaceType => lc.surfaceAt(x, z),
    waterLevel: (x: number, z: number): number | null => hf.waterLevel(x, z),
    obstacleTop: (x: number, z: number): number => {
      let top = -Infinity;
      for (let i = 0; i < sources.length; i++) {
        const v = sources[i](x, z);
        if (v > top) top = v;
      }
      return top;
    },
    registerObstacleSource(fn: ObstacleSource): void {
      sources.push(fn);
    },
  };
}
