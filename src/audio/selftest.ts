/**
 * Functional self-test of the real synth graph: renders each sound in an OfflineAudioContext
 * (faster than real time, no speakers needed) through the full output chain (glue compressor →
 * limiter → soft clipper) and measures it — RMS level (dBFS), peak, the pitch of tonal parts
 * (piston and marine-diesel firing rates, jet turbine whine, horns), the crash's secondary explosions and the silence
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
import { tf34WhistleHz } from './turbofanMapping';
import { TURBOSHAFT, bladePassHz, compressorWhineHz } from './turboshaftMapping';
import type { MarineEngineAudioInputs, RotorAudioInputs, VesselAudioInputs } from './types';
import { MARINE, marineFiringHz } from './marineMapping';
import type { CombatAudioFrame } from './combat';
import type { AirAudioFrame } from './airTargets';
import { airDoppler } from './airTargetsMapping';
import type { AudioSystem } from './types';
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
  /** Combat: a one-shot to fire at this moment (impact, detonation, launch…) and/or a new combat frame. */
  fire?: (a: AudioSystem) => void;
  combat?: Partial<CombatAudioFrame>;
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
  /** Combat frame fed every update (the gun, the missile motor). */
  combat?: Partial<CombatAudioFrame>;
  /** Enemy aircraft fed every update. */
  air?: AirAudioFrame;
  check: (s: Float32Array, sr: number, all: Float32Array, levels: AudioLevels) => { ok: boolean; detail: string };
}

const NO_COMBAT: CombatAudioFrame = { gunRateRps: 0, gunCaliberMm: 30, gunSpin: 0, gunFiring: false, gunDistanceM: 30, cockpit: false, motor: 0, motorDistanceM: 0 };

/** The gun's buzz: the strongest component between 30 and 180 Hz is the firing rate (±3 %). */
const fundamentalAt = (hz: number) => (s: Float32Array, sr: number) => {
  const f = dominantFrequency(s, sr, 30, 180, 0.5);
  const r = rms(s);
  return { ok: Math.abs(f - hz) <= hz * 0.03 && r > 0.02, detail: `fundamental ${f.toFixed(1)} Hz (want ${hz}), ${fmtDb(r)}` };
};
/** The TF34 whistle: the strongest tone between 700 Hz and 5 kHz is the fan blade-pass frequency (±4 %). */
const whistleAt = (hz: number) => (s: Float32Array, sr: number) => {
  const f = spectralPeakHz(s, sr, 700, 5000, 1);
  const r = rms(s);
  return { ok: Math.abs(f - hz) < hz * 0.04 && r > 2e-3, detail: `whistle peak ${f} Hz (want ${hz.toFixed(0)}), ${fmtDb(r)}` };
};
const GAU8: Partial<CombatAudioFrame> = { gunRateRps: 65, gunCaliberMm: 30, gunSpin: 1, gunFiring: true, gunDistanceM: 30 };

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

/** One enemy aircraft `d` m north of a listener at the origin, flying south (toward it) at `v` m/s. */
const airFrame = (kind: 'fighter' | 'attack' | 'helo', d: number, v: number): AirAudioFrame => ({
  listener: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 1, ry: 0, rz: 0, cockpit: false },
  sources: [{ id: 1, kind, x: 60, y: 0, z: -d, vx: 0, vy: 0, vz: v }],
  count: 1,
  dt: 1 / 60,
});

/** The rotor: the signal's envelope beats at the blade-pass rate (×2 over the neighbouring rates). */
const rotorAt = (hz: number) => (s: Float32Array, sr: number) => {
  const a = Math.exp((-2 * Math.PI * 80) / sr);
  const env = new Float32Array(s.length);
  let y = 0;
  for (let i = 0; i < s.length; i++) {
    y = a * y + (1 - a) * Math.abs(s[i]);
    env[i] = y;
  }
  let mean = 0;
  for (let i = 0; i < env.length; i++) mean += env[i];
  mean /= Math.max(1, env.length);
  for (let i = 0; i < env.length; i++) env[i] -= mean;
  const at = goertzelAmplitude(env, sr, hz);
  const off = (goertzelAmplitude(env, sr, hz * 0.62) + goertzelAmplitude(env, sr, hz * 1.4)) / 2;
  const ratio = at / Math.max(1e-12, off);
  return { ok: ratio > 2 && rms(s) > 2e-3, detail: `rotor beat ${hz.toFixed(1)} Hz ×${ratio.toFixed(1)} over its neighbours, ${fmtDb(rms(s))}` };
};

