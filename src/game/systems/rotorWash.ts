/**
 * Rotor downwash (helicopters only: any aircraft whose config has a `rotorcraft` section). When the
 * wake reaches the ground or water below — within ~2.3 rotor diameters — the wash throws up what the
 * surface is made of (dust, grass bits, snow powder, spray; a faint haze on pavement) in a ring that
 * spreads out along the surface, and roughens water into a darker, rippling ring.
 *
 * The where / how strong / what lives in src/fx/rotorWash.ts (pure). The particles go into the
 * effects' shared smoke pool (src/game/systems/fx.ts owns and draws it), so they cost no extra draw
 * call and sort, light and fog with every other particle; the water ring is one extra draw call,
 * only while it is visible. Nothing happens for fixed-wing aircraft, or with ?no=fx.
 */
import * as THREE from 'three';
import { fxHub, smokeLighting } from '../../fx';
import { RotorWashEmitter, newRotorWash, rotorWashAt, washQuality, type WashInput } from '../../fx/rotorWash';
import { createWashRing } from '../../fx/washRing';
import { qualityFromQuery } from '../../render/quality';
import type { RotorcraftConfig } from '../../config';
import type { SystemModule } from './types';

/** Water ring fade in/out time constant, s. */
const RING_TAU = 0.4;
const FOAM_ALBEDO = 0.8;

function qualityLevel(): string {
  try {
    return qualityFromQuery(typeof location !== 'undefined' ? location.search : '');
  } catch {
    return 'auto';
  }
}

const mod: SystemModule = {
  name: 'rotorWash',
  // After fx (80): it emits into the effects that fx creates.
  order: 81,
  create(ctx) {
    const env = ctx.env;
    const hub = fxHub(ctx.scene);
    const emitter = new RotorWashEmitter();
    const wash = newRotorWash();
    const quality = washQuality(qualityLevel());
    const group = new THREE.Group();
    group.name = 'rotor-wash';
    ctx.scene.add(group);
    const ring = createWashRing(group);
    const SUN = new THREE.Color();
    const AMB = new THREE.Color();
    const FOAM = new THREE.Color();
    const WIND = { x: 0, y: 0, z: 0 };
    let rc: RotorcraftConfig | null = ctx.actions?.currentAircraft?.().config.aircraft.rotorcraft ?? null;
    const input: WashInput = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, rotor: null, rotorcraft: null, wind: WIND, crashed: false };
    let ringS = 0;
    let ringX = 0, ringY = 0, ringZ = 0, ringR = 0;
    let clock = 0;

    const clear = () => {
      emitter.reset();
      ring.hide();
      ringS = 0;
      wash.strength = 0;
      wash.kind = 'none';
      wash.surface = null;
      wash.water = false;
    };

    return {
      update(f) {
        if (f.def) rc = f.def.config.aircraft.rotorcraft ?? null;
        if (!rc) {
          // Fixed-wing: nothing to do (and nothing left over from a helicopter).
          if (ringS > 0 || wash.strength > 0) clear();
          return;
        }
        const s = f.state;
        const dt = f.paused ? 0 : Number.isFinite(f.dt) ? Math.max(0, Math.min(0.1, f.dt)) : 0;
        input.position = s.position;
        input.velocity = s.velocity;
        input.orientation = s.orientation;
        input.rotor = s.rotor;
        input.rotorcraft = rc;
        input.crashed = !!s.crash;
        const w = env.wind?.(s.position.x, s.position.y, s.position.z, s.time);
        WIND.x = w ? w.x : 0;
        WIND.y = w ? w.y : 0;
        WIND.z = w ? w.z : 0;
        rotorWashAt(input, env, wash);

        const fx = hub.effects;
        const scale = Number.isFinite(hub.timeScale) ? Math.min(1, Math.max(0, hub.timeScale)) : 1;
        if (fx) emitter.update(fx.sim.smoke, wash, dt * scale, quality);

        // Water ring: eases in and out, stays where the wash last touched the water while it fades.
        const target = wash.water ? wash.strength : 0;
        if (wash.water) {
          ringX = wash.x; ringY = wash.y; ringZ = wash.z; ringR = wash.radius;
        }
        if (dt > 0) {
          ringS += (target - ringS) * (1 - Math.exp(-dt / RING_TAU));
          clock = (clock + dt) % 3600;
        }
        if (ringS < 0.01 && target === 0) {
          ringS = 0;
          ring.hide();
          return;
        }
        const atmo = ctx.atmosphere;
        if (atmo) {
          smokeLighting(atmo.sunLight.color, atmo.sunLight.intensity, atmo.state.skyIrradiance, atmo.state.groundRadiance, SUN, AMB);
          const k = Math.max(0, atmo.sunDirection.y);
          FOAM.setRGB((AMB.r + SUN.r * k) * FOAM_ALBEDO, (AMB.g + SUN.g * k) * FOAM_ALBEDO, (AMB.b + SUN.b * k) * FOAM_ALBEDO);
        }
        ring.update(ringX, ringY, ringZ, ringR, ringS, clock, atmo ? FOAM : undefined);
      },
      onReset() {
        clear();
      },
      onAircraftChange(def) {
        rc = def.config.aircraft.rotorcraft ?? null;
        clear();
      },
      stats: () => ({
        strength: Math.round(wash.strength * 1000) / 1000,
        kind: wash.kind,
        surface: wash.surface,
        heightRatio: Number.isFinite(wash.heightRatio) ? Math.round(wash.heightRatio * 100) / 100 : null,
        offset: Math.round(wash.offset * 10) / 10,
        emitted: emitter.emitted,
        ring: Math.round(ringS * 1000) / 1000,
        quality,
      }),
      dispose() {
        ring.dispose();
        group.removeFromParent();
      },
    };
  },
};
export default mod;
