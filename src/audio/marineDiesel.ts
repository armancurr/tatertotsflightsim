/**
 * The Princess V50's voice (aircraft sound 'marineDiesel'): twin Volvo Penta D6-435 diesels
 * (6-cylinder in-line, 4-stroke, turbocharged) on IPS 600 pod drives, and the hull in the water
 * (see marineMapping.ts for the acoustics).
 *
 *   per engine (port, starboard — slightly detuned, so they beat):
 *     firing tone — PeriodicWave of one 6-cylinder cycle → drive gain → tanh waveshaper (harder under
 *                   load) → low-pass opening with load
 *     clatter     — white noise band gated by a narrow pulse at the firing rate (compression knock)
 *     exhaust     — brown noise → low-pass (underwater, through the prop hubs; more open at idle through
 *                   the idle-relief ports) → AM by the cycle
 *     turbo       — whistle rising with boost and rpm
 *   shared: bubbly underwater exhaust burble, machinery whirr, starter motor + compression chug,
 *     propeller thrum and cavitation churn
 *   water: rush along the hull (band sweeping with speed) + hiss, displacement wash / gurgle, planing
 *     skim, grinding when aground; random hull slaps (one-shots whose rate follows speed and the hull's
 *     motion in the waves)
 *   one-shots: the engines catching, the run-down shudder, gearbox clunks (ahead / neutral / astern),
 *     running aground
 *   cockpit (helm inside the saloon): engines under the floor (low-passed, quieter, a structure-borne
 *     rumble on the cabin path), the hull louder
 *
 * The noise sources are shared between channels (one white, one pink, one brown loop). About 85 nodes.
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels, MarineEngineAudioInputs } from './types';
import { createBuilder, retireGraph, type EngineVoice, type VoiceFrame, type VoiceOutputs } from './builder';
import {
  MARINE as M, clamp, emptyEngineMix, emptyWaterMix, fallbackEngine, marineEngineMix, marineFiringHz, marineWaterMix,
  rundownRpm, sanitiseEngine, slapChance,
} from './marineMapping';
import { zeroRotorLevels } from './turboshaftMapping';
import { dieselCycleWaveform, gateOffset, propWaveform, pulseWaveform, whineWaveform } from './waves';
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
const KNOCK_DUTY = 0.16;
let KNOCK_OFFSET: number | null = null;
const knockOffset = () => (KNOCK_OFFSET ??= gateOffset(pulseWaveform(512, KNOCK_DUTY)));

// ── One-shots ──

/** The diesel catching: a few irregular heavy firings, a clattery burst, a low cough. */
export function playDieselCatch(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  const pops = [0, 0.07, 0.12, 0.17, 0.21, 0.26];
  for (let p = 0; p < pops.length; p++) {
    noiseBurst(k, dest, t + pops[p], {
      buffer: k.brown, filter: 'lowpass', freq: 420, q: 0.9, peak: level * (0.45 + 0.35 * k.rnd()), attack: 0.002, tau: 0.04,
    });
  }
  noiseBurst(k, dest, t + 0.05, { buffer: k.white, filter: 'bandpass', freq: 2400, q: 1.2, peak: 0.25 * level, attack: 0.01, tau: 0.22 });
  toneBurst(k, dest, t, { type: 'sine', freq: 42, freqEnd: 62, sweep: 0.2, peak: 0.6 * level, attack: 0.02, tau: 0.18 });
}

/** The gearbox engaging or disengaging (dog clutch in the IPS leg): a low thunk and a metallic tick. */
export function playMarineClunk(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  toneBurst(k, dest, t, { type: 'sine', freq: 74, freqEnd: 44, sweep: 0.09, peak: 0.9 * level, tau: 0.06 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'bandpass', freq: 320, q: 1.3, peak: 0.8 * level, tau: 0.05 });
  toneBurst(k, dest, t + 0.003, { type: 'triangle', freq: 880 + 120 * k.rnd(), peak: 0.06 * level, tau: 0.08 });
}

/** The engine rocking back on its mounts as it stops. */
export function playShudder(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  toneBurst(k, dest, t, { type: 'sine', freq: 34, freqEnd: 22, sweep: 0.25, peak: 0.8 * level, attack: 0.01, tau: 0.16 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 220, q: 0.8, peak: 0.6 * level, attack: 0.005, tau: 0.1 });
}

/**
 * A wave against the hull: a thud (brown noise, low-pass), a splash (pink band) and, when strong, spray
 * (white hiss) and — planing — a slam (low sine). `i` 0..1.
 */
