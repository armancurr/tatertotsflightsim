/**
 * The Sea-Doo RXP-X 325's voice (aircraft sound 'pwc'): a Rotax 1630 ACE supercharged in-line triple
 * driving the jet pump's impeller, and a small planing hull (see pwcMapping.ts for the acoustics).
 *
 *   engine:
 *     firing tone — PeriodicWave of one 3-cylinder cycle (uneven pulses: the half-order growl) → drive gain
 *                   → tanh waveshaper (buzzy; harder under load) → low-pass opening with load
 *     snarl       — white noise band gated at the firing rate (the raspy edge, loudest under load)
 *     exhaust     — brown noise → low-pass (the waterline outlet: dull and wet at idle) → AM by the cycle;
 *                   a wet, bubbly gurgle band at idle
 *     supercharger — the compressor wheel's whine (1.3 … 6 kHz), louder with boost and load
 *     machinery whirr, starter motor + compression chug
 *   pump: water roar through the impeller (band sweeping with the jet speed), the nozzle's hiss, a faint
 *     impeller blade tone, cavitation churn on hard launches; ventilation (airborne): a hollow fluttering
 *     sputter while the roar falls away
 *   hull: rush + spray hiss, displacement gurgle, planing skim, grinding aground; random, snappy slaps
 *   one-shots: the engine catching, the stop cough, the blow-off whoosh (throttle chopped at high rpm), the
 *     iBR bucket (servo whirr + clunk), landing a jump (slam + splash), slaps, running aground
 *   rider's view (cockpit): open air — the engine under the seat (a structure-borne rumble on the cabin path),
 *     water and wind loud; about as loud as the chase view
 *
 * The noise sources are shared between channels (one white, one pink, one brown loop).
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels } from './types';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import {
  PWC as P, blowOffStep, clamp, emptyPwcEngine, emptyPwcEngineMix, emptyPwcPumpMix, emptyPwcWaterMix, landingStep, newAirState,
  newBlowOff, pwcEngineMix, pwcFiringHz, pwcPumpMix, pwcRundownRpm, pwcWaterMix, sanitisePwcEngine, tripleCycleWaveform,
} from './pwcMapping';
import { slapChance } from './marineMapping';
import { playGrounding } from './marineDiesel';
import { zeroRotorLevels } from './turboshaftMapping';
import { gateOffset, pulseWaveform, whineWaveform } from './waves';
import { noiseBurst, toneBurst, type OneShotKit } from './oneshots';

const A = CONFIG.audio;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Waveshaper input range maps to tanh(SHAPE_K · x); the drive gain is drive / SHAPE_K. */
const SHAPE_K = 2.5;
let SHAPE: Float32Array<ArrayBuffer> | null = null;
function shapeCurve(): Float32Array<ArrayBuffer> {
  if (!SHAPE) {
    const n = 1025;
    SHAPE = new Float32Array(n);
    for (let i = 0; i < n; i++) SHAPE[i] = Math.tanh(SHAPE_K * ((i / (n - 1)) * 2 - 1));
  }
  return SHAPE;
}
const RASP_DUTY = 0.3;
let RASP_OFFSET: number | null = null;
const raspOffset = () => (RASP_OFFSET ??= gateOffset(pulseWaveform(512, RASP_DUTY)));

// ── One-shots ──

/** The Rotax catching: a few quick pops, a short rev flare and a blip of supercharger whine. */
export function playPwcCatch(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  const pops = [0, 0.045, 0.085, 0.12];
  for (let p = 0; p < pops.length; p++) {
    noiseBurst(k, dest, t + pops[p], { buffer: k.brown, filter: 'lowpass', freq: 650, q: 0.9, peak: level * (0.4 + 0.3 * k.rnd()), attack: 0.002, tau: 0.03 });
  }
  toneBurst(k, dest, t + 0.05, { type: 'sawtooth', freq: 45, freqEnd: 90, sweep: 0.18, peak: 0.25 * level, attack: 0.02, tau: 0.14 });
  toneBurst(k, dest, t + 0.08, { type: 'sine', freq: 1300, freqEnd: 2300, sweep: 0.2, peak: 0.05 * level, attack: 0.03, tau: 0.12 });
}

