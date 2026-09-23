/**
 * Combat effects (owned by src/combat/fx): listens to the combat world's events — 30 mm impacts,
 * gun hits, Maverick detonations, vehicles destroyed — and plays them into the scene's shared fx
 * pools (the fx system at order 80 draws them) plus glowing spark/ricochet streaks; shakes the camera
 * while the gun fires (the airframe vibrates, hard in the cockpit) and when a blast wave arrives.
 *
 * QA hook (until/besides the weapons and targets systems): `window.sim.combatFx`
 *   .demo('gun' | 'maverick' | 'kill' | 'all', { x?, z?, distance?, surface?, kind? })
 * emits a scripted GAU-8 burst / Maverick kill into the combat world (so the sound plays too) at a
 * point `distance` m ahead of the aircraft (or x, z); .stats(); .stop().
 */
import * as THREE from 'three';
import { A10_WEAPONS } from '../../config';
import { combatWorld } from '../../combat/world';
import { createCombatFx } from '../../combat/fx';
import { gunRunScript, maverickScript, type DemoScript } from '../../combat/fx/demo';
import { fxHub } from '../../fx/hub';
import { qRotate } from '../../math/quat';
import type { SurfaceType } from '../../types';
import type { TargetKind } from '../../combat/types';
import type { SystemModule } from './types';

type DemoKind = 'gun' | 'maverick' | 'kill' | 'all';
interface DemoOpts {
  x?: number;
  z?: number;
  /** Aim point this far ahead of the aircraft along its heading, m (default 600). */
  distance?: number;
  /** Force the impact surface (e.g. 'water', 'asphalt'). */
  surface?: SurfaceType;
  kind?: TargetKind;
  burstS?: number;
  /** Virtual shooter: bearing from the aim point to the shooter (deg), slant range (m), dive angle (deg). */
  fromDeg?: number;
  slantM?: number;
  diveDeg?: number;
}

const FWD = { x: 0, y: 0, z: -1 };

