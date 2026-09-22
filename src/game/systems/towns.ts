/** Buildings, farmsteads, towns and the coastal city (owned by src/world/towns). */
import { createTowns } from '../../world/towns';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'towns',
  order: 50,
  create(ctx) {
    const towns = createTowns(ctx.scene, { heightAt: terrainHeight });
    ctx.env.registerObstacleSource((x, z) => towns.obstacleTop(x, z));
    return {
      update(f) {
        towns.update(f.camera, f.time);
      },
      stats: () => ({ ...towns.stats() }),
      dispose: () => towns.dispose(),
    };
  },
};
export default mod;
