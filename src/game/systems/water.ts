/** Sea, lakes and rivers (owned by src/world/water). */
import { createWater } from '../../world/terrainIndex';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'water',
  order: 20,
  create(ctx) {
    const water = createWater(ctx.scene);
    return {
      update(f) {
        water.update(f.camera, f.time, ctx.atmosphere.sunDirection);
      },
      dispose: () => water.dispose(),
    };
  },
};
export default mod;
