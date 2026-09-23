/**
 * The enemy aircraft's sound: a small pool of procedural voices (no samples) that follow the
 * nearest MiG-29s, Su-25s and Mi-24s (src/audio/airTargetsMapping.ts picks them and works out the
 * level, Doppler, air absorption, pan and aspect). Each voice carries both layers and blends them by
 * the aircraft's class:
 *
 *   jet   — pink-noise exhaust roar (band-pass, louder astern) + brown-noise rumble + turbine whine
 *           and compressor tone (louder ahead); the noise playback rate and every tone follow the
 *           Doppler factor, so a flyby drops in pitch as it passes;
 *   helo  — rotor thump (brown noise band-passed low, amplitude-gated by a 5-blade pulse train at
 *           ~20 Hz) + blade slap (the same gate on a mid-band noise, stronger advancing) + tail-rotor
 *           buzz + TV3-117 turbine whine.
 *
 *   voice mix → air-absorption low-pass (canopy low-pass in the cockpit) → pan → level → bus → master
 *
 * The bus joins the master (so mute and pause silence it); reset() drops every voice at once.
 */
import { CONFIG } from '../config';
import { createBuilder, noiseBuffer, type Builder, type Knob } from './builder';
import { assignAirVoices, createAirVoiceTarget, type AirListener, type AirSoundSource, type AirVoiceTarget } from './airTargetsMapping';
import type { AudioLevels } from './types';
import { mulberry32 } from './waves';

const C = CONFIG.audio.airTargets;

export interface AirAudioFrame {
  listener: AirListener;
  sources: readonly AirSoundSource[];
  /** How many of `sources` are valid this frame. */
  count: number;
  /** Frame dt, s (0 while paused). */
  dt: number;
}

export interface AirAudioApi {
  update(f: AirAudioFrame): void;
  /** Silence every voice now (the sim was reset). */
  reset(): void;
}

export interface AirAudio extends AirAudioApi {
  levels(L: AudioLevels): void;
  /** The per-voice targets of the last update (QA / tests). */
  readonly voices: readonly AirVoiceTarget[];
  dispose(): void;
}

interface Voice {
  jet: Knob;
  helo: Knob;
  roar: Knob;
  roarBP: Knob;
  roarRate: Knob;
  rumble: Knob;
  rumbleRate: Knob;
  whine: Knob;
  whineHz: Knob;
  whineBP: Knob;
  comp: Knob;
  compHz: Knob;
  blade: Knob;
  thumpRate: Knob;
  slap: Knob;
  tail: Knob;
  tailHz: Knob;
  hWhine: Knob;
  hWhineHz: Knob;
  hWhine2Hz: Knob;
  lp: Knob;
  pan: Knob | null;
  level: Knob;
}

/** One period of the rotor gate: a short, soft-edged pulse per blade passage (0..1). */
export function bladePulse(n: number, duty = 0.28): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ph = i / n;
    const u = ph < duty ? ph / duty : 1;
    out[i] = u < 1 ? Math.pow(Math.sin(Math.PI * u), 2) : 0;
  }
  return out;
}

