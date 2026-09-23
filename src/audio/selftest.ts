/**
 * Functional self-test of the real synth graph: renders each sound in an OfflineAudioContext
 * (faster than real time, no speakers needed) through the full output chain (glue compressor →
 * limiter → soft clipper) and measures it — RMS level (dBFS), peak, the pitch of tonal parts
 * (piston firing rate, jet turbine whine, horns), the crash's secondary explosions and the silence
 * after a reset — then checks the mix: relative levels and that nothing clips.
 *
 * In the live page: `await runAudioSelfTest()` (window hook installed by the audio system), or
 * `node scripts/audio-check.mjs` (Chrome for Testing).
 */
import { createAudio } from './audio';
import type { AudioInputs, AudioLevels } from './types';
import type { EngineSound } from '../fleet/types';
import { rms, goertzelAmplitude, dominantFrequency } from './analysis';
import { firingFrequency } from './mapping';
import { jetWhineHz } from './jetMapping';
import { CONFIG } from '../config';

export interface SelfTestResult {
  name: string;
  /** RMS over the analysed window (linear). */
  rms: number;
  /** RMS in dBFS (−∞ → −120). */
  db: number;
  /** Absolute peak over the whole render. */
  peak: number;
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

interface TimedInputs {
  at: number;
  inputs: Partial<AudioInputs>;
  /** From the next frame on (defaults to `inputs`, without the touchdown). */
  after?: Partial<AudioInputs>;
}

interface Scenario {
  name: string;
  engine?: EngineSound;
  seconds?: number;
  base: Partial<AudioInputs>;
  events?: TimedInputs[];
  /** Update the synth every `tick` s (needed for timelines such as the crash's secondary explosions). */
  tick?: number;
  /** Analysed window [from, to] s (default: from 0.3 s for steady sounds, 0 with events). */
  window?: [number, number];
  muted?: boolean;
  check: (s: Float32Array, sr: number, all: Float32Array, levels: AudioLevels) => { ok: boolean; detail: string };
}

const db = (v: number) => (v > 1e-6 ? 20 * Math.log10(v) : -120);
const fmtDb = (v: number) => `${db(v).toFixed(1)} dBFS`;

const audible = (min = 2e-3) => (s: Float32Array) => {
  const r = rms(s);
  return { ok: r > min, detail: `rms ${r.toFixed(4)} (${fmtDb(r)})` };
};
const silent = (s: Float32Array) => {
  const r = rms(s);
  return { ok: r < 2e-4, detail: `rms ${r.toExponential(1)}` };
};
/** Strong component at `hz` relative to off-harmonic probes. */
const tonalAt = (hz: number, label = 'firing') => (s: Float32Array, sr: number) => {
  const at = goertzelAmplitude(s, sr, hz);
  const probes = [0.61, 0.79, 1.37, 1.63].map((k) => goertzelAmplitude(s, sr, hz * k));
  const off = probes.reduce((a, b) => a + b, 0) / probes.length;
  const ratio = at / Math.max(1e-9, off);
  return { ok: ratio > 3 && rms(s) > 2e-3, detail: `${label} ${hz.toFixed(1)} Hz ×${ratio.toFixed(1)} over off-harmonic, ${fmtDb(rms(s))}` };
};

/** Peak of the averaged short-block spectrum between lo and hi (Hz) — finds pure tones in noise. */
export function spectralPeakHz(s: Float32Array, sr: number, lo: number, hi: number, step = 4, block = 8192): number {
  const n = Math.min(block, s.length);
  const blocks = Math.max(1, Math.min(8, Math.floor(s.length / n)));
  let best = lo;
  let bestA = -1;
  for (let f = lo; f <= hi; f += step) {
    let a = 0;
    for (let b = 0; b < blocks; b++) a += goertzelAmplitude(s.subarray(b * n, b * n + n), sr, f);
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  return best;
}

/** A turbine whine: the strongest tone between 2 and 7 kHz is the HP blade-pass frequency (±4 %). */
const whineAt = (hz: number) => (s: Float32Array, sr: number) => {
  const f = spectralPeakHz(s, sr, 2000, 7000);
  const r = rms(s);
  return { ok: Math.abs(f - hz) < hz * 0.04 && r > 2e-3, detail: `whine peak ${f} Hz (want ${hz.toFixed(0)}), ${fmtDb(r)}` };
};

/** Low-frequency (< ~100 Hz) envelope onsets after `from` s: the booms of explosions. */
function boomOnsets(all: Float32Array, sr: number, from: number): number {
  const a = Math.exp((-2 * Math.PI * 100) / sr);
  let y = 0;
  const win = Math.round(0.05 * sr);
  const env: number[] = [];
  let acc = 0;
  for (let i = 0; i < all.length; i++) {
    y = a * y + (1 - a) * all[i];
    acc += y * y;
    if ((i + 1) % win === 0) {
      env.push(Math.sqrt(acc / win));
      acc = 0;
    }
  }
  // An onset: the envelope jumps to ≥ 2× the quietest of the previous 200 ms; then 300 ms refractory.
  let onsets = 0;
  const start = Math.max(4, Math.ceil((from * sr) / win));
  for (let k = start; k < env.length; k++) {
    const prior = Math.min(env[k - 1], env[k - 2], env[k - 3], env[k - 4]);
    if (env[k] > 0.02 && env[k] > 2 * prior) {
      onsets++;
      k += 6;
    }
  }
  return onsets;
}

const JET_IDLE: Partial<AudioInputs> = { rpm: CONFIG.audio.jet.idleCorePct, power: 0.02, engineRunning: true, listenerDistanceM: 26, aft: 0.95 };
const JET_MIL: Partial<AudioInputs> = { rpm: 100, power: 1, engineRunning: true, listenerDistanceM: 26, aft: 0.95 };
const JET_AB: Partial<AudioInputs> = { ...JET_MIL, afterburner: 1 };
const CRASH_FROM: Partial<AudioInputs> = { rpm: 2500, power: 0.9, engineRunning: true, onGround: false, airspeedKt: 90 };

export const SCENARIOS: Scenario[] = [
  { name: 'silence (engine off, at rest)', base: {}, check: silent },
  // ── Cessna 172RG: O-360 + prop (chase camera 15 m behind) ──
  { name: 'piston idle 700 rpm', base: { rpm: 700, power: 0.045, engineRunning: true }, check: tonalAt(firingFrequency(700)) },
  { name: 'piston cruise 2400 rpm', base: { rpm: 2400, power: 0.7, engineRunning: true, airspeedKt: 110, onGround: false }, check: tonalAt(firingFrequency(2400)) },
  { name: 'piston full power 2700 rpm', base: { rpm: 2700, power: 1, engineRunning: true }, check: tonalAt(firingFrequency(2700)) },
  { name: 'piston cruise, cockpit', base: { rpm: 2400, power: 0.7, engineRunning: true, cameraMode: 'cockpit', airspeedKt: 110, onGround: false }, check: tonalAt(firingFrequency(2400)) },
  { name: 'starter cranking', base: { rpm: CONFIG.aircraft.engine.crankRpm, starting: true }, check: audible() },
  { name: 'wind 120 kt (engine off)', base: { airspeedKt: 120, onGround: false }, check: audible() },
  { name: 'rolling 40 kt on grass', base: { onGround: true, groundSpeedKt: 40, surface: 'grass' }, check: audible(1e-3) },
  {
    name: 'stall horn (cockpit)', base: { stallWarning: true, airspeedKt: 45, onGround: false, cameraMode: 'cockpit' },
    check: (s, sr) => {
      const f = dominantFrequency(s, sr, 1000, 4000, 10);
      return { ok: f >= 1600 && f <= 2000 && rms(s) > 2e-3, detail: `peak ${f} Hz, ${fmtDb(rms(s))}` };
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
      return { ok, detail: `peak ${f} Hz (want ${want}), beep/gap rms ${hi.toFixed(4)}/${lo.toFixed(4)}, ${fmtDb(rms(s))}` };
    },
  },
  { name: 'gear motor (cockpit)', base: { gearMoving: true, cameraMode: 'cockpit' }, check: audible(1e-3) },
  { name: 'flap motor (cockpit)', base: { flapsMoving: true, cameraMode: 'cockpit' }, check: audible(1e-3) },
  { name: 'touchdown 600 fpm', base: { onGround: true, groundSpeedKt: 55 }, events: [{ at: 0.1, inputs: { touchdownFpm: -600 } }], check: audible(4e-3) },
  { name: 'gear clunk', base: { gearMoving: true }, events: [{ at: 0.2, inputs: { gearMoving: false } }], check: audible(2e-3) },
  // ── F-16C: F110 turbofan (chase camera 26 m behind) ──
  { name: 'jet idle', engine: 'jet', base: JET_IDLE, check: whineAt(jetWhineHz(CONFIG.audio.jet.idleCorePct)) },
  { name: 'jet idle, cockpit', engine: 'jet', base: { ...JET_IDLE, cameraMode: 'cockpit' }, check: audible() },
  { name: 'jet MIL (100 %)', engine: 'jet', base: JET_MIL, check: whineAt(jetWhineHz(100)) },
  { name: 'jet MIL, cockpit', engine: 'jet', base: { ...JET_MIL, cameraMode: 'cockpit', airspeedKt: 350, onGround: false }, check: audible() },
  { name: 'jet afterburner', engine: 'jet', base: JET_AB, window: [0.8, 2], check: audible(0.02) },
  { name: 'jet afterburner, cockpit', engine: 'jet', base: { ...JET_AB, cameraMode: 'cockpit', airspeedKt: 350, onGround: false }, window: [0.8, 2], check: audible() },
  {
    name: 'jet afterburner light-off (whoomph)', engine: 'jet', base: JET_MIL, events: [{ at: 0.5, inputs: { afterburner: 1 } }], window: [0.45, 1.1],
    check: (s, sr) => {
      const r = rms(s);
      const pre = rms(s.subarray(0, Math.round(0.05 * sr)));
      return { ok: r > pre * 1.3, detail: `light-off ${fmtDb(r)} vs MIL ${fmtDb(pre)}` };
    },
  },
  { name: 'jet hydraulics (cockpit, gear)', engine: 'jet', base: { gearMoving: true, cameraMode: 'cockpit' }, check: audible(1e-3) },
  // ── Crash: layered impact, fireball, secondary explosions, fire; then a reset ──
  {
    name: 'crash (impact + secondary explosions)', seconds: 8, tick: 0.05, base: CRASH_FROM, window: [0.1, 1.1],
    events: [{ at: 0.1, inputs: { crashed: true, crashSpeedKt: 90 } }],
    check: (s, sr, all, lv) => {
      const r = rms(s);
      const booms = boomOnsets(all, sr, 1.2);
      return { ok: r > 0.03 && booms >= 2, detail: `impact ${fmtDb(r)}, ${lv.explosions} explosions played, ${booms} boom onset(s) after 1.2 s` };
    },
  },
  {
    name: 'jet crash at 300 kt', engine: 'jet', seconds: 3, tick: 0.05, base: { ...JET_AB, onGround: false, airspeedKt: 300 }, window: [0.1, 1.1],
    events: [{ at: 0.1, inputs: { crashed: true, crashSpeedKt: 300 } }], check: audible(0.03),
  },
  {
    name: 'reset after a crash → silence', seconds: 3, tick: 0.05, base: CRASH_FROM, window: [2.2, 3],
    events: [
      { at: 0.1, inputs: { crashed: true, crashSpeedKt: 120 } },
      { at: 1.6, inputs: { crashed: false, rpm: 0, power: 0, engineRunning: false, airspeedKt: 0, onGround: true } },
    ],
    check: silent,
  },
  { name: 'muted at full power', base: { rpm: 2700, power: 1, engineRunning: true }, muted: true, check: silent },
];

function defaultFactory(): OfflineFactory | null {
  const g = globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext };
  const C = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  return C ? (ch, len, sr) => new C(ch, len, sr) : null;
}

/** The mix: relative levels between scenarios, and nothing clips. Appended to the results. */
export function mixChecks(r: SelfTestResult[]): SelfTestResult[] {
  const by = (n: string) => r.find((x) => x.name === n);
  const out: SelfTestResult[] = [];
  const rel = (name: string, lo: string, hi: string, minDb: number, maxDb = 60) => {
    const a = by(lo);
    const b = by(hi);
    if (!a || !b) return;
    const d = b.db - a.db;
    out.push({ name, rms: 0, db: d, peak: 0, ok: d >= minDb && d <= maxDb, detail: `${hi} − ${lo} = ${d.toFixed(1)} dB (want ${minDb}…${maxDb})` });
  };
  rel('mix: piston idle < cruise', 'piston idle 700 rpm', 'piston cruise 2400 rpm', 3);
  rel('mix: piston cruise ≤ full power', 'piston cruise 2400 rpm', 'piston full power 2700 rpm', 0.3);
  // A Cessna cabin is loud (≈ as loud as standing 15 m behind it); a fighter pilot sits under a canopy in a helmet.
  rel('mix: piston cockpit about as loud as outside', 'piston cruise, cockpit', 'piston cruise 2400 rpm', -5, 5);
  rel('mix: jet idle < MIL', 'jet idle', 'jet MIL (100 %)', 4);
  rel('mix: jet MIL < afterburner', 'jet MIL (100 %)', 'jet afterburner', 2.5);
  rel('mix: jet cockpit quieter than outside', 'jet MIL, cockpit', 'jet MIL (100 %)', 3, 18);
  rel('mix: the jet is louder than the Cessna', 'piston full power 2700 rpm', 'jet MIL (100 %)', 3);
  rel('mix: stall horn audible over the cockpit engine', 'piston cruise, cockpit', 'stall horn (cockpit)', -8, 12);
  rel('mix: gear horn audible over the cockpit engine', 'piston cruise, cockpit', 'gear warning horn (cockpit)', -10, 12);
  rel('mix: the crash is the loudest thing', 'jet afterburner', 'crash (impact + secondary explosions)', -1);
  const maxPeak = Math.max(...r.map((x) => x.peak));
  out.push({ name: 'mix: nothing clips (limiter + soft clipper)', rms: 0, db: db(maxPeak), peak: maxPeak, ok: maxPeak <= 0.99, detail: `max peak ${maxPeak.toFixed(3)} (${fmtDb(maxPeak)})` });
  return out;
}

/** Render every scenario and measure it. */
export async function runAudioSelfTest(opts: { seconds?: number; sampleRate?: number; factory?: OfflineFactory; only?: string } = {}): Promise<SelfTestResult[]> {
  const sr = opts.sampleRate ?? 44100;
  const factory = opts.factory ?? defaultFactory();
  if (!factory) return [{ name: 'OfflineAudioContext', rms: 0, db: -120, peak: 0, ok: false, detail: 'unavailable' }];
  const out: SelfTestResult[] = [];
  const q = 128 / sr;
  for (const sc of SCENARIOS) {
    if (opts.only && !sc.name.includes(opts.only)) continue;
    const seconds = sc.seconds ?? opts.seconds ?? 2;
    try {
      const ctx = factory(1, Math.round(sr * seconds), sr);
      const audio = createAudio({ context: ctx, engine: sc.engine ?? 'piston' });
      if (sc.muted) audio.setMuted(true);
      let cur: AudioInputs = { ...BASE, ...sc.base };
      audio.update(cur, 0);
      // One timeline of suspend points (render-quantum aligned, unique): ticks + events.
      const points = new Map<number, TimedInputs[]>();
      const add = (t: number, e: TimedInputs | null) => {
        const k = Math.max(1, Math.round(t / q));
        if (k * q >= seconds - q) return;
        const list = points.get(k) ?? [];
        if (e) list.push(e);
        points.set(k, list);
      };
      if (sc.tick) for (let t = sc.tick; t < seconds; t += sc.tick) add(t, null);
      for (const e of sc.events ?? []) add(e.at, e);
      let lastT = 0;
      for (const k of [...points.keys()].sort((a, b) => a - b)) {
        const evs = points.get(k) as TimedInputs[];
        void ctx.suspend(k * q).then(() => {
          const dt = Math.max(1 / 240, k * q - lastT);
          lastT = k * q;
          if (evs.length) {
            for (const e of evs) {
              audio.update({ ...cur, ...e.inputs }, dt);
              cur = { ...cur, ...e.inputs, ...(e.after ?? {}), touchdownFpm: null };
              audio.update(cur, 1 / 240);
            }
          } else {
            audio.update(cur, dt);
          }
          return ctx.resume();
        });
      }
      const buf = await ctx.startRendering();
      const all = buf.getChannelData(0);
      const [from, to] = sc.window ?? [sc.events?.length ? 0 : 0.3, seconds];
      const s = all.subarray(Math.min(Math.round(from * sr), all.length), Math.min(Math.round(to * sr), all.length));
      let peak = 0;
      for (let i = 0; i < all.length; i++) peak = Math.max(peak, Math.abs(all[i]));
      const r = sc.check(s, sr, all, audio.levels());
      const level = rms(s);
      out.push({ name: sc.name, rms: level, db: db(level), peak, ok: r.ok && audio.levels().errors === 0, detail: r.detail });
      audio.dispose();
    } catch (e) {
      out.push({ name: sc.name, rms: 0, db: -120, peak: 0, ok: false, detail: `threw: ${(e as Error).message}` });
    }
  }
  if (!opts.only) out.push(...mixChecks(out));
  return out;
}
