/** Buildings, farmsteads, towns and the coastal city (owned by src/world/towns). */
import * as THREE from 'three';
import { createTowns } from '../../world/towns';
import { terrainHeight } from '../../world/heightfield';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'towns',
  order: 50,
  create(ctx) {
    // placement + instance records are built in a Web Worker (nothing heavy on the main thread)
    const towns = createTowns(ctx.scene, { heightAt: terrainHeight, worker: true });
    ctx.env.registerObstacleSource((x, z) => towns.obstacleTop(x, z));
    const focus = new THREE.Vector3();
    return {
      async ready(camera) {
        await towns.ready();
        towns.update(camera, 0, camera.position, ctx.atmosphere.sunDirection);
        // compile the building programs without stalling the first frames
        try {
          await ctx.renderer.compileAsync(towns.group, camera, ctx.scene);
        } catch {
          /* compiled on first use instead */
        }
      },
      update(f) {
        const p = f.state.position;
        focus.set(p.x, p.y, p.z);
        towns.update(f.camera, f.time, focus, ctx.atmosphere.sunDirection);
      },
      stats: () => ({ ...towns.stats() }),
      dispose: () => towns.dispose(),
    };
  },
};
export default mod;
