/**
 * Functional self-test of the real synth graph: renders each sound in an OfflineAudioContext
 * (faster than real time, no speakers needed) and measures it — RMS level, the amplitude at
 * the expected frequency vs off-harmonic probes (engine firing rate, stall-horn reed), and the
 * cabin muffling (high-frequency content cockpit vs exterior). Run from preview/fx.html?audio=selftest.
 */
import { createAudio } from './audio';
import type { AudioInputs } from './types';
import { rms, goertzelAmplitude, dominantFrequency } from './analysis';
import { firingFrequency } from './mapping';
import { CONFIG } from '../config';

export interface SelfTestResult {
  name: string;
  rms: number;
  ok: boolean;
  /** Human-readable measurement, e.g. "firing 90.0 Hz ×6.2 over off-harmonic". */
  detail: string;
}

type OfflineFactory = (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

const BASE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};

interface Scenario {
  name: string;
  base: Partial<AudioInputs>;
  /** Inputs applied at `at` seconds (one frame), then `after` from the next frame on. */
  event?: { at: number; inputs: Partial<AudioInputs>; after?: Partial<AudioInputs> };
  muted?: boolean;
  check: (s: Float32Array, sr: number) => { ok: boolean; detail: string };
}

const audible = (min = 2e-3) => (s: Float32Array) => {
  const r = rms(s);
  return { ok: r > min, detail: `rms ${r.toFixed(4)}` };
};
const silent = (s: Float32Array) => {
  const r = rms(s);
  return { ok: r < 2e-4, detail: `rms ${r.toExponential(1)}` };
};
/** Strong component at the firing frequency relative to off-harmonic probes. */
const tonalAt = (hz: number) => (s: Float32Array, sr: number) => {
  const at = goertzelAmplitude(s, sr, hz);
  const probes = [0.61, 0.79, 1.37, 1.63].map((k) => goertzelAmplitude(s, sr, hz * k));
  const off = probes.reduce((a, b) => a + b, 0) / probes.length;
  const ratio = at / Math.max(1e-9, off);
  return { ok: ratio > 3 && rms(s) > 2e-3, detail: `firing ${hz.toFixed(1)} Hz ×${ratio.toFixed(1)} over off-harmonic, rms ${rms(s).toFixed(4)}` };
};

export const SCENARIOS: Scenario[] = [
  { name: 'silence (engine off, at rest)', base: {}, check: silent },
  { name: 'engine idle 700 rpm', base: { rpm: 700, power: 0.045, engineRunning: true }, check: tonalAt(firingFrequency(700)) },
  { name: 'engine full power 2700 rpm', base: { rpm: 2700, power: 1, engineRunning: true }, check: tonalAt(firingFrequency(2700)) },
  { name: 'engine cruise, cockpit', base: { rpm: 2400, power: 0.7, engineRunning: true, cameraMode: 'cockpit', airspeedKt: 110, onGround: false }, check: tonalAt(firingFrequency(2400)) },
  { name: 'starter cranking', base: { rpm: CONFIG.aircraft.engine.crankRpm, starting: true }, check: audible() },
  { name: 'wind 120 kt (engine off)', base: { airspeedKt: 120, onGround: false }, check: audible() },
  { name: 'rolling 40 kt on grass', base: { onGround: true, groundSpeedKt: 40, surface: 'grass' }, check: audible(1e-3) },
  {
    name: 'stall horn (cockpit)', base: { stallWarning: true, airspeedKt: 45, onGround: false, cameraMode: 'cockpit' },
    check: (s, sr) => {
      const f = dominantFrequency(s, sr, 1000, 4000, 10);
      return { ok: f >= 1600 && f <= 2000 && rms(s) > 2e-3, detail: `peak ${f} Hz, rms ${rms(s).toFixed(4)}` };
    },
  },
  {
    name: 'gear warning horn (cockpit)', base: { gearWarning: true, airspeedKt: 70, onGround: false, cameraMode: 'cockpit' },
    check: (s, sr) => {
      const f = dominantFrequency(s, sr, 300, 3000, 5);
      // Intermittent: 40 ms windows swing between loud (beep) and near-silent (gap).
      const win = Math.round(0.04 * sr);
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i + win <= s.length; i += win) {
        const r = rms(s.subarray(i, i + win));
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      const want = CONFIG.audio.gearHornHz;
      const ok = Math.abs(f - want) < want * 0.06 && hi > 5e-3 && hi > lo * 6;
      return { ok, detail: `peak ${f} Hz (want ${want}), beep/gap rms ${hi.toFixed(4)}/${lo.toFixed(4)}` };
    },
  },
  { name: 'gear motor (cockpit)', base: { gearMoving: true, cameraMode: 'cockpit' }, check: audible(1e-3) },
  { name: 'flap motor (cockpit)', base: { flapsMoving: true, cameraMode: 'cockpit' }, check: audible(1e-3) },
  { name: 'touchdown 600 fpm', base: { onGround: true, groundSpeedKt: 55 }, event: { at: 0.1, inputs: { onGround: true, groundSpeedKt: 55, touchdownFpm: -600 } }, check: audible(4e-3) },
  { name: 'gear clunk', base: { gearMoving: true }, event: { at: 0.2, inputs: { gearMoving: false } }, check: audible(2e-3) },
  { name: 'crash (boom + debris)', base: { rpm: 2500, power: 0.9, engineRunning: true, onGround: false, airspeedKt: 90 }, event: { at: 0.1, inputs: { crashed: true, crashSpeedKt: 90 } }, check: audible(0.02) },
  { name: 'muted at full power', base: { rpm: 2700, power: 1, engineRunning: true }, muted: true, check: silent },
];

function defaultFactory(): OfflineFactory | null {
  const g = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const C = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  return C ? (ch, len, sr) => new C(ch, len, sr) : null;
}

/** Render every scenario for `seconds` and measure it. Skips the first 0.3 s (ramp-in) for continuous sounds. */
export async function runAudioSelfTest(opts: { seconds?: number; sampleRate?: number; factory?: OfflineFactory } = {}): Promise<SelfTestResult[]> {
  const seconds = opts.seconds ?? 2;
  const sr = opts.sampleRate ?? 44100;
  const factory = opts.factory ?? defaultFactory();
  if (!factory) return [{ name: 'OfflineAudioContext', rms: 0, ok: false, detail: 'unavailable' }];
  const out: SelfTestResult[] = [];
  for (const sc of SCENARIOS) {
    try {
      const ctx = factory(1, Math.round(sr * seconds), sr);
      const audio = createAudio({ context: ctx });
      if (sc.muted) audio.setMuted(true);
      const base: AudioInputs = { ...BASE, ...sc.base };
      audio.update(base, 0);
      if (sc.event) {
        const ev = sc.event;
        void ctx.suspend(ev.at).then(() => {
          audio.update({ ...base, ...ev.inputs }, 1 / 60);
          audio.update({ ...base, ...ev.inputs, ...(ev.after ?? {}), touchdownFpm: null }, 1 / 60);
          return ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      const all = buf.getChannelData(0);
      const skip = sc.event ? 0 : Math.round(0.3 * sr);
      const s = all.subarray(Math.min(skip, all.length));
      const r = sc.check(s, sr);
      out.push({ name: sc.name, rms: rms(s), ok: r.ok && audio.levels().errors === 0, detail: r.detail });
      audio.dispose();
    } catch (e) {
      out.push({ name: sc.name, rms: 0, ok: false, detail: `threw: ${(e as Error).message}` });
    }
  }
  return out;
}
