/**
 * The Bell 206B-3 JetRanger III's voice: Allison 250-C20J turboshaft, two-blade main and tail rotors,
 * main transmission (see turboshaftMapping.ts for the acoustics).
 *
 *   main rotor (one oscillator period = one revolution, so the two blades can differ a little):
 *     whoosh + thump — pink noise band + brown noise low-pass, gated by a soft pulse per blade passage
 *     slap           — white noise band (centre and Q rise with sharpness), gated by a narrow pulse
 *     crack          — the BVI pressure impulse itself (PeriodicWave) → low-pass opening with sharpness
 *   tail rotor: a blade-pulse PeriodicWave at 2 × 2550/60 Hz → low-pass (opens with tail thrust),
 *     lightly modulated by the main rotor's wake
 *   turbine: compressor whine (2 partials, N1) with a slow waver; power-turbine howl (tone + resonant
 *     noise band, N2); exhaust roar (pink → low-pass) + rumble; starter-generator whine and igniter
 *     ticks while starting; a light-off "whump"
 *   cabin path (cockpit only): transmission whine, turbine whine through the cabin wall
 *
 * The noise sources are shared between channels (one pink, one brown, one white loop). About 55 nodes.
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels } from './types';
import { zeroMarineLevels } from './marineMapping';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import {
  TURBOSHAFT as T, emptyTurboshaftInput, emptyTurboshaftMix, lightOff, rotorDirectivity, turboshaftInputs, turboshaftMix,
} from './turboshaftMapping';
import { bladeSlapWaveform, gateOffset, propWaveform, pulseWaveform, rotorGateWaveform, whineWaveform } from './waves';
import { playWhoomph } from './oneshots';

const A = CONFIG.audio;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

const SOFT_W = 0.075;
const SHARP_W = 0.014;
/** Gate offsets (computed once per page). */
let OFFSETS: { soft: number; sharp: number; ign: number } | null = null;
function offsets() {
  if (!OFFSETS) {
    OFFSETS = {
      soft: gateOffset(rotorGateWaveform(1024, SOFT_W)),
      sharp: gateOffset(rotorGateWaveform(1024, SHARP_W)),
      ign: gateOffset(pulseWaveform(512, 0.06)),
    };
  }
  return OFFSETS;
}

