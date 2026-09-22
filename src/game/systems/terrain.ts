/** Terrain LOD tiles (owned by src/world/terrain). */
import { createTerrain } from '../../world/terrainIndex';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'terrain',
  order: 10,
  create(ctx) {
    const terrain = createTerrain(ctx.renderer, ctx.scene);
    return {
      async ready(camera) {
        terrain.update(camera);
        await terrain.ready();
      },
      update(f) {
        terrain.update(f.camera);
      },
      stats: () => ({ ...terrain.stats() }),
      dispose: () => terrain.dispose(),
    };
  },
};
export default mod;
