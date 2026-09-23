/**
 * The effects (owned by src/fx): draws the particles, plays touchdown smoke and camera shake, and
 * shares its effects with the crash director (src/game/systems/crash.ts) through fxHub — the director
 * plays the crash on them and sets the slow-motion time scale. Without a director (?no=crash) this
 * system plays a one-call crash burst itself.
 */
import * as THREE from 'three';
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../../config';
import { createEffects, cameraShakeFor, smokeLighting, fxHub } from '../../fx';
import type { SystemModule } from './types';

const mod: SystemModule = {
  name: 'fx',
  order: 80,
  create(ctx) {
    const env = ctx.env;
    const ground = (x: number, z: number) => {
      const g = env.groundHeight(x, z);
      const w = env.waterLevel(x, z);
      return w === null ? g : Math.max(g, w);
    };
    const fx = createEffects(ctx.scene, { groundHeight: ground });
    const hub = fxHub(ctx.scene);
    hub.effects = fx;
    const P = new THREE.Vector3();
    const V = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const W = new THREE.Vector3();
    const SUN = new THREE.Color();
    const AMB = new THREE.Color();
    // Stall buffet and overspeed vibration come from the aircraft being flown (not the Cessna's limits).
    let ac = ctx.actions?.currentAircraft?.().config.aircraft ?? CONFIG.aircraft;
    let crashT: number | null = null;
    let tdT = Number.NaN;
    let tdV = Number.NaN;
    return {
      cameraShake: (s) =>
        cameraShakeFor({
          onGround: s.onGround,
          groundSpeedKt: s.derived.groundSpeed * MS_TO_KT,
          surface: env.surfaceAt(s.position.x, s.position.z),
          aoaDeg: s.derived.alpha * RAD_TO_DEG,
          stallAoaDeg: ac.aero.stallAlphaDeg + (ac.aero.stallAlphaFlapsShiftDeg * s.flapsDeg) / 30,
          airspeedKt: s.derived.ias * MS_TO_KT,
          vneKt: ac.limits.vneKt,
          crashAge: s.crash ? s.time - s.crash.time : null,
        }),
      onAircraftChange(def) {
        ac = def.config.aircraft;
      },
      update(f) {
        if (f.def) ac = f.def.config.aircraft;
        const s = f.state;
        P.set(s.position.x, s.position.y, s.position.z);
        V.set(s.velocity.x, s.velocity.y, s.velocity.z);
        if (s.crash && s.crash.time !== crashT && !hub.director) {
          const wl = env.waterLevel(P.x, P.z);
          fx.crash(P, s.crash.speedKt, { velocity: V, water: wl !== null && P.y < wl + 2 });
        }
        const td = s.touchdown;
        if (td && (td.time !== tdT || td.verticalSpeedFpm !== tdV)) {
          fx.touchdown(P, td.verticalSpeedFpm, {
            orientation: Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w),
            velocity: V,
            surface: td.surface,
          });
        }
        crashT = s.crash ? s.crash.time : null;
        tdT = td ? td.time : Number.NaN;
        tdV = td ? td.verticalSpeedFpm : Number.NaN;
        const atmo = ctx.atmosphere;
        smokeLighting(atmo.sunLight.color, atmo.sunLight.intensity, atmo.state.skyIrradiance, atmo.state.groundRadiance, SUN, AMB);
        fx.setSun(atmo.sunDirection, SUN, AMB);
        const w = env.wind?.(P.x, P.y, P.z, s.time);
        const scale = Number.isFinite(hub.timeScale) ? Math.min(1, Math.max(0, hub.timeScale)) : 1;
        fx.update(f.camera, f.paused ? 0 : f.dt * scale, w ? W.set(w.x, w.y, w.z) : undefined);
      },
      onReset() {
        fx.reset();
        crashT = null;
      },
      stats: () => ({ ...fx.stats() }),
      dispose: () => {
        if (hub.effects === fx) hub.effects = null;
        fx.dispose();
      },
    };
  },
};
export default mod;