export function playHullSlap(k: OneShotKit, dest: AudioNode, t: number, i: number, planing: number): void {
  const I = clamp(fin(i, 0), 0, 1);
  if (I <= 0.005) return;
  noiseBurst(k, dest, t, {
    buffer: k.brown, filter: 'lowpass', freq: 240 + 260 * I, freqEnd: 110, sweep: 0.12, q: 0.8, peak: 0.9 * I, attack: 0.004, tau: 0.035 + 0.05 * I,
  });
  noiseBurst(k, dest, t + 0.008, {
    buffer: k.pink, filter: 'bandpass', freq: 800 + 1000 * k.rnd(), freqEnd: 450, sweep: 0.2, q: 0.9, peak: 0.45 * I, attack: 0.006, tau: 0.06 + 0.12 * I,
  });
  if (I > 0.3) {
    noiseBurst(k, dest, t + 0.02, { buffer: k.white, filter: 'highpass', freq: 2800, q: 0.7, peak: 0.2 * I * I, attack: 0.02, tau: 0.15 + 0.2 * I });
  }
  if (planing > 0.5 && I > 0.55) {
    toneBurst(k, dest, t, { type: 'sine', freq: 60, freqEnd: 34, sweep: 0.12, peak: 0.7 * I, attack: 0.003, tau: 0.09 });
  }
}

/** Running aground: a heavy thump through the hull. `i` 0..1. */
export function playGrounding(k: OneShotKit, dest: AudioNode, t: number, i: number): void {
  const I = clamp(fin(i, 0), 0.2, 1);
  toneBurst(k, dest, t, { type: 'sine', freq: 48, freqEnd: 26, sweep: 0.3, peak: 0.9 * I, attack: 0.004, tau: 0.2 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 320, freqEnd: 120, sweep: 0.4, q: 0.8, peak: 0.9 * I, attack: 0.004, tau: 0.22 });
  noiseBurst(k, dest, t + 0.01, { buffer: k.pink, filter: 'bandpass', freq: 700, q: 1.2, peak: 0.35 * I, attack: 0.01, tau: 0.3 });
}

const emptyEngine = (): MarineEngineAudioInputs => ({ rpm: 0, load: 0, boost: 0, gear: 0, propRps: 0, thrustN: 0 });

