/**
 * The naval gunnery range at sea (src/combat/navalRange.ts + src/combat/render/navalRangeRender.ts):
 * registers the floating targets with the combat world (so every weapon — the ship's 16-inch guns,
 * the F-16's and A-10's guns and Mavericks — can hit them), floats them on the drawn sea (the same
 * Gerstner trains and near-camera weighting as the water shader), tows the sled, sinks what is
 * destroyed (burning while it goes down) and brings fresh targets back. Present for every vehicle;
 * drawn only within `CONFIG.combat.gunnery.viewDistance`.
 *
 * Debug: `window.sim.gunnery` — list(), kill(id), look(id | null) (a QA camera on a target), plan.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { combatWorld } from '../../combat/world';
import { createGunneryRange, type WaveSampler } from '../../combat/navalRange';
import { createNavalRangeRenderer } from '../../combat/render/navalRangeRender';
import { hullWaveMotion, newWaveMotion, shoalFactor, waveWeights } from '../../world/traffic/buoyancy';
import { WATER_DISP_RANGE } from '../../world/traffic/ships';
import { getSeaSpectrum } from '../../world/water/waves';
import { fxHub } from '../../fx/hub';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'navalRange',
  order: 67,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const range = createGunneryRange(world);
    range.install();
    const renderer = createNavalRangeRenderer(ctx.scene);
    const spectrum = getSeaSpectrum();
    const weights = new Float64Array(Math.max(1, spectrum.trains.length));
    const wm = newWaveMotion();
    const cam = new THREE.Vector3();
    let waveTime = 0;
    const view = CONFIG.combat.gunnery.viewDistance;
    const env = ctx.env;
    const sampler: WaveSampler = {
      motion(x, z, headingDeg, L, B, out) {
        const r = Math.hypot(x - cam.x, z - cam.z);
        if (r >= WATER_DISP_RANGE || waveWeights(spectrum, r, WATER_DISP_RANGE, weights) === 0) {
          out.heave = 0;
          out.pitch = 0;
          out.roll = 0;
          return;
        }
        const wl = env.waterLevel(x, z);
        const gain = wl === null ? 0 : shoalFactor(wl - env.groundHeight(x, z));
        hullWaveMotion(spectrum, weights, gain, x, z, waveTime, headingDeg, L, B, wm, 4);
        out.heave = wm.heave + (wl ?? 0);
        out.pitch = wm.pitch;
        out.roll = wm.roll;
      },
    };
    const bm = { heave: 0, pitch: 0, roll: 0 };
    const buoyOut = { y: 0, pitch: 0, roll: 0 };
    const buoyY = (x: number, z: number) => {
      sampler.motion(x, z, 0, 2.5, 2.5, bm);
      buoyOut.y = bm.heave;
      buoyOut.pitch = bm.pitch;
      buoyOut.roll = bm.roll;
      return buoyOut;
    };

    // wrecks burn while they sink
    const fires = new Map<number, number>();
    let time = 0;
    const offWorld = world.on((e) => {
      if (e.type !== 'destroyed') return;
      const r = range.targets.find((t) => t.target.id === e.targetId);
      const fx = fxHub(ctx.scene).effects?.sim;
      if (!r || !fx) return;
      const big = r.plan.kind === 'hulk';
      fires.set(e.targetId, fx.addFire(r.x, r.y + (big ? 9 : 2), r.z, r.y, big ? 1 : 0.55, big ? 70 : 20, big ? 14 : 4, true));
    });

    let debugCam: { id: number } | null = null;
    const debug = {
      plan: range.plan,
      list: () => range.targets.map((r) => ({ id: r.target.id, kind: r.plan.kind, phase: r.phase, alive: r.target.alive, health: r.target.health, x: r.x, y: r.y, z: r.z })),
      kill: (id: number) => range.kill(id, time),
      look(id: number | null) {
        debugCam = id === null ? null : { id };
      },
    };
    let debugInstalled = false;

    return {
      update(f) {
        if (!debugInstalled) {
          const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
          if (sim) {
            sim.gunnery = debug;
            debugInstalled = true;
          }
        }
        time = f.time;
        waveTime = f.waveTime;
        f.camera.getWorldPosition(cam);
        range.update(f.paused ? 0 : f.dt, f.time, sampler);
        // fires follow their wreck down, and go out when it is under
        const fx = fxHub(ctx.scene).effects?.sim;
        if (fx && fires.size) {
          for (const [id, h] of fires) {
            const r = range.targets.find((t) => t.target.id === id);
            if (!r || r.phase === 'afloat') {
              fires.delete(id);
              continue;
            }
            const big = r.plan.kind === 'hulk';
            const y = r.y - r.sink + (big ? 9 : 2);
            if (y < r.y + 0.5) {
              fx.quench(h);
              fires.delete(id);
            } else fx.moveFire(h, r.x, y, r.z, r.y);
          }
        }
        if (debugCam) {
          const r = range.targets.find((t) => t.target.id === debugCam!.id);
          if (r) {
            const L = world.classOf(r.target.kind).length;
            f.camera.position.set(r.x + L * 1.6, r.y + L * 0.5 + 4, r.z + L * 1.2);
            f.camera.lookAt(r.x, r.y + 2, r.z);
            f.camera.updateMatrixWorld();
          }
        }
        renderer.update(range, f.camera, view, buoyY);
      },
      onReset() {
        range.reset();
        fires.clear();
      },
      stats: () => ({ targets: range.targets.length, afloat: range.targets.filter((r) => r.phase === 'afloat').length }),
      dispose() {
        offWorld();
        range.dispose();
        renderer.dispose();
        const sim = (globalThis as unknown as { sim?: Record<string, unknown> }).sim;
        if (sim && sim.gunnery === debug) delete sim.gunnery;
      },
    };
  },
};
export default mod;