const JET_IDLE: Partial<AudioInputs> = { rpm: CONFIG.audio.jet.idleCorePct, power: 0.02, engineRunning: true, listenerDistanceM: 26, aft: 0.95 };
const JET_MIL: Partial<AudioInputs> = { rpm: 100, power: 1, engineRunning: true, listenerDistanceM: 26, aft: 0.95 };
const JET_AB: Partial<AudioInputs> = { ...JET_MIL, afterburner: 1 };
/** JetRanger rotor states (physical units, as createAudioInputTracker makes them from AircraftState.rotor). */
const ROTOR_HOVER: RotorAudioInputs = {
  nrRpm: TURBOSHAFT.nominalNrRpm, n1: 0.9, enginePowerW: 175000, torque: 0.78, thrustN: 12700, tailThrustN: 740, collective: 0.55,
  vrs: 0, bladeStall: 0, groundEffect: 0.1, climbMs: 0, decelMs2: 0,
};
const HELI_HOVER: Partial<AudioInputs> = { rpm: TURBOSHAFT.nominalNrRpm, power: 0.74, engineRunning: true, onGround: false, listenerDistanceM: 20, aft: 0.7, rotor: ROTOR_HOVER };
const HELI_GROUND_IDLE: Partial<AudioInputs> = {
  ...HELI_HOVER, onGround: true, power: 0.12,
  rotor: { ...ROTOR_HOVER, n1: 0.7, enginePowerW: 28000, torque: 0.12, thrustN: 1500, tailThrustN: 120, collective: 0, groundEffect: 1 },
};
/** A 500 fpm descent at 60 kt: blade–vortex interaction, the slap you hear from miles away. */
const HELI_BVI: Partial<AudioInputs> = { ...HELI_HOVER, airspeedKt: 60, power: 0.4, rotor: { ...ROTOR_HOVER, enginePowerW: 95000, torque: 0.42, thrustN: 12200, climbMs: -3 } };
/** The rotor horn alone (rotor stopped, engine off) so it can be measured without the rest of the helicopter. */
const HORN_ONLY: Partial<AudioInputs> = { lowRotorRpm: true, onGround: false, airspeedKt: 0, cameraMode: 'cockpit' };

