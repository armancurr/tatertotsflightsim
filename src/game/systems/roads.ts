/** Roads, bridges, street lights (owned by src/world/roads). */
import { createRoads } from '../../world/roads';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'roads',
  order: 40,
  create(ctx) {
    const roads = createRoads(ctx.scene, { heightAt: terrainHeight });
    const sunElev = () => (Math.asin(Math.max(-1, Math.min(1, ctx.atmosphere.sunDirection.y))) * 180) / Math.PI;
    return {
      ready: (camera) => roads.ready(camera),
      update(f) {
        roads.update(f.camera, f.time, sunElev());
      },
      stats: () => ({ ...roads.stats() }),
      dispose: () => roads.dispose(),
    };
  },
};
export default mod;