/** The engine stopping: a last cough through the wet exhaust. */
export function playPwcCough(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 420, q: 0.9, peak: 0.7 * level, attack: 0.004, tau: 0.06 });
  noiseBurst(k, dest, t + 0.03, { buffer: k.pink, filter: 'bandpass', freq: 320, q: 2.5, peak: 0.35 * level, attack: 0.01, tau: 0.12 });
  toneBurst(k, dest, t, { type: 'sine', freq: 48, freqEnd: 30, sweep: 0.15, peak: 0.4 * level, attack: 0.006, tau: 0.08 });
}

/** Throttle chopped at high rpm: the boost dumps — a quick falling whoosh with a flutter. */
export function playBlowOff(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  noiseBurst(k, dest, t, { buffer: k.white, filter: 'bandpass', freq: 3600, freqEnd: 900, sweep: 0.35, q: 1.4, peak: 0.5 * level, attack: 0.008, tau: 0.11 });
  noiseBurst(k, dest, t + 0.02, { buffer: k.pink, filter: 'bandpass', freq: 900, freqEnd: 400, sweep: 0.3, q: 2, peak: 0.3 * level, attack: 0.01, tau: 0.09, rate: 1.4 });
}

/** The iBR bucket moving: a short servo whirr, then the bucket's clunk (a plastic-and-aluminium thunk). */
export function playBucketClunk(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  toneBurst(k, dest, t, { type: 'sawtooth', freq: 210, freqEnd: 300, sweep: 0.22, peak: 0.05 * level, attack: 0.03, tau: 0.07 });
  const tc = t + 0.2;
  toneBurst(k, dest, tc, { type: 'sine', freq: 115, freqEnd: 62, sweep: 0.08, peak: 0.7 * level, tau: 0.045 });
  noiseBurst(k, dest, tc, { buffer: k.brown, filter: 'bandpass', freq: 480, q: 1.4, peak: 0.6 * level, tau: 0.04 });
  toneBurst(k, dest, tc + 0.002, { type: 'triangle', freq: 1400 + 200 * k.rnd(), peak: 0.05 * level, tau: 0.05 });
}

/**
 * A wave against the small hull: lighter and snappier than a yacht's — a short knock, a bright splash and,
 * when strong, spray and (planing) a hollow slam. `i` 0..1.
 */
export function playPwcSlap(k: OneShotKit, dest: AudioNode, t: number, i: number, planing: number): void {
  const I = clamp(fin(i, 0), 0, 1);
  if (I <= 0.005) return;
  noiseBurst(k, dest, t, {
    buffer: k.brown, filter: 'lowpass', freq: 420 + 300 * I, freqEnd: 160, sweep: 0.07, q: 0.9, peak: 0.8 * I, attack: 0.002, tau: 0.018 + 0.03 * I,
  });
  noiseBurst(k, dest, t + 0.004, {
    buffer: k.pink, filter: 'bandpass', freq: 1200 + 1200 * k.rnd(), freqEnd: 600, sweep: 0.12, q: 1, peak: 0.4 * I, attack: 0.003, tau: 0.035 + 0.07 * I,
  });
  if (I > 0.35) {
    noiseBurst(k, dest, t + 0.012, { buffer: k.white, filter: 'highpass', freq: 3000, q: 0.7, peak: 0.18 * I * I, attack: 0.012, tau: 0.08 + 0.14 * I });
  }
  if (planing > 0.5 && I > 0.5) {
    toneBurst(k, dest, t, { type: 'sine', freq: 90, freqEnd: 46, sweep: 0.07, peak: 0.55 * I, attack: 0.002, tau: 0.05 });
  }
}

