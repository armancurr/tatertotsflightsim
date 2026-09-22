/** Crash fire/smoke/debris and touchdown smoke; camera shake (owned by src/fx). */
import * as THREE from 'three';
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../../config';
import { createEffects, cameraShakeFor, smokeLighting } from '../../fx';
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
    const P = new THREE.Vector3();
    const V = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const W = new THREE.Vector3();
    const SUN = new THREE.Color();
    const AMB = new THREE.Color();
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
          stallAoaDeg: CONFIG.aircraft.aero.stallAlphaDeg + (CONFIG.aircraft.aero.stallAlphaFlapsShiftDeg * s.flapsDeg) / 30,
          airspeedKt: s.derived.ias * MS_TO_KT,
          vneKt: CONFIG.aircraft.limits.vneKt,
          crashAge: s.crash ? s.time - s.crash.time : null,
        }),
      update(f) {
        const s = f.state;
        P.set(s.position.x, s.position.y, s.position.z);
        V.set(s.velocity.x, s.velocity.y, s.velocity.z);
        if (s.crash && s.crash.time !== crashT) {
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
        fx.update(f.camera, f.paused ? 0 : f.dt, w ? W.set(w.x, w.y, w.z) : undefined);
      },
      onReset() {
        fx.reset();
        crashT = null;
      },
      stats: () => ({ ...fx.stats() }),
      dispose: () => fx.dispose(),
    };
  },
};
export default mod;
