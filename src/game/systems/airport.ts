/** Airport: pavement, markings, buildings, lights, PAPI (owned by src/world/airport). */
import { createInterimAirport } from '../../world/airport/interim';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'airport',
  order: 30,
  create(ctx) {
    const airport = createInterimAirport(ctx.scene);
    return {
      update(f) {
        const sunElev = (Math.asin(Math.max(-1, Math.min(1, ctx.atmosphere.sunDirection.y))) * 180) / Math.PI;
        airport.update(f.camera, f.time, sunElev);
      },
      dispose: () => airport.dispose(),
    };
  },
};
export default mod;