/** Princess V50: both D6s the same (the voice detunes the starboard one), a hull state (chase camera 25 m astern). */
const v50Engine = (rpm: number, load: number, boost: number, gear: number, thrustN: number): MarineEngineAudioInputs => ({
  rpm, load, boost, gear, propRps: gear === 0 ? 0 : (gear * rpm) / MARINE.gearRatio / 60, thrustN,
});
const v50 = (e: MarineEngineAudioInputs, hull: Partial<VesselAudioInputs> = {}): VesselAudioInputs => ({
  engines: [e, { ...e }], engineCount: 2, speedMs: 0, planing: 0, trimDeg: 0, aground: false, heaveMs: 0.05, pitchRate: 0.01,
  rollRate: 0.01, moored: false, ...hull,
});
const V50_BASE: Partial<AudioInputs> = { onGround: false, surface: 'water', listenerDistanceM: 25, aft: 0.9 };
const V50_IDLE: Partial<AudioInputs> = { ...V50_BASE, rpm: 700, power: 0.05, engineRunning: true, vessel: v50(v50Engine(700, 0.08, 0.05, 0, 0), { moored: true }) };
const V50_CRUISE: Partial<AudioInputs> = {
  ...V50_BASE, rpm: 3000, power: 0.75, engineRunning: true, airspeedKt: 29,
  vessel: v50(v50Engine(3000, 0.8, 0.9, 1, 14000), { speedMs: 14.4, planing: 0.9, trimDeg: 4, heaveMs: 0.3, pitchRate: 0.04 }),
};
const V50_FULL: Partial<AudioInputs> = {
  ...V50_BASE, rpm: 3500, power: 1, engineRunning: true, airspeedKt: 35,
  vessel: v50(v50Engine(3500, 1, 1, 1, 15500), { speedMs: 17.5, planing: 1, trimDeg: 3.5, heaveMs: 0.35, pitchRate: 0.05 }),
};
/** Engines stopped, the hull working in a short chop (heave and pitch). */
const V50_CHOP: Partial<AudioInputs> = { ...V50_BASE, vessel: v50(v50Engine(0, 0, 0, 0, 0), { heaveMs: 0.8, pitchRate: 0.12, rollRate: 0.1 }) };

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
  // ── A-10C: TF34 turbofans (chase camera 26 m behind) ──
  { name: 'turbofan idle', engine: 'turbofan', base: JET_IDLE, check: whistleAt(tf34WhistleHz(CONFIG.audio.turbofan.idleCorePct)) },
  { name: 'turbofan 100 %', engine: 'turbofan', base: JET_MIL, check: whistleAt(tf34WhistleHz(100)) },
  { name: 'turbofan 100 %, cockpit', engine: 'turbofan', base: { ...JET_MIL, cameraMode: 'cockpit', airspeedKt: 300, onGround: false }, check: audible() },
  // ── Bell 206 JetRanger: Allison 250 turboshaft + rotors (chase camera 20 m behind) ──
  { name: 'turboshaft hover (rotor)', engine: 'turboshaft', base: HELI_HOVER, check: rotorAt(bladePassHz(TURBOSHAFT.nominalNrRpm)) },
  { name: 'turboshaft ground idle, flat pitch (turbine whine)', engine: 'turboshaft', base: HELI_GROUND_IDLE, check: whineAt(compressorWhineHz(0.7)) },
  { name: 'turboshaft descent, blade slap (BVI)', engine: 'turboshaft', base: HELI_BVI, check: rotorAt(bladePassHz(TURBOSHAFT.nominalNrRpm)) },
  { name: 'turboshaft hover, cockpit', engine: 'turboshaft', base: { ...HELI_HOVER, cameraMode: 'cockpit' }, check: audible() },
  {
    name: 'turboshaft start (starter, light-off, spool-up)', engine: 'turboshaft', tick: 0.05, seconds: 2.5, window: [0, 2.5],
    base: { starting: true, rotor: { ...ROTOR_HOVER, nrRpm: 0, n1: 0.05, enginePowerW: 0, torque: 0, thrustN: 0, tailThrustN: 0, collective: 0 } },
    events: [0.3, 0.6, 0.9, 1.2, 1.5, 1.8].map((at, k): TimedInputs => ({
      at, inputs: { rotor: { ...ROTOR_HOVER, nrRpm: 20 * k, n1: 0.1 + 0.08 * k, enginePowerW: 6000 * k, torque: 0.03 * k, thrustN: 0, tailThrustN: 0, collective: 0 } },
    })),
    check: (s, sr, _all, lv) => {
      const win = (a: number, b: number) => rms(s.subarray(Math.round(a * sr), Math.round(b * sr)));
      const early = win(0.05, 0.3);
      const late = win(1.9, 2.4);
      return { ok: early > 1e-3 && late > early && lv.oneShots >= 1, detail: `cranking ${fmtDb(early)}, spooling ${fmtDb(late)}, ${lv.oneShots} light-off` };
    },
  },
  {
    name: 'low rotor RPM horn (cockpit)', engine: 'turboshaft', base: HORN_ONLY,
    check: (s, sr) => {
      const f = dominantFrequency(s, sr, 300, 3000, 5);
      // Steady (not beeped like the gear horn): 40 ms windows stay within a factor of 2.
      const win = Math.round(0.04 * sr);
      let lo = Infinity;
      let hi = 0;
      for (let i = 0; i + win <= s.length; i += win) {
        const r = rms(s.subarray(i, i + win));
        lo = Math.min(lo, r);
        hi = Math.max(hi, r);
      }
      const want = TURBOSHAFT.hornHz;
      const ok = Math.abs(f - want) < want * 0.06 && hi > 5e-3 && hi < lo * 2;
      return { ok, detail: `peak ${f} Hz (want ${want}), steady rms ${lo.toFixed(4)}…${hi.toFixed(4)}, ${fmtDb(rms(s))}` };
    },
  },
  // ── Princess V50: twin D6-435 diesels on IPS 600 drives, and the hull (chase camera 25 m astern) ──
  { name: 'marine idle 700 rpm (moored)', engine: 'marineDiesel', base: V50_IDLE, check: tonalAt(marineFiringHz(700)) },
  { name: 'marine cruise 3000 rpm, planing 28 kt', engine: 'marineDiesel', base: V50_CRUISE, check: tonalAt(marineFiringHz(3000)) },
  { name: 'marine full 3500 rpm, 34 kt', engine: 'marineDiesel', base: V50_FULL, check: tonalAt(marineFiringHz(3500)) },
  { name: 'marine cruise, cockpit (saloon helm)', engine: 'marineDiesel', base: { ...V50_CRUISE, cameraMode: 'cockpit' }, check: tonalAt(marineFiringHz(3000)) },
  {
    name: 'marine start (crank, catch)', engine: 'marineDiesel', tick: 0.05, seconds: 2, window: [0, 2],
    base: { ...V50_BASE, rpm: 180, starting: true, vessel: v50(v50Engine(180, 0, 0, 0, 0), { moored: true }) },
    events: [{ at: 1.0, inputs: { starting: false, engineRunning: true, rpm: 700, vessel: v50(v50Engine(700, 0.1, 0.05, 0, 0), { moored: true }) } }],
    check: (s, sr, _all, lv) => {
      const win = (a: number, b: number) => rms(s.subarray(Math.round(a * sr), Math.round(b * sr)));
      const crank = win(0.1, 0.9);
      const run = win(1.4, 1.95);
      return { ok: crank > 1e-3 && run > 1e-3 && lv.oneShots >= 1, detail: `cranking ${fmtDb(crank)}, running ${fmtDb(run)}, ${lv.oneShots} catch` };
    },
  },
  {
    name: 'marine stop (run-down)', engine: 'marineDiesel', tick: 0.05, seconds: 2.5, window: [0, 2.5], base: V50_IDLE,
    events: [{ at: 0.6, inputs: { engineRunning: false, rpm: 0, vessel: v50(v50Engine(0, 0, 0, 0, 0), { moored: true }) } }],
    check: (s, sr, _all, lv) => {
      const win = (a: number, b: number) => rms(s.subarray(Math.round(a * sr), Math.round(b * sr)));
      const idle = win(0.3, 0.6);
      const down = win(0.62, 0.95);
      const after = win(1.9, 2.5);
      return {
        ok: down > after * 1.5 && after < idle * 0.4 && lv.oneShots >= 1,
        detail: `idle ${fmtDb(idle)}, running down ${fmtDb(down)}, stopped ${fmtDb(after)}, ${lv.oneShots} shudder`,
      };
    },
  },
  {
    name: 'marine gearbox clunk (ahead → neutral)', engine: 'marineDiesel', tick: 0.05, window: [0.45, 1],
    base: { ...V50_IDLE, vessel: v50(v50Engine(700, 0.15, 0.05, 1, 1500), { moored: true }) },
    events: [{ at: 0.5, inputs: { vessel: v50(v50Engine(700, 0.08, 0.05, 0, 0), { moored: true }) } }],
    check: (s, _sr, _all, lv) => ({ ok: lv.gearClunks === 2 && rms(s) > 2e-3, detail: `${lv.gearClunks} clunks (both drives), ${fmtDb(rms(s))}` }),
  },
  {
    name: 'marine hull slap in a chop (engines off)', engine: 'marineDiesel', tick: 0.02, seconds: 3, window: [0, 3], base: V50_CHOP,
    check: (s, _sr, _all, lv) => ({ ok: lv.hullSlaps >= 4 && rms(s) > 1e-3, detail: `${lv.hullSlaps} slaps (${lv.slapRate.toFixed(1)}/s expected), ${fmtDb(rms(s))}` }),
  },
  {
    name: 'marine water at 30 kt (engines silent)', engine: 'marineDiesel', tick: 0.05,
    base: { ...V50_BASE, airspeedKt: 30, vessel: v50(v50Engine(0, 0, 0, 0, 0), { speedMs: 15.4, planing: 0.9, heaveMs: 0.3, pitchRate: 0.04 }) },
    check: audible(3e-3),
  },
  {
    name: 'marine aground (grinding)', engine: 'marineDiesel', tick: 0.05, window: [0.1, 2],
    base: { ...V50_IDLE, vessel: v50(v50Engine(900, 0.4, 0.2, 1, 5000), { speedMs: 2, aground: true }) },
    check: (s, _sr, _all, lv) => ({ ok: lv.grind > 0.3 && rms(s) > 3e-3, detail: `grind ${lv.grind.toFixed(2)}, ${fmtDb(rms(s))}` }),
  },
  // ── Combat: the gun, explosions, missiles ──
  { name: 'GAU-8/A burst (outside, 30 m)', base: {}, combat: GAU8, tick: 0.05, window: [0.4, 2], check: fundamentalAt(65) },
  { name: 'GAU-8/A burst (cockpit)', base: { cameraMode: 'cockpit' }, combat: { ...GAU8, cockpit: true }, tick: 0.05, window: [0.4, 2], check: fundamentalAt(65) },
  { name: 'M61A1 burst (outside, 30 m)', base: {}, combat: { ...GAU8, gunRateRps: 100, gunCaliberMm: 20 }, tick: 0.05, window: [0.4, 2], check: fundamentalAt(100) },
  {
    name: 'GAU-8/A spin-up and stop', base: {}, combat: { ...GAU8, gunSpin: 0.05 }, tick: 0.05, seconds: 2.5, window: [0, 2.5],
    events: [...[0.1, 0.2, 0.3, 0.4, 0.5].map((at): TimedInputs => ({ at, inputs: {}, combat: { gunSpin: at / 0.55 } })), { at: 0.6, inputs: {}, combat: { gunSpin: 1 } }, { at: 1.6, inputs: {}, combat: { gunFiring: false, gunSpin: 0.5 } }],
    check: (s, sr) => {
      const win = (a: number, b: number) => rms(s.subarray(Math.round(a * sr), Math.round(b * sr)));
      const firing = win(0.8, 1.5);
      const after = win(2.0, 2.5);
      return { ok: firing > 0.02 && after < firing * 0.1, detail: `firing ${fmtDb(firing)}, after the stop ${fmtDb(after)}` };
    },
  },
  {
    name: 'Maverick boom 686 m away arrives 2 s later', base: {}, seconds: 4, tick: 0.05, window: [0, 4],
    events: [{ at: 0.1, inputs: {}, fire: (a) => a.combat.detonation({ distanceM: 686, size: 1 }) }],
    check: (s, sr) => {
      const win = (a: number, b: number) => rms(s.subarray(Math.round(a * sr), Math.round(b * sr)));
      const early = win(0.2, 2.0);
      const boom = win(2.1, 3.0);
      return { ok: boom > 0.01 && boom > early * 10, detail: `before ${fmtDb(early)}, on arrival ${fmtDb(boom)}` };
    },
  },
  {
    name: 'tank cook-off 150 m away', base: {}, seconds: 4, tick: 0.05, window: [0.5, 2],
    events: [{ at: 0.05, inputs: {}, fire: (a) => a.combat.cookoff({ distanceM: 150, size: 1.1, secondaryDelayS: 0.8, secondarySize: 0.7 }) }],
    check: audible(0.02),
  },
  {
    name: '30 mm impacts 300 m away (crackle)', base: {}, seconds: 3, tick: 0.02, window: [0.9, 3],
    events: Array.from({ length: 60 }, (_, i) => ({ at: 0.05 + i / 30, inputs: {}, fire: (a: AudioSystem) => a.combat.impact({ distanceM: 300 + (i % 7), surface: i % 5 === 0 ? 'target' : 'dirt', ricochet: i % 9 === 0 }) })),
    check: audible(3e-3),
  },
  {
    name: 'Maverick launch + motor (chase)', base: {}, seconds: 2.5, tick: 0.05, window: [0.1, 1.5], combat: { motor: 1, motorDistanceM: 40 },
    events: [{ at: 0.05, inputs: {}, fire: (a) => a.combat.launch({ distanceM: 20 }) }],
    check: audible(0.01),
  },
  // ── Enemy aircraft (src/audio/airTargets.ts) ──
  {
    name: 'MiG-29 300 m, closing at 120 m/s (Doppler-shifted whine)', base: {}, tick: 0.05, air: airFrame('fighter', 300, 120),
    check: whineAt(CONFIG.audio.airTargets.fighter.whineHz * airDoppler(120)),
  },
  { name: 'MiG-29 2.5 km away', base: {}, tick: 0.05, air: airFrame('fighter', 2500, 120), check: audible(1e-4) },
  { name: 'Mi-24 250 m (rotor)', base: {}, tick: 0.05, seconds: 2.5, air: airFrame('helo', 250, 0), check: rotorAt(CONFIG.audio.airTargets.helo.bladeHz) },
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
  rel('mix: the A-10 is quieter than the F-16 at full power', 'turbofan 100 %', 'jet MIL (100 %)', 1);
  rel('mix: turbofan idle < 100 %', 'turbofan idle', 'turbofan 100 %', 2);
  rel('mix: the GAU-8 drowns the A-10 engines', 'turbofan 100 %', 'GAU-8/A burst (outside, 30 m)', 4);
  rel('mix: the GAU-8 is heavier than the M61', 'M61A1 burst (outside, 30 m)', 'GAU-8/A burst (outside, 30 m)', -1);
  rel('mix: a MiG 2.5 km away is far quieter than at 300 m', 'MiG-29 2.5 km away', 'MiG-29 300 m, closing at 120 m/s (Doppler-shifted whine)', 12);
  rel('mix: a MiG passing 300 m away is no louder than our own jet', 'MiG-29 300 m, closing at 120 m/s (Doppler-shifted whine)', 'jet MIL (100 %)', 0);
  rel('mix: JetRanger ground idle < hover', 'turboshaft ground idle, flat pitch (turbine whine)', 'turboshaft hover (rotor)', 2);
  rel('mix: blade slap is louder than the hover', 'turboshaft hover (rotor)', 'turboshaft descent, blade slap (BVI)', 1.5);
  rel('mix: the JetRanger is about as loud as the Cessna at full power', 'piston full power 2700 rpm', 'turboshaft hover (rotor)', -6, 6);
  rel('mix: the F-16 at MIL is louder than the JetRanger', 'turboshaft hover (rotor)', 'jet MIL (100 %)', 2);
  rel('mix: the rotor horn is audible over the JetRanger cabin', 'turboshaft hover, cockpit', 'low rotor RPM horn (cockpit)', -12, 10);
  rel('mix: marine idle < cruise', 'marine idle 700 rpm (moored)', 'marine cruise 3000 rpm, planing 28 kt', 4);
  rel('mix: marine cruise ≤ full', 'marine cruise 3000 rpm, planing 28 kt', 'marine full 3500 rpm, 34 kt', 0.3);
  // The saloon of a sports yacht is quiet: the engines are under the floor, the hull around you.
  rel('mix: marine saloon quieter than on deck', 'marine cruise, cockpit (saloon helm)', 'marine cruise 3000 rpm, planing 28 kt', 1, 15);
  rel('mix: water noise is a big part of the V50 at speed', 'marine cruise 3000 rpm, planing 28 kt', 'marine water at 30 kt (engines silent)', -12, 0);
  rel('mix: the F-16 at MIL is louder than the V50 flat out', 'marine full 3500 rpm, 34 kt', 'jet MIL (100 %)', 3);
  rel('mix: the V50 flat out is about as loud as the Cessna at full power', 'piston full power 2700 rpm', 'marine full 3500 rpm, 34 kt', -8, 4);
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
      let cf: CombatAudioFrame = { ...NO_COMBAT, ...(sc.combat ?? {}) };
      audio.update(cur, 0);
      if (sc.combat) audio.combat.update(cf);
      if (sc.air) audio.air.update(sc.air);
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
              if (e.combat) cf = { ...cf, ...e.combat };
              e.fire?.(audio);
            }
          } else {
            audio.update(cur, dt);
          }
          if (sc.combat || evs.some((e) => e.combat)) audio.combat.update(cf);
          if (sc.air) audio.air.update(sc.air);
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
