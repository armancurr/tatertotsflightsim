/** Road traffic: moving cars, trucks, buses and tractors, parked cars (owned by src/world/cars). */
import { createCars } from '../../world/cars';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'cars',
  order: 45,
  create(ctx) {
    const cars = createCars(ctx.scene, { heightAt: terrainHeight, obstacleTop: (x, z) => ctx.env.obstacleTop(x, z) });
    return {
      update(f) {
        cars.update(f.camera, f.dt, f.paused, ctx.atmosphere.sunDirection);
      },
      onReset() {
        cars.reset();
      },
      stats: () => ({ ...cars.stats() }),
      dispose: () => cars.dispose(),
    };
  },
};
export default mod;
