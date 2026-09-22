/** Roads, bridges (owned by src/world/roads). */
import { createRoads } from '../../world/roads';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'roads',
  order: 40,
  create(ctx) {
    const roads = createRoads(ctx.scene, { heightAt: terrainHeight });
    return {
      update(f) {
        roads.update(f.camera, f.time);
      },
      stats: () => ({ ...roads.stats() }),
      dispose: () => roads.dispose(),
    };
  },
};
export default mod;