export function createAirAudio(ctx: BaseAudioContext, out: AudioNode, seed = 9127): AirAudio {
  const rnd = mulberry32(seed);
  const b: Builder = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const pink = noiseBuffer(ctx, 'pink', 2.9, seed + 1);
  const brown = noiseBuffer(ctx, 'brown', 3.7, seed + 2);
  const white = noiseBuffer(ctx, 'white', 2.3, seed + 3);
  const bus = gain(C.volume);
  bus.connect(out);
  const gate = b.wave(() => bladePulse(512), 24, 'rotorGate');
  const canPan = typeof (ctx as { createStereoPanner?: unknown }).createStereoPanner === 'function';

  const makeVoice = (): Voice => {
    const mix = gain(1);
    // ── jet layer ──
    const jet = gain(0);
    const roarSrc = loop(pink);
    const roarBP = filter('bandpass', 500, 0.55);
    const roar = gain(0);
    chain(roarSrc, roarBP, roar, jet);
    const rumbleSrc = loop(brown);
    const rumbleLP = filter('lowpass', 170, 0.7);
    const rumble = gain(0);
    chain(rumbleSrc, rumbleLP, rumble, jet);
    const whineOsc = osc('sawtooth', 3000);
    const whineBP = filter('bandpass', 3000, 5);
    const whine = gain(0);
    chain(whineOsc, whineBP, whine, jet);
    const compOsc = osc('triangle', 1100);
    const comp = gain(0);
    chain(compOsc, comp, jet);
    jet.connect(mix);
    // ── helo layer ──
    const helo = gain(0);
    // audio-rate gate: the pulse train (its mean removed and normalised by WebAudio) on a base that keeps it ≥ 0
    const bladeGate = gain(0.17);
    const gateOsc = osc(gate, 20);
    gateOsc.connect(bladeGate.gain);
    const thumpSrc = loop(brown);
    const thumpBP = filter('bandpass', 85, 0.9);
    const thumpBoost = gain(2.2);
    chain(thumpSrc, thumpBP, thumpBoost, bladeGate);
    const slapGate = gain(0.17);
    gateOsc.connect(slapGate.gain);
    const slapSrc = loop(white);
    const slapBP = filter('bandpass', 650, 1.1);
    const slap = gain(0);
    chain(slapSrc, slapBP, slapGate, slap, helo);
    const blade = gain(0);
    chain(bladeGate, blade, helo);
    const tailOsc = osc('sawtooth', 58);
    const tailLP = filter('lowpass', 420, 0.8);
    const tail = gain(0);
    chain(tailOsc, tailLP, tail, helo);
    const hWhineOsc = osc('sine', 4200);
    const hWhine2Osc = osc('triangle', 1650);
    const hWhine = gain(0);
    hWhineOsc.connect(hWhine);
    chain(hWhine2Osc, gain(0.6), hWhine);
    hWhine.connect(helo);
    helo.connect(mix);
    // ── out: absorption low-pass → pan → level → bus ──
    const lp = filter('lowpass', 8000, 0.6);
    const level = gain(0);
    let pan: Knob | null = null;
    if (canPan) {
      const p = (ctx as BaseAudioContext & { createStereoPanner(): StereoPannerNode }).createStereoPanner();
      b.nodes.push(p);
      chain(mix, lp, p, level, bus);
      pan = knob(p.pan, 1e-3);
    } else chain(mix, lp, level, bus);
    return {
      jet: knob(jet.gain), helo: knob(helo.gain),
      roar: knob(roar.gain), roarBP: knob(roarBP.frequency, 1e-3), roarRate: knob(roarSrc.playbackRate, 1e-3),
      rumble: knob(rumble.gain), rumbleRate: knob(rumbleSrc.playbackRate, 1e-3),
      whine: knob(whine.gain), whineHz: knob(whineOsc.frequency, 1e-3), whineBP: knob(whineBP.frequency, 1e-3),
      comp: knob(comp.gain), compHz: knob(compOsc.frequency, 1e-3),
      blade: knob(blade.gain), thumpRate: knob(gateOsc.frequency, 1e-3), slap: knob(slap.gain),
      tail: knob(tail.gain), tailHz: knob(tailOsc.frequency, 1e-3),
      hWhine: knob(hWhine.gain), hWhineHz: knob(hWhineOsc.frequency, 1e-3), hWhine2Hz: knob(hWhine2Osc.frequency, 1e-3),
      lp: knob(lp.frequency, 1e-3), pan, level: knob(level.gain),
    };
  };

  const n = Math.max(0, Math.min(6, Math.floor(C.voices)));
  const voices: Voice[] = Array.from({ length: n }, makeVoice);
  const targets: AirVoiceTarget[] = Array.from({ length: n }, createAirVoiceTarget);
  const canopy = CONFIG.audio.combat;
  let heard = 0;
  let lastCockpit = false;
  let disposed = false;

  const silence = (t: number, tau: number) => {
    for (let i = 0; i < n; i++) {
      targets[i].id = -1;
      targets[i].gain = 0;
      voices[i].level.set(0, t, tau);
    }
    heard = 0;
  };

  return {
    voices: targets,
    update(f) {
      if (disposed || n === 0) return;
      const t = ctx.currentTime;
      heard = assignAirVoices(targets, f.sources, f.count, f.listener, C);
      lastCockpit = !!f.listener.cockpit;
      const tau = C.rampS;
      for (let i = 0; i < n; i++) {
        const v = voices[i];
        const T = targets[i];
        if (T.id < 0 || !(T.gain > 0)) {
          v.level.set(0, t, tau);
          continue;
        }
        const dop = T.doppler;
        const astern = Math.max(0, -T.aspect);
        const ahead = Math.max(0, T.aspect);
        if (T.kind === 'helo') {
          const h = C.helo;
          v.jet.set(0, t, 0.05);
          v.helo.set(1, t, 0.05);
          v.thumpRate.set(h.bladeHz * dop, t, 0.05);
          v.blade.set(1, t, tau);
          // blade slap: strongest when it comes at you (advancing blades), and close in
          v.slap.set(0.35 + h.advancingSlap * Math.max(0, Math.min(1, T.closingMs / 60)), t, tau);
          v.tail.set(0.16, t, tau);
          v.tailHz.set(h.tailHz * dop, t, 0.05);
          v.hWhine.set(0.05 + 0.05 * ahead, t, tau);
          v.hWhineHz.set(h.whineHz * dop, t, 0.05);
          v.hWhine2Hz.set(h.whine2Hz * dop, t, 0.05);
        } else {
          const j = T.kind === 'attack' ? C.attack : C.fighter;
          v.helo.set(0, t, 0.05);
          v.jet.set(1, t, 0.05);
          v.roar.set(0.55 * (1 + j.aftRoar * astern - 0.35 * ahead), t, tau);
          v.roarBP.set(j.roarHz * dop, t, 0.05);
          v.roarRate.set(dop, t, 0.05);
          v.rumble.set(0.45 * (1 + 0.5 * astern), t, tau);
          v.rumbleRate.set(dop, t, 0.05);
          v.whine.set(0.035 * (1 + j.frontWhine * ahead - 0.5 * astern), t, tau);
          v.whineHz.set(j.whineHz * dop, t, 0.05);
          v.whineBP.set(j.whineHz * dop, t, 0.05);
          v.comp.set(0.02 * (1 + j.frontWhine * ahead), t, tau);
          v.compHz.set(j.compressorHz * dop, t, 0.05);
        }
        // air absorption, and the canopy in the cockpit
        const cut = f.listener.cockpit ? Math.min(T.cutoffHz, canopy.canopyCutoffHz) : T.cutoffHz;
        v.lp.set(cut, t, 0.08);
        v.pan?.set(T.pan, t, 0.06);
        v.level.set(T.gain * (f.listener.cockpit ? canopy.canopyGain : 1), t, tau);
      }
    },
    reset() {
      if (disposed) return;
      silence(ctx.currentTime, 0.02);
    },
    levels(L) {
      L.airVoices = heard;
      let g = 0;
      let d = 1;
      for (const T of targets) {
        if (T.id >= 0 && T.gain > g) {
          g = T.gain;
          d = T.doppler;
        }
      }
      L.airLevel = g * (lastCockpit ? canopy.canopyGain : 1);
      L.airDoppler = d;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const nd of b.sources) {
        try {
          nd.stop();
        } catch {
          /* already */
        }
      }
      for (const nd of b.nodes) {
        try {
          nd.disconnect();
        } catch {
          /* already */
        }
      }
    },
  };
}