export function createTurboshaftVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;
  const off = offsets();

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const bus = gain(A.engineVolume * T.volume);
  bus.connect(outE);
  const rotorBus = gain(1);
  rotorBus.connect(bus);
  const tailBus = gain(1);
  tailBus.connect(bus);
  const engBus = gain(1);
  engBus.connect(bus);

  // Shared noise.
  const pinkSrc = loop(pink);
  const brownSrc = loop(brown);
  const whiteSrc = loop(white);

  // ── Main rotor ──
  const softOsc = osc(b.wave(() => rotorGateWaveform(1024, SOFT_W), 40, `rotorSoft${SOFT_W}`), 0);
  const sharpOsc = osc(b.wave(() => rotorGateWaveform(1024, SHARP_W), 160, `rotorSharp${SHARP_W}`), 0);
  const crackOsc = osc(b.wave(() => bladeSlapWaveform(1024), 160, 'bladeSlap'), 0);
  const softGate = gain(off.soft);
  softOsc.connect(softGate.gain);
  const whooshBP = filter('bandpass', 650, 0.55);
  const whoosh = gain(0);
  chain(pinkSrc, whooshBP, whoosh, softGate);
  const thumpLP = filter('lowpass', 95, 0.8);
  const thump = gain(0);
  chain(brownSrc, thumpLP, thump, softGate);
  softGate.connect(rotorBus);
  const sharpGate = gain(off.sharp);
  sharpOsc.connect(sharpGate.gain);
  const slapBP = filter('bandpass', 500, 0.8);
  const slap = gain(0);
  chain(whiteSrc, slapBP, slap, sharpGate, rotorBus);
  const crackLP = filter('lowpass', 400, 0.7);
  const crack = gain(0);
  chain(crackOsc, crackLP, crack, rotorBus);

  // ── Tail rotor ──
  const tailOsc = osc(b.wave(() => propWaveform(1024), 40, 'prop'), 0);
  const tailLP = filter('lowpass', 500, 0.7);
  const tailAM = gain(0.85);
  chain(softOsc, gain(0.12)).connect(tailAM.gain);
  const tail = gain(0);
  chain(tailOsc, tailLP, tailAM, tail, tailBus);

  // ── Turbine: compressor whine, power-turbine howl ──
  const whineWave = b.wave(() => whineWaveform(512), 4, 'whine');
  const w1 = osc(whineWave, 0);
  const w2 = osc('sine', 0);
  const whineAM = gain(0.9);
  chain(osc('sine', 0.41), gain(0.08)).connect(whineAM.gain);
  w1.connect(whineAM);
  chain(w2, gain(0.4), whineAM);
  const whine = gain(0);
  chain(whineAM, whine, engBus);
  const whineCabin = gain(0);
  chain(whineAM, whineCabin, outC);
  const howlOsc = osc('triangle', 0);
  const howlBP = filter('bandpass', 1100, 3);
  const howl = gain(0);
  howlOsc.connect(howl);
  chain(pinkSrc, howlBP, gain(0.7), howl);
  howl.connect(engBus);

  // ── Exhaust ──
  const roarLP = filter('lowpass', 500, 0.6);
  const roar = gain(0);
  chain(pinkSrc, roarLP, roar, engBus);
  const rumbleLP = filter('lowpass', 140, 0.7);
  const rumble = gain(0);
  chain(brownSrc, rumbleLP, rumble, engBus);

  // ── Start: starter-generator whine, igniter ticks ──
  const stOsc = osc('sawtooth', 300);
  const stBP = filter('bandpass', 1200, 1.1);
  const starter = gain(0);
  chain(stOsc, stBP, starter, engBus);
  const ignOsc = osc(b.wave(() => pulseWaveform(512, 0.06), 48, 'pulse0.06'), T.igniterHz);
  const ignHP = filter('highpass', 2500, 0.7);
  const ignGate = gain(off.ign);
  ignOsc.connect(ignGate.gain);
  const igniter = gain(0);
  chain(whiteSrc, ignHP, ignGate, igniter, engBus);

  // ── Transmission ──
  const g1 = osc(whineWave, 0);
  const g2 = osc('sine', 0);
  const gearMix = gain(1);
  g1.connect(gearMix);
  chain(g2, gain(0.5), gearMix);
  const gearCabin = gain(0);
  chain(gearMix, gearCabin, outC);
  const gearExt = gain(0);
  chain(gearMix, gearExt, bus);

  const K = {
    outE: knob(outE.gain),
    rotorBus: knob(rotorBus.gain),
    tailBus: knob(tailBus.gain),
    engBus: knob(engBus.gain),
    softF: knob(softOsc.frequency, 2e-4),
    sharpF: knob(sharpOsc.frequency, 2e-4),
    crackF: knob(crackOsc.frequency, 2e-4),
    whoosh: knob(whoosh.gain),
    thump: knob(thump.gain),
    slap: knob(slap.gain),
    slapBP: knob(slapBP.frequency, 1e-3),
    slapQ: knob(slapBP.Q, 1e-3),
    crack: knob(crack.gain),
    crackLP: knob(crackLP.frequency, 1e-3),
    tailF: knob(tailOsc.frequency, 2e-4),
    tailLP: knob(tailLP.frequency, 1e-3),
    tail: knob(tail.gain),
    w1: knob(w1.frequency, 2e-4),
    w2: knob(w2.frequency, 2e-4),
    whine: knob(whine.gain),
    whineCabin: knob(whineCabin.gain),
    howlF: knob(howlOsc.frequency, 2e-4),
    howlBP: knob(howlBP.frequency, 1e-3),
    howl: knob(howl.gain),
    roarLP: knob(roarLP.frequency, 1e-3),
    roar: knob(roar.gain),
    rumble: knob(rumble.gain),
    stF: knob(stOsc.frequency, 1e-3),
    starter: knob(starter.gain),
    igniter: knob(igniter.gain),
    g1: knob(g1.frequency, 2e-4),
    g2: knob(g2.frequency, 2e-4),
    gearCabin: knob(gearCabin.gain),
    gearExt: knob(gearExt.gain),
    rates: [pinkSrc, brownSrc, whiteSrc].map((s) => knob(s.playbackRate, 1e-3)),
  };

  // Reused per-frame scratch (no allocation in update).
  const mi = emptyTurboshaftInput();
  const m = emptyTurboshaftMix();
  const extDir = rotorDirectivity(0);
  const COCKPIT_DIR = { main: 1, tail: 0.6, engine: 0.8 };
  let prevN1 = Number.NaN;

  return {
    kind: 'turboshaft',
    refDistanceM: T.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, tau, crashed } = f;
      turboshaftInputs(a, mi);
      mi.crashed = crashed;
      turboshaftMix(mi, m);
      const dir = f.exterior ? rotorDirectivity(fin(a.aft, 0), extDir) : COCKPIT_DIR;
      const dop = f.doppler;
      // With the rotor state the physics spools N1/NR; without it (or after a crash) let things wind down.
      const spoolTau = crashed ? 0.8 : a.rotor ? tau : 0.6;
      const cockpit = !f.exterior;

      // Main rotor
      K.softF.set(m.revHz * dop, t, spoolTau);
      K.sharpF.set(m.revHz * dop, t, spoolTau);
      K.crackF.set(m.revHz * dop, t, spoolTau);
      K.whoosh.set(T.whoosh * m.whoosh, t, tau);
      K.thump.set(T.thump * m.thump, t, tau);
      K.slap.set(T.slap * m.slap, t, tau);
      K.slapBP.set(450 + 900 * m.sharpness, t, tau);
      K.slapQ.set(0.7 + 0.9 * m.sharpness, t, tau);
      K.crack.set(T.crack * m.crack, t, tau);
      K.crackLP.set(300 + 1500 * m.sharpness, t, tau);
      // Tail rotor
      K.tailF.set(m.tailHz * dop, t, spoolTau);
      K.tailLP.set(350 + 1100 * m.tailBright, t, tau);
      K.tail.set(T.tail * m.tail, t, tau);
      // Turbine
      const whineHz = Math.min(16000, m.whineHz * dop);
      K.w1.set(whineHz, t, spoolTau);
      K.w2.set(Math.min(16000, whineHz * 0.56), t, spoolTau);
      K.whine.set(T.whine * m.whine, t, spoolTau);
      K.whineCabin.set(cockpit ? T.whineCabin * m.whine : 0, t, A.cameraRampTau);
      K.howlF.set(m.howlHz * dop, t, spoolTau);
      K.howlBP.set(Math.max(40, m.howlHz * dop), t, spoolTau);
      K.howl.set(T.howl * m.howl, t, spoolTau);
      K.roarLP.set(300 + 1400 * m.roarBright, t, tau);
      K.roar.set(T.roar * m.roar, t, spoolTau);
      K.rumble.set(T.rumble * m.rumble, t, spoolTau);
      K.stF.set(m.starterHz, t, 0.3);
      K.starter.set(T.starter * m.starter, t, 0.25);
      K.igniter.set(T.igniter * m.igniter, t, 0.05);
      // Transmission
      K.g1.set(m.gearHz * dop, t, spoolTau);
      K.g2.set(m.gearHz * T.gearMesh2Ratio * dop, t, spoolTau);
      K.gearCabin.set(cockpit ? T.gearCabin * m.gear : 0, t, A.cameraRampTau);
      K.gearExt.set(cockpit ? 0 : T.gearExterior * m.gear, t, A.cameraRampTau);
      for (const r of K.rates) r.set(dop, t, tau);
      K.rotorBus.set(dir.main, t, A.cameraRampTau);
      K.tailBus.set(dir.tail, t, A.cameraRampTau);
      K.engBus.set(dir.engine, t, A.cameraRampTau);
      K.outE.set(cockpit ? T.cockpitGain : 1, t, A.cameraRampTau);

      L.turboshaft = 1;
      L.rotorPct = m.nrPct;
      L.bladeHz = m.bladeHz * dop;
      L.slap = Math.max(m.slap, m.crack) * dir.main;
      L.slapSharpness = m.sharpness;
      L.tailRotor = m.tail * dir.tail;
      L.tailHz = m.tailHz * dop;
      L.gearbox = m.gear;
      L.corePct = mi.n1 * 100;
      L.whineHz = whineHz;
      L.whine = m.whine * dir.engine;
      L.roar = m.roar * dir.engine;
      L.starter = m.starter;
      // The other voices' channels are silent.
      L.jet = 0;
      L.turbofan = 0;
      L.fanHz = 0;
      L.fan = 0;
      L.afterburner = 0;
      L.crackle = 0;
      L.intake = 0;
      L.ecs = 0;
      L.hydraulic = 0;
      L.exhaust = 0;
      L.prop = 0;
      L.mechanical = 0;
      L.cycleHz = 0;
      L.firingHz = 0;
      L.whistle = 0;
      L.gear = 0;
      L.flap = 0;
      zeroMarineLevels(L);

      let shots = 0;
      const n1 = crashed ? 0 : mi.n1;
      if (f.primed && a.rotor && lightOff(prevN1, n1, !!a.starting)) {
        playWhoomph(out.kit, engBus, t, T.lightOff);
        shots++;
      }
      prevN1 = n1;
      return shots;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
