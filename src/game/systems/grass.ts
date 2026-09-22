/** Grass tufts and wildflowers near the camera (owned by src/world/grass). */
import { CONFIG } from '../../config';
import { createGrass } from '../../world/grass';
import { createRealVegWorld } from '../../world/vegetation/world';
import { acquireSharedWorkers, releaseSharedWorkers } from '../../world/vegetation/workers';
import { placementParams } from '../../world/vegetation/placement';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'grass',
  order: 61,
  create(ctx) {
    const vcfg = CONFIG.world.vegetation;
    const gcfg = CONFIG.world.grass;
    // the same init as the vegetation system → the same shared worker pool
    const workers = acquireSharedWorkers(vcfg.workers, {
      seed: CONFIG.world.seed,
      params: placementParams(vcfg),
      cellsPerSide: Math.round(vcfg.chunkSize / vcfg.cellSize),
      grass: { cellSize: gcfg.cellSize, perSide: gcfg.perSide, mownRadius: gcfg.mownRadius },
    });
    const grass = createGrass(ctx.scene, { world: createRealVegWorld(), seed: CONFIG.world.seed, source: workers?.grass ?? null });
    return {
      update(f) {
        grass.update(f.camera, f.time);
      },
      stats: () => ({ ...grass.stats() }),
      dispose: () => {
        grass.dispose();
        releaseSharedWorkers(workers);
      },
    };
  },
};
export default mod;
