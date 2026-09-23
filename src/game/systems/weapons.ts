/**
 * The aircraft's gun (A-10 GAU-8/A, F-16 M61A1; the Cessna has none), on the pure gun core
 * (src/combat/gunnery.ts): sets Controls.gunFiring before the physics (recoil), flies the rounds,
 * applies hits to the combat world, emits the gun events, solves the CCIP and writes the GUN fields
 * of the weapons status (the missiles system writes the missile/lock fields). Draws the tracers and
 * the muzzle flash (one instanced additive draw call) and puffs the gun gas into the fx smoke.
 *
 * Debug: `?targets=test` places a few vehicles at the range (src/combat/testTargets.ts) and exposes
 * `window.__weaponsQa` for QA scripts.
 */
import * as THREE from 'three';
import { combatWorld } from '../../combat/world';
import { createGunnery, type GunPose } from '../../combat/gunnery';
import { createGlowRenderer } from '../../combat/render/glow';
import { writeTracers, writeMuzzleFlash } from '../../combat/render/tracers';
import { createGunGasState, emitGunGas } from '../../combat/render/gunGas';
import { testTargets, TEST_GROUP } from '../../combat/testTargets';
import { createRng } from '../../combat/rng';
import { fxHub } from '../../fx/hub';
import type { TargetKind } from '../../combat/types';
import type { SystemModule } from './types';

const urlFlag = (name: string): string | null => {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
};

const mod: SystemModule = {
  name: 'weapons',
  order: 70,
  create(ctx) {
    const world = combatWorld(ctx.scene);
    const gn = createGunnery(world, ctx.env);
    let time = 0;
    gn.setGun(ctx.actions.currentAircraft().config.weapons?.gun ?? null, 0);
    const glow = createGlowRenderer(ctx.scene, 640);
    const gas = createGunGasState();
    const flicker = createRng(0xf1a5);
    const pose: GunPose = { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    const vp = new THREE.Vector2();
    let tracersDrawn = 0;

    // ── ?targets=test ──
    const wantTest = urlFlag('targets') === 'test';
    const placeTestTargets = () => {
      if (!wantTest || world.targets.some((t) => t.group === TEST_GROUP)) return;
      for (const n of testTargets(world.range, ctx.env)) world.addTarget(n);
    };
    const home = new Map<number, { x: number; z: number }>();
    const moveTestTargets = (dt: number) => {
      for (const t of world.targets) {
        if (t.group !== TEST_GROUP || !t.alive || Math.hypot(t.velocity.x, t.velocity.z) < 1e-3) continue;
        let h = home.get(t.id);
        if (!h) home.set(t.id, (h = { x: t.position.x, z: t.position.z }));
        t.position.x += t.velocity.x * dt;
        t.position.z += t.velocity.z * dt;
        t.position.y = ctx.env.groundHeight(t.position.x, t.position.z);
        // Drive back and forth: turn around 200 m from the start, heading back.
        const ox = t.position.x - h.x, oz = t.position.z - h.z;
        if (Math.hypot(ox, oz) > 200 && ox * t.velocity.x + oz * t.velocity.z > 0) {
          t.velocity.x = -t.velocity.x;
          t.velocity.z = -t.velocity.z;
          t.headingDeg = (t.headingDeg + 180) % 360;
        }
      }
    };
    if (wantTest) {
      (globalThis as Record<string, unknown>).__weaponsQa = {
        world,
        gunnery: gn,
        /** Put a vehicle on the ground at x,z (default: the current CCIP point). */
        addAt(kind: TargetKind = 'tank', x?: number, z?: number, headingDeg = 0) {
          const c = world.status.ccip;
          const px = x ?? c?.x ?? 0;
          const pz = z ?? c?.z ?? 0;
          return world.addTarget({ kind, position: { x: px, y: ctx.env.groundHeight(px, pz), z: pz }, headingDeg, group: TEST_GROUP }).id;
        },
      };
    }

    return {
      adjustControls: (controls, state, dt) => gn.adjustControls(controls, state.phase === 'crashed', dt),

      update(f) {
        time = f.time;
        placeTestTargets();
        if (wantTest && !f.paused) moveTestTargets(f.dt);
        const r = f.aircraft.root;
        pose.position.x = r.position.x; pose.position.y = r.position.y; pose.position.z = r.position.z;
        pose.orientation.x = r.quaternion.x; pose.orientation.y = r.quaternion.y; pose.orientation.z = r.quaternion.z; pose.orientation.w = r.quaternion.w;
        gn.update(pose, f.state.velocity, f.dt, f.time, f.paused);

        // Tracers + muzzle flash.
        glow.begin();
        tracersDrawn = writeTracers(gn.pool, glow);
        const firing = world.status.gunFiring && gn.gun !== null;
        if (firing) writeMuzzleFlash(glow, gn.muzzle, gn.gunDir, f.paused ? 0.5 : flicker.next(), gn.gun!.caliberMm >= 30 ? 1 : 0.7);
        ctx.renderer.getDrawingBufferSize(vp);
        glow.end(vp.x, vp.y);

        // Gun gas into the shared fx smoke.
        const fx = fxHub(ctx.scene).effects;
        if (firing && fx && !f.paused) emitGunGas(fx.sim, gas, gn.muzzle, gn.gunDir, f.state.velocity, f.dt, gn.burstTime, gn.gun!.caliberMm);
      },

      onReset() {
        gn.reload(time);
        placeTestTargets();
      },

      onAircraftChange(def) {
        gn.setGun(def.config.weapons?.gun ?? null, time);
      },

      stats: () => ({ ...gn.stats(), drawn: tracersDrawn, glow: glow.count }),

      dispose() {
        glow.dispose();
        if (wantTest) delete (globalThis as Record<string, unknown>).__weaponsQa;
      },
    };
  },
};
export default mod;
