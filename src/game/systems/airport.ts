/** Airport: pavement, markings, buildings, parked aircraft, lights, PAPI (owned by src/world/airport). */
import { createAirport } from '../../world/airport';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'airport',
  order: 30,
  create(ctx) {
    // createAirport registers the airport's obstacles (tower, hangars, parked aircraft, masts…)
    // with ctx.env: flying into them is a crash.
    const airport = createAirport(ctx.scene, ctx.env, { heightAt: terrainHeight });
    let sunElev = 30;
    return {
      async ready(camera) {
        // compile the airport's programs up front (parallel compile where supported) so the
        // first frame that sees the field doesn't stall on shader compilation
        airport.update(camera, 0, sunElev);
        await ctx.renderer.compileAsync(airport.group, camera, ctx.scene);
      },
      update(f) {
        const y = ctx.atmosphere.sunDirection.y;
        sunElev = (Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI;
        airport.update(f.camera, f.time, sunElev);
      },
      stats: () => ({ ...airport.stats() }),
      dispose: () => airport.dispose(),
    };
  },
};
export default mod;