/** Landing a jump: the hull slams flat (a low thump), a big splash and a spray curtain. `i` 0.3..1. */
export function playLandingSplash(k: OneShotKit, dest: AudioNode, t: number, i: number): void {
  const I = clamp(fin(i, 0), 0.2, 1);
  toneBurst(k, dest, t, { type: 'sine', freq: 72, freqEnd: 34, sweep: 0.16, peak: 0.9 * I, attack: 0.003, tau: 0.09 + 0.05 * I });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 520, freqEnd: 130, sweep: 0.25, q: 0.8, peak: 0.9 * I, attack: 0.003, tau: 0.09 + 0.06 * I });
  noiseBurst(k, dest, t + 0.01, { buffer: k.pink, filter: 'bandpass', freq: 1100, freqEnd: 420, sweep: 0.4, q: 0.8, peak: 0.6 * I, attack: 0.008, tau: 0.18 + 0.12 * I });
  noiseBurst(k, dest, t + 0.03, { buffer: k.white, filter: 'highpass', freq: 2400, q: 0.6, peak: 0.28 * I, attack: 0.03, tau: 0.25 + 0.2 * I });
}

export function createPwcVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const bus = gain(A.engineVolume * P.volume);
  bus.connect(outE);
  const engBus = gain(1);
  engBus.connect(bus);
  const waterBus = gain(1);
  waterBus.connect(bus);
  const fx = gain(A.effectsVolume);
  fx.connect(bus);

  const whiteSrc = loop(white);
  const pinkSrc = loop(pink);
  const brownSrc = loop(brown);

  // ── The Rotax triple ──
  const cyc = osc(b.wave(() => tripleCycleWaveform(2048), 96, 'tripleCycle'), 0);
  const drive = gain(0.3 / SHAPE_K);
  const shaper = ctx.createWaveShaper();
  shaper.curve = shapeCurve();
  b.nodes.push(shaper);
  const toneLP = filter('lowpass', 400, 0.8);
  const tone = gain(0);
  chain(cyc, drive, shaper, toneLP, tone, engBus);
  // The snarl: a noise band gated at every firing.
  const raspBP = filter('bandpass', 1500, 1.1);
  const raspOsc = osc(b.wave(() => pulseWaveform(512, RASP_DUTY), 32, `pulse${RASP_DUTY}`), 0);
  const raspGate = gain(raspOffset());
  raspOsc.connect(raspGate.gain);
  const rasp = gain(0);
  chain(whiteSrc, raspBP, raspGate, rasp, engBus);
  // Waterline exhaust: dull and wet at idle, AM by the cycle.
  const exLP = filter('lowpass', 260, 0.8);
  const exAM = gain(0.5);
  chain(cyc, gain(0.5)).connect(exAM.gain);
  const ex = gain(0);
  chain(brownSrc, exLP, exAM, ex, engBus);
  // The wet gurgle at idle: a resonant band wandering around 300 Hz, fluttering like bubbles.
  const gurBP = filter('bandpass', 300, 3.2);
  chain(osc('sine', 2.1), gain(90)).connect(gurBP.frequency);
  const gurAM = gain(0.55);
  chain(osc('sine', 7.3), gain(0.3)).connect(gurAM.gain);
  chain(osc('sine', 11.9), gain(0.2)).connect(gurAM.gain);
  const gurgle = gain(0);
  chain(pinkSrc, gurBP, gurAM, gurgle, engBus);
  // Supercharger whine.
  const whineOsc = osc(b.wave(() => whineWaveform(512), 4, 'whine'), 1200);
  const whine = gain(0);
  chain(whineOsc, whine, engBus);
  // Machinery whirr (cam chain, gears), modulated by the cycle.
  const mechBP = filter('bandpass', 1400, 1.6);
  const mechAM = gain(0.7);
  chain(cyc, gain(0.3)).connect(mechAM.gain);
  const mech = gain(0);
  chain(pinkSrc, mechBP, mechAM, mech, engBus);
  // Starter: a small, fast motor whine + the compression chug at the cranking firing rate.
  const crankLfo = osc('sine', 12);
  const stOsc = osc('sawtooth', 300);
  const stBP = filter('bandpass', 1400, 1.4);
  const stAM = gain(0.5);
  chain(crankLfo, gain(0.5)).connect(stAM.gain);
  chain(stOsc, stBP, stAM);
  const crankLP = filter('lowpass', 300, 0.8);
  const crank = gain(0);
  chain(brownSrc, crankLP, crank, stAM);
  const starter = gain(0);
  chain(stAM, starter, engBus);

  // ── The pump ──
  const roarBP = filter('bandpass', 400, 0.7);
  const roar = gain(0);
  chain(pinkSrc, roarBP, roar, waterBus);
  const nozHP = filter('highpass', 2200, 0.6);
  const nozzle = gain(0);
  chain(whiteSrc, nozHP, nozzle, waterBus);
  const bladeOsc = osc('triangle', 100);
  const blade = gain(0);
  chain(bladeOsc, blade, waterBus);
  const cavBP = filter('bandpass', 1800, 0.8);
  const cavAM = gain(0.6);
  chain(osc('sine', 23), gain(0.25)).connect(cavAM.gain);
  chain(osc('sine', 37), gain(0.15)).connect(cavAM.gain);
  const cav = gain(0);
  chain(whiteSrc, cavBP, cavAM, cav, waterBus);
  // Ventilation: a hollow resonant band, chopped into a sputter.
  const ventBP = filter('bandpass', 500, 4);
  const ventAM = gain(0.45);
  const ventLfo = osc('sawtooth', 12);
  chain(ventLfo, gain(0.45)).connect(ventAM.gain);
  const vent = gain(0);
  chain(pinkSrc, ventBP, ventAM, vent, waterBus);

  // The engine under the seat (rider's view only): a structure-borne rumble on the cabin path.
  const cabinLP = filter('lowpass', 140, 0.7);
  const cabinRumble = gain(0);
  chain(cyc, cabinLP, cabinRumble, outC);

  // ── The hull ──
  const slowLfo = osc('sine', 0.31);
  const rushBP = filter('bandpass', 500, 0.7);
  const rushAM = gain(0.85);
  chain(slowLfo, gain(0.12)).connect(rushAM.gain);
  const rush = gain(0);
  chain(pinkSrc, rushBP, rushAM, rush, waterBus);
  const hissHP = filter('highpass', 3500, 0.6);
  const hiss = gain(0);
  chain(whiteSrc, hissHP, hiss, waterBus);
  const washLP = filter('lowpass', 380, 0.8);
  const washAM = gain(0.7);
  chain(osc('sine', 1.1), gain(0.25)).connect(washAM.gain);
  chain(slowLfo, gain(0.15)).connect(washAM.gain);
  const wash = gain(0);
  chain(brownSrc, washLP, washAM, wash, waterBus);
  const skimBP = filter('bandpass', 4600, 1.1);
  const skim = gain(0);
  chain(whiteSrc, skimBP, skim, waterBus);
  const grindBP = filter('bandpass', 700, 1.6);
  chain(osc('sine', 0.9), gain(250)).connect(grindBP.frequency);
  const grindAM = gain(0.6);
  chain(osc('sawtooth', 11), gain(0.4)).connect(grindAM.gain);
  const grind = gain(0);
  chain(pinkSrc, grindBP, grindAM, grind, waterBus);
  const grindLP = filter('lowpass', 160, 0.8);
  const grindRumble = gain(0);
  chain(brownSrc, grindLP, grindRumble, waterBus);

  const K = {
    outE: knob(outE.gain),
    engBus: knob(engBus.gain),
    waterBus: knob(waterBus.gain),
    cyc: knob(cyc.frequency, 2e-4),
    drive: knob(drive.gain, 1e-3),
    toneLP: knob(toneLP.frequency, 1e-3),
    tone: knob(tone.gain),
    raspF: knob(raspOsc.frequency, 2e-4),
    raspBP: knob(raspBP.frequency, 1e-3),
    rasp: knob(rasp.gain),
    exLP: knob(exLP.frequency, 1e-3),
    ex: knob(ex.gain),
    gurgle: knob(gurgle.gain),
    whineF: knob(whineOsc.frequency, 1e-3),
    whine: knob(whine.gain),
    mechBP: knob(mechBP.frequency, 1e-3),
    mech: knob(mech.gain),
    crankF: knob(crankLfo.frequency, 1e-3),
    stF: knob(stOsc.frequency, 1e-3),
    starter: knob(starter.gain),
    crank: knob(crank.gain),
    roarBP: knob(roarBP.frequency, 1e-3),
    roar: knob(roar.gain),
    nozzle: knob(nozzle.gain),
    bladeF: knob(bladeOsc.frequency, 2e-4),
    blade: knob(blade.gain),
    cav: knob(cav.gain),
    ventBP: knob(ventBP.frequency, 1e-3),
    ventF: knob(ventLfo.frequency, 1e-3),
    vent: knob(vent.gain),
    cabinRumble: knob(cabinRumble.gain),
    rushBP: knob(rushBP.frequency, 1e-3),
    rush: knob(rush.gain),
    hiss: knob(hiss.gain),
    wash: knob(wash.gain),
    skim: knob(skim.gain),
    grind: knob(grind.gain),
    grindRumble: knob(grindRumble.gain),
    rates: [whiteSrc, pinkSrc, brownSrc].map((s) => knob(s.playbackRate, 1e-3)),
  };

  // Reused per-frame scratch (no allocation in update).
  const E = emptyPwcEngine();
  const M = emptyPwcEngineMix();
  const U = emptyPwcPumpMix();
  const W = emptyPwcWaterMix();
  const blow = newBlowOff();
  const jump = newAirState();
  const prev = { starting: false, aground: false, er: 0, gear: Number.NaN };
  let er = 0;

  return {
    kind: 'pwc',
    refDistanceM: P.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, tau, crashed } = f;
      const dt = Math.max(0, fin(f.dt, 0));
      const v = a.vessel;
      const running = !!a.engineRunning && !crashed;
      const starting = !!a.starting && !crashed;
      const cockpit = !f.exterior;
      const dop = f.doppler;

      // The engine and pump (one propulsor; none → from rpm / power).
      const count = v ? clamp(Math.floor(fin(v.engineCount, 0)), 0, v.engines?.length ?? 0) : 0;
      sanitisePwcEngine(count >= 1 ? v!.engines[0] : undefined, a, E);
      er = pwcRundownRpm(er, E.rpm, running, dt);
      const vent = crashed ? 0 : E.ventilation;
      const m = pwcEngineMix(er, E.load, E.boost, vent, running, crashed, M);
      K.cyc.set(m.cycleHz * dop, t, tau);
      K.raspF.set(m.firingHz * dop, t, tau);
      K.drive.set(m.drive / SHAPE_K, t, tau);
      K.toneLP.set(300 + 3000 * m.bright, t, tau);
      K.tone.set((P.tone * m.tone) / Math.tanh(m.drive), t, tau);
      K.raspBP.set(m.raspHz * dop, t, tau);
      K.rasp.set(P.rasp * m.rasp, t, tau);
      K.exLP.set(m.exhaustLpHz, t, tau);
      K.ex.set(P.exhaust * m.exhaust, t, tau);
      K.gurgle.set(P.gurgle * m.gurgle, t, tau);
      K.whineF.set(Math.min(16000, m.whineHz * dop), t, 0.08);
      K.whine.set(P.whine * m.whine, t, 0.12);
      K.mechBP.set(1000 + 2200 * clamp(er / P.maxRpm, 0, 1.25), t, tau);
      K.mech.set(P.mech * m.mech, t, tau);
      // Starter
      K.crankF.set(Math.max(4, pwcFiringHz(E.rpm)), t, tau);
      K.stF.set(260 + 0.25 * E.rpm, t, 0.15);
      K.starter.set(starting ? P.starter : 0, t, 0.05);
      K.crank.set(P.crank, t, tau);

      // The pump
      const speedMs = fin(v?.speedMs, 0);
      const u = pwcPumpMix(er, E.flow, E.jetSpeed, running ? E.load : 0, speedMs, vent, crashed, U);
      K.roarBP.set(u.roarHz * dop, t, tau);
      K.roar.set(P.roar * u.roar, t, 0.08);
      K.nozzle.set(P.nozzle * u.nozzle, t, 0.08);
      K.bladeF.set(Math.max(1, u.bladeHz * dop), t, tau);
      K.blade.set(P.blade * u.blade, t, tau);
      K.cav.set(P.cavitation * u.cavitation, t, 0.08);
      K.ventBP.set(u.ventBandHz * dop, t, tau);
      K.ventF.set(u.ventRateHz, t, tau);
      K.vent.set(P.vent * u.vent, t, 0.06);

      // The hull
      const planing = fin(v?.planing, 0);
      const heave = fin(v?.heaveMs, 0);
      const w = pwcWaterMix(speedMs, planing, heave, fin(v?.pitchRate, 0), fin(v?.rollRate, 0), !!v?.aground, vent, W);
      K.rushBP.set(w.rushHz * dop, t, tau);
      K.rush.set(P.rush * w.rush, t, tau);
      K.hiss.set(P.hiss * w.hiss, t, tau);
      K.wash.set(P.wash * w.wash, t, tau);
      K.skim.set(P.skim * w.skim, t, tau);
      K.grind.set(P.grind * w.grind, t, 0.08);
      K.grindRumble.set(P.grindRumble * w.grind, t, 0.08);
      for (const r of K.rates) r.set(dop, t, tau);

      // View: open air either way; in the rider's seat the engine is under you (the seat rumble), the water all around.
      const dirEng = cockpit ? P.cockpitEngines : 0.8 + 0.2 * smooth(-0.6, 0.9, fin(a.aft, 0));
      K.engBus.set(dirEng, t, A.cameraRampTau);
      K.waterBus.set(cockpit ? P.cockpitWater : 1, t, A.cameraRampTau);
      K.outE.set(cockpit ? P.cockpitGain : 1, t, A.cameraRampTau);
      K.cabinRumble.set(cockpit ? P.cabinRumble * m.tone : 0, t, A.cameraRampTau);

      L.pwc = 1;
      L.pump = u.roar;
      L.pumpVent = u.vent;
      L.marine = 0;
      L.marineRpm = er;
      L.engineLoad = m.load;
      L.turbo = m.whine;
      L.turboHz = m.whineHz * dop;
      L.hullRush = w.rush;
      L.skim = w.skim;
      L.wash = w.wash;
      L.slapRate = crashed ? 0 : w.slapRate;
      L.grind = w.grind;
      L.firingHz = m.firingHz * dop;
      L.cycleHz = m.cycleHz * dop;
      L.bladeHz = u.bladeHz * dop;
      L.exhaust = m.exhaust;
      L.mechanical = m.rasp;
      L.prop = u.blade;
      L.starter = starting ? 1 : 0;
      // The other voices' channels are silent.
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
      L.whistle = 0;
      L.gear = 0;
      L.flap = 0;
      zeroRotorLevels(L);

      // One-shots (the detectors run every frame so their memory stays current).
      const blowOff = blowOffStep(blow, er, running ? E.load : 0, vent, running, dt);
      const landed = landingStep(jump, running ? vent : 0, heave, dt);
      const landing = running ? landed : 0;
      let shots = 0;
      const kit = out.kit;
      if (f.primed && !crashed) {
        if (prev.starting && !starting && running) {
          playPwcCatch(kit, engBus, t, P.catchLevel);
          shots++;
        }
        if (!running && !starting && prev.er >= P.coughRpm && er < P.coughRpm) {
          playPwcCough(kit, engBus, t, P.coughLevel);
          shots++;
        }
        if (blowOff) {
          playBlowOff(kit, engBus, t, P.blowOffLevel * (0.6 + 0.4 * smooth(P.blowOffRpm, P.maxRpm, er)));
          shots++;
        }
        if (count >= 1 && Number.isFinite(prev.gear) && E.gear !== prev.gear) {
          playBucketClunk(kit, fx, t, P.clunkLevel);
          L.gearClunks++;
          shots++;
        }
        if (landing > 0) {
          playLandingSplash(kit, waterBus, t, landing * P.landingLevel);
          shots++;
        }
        if (v?.aground && !prev.aground) {
          playGrounding(kit, waterBus, t, 0.3 + 0.7 * smooth(0.5, 10, w.speedKt));
          shots++;
        }
        if (dt > 0 && !a.paused && rnd() < slapChance(w.slapRate, dt)) {
          const i = w.slapIntensity * (0.45 + 0.75 * rnd());
          playPwcSlap(kit, waterBus, t, Math.min(1, i) * P.slapLevel, planing);
          L.hullSlaps++;
        }
      }
      prev.gear = count >= 1 ? E.gear : Number.NaN;
      prev.starting = starting;
      prev.aground = !!v?.aground;
      prev.er = er;
      return shots;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
