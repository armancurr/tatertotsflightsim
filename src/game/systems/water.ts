/** Sea, lakes and rivers (owned by src/world/water). */
import { createWater } from '../../world/terrainIndex';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'water',
  order: 20,
  create(ctx) {
    const water = createWater(ctx.scene);
    // ?waterGpu=1: time the water draws on the GPU (window.sim.debug().water.gpuMs)
    try {
      if (new URLSearchParams(location.search).get('waterGpu') === '1') water.setGpuTimer(ctx.renderer);
    } catch {
      /* no location (tests) */
    }
    const env = { timeOfDay: ctx.atmosphere.timeOfDay, viewportHeight: 900 };
    return {
      async ready(camera) {
        water.update(camera, 0, ctx.atmosphere.sunDirection, env);
        await water.ready(camera);
      },
      update(f) {
        env.timeOfDay = ctx.atmosphere.timeOfDay;
        env.viewportHeight = ctx.renderer.domElement.height;
        water.update(f.camera, f.waveTime, ctx.atmosphere.sunDirection, env);
      },
      stats: () => water.stats(),
      dispose: () => water.dispose(),
    };
  },
};
export default mod;