export function createMarineDieselVoice(ctx: BaseAudioContext, out: VoiceOutputs, rnd: () => number): EngineVoice {
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const { white, pink, brown } = out.kit;

  const outE = gain(1);
  outE.connect(out.exterior);
  const outC = gain(1);
  outC.connect(out.cabin);
  const bus = gain(A.engineVolume * M.volume);
  bus.connect(outE);
  const engBus = gain(1);
  const engLP = filter('lowpass', A.exteriorCutoffHz, 0.7);
  chain(engBus, engLP, bus);
  const waterBus = gain(1);
  waterBus.connect(bus);
  const fx = gain(A.effectsVolume);
  fx.connect(bus);

  const whiteSrc = loop(white);
  const pinkSrc = loop(pink);
  const brownSrc = loop(brown);

  // ── The two diesels ──
  const cycleWave = b.wave(() => dieselCycleWaveform(2048), 96, 'dieselCycle');
  const knockWave = b.wave(() => pulseWaveform(512, KNOCK_DUTY), 32, `pulse${KNOCK_DUTY}`);
  const whineWave = b.wave(() => whineWaveform(512), 4, 'whine');
  const clatterBP = filter('bandpass', 2000, 1.3);
  whiteSrc.connect(clatterBP);
  const exLP = filter('lowpass', 250, 0.8);
  brownSrc.connect(exLP);
  const koff = knockOffset();
  const eng = [0, 1].map(() => {
    const cyc = osc(cycleWave, 0);
    const drive = gain(0.2 / SHAPE_K);
    const shaper = ctx.createWaveShaper();
    shaper.curve = shapeCurve();
    b.nodes.push(shaper);
    const toneLP = filter('lowpass', 300, 0.8);
    const tone = gain(0);
    chain(cyc, drive, shaper, toneLP, tone, engBus);
    const knock = osc(knockWave, 0);
    const gate = gain(koff);
    knock.connect(gate.gain);
    const clat = gain(0);
    chain(clatterBP, gate, clat, engBus);
    const exAM = gain(0.55);
    chain(cyc, gain(0.45)).connect(exAM.gain);
    const ex = gain(0);
    chain(exLP, exAM, ex, engBus);
    const turboOsc = osc(whineWave, M.turboMinHz);
    const turbo = gain(0);
    chain(turboOsc, turbo, engBus);
    return {
      cyc: knob(cyc.frequency, 2e-4),
      drive: knob(drive.gain, 1e-3),
      toneLP: knob(toneLP.frequency, 1e-3),
      tone: knob(tone.gain),
      knock: knob(knock.frequency, 2e-4),
      clat: knob(clat.gain),
      ex: knob(ex.gain),
      turboF: knob(turboOsc.frequency, 1e-3),
      turbo: knob(turbo.gain),
      cycNode: cyc,
    };
  });

  // Underwater exhaust burble: a resonant band wandering around 250 Hz, fluttering like bubbles.
  const bubBP = filter('bandpass', 260, 3);
  chain(osc('sine', 1.7), gain(70)).connect(bubBP.frequency);
  const bubAM = gain(0.6);
  chain(osc('sine', 6.3), gain(0.3)).connect(bubAM.gain);
  chain(osc('sine', 9.7), gain(0.2)).connect(bubAM.gain);
  const bubble = gain(0);
  chain(pinkSrc, bubBP, bubAM, bubble, engBus);

  // Machinery whirr (valve train, injection pumps, gears), modulated by the port cycle.
  const mechBP = filter('bandpass', 1200, 1.6);
  const mechAM = gain(0.7);
  chain(eng[0].cycNode, gain(0.3)).connect(mechAM.gain);
  const mech = gain(0);
  chain(pinkSrc, mechBP, mechAM, mech, engBus);

  // Starter: motor whine + heavy compression chug, pulsing at the cranking firing rate.
  const crankLfo = osc('sine', 8);
  const stOsc = osc('sawtooth', 110);
  const stBP = filter('bandpass', 900, 1.2);
  const stAM = gain(0.5);
  chain(crankLfo, gain(0.5)).connect(stAM.gain);
  chain(stOsc, stBP, stAM);
  const crankLP = filter('lowpass', 240, 0.8);
  const crank = gain(0);
  chain(brownSrc, crankLP, crank, stAM);
  const starter = gain(0);
  chain(stAM, starter, engBus);

  // Propellers: blade thrum through the hull, cavitation / churn when heavily loaded.
  const propOsc = osc(b.wave(() => propWaveform(1024), 40, 'prop'), 0);
  const propLP = filter('lowpass', 260, 0.7);
  const prop = gain(0);
  chain(propOsc, propLP, prop, waterBus);
  const cavBP = filter('bandpass', 1400, 0.8);
  const cav = gain(0);
  chain(whiteSrc, cavBP, cav, waterBus);

  // Structure-borne rumble in the saloon (cockpit only).
  const cabinLP = filter('lowpass', 160, 0.7);
  const cabinRumble = gain(0);
  chain(eng[0].cycNode, cabinLP, cabinRumble, outC);

  // ── Water ──
  const slowLfo = osc('sine', 0.23);
  const rushBP = filter('bandpass', 400, 0.7);
  const rushAM = gain(0.85);
  chain(slowLfo, gain(0.12)).connect(rushAM.gain);
  const rush = gain(0);
  chain(pinkSrc, rushBP, rushAM, rush, waterBus);
  const hissHP = filter('highpass', 3500, 0.6);
  const hiss = gain(0);
  chain(whiteSrc, hissHP, hiss, waterBus);
  const washLP = filter('lowpass', 320, 0.8);
  const washAM = gain(0.7);
  chain(osc('sine', 0.8), gain(0.25)).connect(washAM.gain);
  chain(slowLfo, gain(0.15)).connect(washAM.gain);
  const wash = gain(0);
  chain(brownSrc, washLP, washAM, wash, waterBus);
  const skimBP = filter('bandpass', 4200, 1.1);
  const skim = gain(0);
  chain(whiteSrc, skimBP, skim, waterBus);
  // Aground: a wandering scrape band chopped irregularly, and a low rumble.
  const grindBP = filter('bandpass', 600, 1.6);
  chain(osc('sine', 0.7), gain(250)).connect(grindBP.frequency);
  const grindAM = gain(0.6);
  chain(osc('sawtooth', 9), gain(0.4)).connect(grindAM.gain);
  const grind = gain(0);
  chain(pinkSrc, grindBP, grindAM, grind, waterBus);
  const grindLP = filter('lowpass', 150, 0.8);
  const grindRumble = gain(0);
  chain(brownSrc, grindLP, grindRumble, waterBus);

  const K = {
    outE: knob(outE.gain),
    engBus: knob(engBus.gain),
    engLP: knob(engLP.frequency, 1e-3),
    waterBus: knob(waterBus.gain),
    clatterBP: knob(clatterBP.frequency, 1e-3),
    exLP: knob(exLP.frequency, 1e-3),
    bubble: knob(bubble.gain),
    mech: knob(mech.gain),
    mechBP: knob(mechBP.frequency, 1e-3),
    crankF: knob(crankLfo.frequency, 1e-3),
    stF: knob(stOsc.frequency, 1e-3),
    starter: knob(starter.gain),
    crank: knob(crank.gain),
    propF: knob(propOsc.frequency, 2e-4),
    prop: knob(prop.gain),
    cav: knob(cav.gain),
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
  const E = [emptyEngine(), emptyEngine()];
  const mix = [emptyEngineMix(), emptyEngineMix()];
  const W = emptyWaterMix();
  const er = [0, 0];
  const prevGear = [Number.NaN, Number.NaN];
  const prev = { starting: false, aground: false, er0: 0 };
  let wander = 0;

  return {
    kind: 'marineDiesel',
    refDistanceM: M.refDistanceM,
    update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number {
      const { t, tau, crashed } = f;
      const dt = Math.max(0, fin(f.dt, 0));
      const v = a.vessel;
      const running = !!a.engineRunning && !crashed;
      const starting = !!a.starting && !crashed;
      const cockpit = !f.exterior;
      const dop = f.doppler;

      // Engines: port and starboard (one reported engine drives both; none → from rpm / power).
      const count = v ? clamp(Math.floor(fin(v.engineCount, 0)), 0, v.engines?.length ?? 0) : 0;
      if (count >= 1) {
        sanitiseEngine(v!.engines[0], E[0]);
        sanitiseEngine(count >= 2 ? v!.engines[1] : v!.engines[0], E[1]);
      } else {
        fallbackEngine(a, E[0]);
        fallbackEngine(a, E[1]);
      }
      wander += dt * 0.13 * 2 * Math.PI;
      if (wander > 2 * Math.PI) wander -= 2 * Math.PI;
      const stbd = 1 + M.detune + M.detuneWander * Math.sin(wander);
      let thrust = 0;
      let rps = 0;
      let loadSum = 0;
      let turboMax = 0;
      for (let e = 0; e < 2; e++) {
        er[e] = rundownRpm(er[e], E[e].rpm * (e === 1 ? stbd : 1), running, dt);
        const m = marineEngineMix(er[e], E[e].load, E[e].boost, running, crashed, mix[e]);
        const k = eng[e];
        k.cyc.set(m.cycleHz * dop, t, tau);
        k.knock.set(m.firingHz * dop, t, tau);
        k.drive.set(m.drive / SHAPE_K, t, tau);
        k.toneLP.set(220 + 2400 * m.bright, t, tau);
        k.tone.set((M.tone * m.tone) / Math.tanh(m.drive), t, tau);
        k.clat.set(M.clatter * m.clatter, t, tau);
        k.ex.set(M.exhaust * m.exhaust, t, tau);
        k.turboF.set(Math.min(16000, m.turboHz * dop), t, 0.4);
        k.turbo.set(M.turbo * m.turbo, t, 0.3);
        thrust += Math.abs(E[e].thrustN);
        rps += Math.abs(E[e].propRps) / 2;
        loadSum += crashed ? 0 : clamp(E[e].load, 0, 1) / 2;
        turboMax = Math.max(turboMax, m.turbo);
      }
      const m0 = mix[0];
      const m1 = mix[1];
      K.clatterBP.set((m0.clatterHz + m1.clatterHz) / 2, t, tau);
      K.exLP.set((m0.exhaustLpHz + m1.exhaustLpHz) / 2, t, tau);
      K.bubble.set((M.bubble * (m0.bubble + m1.bubble)) / 2, t, tau);
      K.mech.set((M.mech * (m0.mech + m1.mech)) / 2, t, tau);
      K.mechBP.set(900 + 1600 * clamp(er[0] / M.maxRpm, 0, 1.3), t, tau);
      // Starter
      const crankHz = Math.max(3, marineFiringHz(E[0].rpm));
      K.crankF.set(crankHz, t, tau);
      K.stF.set(100 + 0.15 * E[0].rpm, t, 0.2);
      K.starter.set(starting ? M.starter : 0, t, 0.06);
      K.crank.set(M.crank, t, tau);

      // Water
      const n = count >= 1 ? Math.min(2, count) : 2;
      marineWaterMix(
        fin(v?.speedMs, 0), fin(v?.planing, 0), fin(v?.heaveMs, 0), fin(v?.pitchRate, 0), fin(v?.rollRate, 0), !!v?.aground,
        count >= 1 ? thrust / (count >= 2 ? 1 : 2) : 0, rps, n, W,
      );
      K.propF.set(Math.max(1, W.bladeHz * dop), t, tau);
      K.prop.set(M.prop * W.prop, t, tau);
      K.cav.set(M.cavitation * W.cavitation, t, tau);
      K.rushBP.set(W.rushHz * dop, t, tau);
      K.rush.set(M.rush * W.rush, t, tau);
      K.hiss.set(M.hiss * W.hiss, t, tau);
      K.wash.set(M.wash * W.wash, t, tau);
      K.skim.set(M.skim * W.skim, t, tau);
      K.grind.set(M.grind * W.grind, t, 0.08);
      K.grindRumble.set(M.grindRumble * W.grind, t, 0.08);
      for (const r of K.rates) r.set(dop, t, tau);

      // View: the engines are under the saloon floor; the hull is all around you.
      const dirEng = cockpit ? M.cockpitEngines : 0.75 + 0.25 * smooth(-0.6, 0.9, fin(a.aft, 0));
      K.engBus.set(dirEng, t, A.cameraRampTau);
      K.engLP.set(cockpit ? M.cockpitEngineLpHz : A.exteriorCutoffHz, t, A.cameraRampTau);
      K.waterBus.set(cockpit ? M.cockpitWater : 1, t, A.cameraRampTau);
      K.outE.set(cockpit ? M.cockpitGain : 1, t, A.cameraRampTau);
      K.cabinRumble.set(cockpit ? M.cabinRumble * ((m0.tone + m1.tone) / 2) : 0, t, A.cameraRampTau);

      L.marine = 1;
      L.marineRpm = er[0];
      L.engineLoad = loadSum;
      L.turbo = turboMax;
      L.turboHz = m0.turboHz * dop;
      L.hullRush = W.rush;
      L.skim = W.skim;
      L.wash = W.wash;
      L.slapRate = crashed ? 0 : W.slapRate;
      L.grind = W.grind;
      L.firingHz = m0.firingHz * dop;
      L.cycleHz = m0.cycleHz * dop;
      L.bladeHz = W.bladeHz * dop;
      L.exhaust = m0.exhaust;
      L.mechanical = m0.clatter;
      L.prop = W.prop;
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

      // One-shots.
      let shots = 0;
      const kit = out.kit;
      if (f.primed && !crashed) {
        if (prev.starting && !starting && running) {
          playDieselCatch(kit, engBus, t, M.catchLevel);
          shots++;
        }
        if (!running && !starting && prev.er0 >= M.shudderRpm && er[0] < M.shudderRpm) {
          playShudder(kit, engBus, t, M.shudderLevel);
          shots++;
        }
        let clunks = 0;
        for (let e = 0; e < Math.min(2, count); e++) {
          const g = E[e].gear;
          if (Number.isFinite(prevGear[e]) && g !== prevGear[e]) {
            playMarineClunk(kit, fx, t + 0.04 * clunks, M.clunkLevel);
            clunks++;
          }
        }
        shots += clunks;
        L.gearClunks += clunks;
        if (v?.aground && !prev.aground) {
          playGrounding(kit, waterBus, t, 0.3 + 0.7 * smooth(0.5, 10, W.speedKt));
          shots++;
        }
        if (dt > 0 && !a.paused && rnd() < slapChance(W.slapRate, dt)) {
          const i = W.slapIntensity * (0.45 + 0.75 * rnd());
          playHullSlap(kit, waterBus, t, Math.min(1, i), fin(v?.planing, 0));
          L.hullSlaps++;
        }
      }
      for (let e = 0; e < 2; e++) prevGear[e] = e < count ? E[e].gear : Number.NaN;
      prev.starting = starting;
      prev.aground = !!v?.aground;
      prev.er0 = er[0];
      return shots;
    },
    retire(t, onGone) {
      retireGraph(b, [outE, outC], t, onGone);
    },
  };
}
