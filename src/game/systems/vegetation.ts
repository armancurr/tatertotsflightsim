/** Trees, forests, hedgerows, orchards (owned by src/world/vegetation). */
import { CONFIG } from '../../config';
import { createVegetation } from '../../world/vegetation';
import { createRealVegWorld } from '../../world/vegetation/world';
import { acquireSharedWorkers, releaseSharedWorkers } from '../../world/vegetation/workers';
import { placementParams } from '../../world/vegetation/placement';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'vegetation',
  order: 60,
  create(ctx) {
    const cfg = CONFIG.world.vegetation;
    const world = createRealVegWorld();
    const workers = acquireSharedWorkers(cfg.workers, {
      seed: CONFIG.world.seed,
      params: placementParams(cfg),
      cellsPerSide: Math.round(cfg.chunkSize / cfg.cellSize),
      grass: { cellSize: CONFIG.world.grass.cellSize, perSide: CONFIG.world.grass.perSide, mownRadius: CONFIG.world.grass.mownRadius },
    });
    const veg = createVegetation(ctx.scene, {
      heightAt: world.heightAt,
      densityAt: world.densityAt,
      world,
      seed: CONFIG.world.seed,
      renderer: ctx.renderer,
      source: workers?.trees ?? null,
    });
    ctx.env.registerObstacleSource((x, z) => veg.obstacleTop(x, z));
    const sun = ctx.atmosphere.sunLight;
    return {
      async ready(camera) {
        // Trees within ~1.5 km before the first frame (the system loader times out after a few seconds anyway).
        const t0 = performance.now();
        while (performance.now() - t0 < 6000) {
          veg.update(camera, 0, ctx.atmosphere.sunDirection, sun.color);
          if (veg.isReadyAround(1500)) return;
          await new Promise((r) => setTimeout(r, 30));
        }
      },
      update(f) {
        veg.update(f.camera, f.time, ctx.atmosphere.sunDirection, sun.color);
      },
      onReset() {
        // a teleport: the streamer re-centres on the next update (workers fetch the new area first)
      },
      stats: () => ({ ...veg.stats(), workers: workers?.workerCount ?? 0 }),
      dispose: () => {
        veg.dispose();
        releaseSharedWorkers(workers);
      },
    };
  },
};
export default mod;
