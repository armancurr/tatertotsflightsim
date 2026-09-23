/**
 * The F-16C's voice: a GE F110-GE-129 afterburning turbofan (see jetMapping.ts for the acoustics).
 *
 *   fore bus (inlet-radiated, loudest ahead/abeam):
 *     turbine whine — 3 partials (HP blade-pass, a 0.4 %-detuned twin for the shimmer, a second
 *                     stage at ×1.52) with a slow waver
 *     shaft buzz    — buzz-saw PeriodicWave at the core shaft rate
 *     fan buzz-saw  — buzz-saw PeriodicWave at the fan shaft rate → low-pass opening with N1
 *   aft bus (jet-radiated, loudest behind):
 *     roar          — pink noise → 2 × low-pass opening with power
 *     rumble        — brown noise → low-pass (the body of the jet, felt in the cockpit)
 *     afterburner   — brown noise rumble with irregular flutter, torn mid-band noise, crackle
 *                     (a looped buffer of skewed pressure spikes); light-off "whoomph" one-shot
 *   cabin path (cockpit only): inlet-duct howl (fan tone + noise in a resonance), ECS air hiss,
 *     hydraulic whine (gear, speed brake)
 *   JFS (jet fuel starter) whine while starting
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels } from './types';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import { abLightOff, jetCorePct, jetDirectivity, jetFanHz, jetFanPct, jetIntakeHz, jetMix, jetRoarCutoffHz, jetShaftHz, jetWhineHz } from './jetMapping';
import { buzzsawWaveform, crackleSamples, whineWaveform } from './waves';
import { playWhoomph } from './oneshots';

const A = CONFIG.audio;
const J = A.jet;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The afterburner crackle loop's samples, computed once per length/sample rate. */
const CRACKLE = new Map<string, Float32Array>();
function crackleData(n: number, sampleRate: number): Float32Array {
  const k = `${n}/${sampleRate}`;
  let d = CRACKLE.get(k);
  if (!d) {
    d = crackleSamples(n, 97, 180 / sampleRate);
    CRACKLE.set(k, d);
  }
  return d;
}

