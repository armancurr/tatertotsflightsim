/** Trees, forests, hedgerows (owned by src/world/vegetation). */
import { CONFIG } from '../../config';
import { createVegetation } from '../../world/vegetation';
import { terrainHeight } from '../../world/heightfield';
import { treeDensity } from '../../world/landcover';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'vegetation',
  order: 60,
  create(ctx) {
    const veg = createVegetation(ctx.scene, { heightAt: terrainHeight, densityAt: treeDensity, seed: CONFIG.world.seed, renderer: ctx.renderer });
    ctx.env.registerObstacleSource((x, z) => veg.obstacleTop(x, z));
    return {
      update(f) {
        veg.update(f.camera, f.time, ctx.atmosphere.sunDirection);
      },
      stats: () => ({ ...veg.stats() }),
      dispose: () => veg.dispose(),
    };
  },
};
export default mod;