const mod: SystemModule = {
  name: 'combatfx',
  order: 85,
  create(ctx) {
    const env = ctx.env;
    const world = combatWorld(ctx.scene);
    const hub = fxHub(ctx.scene);
    const cfx = createCombatFx(ctx.scene);
    const ground = {
      groundHeight: (x: number, z: number) => {
        const g = env.groundHeight(x, z);
        const w = env.waterLevel(x, z);
        return w === null ? g : Math.max(g, w);
      },
    };
    const unsubscribe = world.on((e) => cfx.onEvent(e));
    const viewport = new THREE.Vector2(1440, 900);
    let cockpit = false;
    // The aircraft on the last frame (for the demos), reused.
    const lastState = { x: 0, y: 0, z: 0, q: { x: 0, y: 0, z: 0, w: 1 }, v: { x: 0, y: 0, z: 0 }, set: false };

    // ── Scripted demos (QA) ──
    let demo: { script: DemoScript; t: number; next: number } | null = null;
    const demoQueue: { script: DemoScript; delay: number }[] = [];
    const runDemo = (kind: DemoKind = 'gun', o: DemoOpts = {}) => {
      const s = lastState;
      if (!s.set) return { ok: false, reason: 'no frame yet' };
      const f = qRotate(s.q, FWD);
      const fl = Math.hypot(f.x, f.z) || 1;
      const dist = Number.isFinite(o.distance) ? (o.distance as number) : 600;
      const tx = Number.isFinite(o.x) ? (o.x as number) : s.x + (f.x / fl) * dist;
      const tz = Number.isFinite(o.z) ? (o.z as number) : s.z + (f.z / fl) * dist;
      const target = { x: tx, y: ground.groundHeight(tx, tz), z: tz };
      // The shooter: the aircraft when it flies; parked (or asked to), a virtual A-10 diving in from
      // `fromDeg` (default: from the left of the view) at `slantM` / `diveDeg` — a real gun-run geometry.
      const agl = s.y - ground.groundHeight(s.x, s.z);
      const virtual = Number.isFinite(o.fromDeg) || agl < 10;
      const headingDeg = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
      const b = ((Number.isFinite(o.fromDeg) ? (o.fromDeg as number) : headingDeg - 90) * Math.PI) / 180;
      const slant = Number.isFinite(o.slantM) ? (o.slantM as number) : 1200;
      const dive = ((Number.isFinite(o.diveDeg) ? (o.diveDeg as number) : 20) * Math.PI) / 180;
      const shooter = virtual
        ? { x: tx + Math.sin(b) * Math.cos(dive) * slant, y: target.y + Math.sin(dive) * slant, z: tz - Math.cos(b) * Math.cos(dive) * slant }
        : { x: s.x, y: s.y, z: s.z };
      const surfaceAt = (x: number, z: number): SurfaceType => o.surface ?? env.surfaceAt(x, z);
      const denv = { groundHeight: ground.groundHeight, surfaceAt };
      const kindOf = o.kind ?? 'tank';
      const scripts: { script: DemoScript; delay: number }[] = [];
      if (kind === 'gun' || kind === 'all') scripts.push({ script: gunRunScript({ ...denv, shooter, target, burstS: o.burstS, targetRadiusM: o.surface ? 0 : 3.5 }), delay: 0 });
      if (kind === 'maverick' || kind === 'all') {
        const side = kind === 'all' ? 70 : 0;
        const mt = { x: tx - (f.z / fl) * side, y: 0, z: tz + (f.x / fl) * side };
        mt.y = ground.groundHeight(mt.x, mt.z);
        scripts.push({ script: maverickScript({ ...denv, shooter, velocity: { ...s.v }, target: mt, kind: kindOf }), delay: kind === 'all' ? 3.5 : 0 });
      }
      if (kind === 'kill') {
        scripts.push({
          script: { events: [{ at: 0, event: { type: 'destroyed', time: 0, weapon: 'gun', targetId: 997, kind: kindOf, position: target } }], firing: null, spinUpS: 0, spinDownS: 0, duration: 3 },
          delay: 0,
        });
      }
      demoQueue.length = 0;
      demoQueue.push(...scripts);
      demo = null;
      return { ok: true, target, kind };
    };
    const stopDemo = () => {
      demo = null;
      demoQueue.length = 0;
    };
    const stepDemo = (dt: number) => {
      if (!demo && demoQueue.length) {
        const q = demoQueue[0];
        q.delay -= dt;
        if (q.delay > 0) return;
        demoQueue.shift();
        demo = { script: q.script, t: 0, next: 0 };
      }
      if (!demo) return;
      demo.t += dt;
      const d = demo;
      const evs = d.script.events;
      while (d.next < evs.length && evs[d.next].at <= d.t) world.emit(evs[d.next++].event);
      // The gun's status for the sound and the shake (the weapons system writes it when present).
      const fire = d.script.firing;
      if (fire) {
        const st = world.status;
        const [from, to] = fire;
        st.hasGun = true;
        if (!st.gunName) st.gunName = A10_WEAPONS.gun?.name ?? 'GAU-8/A Avenger';
        st.gunFiring = d.t >= from && d.t < to;
        st.gunSpin = d.t < to ? Math.min(1, Math.max(0, (d.t - from) / Math.max(0.05, d.script.spinUpS))) : Math.max(0, 1 - (d.t - to) / Math.max(0.05, d.script.spinDownS));
      }
      if (d.t > d.script.duration && d.next >= evs.length) demo = null;
    };
    const api = {
      demo: runDemo,
      stop: stopDemo,
      stats: () => cfx.stats(),
    };
    const w = globalThis as unknown as { sim?: Record<string, unknown>; simCombatFx?: unknown };
    w.simCombatFx = api;
    const attach = () => {
      const sim = w.sim;
      if (sim && typeof sim === 'object' && !('combatFx' in sim)) {
        Object.defineProperty(sim, 'combatFx', { value: api, enumerable: true, configurable: true });
      }
    };

    return {
      cameraShake: () => cfx.shake(cockpit, world.status.gunSpin, world.status.gunFiring),
      update(f) {
        attach();
        cockpit = f.cameraMode === 'cockpit';
        const s = f.state;
        lastState.x = s.position.x;
        lastState.y = s.position.y;
        lastState.z = s.position.z;
        lastState.q.x = s.orientation.x;
        lastState.q.y = s.orientation.y;
        lastState.q.z = s.orientation.z;
        lastState.q.w = s.orientation.w;
        lastState.v.x = s.velocity.x;
        lastState.v.y = s.velocity.y;
        lastState.v.z = s.velocity.z;
        lastState.set = true;
        const scale = Number.isFinite(hub.timeScale) ? Math.min(1, Math.max(0, hub.timeScale)) : 1;
        const dt = f.paused ? 0 : Math.max(0, f.dt) * scale;
        if (dt > 0) stepDemo(dt);
        ctx.renderer.getDrawingBufferSize(viewport);
        cfx.update(f.camera, dt, hub.effects?.sim ?? null, ground, s.position, viewport);
      },
      onReset() {
        cfx.reset();
        stopDemo();
      },
      stats: () => ({ ...cfx.stats() }),
      dispose() {
        unsubscribe();
        cfx.dispose();
        if (w.simCombatFx === api) delete w.simCombatFx;
        const sim = w.sim;
        if (sim && (sim as Record<string, unknown>).combatFx === api) delete (sim as Record<string, unknown>).combatFx;
      },
    };
  },
};
export default mod;
