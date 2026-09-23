/**
 * Synthesised sound (owned by src/audio): the flown aircraft's engine voice (Cessna O-360 + prop or
 * F-16 F110 turbofan, swapped on onAircraftChange / the frame's def), wind, horns, tyres, motors,
 * hydraulics and the crash. Listens for the crash effects' window events:
 *   `sim:explosion` {detail: {position, size}}  and  `sim:impact` {detail: {position, speed}}.
 * QA hooks on window: `runAudioSelfTest()` and `simAudio` {levels, meter, override, resume, selfTest}.
 */
import { createAudio, createAudioInputTracker, runAudioSelfTest, type AudioInputs } from '../../audio';
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
    const soundOf = (s: unknown): EngineSound => (s === 'jet' ? 'jet' : 'piston');
    const audio = createAudio({ engine: soundOf(ctx.actions?.currentAircraft?.().sound) });
    const track = createAudioInputTracker();
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

    w.runAudioSelfTest = runAudioSelfTest;
    w.simAudio = {
      levels: () => audio.levels(),
      meter: () => audio.meter(),
      /** Force some inputs on top of the live state (QA: jet idle/MIL/AB in the live page); null clears. */
      override: (p: Partial<AudioInputs> | null) => {
        override = p && typeof p === 'object' ? { ...p } : null;
      },
      resume: () => audio.resume(),
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
        const inputs = track({
          state: f.state, controls: f.controls, cameraMode: f.cameraMode, paused: f.paused, dt: f.dt,
          surface: ctx.env.surfaceAt(p.x, p.z), cameraPosition: c,
          stallWarning: f.readings?.stallWarning,
          gearWarning: (f.readings as HudReadings | null)?.gearHorn,
        });
        audio.update(override ? { ...inputs, ...override } : inputs, f.dt);
      },
      onAction(a) {
        if (a === 'mute') audio.setMuted(!audio.muted);
      },
      onReset() {
        audio.reset();
      },
      onAircraftChange(def) {
        audio.setEngine(soundOf(def.sound));
      },
      stats() {
        return audio.levels() as unknown as Record<string, unknown>;
      },
      dispose() {
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
