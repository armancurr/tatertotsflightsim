/**
 * The Cessna 172RG's voice: Lycoming O-360 (4 cylinders, 4-stroke) + 2-blade McCauley prop, plus
 * the systems sounds of a light piston single (electric-hydraulic gear pump, flap motor, door-seal
 * whistle).
 *
 *   cycle oscillator (PeriodicWave of one 4-stroke cycle, 4 uneven exhaust pulses) → tone LP
 *   exhaust noise (pink) → band-pass → AM at the firing rate (pulse oscillator → gain.gain)
 *   prop buzz (PeriodicWave blade pulse at the blade-pass rate) + blade-slap noise AM'd at it
 *   valve-train tick, starter motor (AM'd at the compression rate while cranking)
 *   → exterior path;   gear pump hum, flap motor whine, door whistle → cabin path
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels } from './types';
import { zeroRotorLevels } from './turboshaftMapping';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import {
  bladePassFrequency, clamp, cycleFrequency, engineMix, exhaustCenterHz, firingFrequency, whistleGain,
} from './mapping';
import { engineCycleWaveform, propWaveform, pulseWaveform } from './waves';
import { playCatch, playGearClunk } from './oneshots';

const A = CONFIG.audio;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createPistonVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const engineBus = gain(A.engineVolume);
  engineBus.connect(outE);

  // ── Engine ──
  const engineWave = b.wave(() => engineCycleWaveform(2048), 72, 'engineCycle');
  const propWave = b.wave(() => propWaveform(1024), 40, 'prop');
  const pulseWave = b.wave(() => pulseWaveform(1024, 0.3), 24, 'pulse0.3');
  const cycleOsc = osc(engineWave, 0);
  const tone = gain(0);
  const toneLP = filter('lowpass', 400, 0.9);
  chain(cycleOsc, toneLP, tone, engineBus);

  const fireOsc = osc(pulseWave, 0);
  const exSrc = loop(pink);
  const exBP = filter('bandpass', 200, 0.9);
  const exAM = gain(0.4);
  chain(fireOsc, gain(0.6)).connect(exAM.gain);
  const exhaust = gain(0);
  chain(exSrc, exBP, exAM, exhaust, engineBus);

  const propOsc = osc(propWave, 0);
  const propLP = filter('lowpass', 900, 0.7);
  const prop = gain(0);
  chain(propOsc, propLP, prop, engineBus);
  const bpfOsc = osc(pulseWave, 0);
  const propSrc = loop(white);
  const propBP = filter('bandpass', 1700, 0.6);
  const propAM = gain(0.3);
  chain(bpfOsc, gain(0.7)).connect(propAM.gain);
  const propNoise = gain(0);
  chain(propSrc, propBP, propAM, propNoise, engineBus);

  const mechSrc = loop(white);
  const mechBP = filter('bandpass', 3200, 1.6);
  const mechAM = gain(0.2);
  chain(cycleOsc, gain(0.8)).connect(mechAM.gain);
  const mech = gain(0);
  chain(mechSrc, mechBP, mechAM, mech, engineBus);

  // Starter: motor whine + compression chug, both pulsing at the cranking firing rate.
  const crankLfo = osc('sine', 6);
  const starterOsc = osc('sawtooth', 96);
  const starterBP = filter('bandpass', 850, 1.2);
  const starterAM = gain(0.55);
  chain(crankLfo, gain(0.45)).connect(starterAM.gain);
  const starter = gain(0);
  chain(starterOsc, starterBP, starterAM, starter, engineBus);
  const crankSrc = loop(brown);
  const crankLP = filter('lowpass', 260, 0.8);
  const crankAM = gain(0.5);
  chain(crankLfo, gain(0.5)).connect(crankAM.gain);
  const crank = gain(0);
  chain(crankSrc, crankLP, crankAM, crank, engineBus);

  // ── Cabin: door-seal whistle, gear pump, flap motor ──
  const whistleSrc = loop(white);
  const whistleBP = filter('bandpass', A.whistleHz, 22);
  chain(osc('sine', 0.31), gain(35)).connect(whistleBP.frequency);
  const whistle = gain(0);
  chain(whistleSrc, whistleBP, whistle, outC);

  const gearOsc = osc('sawtooth', 118);
  const gearBP = filter('bandpass', 430, 1.3);
  const gear = gain(0);
  chain(gearOsc, gearBP, gear, outC);
  chain(osc('sine', 790), gain(0.18), gear);
  const flapOsc = osc('sawtooth', 290);
  chain(osc('sine', 7), gain(5)).connect(flapOsc.frequency);
  const flapBP = filter('bandpass', 950, 2);
  const flap = gain(0);
  chain(flapOsc, flapBP, flap, outC);

  const cabinFx = gain(A.effectsVolume);
  cabinFx.connect(outC);

  const K = {
    cycleF: knob(cycleOsc.frequency, 2e-4),
    fireF: knob(fireOsc.frequency, 2e-4),
    propF: knob(propOsc.frequency, 2e-4),
    bpfF: knob(bpfOsc.frequency, 2e-4),
    crankF: knob(crankLfo.frequency, 1e-3),
    exRate: knob(exSrc.playbackRate, 1e-3),
    tone: knob(tone.gain),
    toneLP: knob(toneLP.frequency, 1e-3),
    exBP: knob(exBP.frequency, 1e-3),
    exhaust: knob(exhaust.gain),
    propLP: knob(propLP.frequency, 1e-3),
    prop: knob(prop.gain),
    propNoise: knob(propNoise.gain),
    mech: knob(mech.gain),
    starter: knob(starter.gain),
    crank: knob(crank.gain),
    whistle: knob(whistle.gain),
    gear: knob(gear.gain),
    flap: knob(flap.gain),
  };

  const prev = { gear: false, starting: false };

  return {
    kind: 'piston',
    refDistanceM: A.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, tau, crashed } = f;
      const rpm = fin(a.rpm, 0);
      const mix = engineMix({ rpm, power: a.power, engineRunning: !!a.engineRunning, starting: !!a.starting, crashed });
      const dop = f.doppler;
      L.exhaust = mix.exhaust;
      L.prop = mix.prop;
      L.mechanical = mix.mechanical;
      L.starter = mix.starter;
      L.cycleHz = cycleFrequency(rpm) * dop;
      L.firingHz = firingFrequency(rpm) * dop;
      L.bladeHz = bladePassFrequency(rpm) * dop;
      K.cycleF.set(L.cycleHz, t, tau);
      K.fireF.set(L.firingHz, t, tau);
      K.propF.set(L.bladeHz, t, tau);
      K.bpfF.set(L.bladeHz, t, tau);
      K.exRate.set(dop, t, tau);
      K.crankF.set(Math.max(3, firingFrequency(rpm)), t, tau);
      const rpmN = clamp(rpm / CONFIG.aircraft.engine.maxRpm, 0, 1);
      K.tone.set(0.6 * mix.exhaust, t, tau);
      K.toneLP.set(260 + 2600 * mix.brightness, t, tau);
      K.exBP.set(exhaustCenterHz(rpm), t, tau);
      K.exhaust.set(0.85 * mix.exhaust, t, tau);
      K.propLP.set(650 + 3800 * Math.pow(rpmN, 1.5), t, tau);
      K.prop.set(0.42 * mix.prop, t, tau);
      K.propNoise.set(0.3 * mix.prop, t, tau);
      K.mech.set(0.05 * mix.mechanical, t, tau);
      K.starter.set(0.32 * mix.starter, t, tau);
      K.crank.set(0.55 * mix.starter, t, tau);

      L.whistle = whistleGain(fin(a.airspeedKt, 0), a.cameraMode);
      K.whistle.set(L.whistle * A.whistleVolume, t, tau);
      L.gear = a.gearMoving && !crashed ? A.motorVolume : 0;
      L.flap = a.flapsMoving && !crashed ? A.motorVolume : 0;
      K.gear.set(L.gear, t, 0.08);
      K.flap.set(L.flap, t, 0.06);

      // The jet's channels are silent while the piston engine plays.
      L.jet = 0;
      L.turbofan = 0;
      L.corePct = 0;
      L.whineHz = 0;
      L.fanHz = 0;
      L.whine = 0;
      L.fan = 0;
      L.roar = 0;
      L.afterburner = 0;
      L.crackle = 0;
      L.intake = 0;
      L.ecs = 0;
      L.hydraulic = 0;
      zeroRotorLevels(L);

      let shots = 0;
      if (f.primed) {
        if (prev.gear && !a.gearMoving && !crashed) {
          playGearClunk(out.kit, cabinFx, t);
          shots++;
        }
        if (prev.starting && !a.starting && a.engineRunning && !crashed) {
          playCatch(out.kit, engineBus, t);
          shots++;
        }
      }
      prev.gear = !!a.gearMoving && !crashed;
      prev.starting = !!a.starting;
      return shots;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
