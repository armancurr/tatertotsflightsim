/**
 * The A-10C's voice: two GE TF34-GE-100A high-bypass turbofans (see turbofanMapping.ts).
 *
 *   fore bus: the "Hog whistle" — the fan blade-pass tone of each engine (a 0.6 %-detuned pair: two
 *             engines never run at exactly the same N1, so the whistle shimmers), its 2nd harmonic,
 *             and the faint high core-compressor whine
 *   aft bus:  a soft low roar (pink noise → low-pass opening with power) and rumble (brown noise) —
 *             a high-bypass jet is slow and quiet; no afterburner
 *   cabin:    ECS air hiss (engines far behind the pilot); APU/air-start whine while starting
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels } from './types';
import { zeroRotorLevels } from './turboshaftMapping';
import { zeroMarineLevels } from './marineMapping';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import { jetCorePct, jetDirectivity } from './jetMapping';
import { tf34CoreHz, tf34FanPct, tf34WhistleHz, turbofanMix } from './turbofanMapping';
import { whineWaveform } from './waves';

const A = CONFIG.audio;
const T = A.turbofan;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createTurbofanVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const bus = gain(A.engineVolume * T.volume);
  bus.connect(outE);
  const fore = gain(1);
  fore.connect(bus);
  const aft = gain(1);
  aft.connect(bus);

  // ── The whistle: fan blade-pass of each engine + 2nd harmonic, a slow waver ──
  const wave = b.wave(() => whineWaveform(512), 4, 'whine');
  const f1 = osc(wave, 0);
  const f2 = osc(wave, 0);
  const h2 = osc('sine', 0);
  const coreOsc = osc('sine', 0);
  const whistleAM = gain(0.9);
  chain(osc('sine', 0.37), gain(0.08)).connect(whistleAM.gain);
  chain(f1, gain(0.6), whistleAM);
  chain(f2, gain(0.35), whistleAM);
  const whistle = gain(0);
  chain(whistleAM, whistle, fore);
  const whistle2 = gain(0);
  chain(h2, whistle2, fore);
  const core = gain(0);
  chain(coreOsc, core, fore);

  // ── Roar + rumble ──
  const roarSrc = loop(pink);
  const roarLP = filter('lowpass', 600, 0.6);
  const roar = gain(0);
  chain(roarSrc, roarLP, roar, aft);
  const rumbleSrc = loop(brown);
  const rumbleLP = filter('lowpass', 150, 0.7);
  const rumble = gain(0);
  chain(rumbleSrc, rumbleLP, rumble, aft);

  // ── Starting (APU air start) ──
  const startOsc = osc(wave, 1900);
  const starter = gain(0);
  chain(startOsc, gain(0.5), starter, bus);

  // ── Cockpit ECS ──
  const ecsSrc = loop(white);
  const ecsBP = filter('bandpass', 4000, 0.6);
  const ecs = gain(0);
  chain(ecsSrc, ecsBP, ecs, outC);

  const K = {
    outE: knob(outE.gain),
    fore: knob(fore.gain),
    aft: knob(aft.gain),
    f1: knob(f1.frequency, 2e-4),
    f2: knob(f2.frequency, 2e-4),
    h2: knob(h2.frequency, 2e-4),
    coreF: knob(coreOsc.frequency, 2e-4),
    whistle: knob(whistle.gain),
    whistle2: knob(whistle2.gain),
    core: knob(core.gain),
    roarLP: knob(roarLP.frequency, 1e-3),
    roar: knob(roar.gain),
    rumble: knob(rumble.gain),
    starter: knob(starter.gain),
    ecs: knob(ecs.gain),
    rates: [roarSrc, rumbleSrc].map((s) => knob(s.playbackRate, 1e-3)),
  };
  const m = turbofanMix(0, 0, false, false, false);
  const extDir = jetDirectivity(0);
  const COCKPIT_DIR = { aft: 0.8, fore: 0.8 };

  return {
    kind: 'turbofan',
    refDistanceM: T.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, crashed } = f;
      const tau = f.tau;
      const corePct = jetCorePct(fin(a.rpm, 0));
      turbofanMix(corePct, fin(a.power, 0), !!a.engineRunning, !!a.starting, crashed, m);
      const eff = a.engineRunning && !a.starting ? Math.max(corePct, T.idleCorePct) : corePct;
      const dir = f.exterior ? jetDirectivity(fin(a.aft, 0), extDir) : COCKPIT_DIR;
      // The fan whistle radiates from the inlet AND aft out of the bypass duct: keep it strong behind too.
      const whistleDir = Math.max(dir.fore, 0.75);
      const dop = f.doppler;
      const spoolTau = crashed ? 0.8 : tau;
      const hz = tf34WhistleHz(eff) * dop;
      K.f1.set(hz, t, spoolTau);
      K.f2.set(hz * 1.006, t, spoolTau);
      K.h2.set(hz * 2, t, spoolTau);
      K.coreF.set(Math.min(16000, tf34CoreHz(eff) * dop), t, spoolTau);
      K.whistle.set(T.whistle * m.whistle, t, spoolTau);
      K.whistle2.set(T.whistle2 * m.whistle, t, spoolTau);
      K.core.set(T.core * m.core, t, spoolTau);
      K.roarLP.set(350 + 1500 * m.brightness, t, tau);
      K.roar.set(T.roar * m.roar, t, tau);
      K.rumble.set(T.rumble * m.rumble, t, tau);
      K.starter.set(T.starter * m.starter, t, 0.25);
      for (const r of K.rates) r.set(dop, t, tau);
      K.fore.set(whistleDir, t, A.cameraRampTau);
      K.aft.set(dir.aft, t, A.cameraRampTau);
      K.outE.set(f.exterior ? 1 : T.cockpitGain, t, A.cameraRampTau);
      K.ecs.set(!f.exterior && a.engineRunning && !crashed ? T.ecs : 0, t, A.cameraRampTau);

      L.jet = 0;
      L.turbofan = 1;
      L.corePct = eff;
      L.whineHz = hz;
      L.fanHz = (tf34FanPct(eff) / 100) * (T.fanMaxRpm / 60) * dop;
      L.whine = m.whistle * whistleDir;
      L.fan = m.whistle;
      L.roar = m.roar * dir.aft;
      L.afterburner = 0;
      L.crackle = 0;
      L.intake = 0;
      L.ecs = !f.exterior && a.engineRunning ? 1 : 0;
      L.hydraulic = 0;
      L.starter = m.starter;
      L.exhaust = 0;
      L.prop = 0;
      L.mechanical = 0;
      L.cycleHz = 0;
      L.firingHz = 0;
      L.bladeHz = 0;
      L.whistle = 0;
      L.gear = 0;
      L.flap = 0;
      zeroRotorLevels(L);
      zeroMarineLevels(L);
      return 0;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
