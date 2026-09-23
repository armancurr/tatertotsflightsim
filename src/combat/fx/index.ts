/**
 * Combat effects (three.js adapter): the pure CombatFxSim playing into the scene's shared fx pools
 * (dust, fire, debris — drawn by the fx system) plus this module's glowing streaks (one draw call).
 * The combatfx system (src/game/systems/combatfx.ts) feeds it the combat events.
 */
import * as THREE from 'three';
import type { FxSim } from '../../fx/sim';
import type { Vec3 } from '../../types';
import type { CombatEvent } from '../types';
import { CombatFxSim, type CombatFxEnv, type CombatFxOptions, type CombatFxStats } from './sim';
import { createStreakRenderer } from './render';

export { CombatFxSim, type CombatFxEnv, type CombatFxStats } from './sim';
export { gunRunScript, maverickScript, type DemoScript, type DemoEvent } from './demo';

export interface CombatFx {
  readonly sim: CombatFxSim;
  readonly object: THREE.Group;
  onEvent(e: CombatEvent): void;
  /** Per frame: play queued events into `fx`, step and draw the streaks. dt = 0 while paused. */
  update(camera: THREE.PerspectiveCamera, dt: number, fx: FxSim | null, env: CombatFxEnv, shooter: Vec3 | null, viewport: { x: number; y: number }): void;
  shake(cockpit: boolean, gunSpin: number, gunFiring: boolean): number;
  reset(): void;
  stats(): CombatFxStats & { streaksDrawn: number };
  dispose(): void;
}

export function createCombatFx(scene: THREE.Scene, opts: CombatFxOptions & { streakIntensity?: number } = {}): CombatFx {
  const sim = new CombatFxSim(opts);
  const streaks = createStreakRenderer(sim.streaks, { intensity: opts.streakIntensity ?? 3 });
  const group = new THREE.Group();
  group.name = 'combatfx';
  group.add(streaks.mesh);
  scene.add(group);
  const cam = { x: 0, y: 0, z: 0 };
  let disposed = false;
  return {
    sim,
    object: group,
    onEvent: (e) => {
      if (!disposed) sim.onEvent(e);
    },
    update(camera, dt, fx, env, shooter, viewport) {
      if (disposed) return;
      const e = camera.matrixWorld.elements;
      cam.x = e[12];
      cam.y = e[13];
      cam.z = e[14];
      sim.update(dt, fx, env, shooter, cam);
      streaks.update(camera, viewport.y, viewport.x);
    },
    shake: (cockpit, spin, firing) => sim.shake(cockpit, spin, firing),
    reset() {
      sim.reset();
      streaks.update(null as unknown as THREE.PerspectiveCamera, 900, 1440);
    },
    stats: () => ({ ...sim.stats(), streaksDrawn: streaks.drawn }),
    dispose() {
      if (disposed) return;
      disposed = true;
      streaks.dispose();
      group.removeFromParent();
    },
  };
}