export function createJetVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const bus = gain(A.engineVolume * J.volume);
  bus.connect(outE);
  const fore = gain(1);
  fore.connect(bus);
  const aft = gain(1);
  aft.connect(bus);

  // ── Turbine whine ──
  const whineWave = b.wave(() => whineWaveform(512), 4, 'whine');
  const w1 = osc(whineWave, 0);
  const w2 = osc('sine', 0);
  const w3 = osc('sine', 0);
  const whineAM = gain(0.88);
  chain(osc('sine', 0.63), gain(0.1)).connect(whineAM.gain);
  chain(w1, gain(1), whineAM);
  chain(w2, gain(0.45), whineAM);
  chain(w3, gain(0.3), whineAM);
  const whine = gain(0);
  chain(whineAM, whine, fore);

  // ── Shaft + fan buzz-saw ──
  const buzz = b.wave(() => buzzsawWaveform(2048, 11), 36, 'buzz11');
  const shaftOsc = osc(buzz, 0);
  const shaftLP = filter('lowpass', 2200, 0.7);
  const shaft = gain(0);
  chain(shaftOsc, shaftLP, shaft, fore);
  const fanOsc = osc(b.wave(() => buzzsawWaveform(2048, 23), 36, 'buzz23'), 0);
  const fanLP = filter('lowpass', 1200, 0.8);
  const fan = gain(0);
  chain(fanOsc, fanLP, fan, fore);

  // ── Roar + rumble ──
  const roarSrc = loop(pink);
  const roarLP1 = filter('lowpass', 800, 0.6);
  const roarLP2 = filter('lowpass', 800, 0.5);
  const roar = gain(0);
  chain(roarSrc, roarLP1, roarLP2, roar, aft);
  const rumbleSrc = loop(brown);
  const rumbleLP = filter('lowpass', 170, 0.7);
  const rumble = gain(0);
  chain(rumbleSrc, rumbleLP, rumble, aft);

  // ── Afterburner ──
  const abSrc = loop(brown);
  const abLP = filter('lowpass', 130, 0.9);
  const abAM = gain(0.8);
  chain(osc('sine', 5.3), gain(0.16)).connect(abAM.gain);
  chain(osc('sine', 8.9), gain(0.1)).connect(abAM.gain);
  const abRumble = gain(0);
  chain(abSrc, abLP, abAM, abRumble, aft);
  const tearSrc = loop(white);
  const tearBP = filter('bandpass', 650, 0.5);
  const abTear = gain(0);
  chain(tearSrc, tearBP, abTear, aft);
  const crackleBuf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2.3), ctx.sampleRate);
  crackleBuf.getChannelData(0).set(crackleData(crackleBuf.length, ctx.sampleRate));
  const crackleSrc = loop(crackleBuf);
  const crackleHP = filter('highpass', 380, 0.7);
  const crackle = gain(0);
  chain(crackleSrc, crackleHP, crackle, aft);

  // ── Jet fuel starter ──
  const jfsOsc = osc(whineWave, 2300);
  const jfsNoise = loop(white);
  const jfsBP = filter('bandpass', 2600, 1.2);
  const starter = gain(0);
  chain(jfsOsc, gain(0.6), starter);
  chain(jfsNoise, jfsBP, gain(0.5), starter);
  starter.connect(bus);

  // ── Cockpit: inlet howl, ECS, hydraulics ──
  const intakeSrc = loop(pink);
  const intakeBP = filter('bandpass', 900, 6);
  const intakeTone = filter('bandpass', 900, 3);
  const intake = gain(0);
  chain(intakeSrc, intakeBP, intake);
  chain(fanOsc, intakeTone, gain(0.5), intake);
  intake.connect(outC);
  const ecsSrc = loop(white);
  const ecsBP = filter('bandpass', 4200, 0.6);
  const ecsLowSrc = loop(pink);
  const ecsLP = filter('lowpass', 520, 0.7);
  const ecs = gain(0);
  chain(ecsSrc, ecsBP, ecs);
  chain(ecsLowSrc, ecsLP, gain(1.6), ecs);
  ecs.connect(outC);
  const hydOsc = osc('sawtooth', J.hydraulicHz);
  chain(osc('sine', 3.1), gain(12)).connect(hydOsc.frequency);
  const hydBP = filter('bandpass', J.hydraulicHz * 2, 2.5);
  const hydSine = osc('sine', J.hydraulicHz * 2);
  const hyd = gain(0);
  chain(hydOsc, hydBP, hyd);
  chain(hydSine, gain(0.25), hyd);
  hyd.connect(outC);
  // A little of the hydraulics is heard outside too (gear doors, pumps in the wheel wells).
  chain(hyd, gain(0.3), outE);

  const K = {
    outE: knob(outE.gain),
    fore: knob(fore.gain),
    aft: knob(aft.gain),
    w1: knob(w1.frequency, 2e-4),
    w2: knob(w2.frequency, 2e-4),
    w3: knob(w3.frequency, 2e-4),
    whine: knob(whine.gain),
    shaftF: knob(shaftOsc.frequency, 2e-4),
    shaft: knob(shaft.gain),
    fanF: knob(fanOsc.frequency, 2e-4),
    fanLP: knob(fanLP.frequency, 1e-3),
    fan: knob(fan.gain),
    roarLP1: knob(roarLP1.frequency, 1e-3),
    roarLP2: knob(roarLP2.frequency, 1e-3),
    roar: knob(roar.gain),
    rumble: knob(rumble.gain),
    abRumble: knob(abRumble.gain),
    abTear: knob(abTear.gain),
    crackle: knob(crackle.gain),
    starter: knob(starter.gain),
    jfsF: knob(jfsOsc.frequency, 1e-3),
    intakeF: knob(intakeBP.frequency, 1e-3),
    intakeToneF: knob(intakeTone.frequency, 1e-3),
    intake: knob(intake.gain),
    ecs: knob(ecs.gain),
    hyd: knob(hyd.gain),
    rates: [roarSrc, rumbleSrc, abSrc, tearSrc].map((s) => knob(s.playbackRate, 1e-3)),
  };

  let prevAb = Number.NaN;
  // Reused per-frame scratch (no allocation in update).
  const mixIn = { corePct: 0, power: 0, afterburner: 0, engineRunning: false, starting: false, crashed: false };
  const m = jetMix(mixIn);
  const extDir = jetDirectivity(0);
  const COCKPIT_DIR = { aft: 0.75, fore: 1 };

  return {
    kind: 'jet',
    refDistanceM: J.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, crashed } = f;
      const tau = f.tau;
      const ab = a.engineRunning ? fin(a.afterburner, 0) : 0;
      mixIn.corePct = jetCorePct(fin(a.rpm, 0));
      mixIn.power = a.power;
      mixIn.afterburner = ab;
      mixIn.engineRunning = !!a.engineRunning;
      mixIn.starting = !!a.starting;
      mixIn.crashed = crashed;
      jetMix(mixIn, m);
      const dir = f.exterior ? jetDirectivity(fin(a.aft, 0), extDir) : COCKPIT_DIR;
      const dop = f.doppler;
      // A crash kills the engine: let the turbine wind down (slower pitch and level fall) instead of cutting.
      const spoolTau = crashed ? 0.6 : tau;
      const whineHz = jetWhineHz(m.corePct) * dop;
      K.w1.set(whineHz, t, spoolTau * (crashed ? 1.5 : 1));
      K.w2.set(whineHz * 1.004, t, spoolTau * (crashed ? 1.5 : 1));
      K.w3.set(whineHz * 1.52, t, spoolTau * (crashed ? 1.5 : 1));
      K.whine.set(J.whine * m.whine, t, spoolTau);
      K.shaftF.set(jetShaftHz(m.corePct) * dop, t, spoolTau);
      K.shaft.set(J.shaft * m.whine, t, spoolTau);
      const fanPct = jetFanPct(m.corePct);
      K.fanF.set(jetFanHz(m.corePct) * dop, t, spoolTau);
      K.fanLP.set(700 + 60 * fanPct, t, tau);
      K.fan.set(J.fan * m.fan, t, spoolTau);
      const cut = jetRoarCutoffHz(m.brightness > 0 ? fin(a.power, 0) : 0, m.abTear);
      K.roarLP1.set(cut, t, tau);
      K.roarLP2.set(cut * 1.3, t, tau);
      K.roar.set(J.roar * m.roar, t, tau);
      K.rumble.set(J.rumble * m.rumble, t, tau);
      K.abRumble.set(J.abRumble * m.abRumble, t, 0.12);
      K.abTear.set(J.abTear * m.abTear, t, 0.12);
      K.crackle.set(J.crackle * m.crackle, t, 0.15);
      K.starter.set(J.starter * m.starter, t, 0.25);
      K.jfsF.set(2300 + 8 * m.corePct, t, 0.3);
      for (const r of K.rates) r.set(dop, t, tau);
      K.fore.set(dir.fore, t, A.cameraRampTau);
      K.aft.set(dir.aft, t, A.cameraRampTau);
      // Canopy + helmet: the engine is much quieter in the cockpit than outside.
      K.outE.set(f.exterior ? 1 : J.cockpitGain, t, A.cameraRampTau);

      const cockpit = !f.exterior;
      const ihz = jetIntakeHz(m.corePct);
      K.intakeF.set(ihz, t, tau);
      K.intakeToneF.set(ihz, t, tau);
      const intakeLevel = cockpit ? m.intake : 0;
      const ecsLevel = cockpit ? m.ecs : 0;
      K.intake.set(J.intake * intakeLevel, t, A.cameraRampTau);
      K.ecs.set(J.ecs * ecsLevel, t, A.cameraRampTau);
      const hydLevel = (a.gearMoving || a.speedBrakeMoving) && !crashed ? J.hydraulicVolume : 0;
      K.hyd.set(hydLevel, t, 0.1);

      L.jet = 1;
      L.turbofan = 0;
      L.corePct = m.corePct;
      L.whineHz = whineHz;
      L.fanHz = jetFanHz(m.corePct) * dop;
      L.whine = m.whine * dir.fore;
      L.fan = m.fan * dir.fore;
      L.roar = m.roar * dir.aft;
      L.afterburner = crashed ? 0 : Math.max(0, Math.min(1, ab));
      L.crackle = m.crackle * dir.aft;
      L.intake = intakeLevel;
      L.ecs = ecsLevel;
      L.hydraulic = hydLevel;
      L.starter = m.starter;
      // The piston's channels are silent while the jet plays.
      L.exhaust = 0;
      L.prop = 0;
      L.mechanical = 0;
      L.cycleHz = 0;
      L.firingHz = 0;
      L.bladeHz = 0;
      L.whistle = 0;
      L.gear = 0;
      L.flap = 0;

      let shots = 0;
      const abNow = crashed ? 0 : ab;
      if (f.primed && abLightOff(prevAb, abNow)) {
        playWhoomph(out.kit, aft, t, J.whoomph);
        shots++;
      }
      prevAb = abNow;
      return shots;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
