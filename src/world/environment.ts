/**
 * The physics' view of the world (types.ts `Environment`), built from the same
 * pure heightfield and landcover the terrain mesh is drawn from — what you see
 * is what you hit. Wave 2 registers obstacle sources (trees, buildings, towers).
 * Landable decks (pier decks, a berthed ship's helipad, the offshore helideck: `deckTop`) are
 * ground to aircraft only (src/physics/ground.ts); soft obstacles (inflatable race buoys) only push
 * a hull away.
 */
import type { Environment, SurfaceType, Vec3 } from '../types';
import { getHeightfield, type Heightfield } from './heightfield';
import { getLandcover, type Landcover } from './landcover';

const UP: Vec3 = Object.freeze({ x: 0, y: 1, z: 0 });

export type ObstacleSource = (x: number, z: number) => number;


export interface WorldEnvironment extends Environment {
  groundNormal(x: number, z: number): Vec3;
  obstacleTop(x: number, z: number): number;
  /** Adds a source of obstacle tops (m MSL, or −Infinity where there is none). */
  registerObstacleSource(fn: ObstacleSource): void;
  // ── landable decks (port work: src/world/harbour, src/game/systems/port.ts, berthedShips.ts) ──
  deckTop(x: number, z: number): number;
  /** Adds a source of landable deck tops (pier decks, a berthed ship's deck): aircraft may set down on them. */
  registerDeckSource(fn: ObstacleSource): void;
  // ── soft obstacles (offshore work: inflatable race buoys) ──
  /** Top (m MSL) of the tallest SOFT obstacle at x, z, or −Infinity. */
  softObstacleTop(x: number, z: number): number;
  /** Adds a source of soft obstacles: a hull bumps off them, nothing crashes. Aircraft ignore them. */
  registerSoftObstacleSource(fn: ObstacleSource): void;
}

export function createEnvironment(hf: Heightfield = getHeightfield(), lc: Landcover = getLandcover()): WorldEnvironment {
  const sources: ObstacleSource[] = [];
  const soft: ObstacleSource[] = [];
  const decks: ObstacleSource[] = [];
  const deckTop = (x: number, z: number): number => {
    let top = -Infinity;
    for (let i = 0; i < decks.length; i++) {
      const v = decks[i](x, z);
      if (v > top) top = v;
    }
    return top;
  };
  return {
    groundHeight: (x: number, z: number): number => hf.height(x, z),
    groundNormal: (x: number, z: number): Vec3 => hf.normal(x, z),
    // (a deck above the water or the ground is paved: skids and wheels grip it)
    surfaceAt: (x: number, z: number): SurfaceType => {
      if (decks.length) {
        const d = deckTop(x, z);
        if (d !== -Infinity && d > hf.height(x, z)) return 'asphalt';
      }
      return lc.surfaceAt(x, z);
    },
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
    deckTop,
    registerDeckSource(fn: ObstacleSource): void {
      decks.push(fn);
    },
    softObstacleTop: (x: number, z: number): number => {
      let top = -Infinity;
      for (let i = 0; i < soft.length; i++) {
        const v = soft[i](x, z);
        if (v > top) top = v;
      }
      return top;
    },
    registerSoftObstacleSource(fn: ObstacleSource): void {
      soft.push(fn);
    },
  };
}
