/**
 * Synthesised sound (owned by src/audio): the flown aircraft's engine voice (Cessna O-360 + prop or
 * F-16 F110 turbofan, swapped on onAircraftChange / the frame's def), wind, horns, tyres, motors,
 * hydraulics and the crash. Listens for the crash effects' window events:
 *   `sim:explosion` {detail: {position, size}}  and  `sim:impact` {detail: {position, speed}}.
 * QA hooks on window: `runAudioSelfTest()` and `simAudio` {levels, meter, override, resume, selfTest}.
 */
import { createAudio, createAudioInputTracker, runAudioSelfTest, type AudioInputs } from '../../audio';
import { A10_WEAPONS } from '../../config';
import { combatWorld } from '../../combat/world';
import { secondaryPlan, isAirBurst } from '../../combat/fx/plan';
import { motorLevel, missilePosition } from '../../audio/combatMapping';
import type { CombatAudioFrame } from '../../audio/combat';
import type { HudReadings } from '../../ui/instruments';
import type { EngineSound } from '../../fleet/types';
import type { Vec3 } from '../../types';
import type { SystemModule } from './types';

type Win = {
  addEventListener?: (type: string, fn: (e: Event) => void) => void;
  removeEventListener?: (type: string, fn: (e: Event) => void) => void;
  runAudioSelfTest?: unknown;
  simAudio?: unknown;
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const vec = (v: unknown): Vec3 | null => {
  const o = v as Partial<Vec3> | null | undefined;
  if (!o || typeof o !== 'object') return null;
  const x = num(o.x);
  const y = num(o.y);
  const z = num(o.z);
  return x === undefined || y === undefined || z === undefined ? null : { x, y, z };
};

const mod: SystemModule = {
  name: 'audio',
  order: 90,
  create(ctx) {
    const w = globalThis as unknown as Win;
    const soundOf = (s: unknown): EngineSound => (s === 'jet' || s === 'turbofan' ? s : 'piston');
    const audio = createAudio({ engine: soundOf(ctx.actions?.currentAircraft?.().sound) });
    const track = createAudioInputTracker();
    // Reused per-frame tracker source (no allocation in update).
    const src = {} as Parameters<typeof track>[0];
    const cam = { x: 0, y: 0, z: 0, set: false };
    let override: Partial<AudioInputs> | null = null;

    const distanceTo = (p: Vec3 | null): number | undefined => {
      if (!p || !cam.set) return undefined;
      return Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
    };
    const onExplosion = (e: Event) => {
      const d = (e as CustomEvent).detail as { position?: unknown; size?: unknown } | null | undefined;
      audio.explosion({ size: num(d?.size), distanceM: distanceTo(vec(d?.position)) });
    };
    const onImpact = (e: Event) => {
      const d = (e as CustomEvent).detail as { position?: unknown; speed?: unknown } | null | undefined;
      if (!d) return;
      audio.impact({ speed: num(d.speed), distanceM: distanceTo(vec(d.position)) });
    };
    const unlock = () => void audio.resume();
    w.addEventListener?.('keydown', unlock);
    w.addEventListener?.('pointerdown', unlock);
    w.addEventListener?.('sim:explosion', onExplosion);
    w.addEventListener?.('sim:impact', onImpact);

    // ── Combat: events → sounds at their distance from the camera (the audio engine adds d / c) ──
    const world = ctx.scene ? combatWorld(ctx.scene) : null;
    const dist = (p: Vec3 | null | undefined): number => {
      if (!p || !cam.set) return 0;
      const d = Math.hypot(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      return Number.isFinite(d) ? d : 0;
    };
    /** Missiles in flight (for the receding motor): launch point, velocity, age. Fixed pool. */
    const motors = Array.from({ length: 6 }, () => ({ live: false, age: 0, p: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } }));
    const mp = { x: 0, y: 0, z: 0 };
    const cruise = () => (A10_WEAPONS.missiles as { speed?: number } | null)?.speed ?? 300;
    const ground = (x: number, z: number) => {
      const g = ctx.env?.groundHeight?.(x, z);
      return typeof g === 'number' && Number.isFinite(g) ? g : -1e9;
    };
    const unsubscribe = world?.on((e) => {
      switch (e.type) {
        case 'impact':
          if (e.weapon === 'gun') audio.combat.impact({ distanceM: dist(e.point), surface: e.surface, ricochet: e.ricochet });
          break;
        case 'detonation':
          if (e.weapon !== 'missile') break;
          audio.combat.detonation({ distanceM: dist(e.position), size: 1, air: isAirBurst(e.position.y, ground(e.position.x, e.position.z)) });
          // The oldest motor in flight burns out with it.
          {
            let oldest = -1;
            for (let i = 0; i < motors.length; i++) if (motors[i].live && (oldest < 0 || motors[i].age > motors[oldest].age)) oldest = i;
            if (oldest >= 0) motors[oldest].live = false;
          }
          break;
        case 'destroyed': {
          const plan = secondaryPlan(e.targetId, e.kind, e.time);
          const size = e.kind === 'tank' ? 1.1 : e.kind === 'truck' ? 0.7 : 0.9;
          audio.combat.cookoff({ distanceM: dist(e.position), size, secondaryDelayS: plan.delayS, secondarySize: plan.size });
          break;
        }
        case 'missileLaunch': {
          audio.combat.launch({ distanceM: dist(e.position) });
          let slot = motors.find((m) => !m.live);
          if (!slot) slot = motors.reduce((a, b) => (a.age > b.age ? a : b));
          slot.live = true;
          slot.age = 0;
          slot.p.x = e.position.x; slot.p.y = e.position.y; slot.p.z = e.position.z;
          slot.v.x = e.velocity.x; slot.v.y = e.velocity.y; slot.v.z = e.velocity.z;
          break;
        }
        default:
          break;
      }
    });
    const cf: CombatAudioFrame = { gunRateRps: 0, gunCaliberMm: 30, gunSpin: 0, gunFiring: false, gunDistanceM: 0, cockpit: false, motor: 0, motorDistanceM: 0 };

    w.runAudioSelfTest = runAudioSelfTest;
    w.simAudio = {
      levels: () => audio.levels(),
      meter: () => audio.meter(),
      /** Force some inputs on top of the live state (QA: jet idle/MIL/AB in the live page); null clears. */
      override: (p: Partial<AudioInputs> | null) => {
        override = p && typeof p === 'object' ? { ...p } : null;
      },
      resume: () => audio.resume(),
      /** The real-time context: 'running' | 'suspended' | 'closed' | 'none', and its clock (s). */
      context: () => ({ state: (audio.context as AudioContext | null)?.state ?? 'none', time: audio.context?.currentTime ?? 0 }),
      selfTest: runAudioSelfTest,
      get engine() {
        return audio.engine;
      },
    };

    return {
      update(f) {
        if (f.def) audio.setEngine(soundOf(f.def.sound));
        const p = f.state.position;
        const c = f.camera.position;
        cam.x = c.x;
        cam.y = c.y;
        cam.z = c.z;
        cam.set = true;
        src.state = f.state;
        src.controls = f.controls;
        src.cameraMode = f.cameraMode;
        src.paused = f.paused;
        src.dt = f.dt;
        src.surface = ctx.env.surfaceAt(p.x, p.z);
        src.cameraPosition = c;
        src.stallWarning = f.readings?.stallWarning;
        src.gearWarning = (f.readings as HudReadings | null)?.gearHorn;
        const inputs = track(src);
        audio.update(override ? { ...inputs, ...override } : inputs, f.dt);
        // Combat: the flown aircraft's gun (the demo can run one on any aircraft), the nearest motor.
        if (world) {
          const st = world.status;
          const gun = f.def?.config?.weapons?.gun ?? (st.hasGun ? A10_WEAPONS.gun : null);
          cf.gunRateRps = gun ? gun.rateRps : 0;
          cf.gunCaliberMm = gun ? gun.caliberMm : 30;
          cf.gunSpin = st.gunSpin;
          cf.gunFiring = st.gunFiring && !f.paused;
          cf.gunDistanceM = inputs.listenerDistanceM ?? 0;
          cf.cockpit = f.cameraMode === 'cockpit';
          let best = 0;
          let bestD = 0;
          const dt = f.paused ? 0 : Math.max(0, f.dt);
          for (const m of motors) {
            if (!m.live) continue;
            m.age += dt;
            const lvl = motorLevel(m.age);
            if (lvl <= 0) {
              m.live = false;
              continue;
            }
            missilePosition(m.p, m.v, m.age, cruise(), mp);
            const d = dist(mp);
            const heard = lvl / (1 + d / 200);
            if (heard > best) {
              best = heard;
              bestD = d;
              cf.motor = lvl;
            }
          }
          if (best === 0) cf.motor = 0;
          cf.motorDistanceM = bestD;
          audio.combat.update(cf);
        }
      },
      onAction(a) {
        if (a === 'mute') audio.setMuted(!audio.muted);
      },
      onReset() {
        audio.reset();
        for (const m of motors) m.live = false;
      },
      onAircraftChange(def) {
        audio.setEngine(soundOf(def.sound));
      },
      stats() {
        return audio.levels() as unknown as Record<string, unknown>;
      },
      dispose() {
        unsubscribe?.();
        audio.dispose();
        w.removeEventListener?.('keydown', unlock);
        w.removeEventListener?.('pointerdown', unlock);
        w.removeEventListener?.('sim:explosion', onExplosion);
        w.removeEventListener?.('sim:impact', onImpact);
        if (w.runAudioSelfTest === runAudioSelfTest) delete w.runAudioSelfTest;
        delete w.simAudio;
      },
    };
  },
};
export default mod;
