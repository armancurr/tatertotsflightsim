/**
 * One-shot sounds (touchdown chirp/thump, gear clunk, engine catch, crash boom + debris, fire
 * crackle). Each builds a few short-lived nodes, shapes them with a click-free envelope
 * (0 → linear attack → exponential decay) and stops/disconnects them when done.
 */
import type { SurfaceType } from '../types';

export interface OneShotKit {
  ctx: BaseAudioContext;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  rnd: () => number;
}

interface BurstOpts {
  buffer: AudioBuffer;
  peak: number;
  attack?: number;
  /** Exponential decay time constant, s. */
  tau: number;
  filter: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  sweep?: number;
  q?: number;
  rate?: number;
}

const safe = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Click-free envelope on a gain param: 0 → peak (linear, `attack` s) → exponential decay. Returns the end time. */
function envelope(p: AudioParam, t: number, peak: number, attack: number, tau: number): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, tau);
  return t + attack + tau * 7;
}

function release(nodes: AudioNode[], src: AudioScheduledSourceNode) {
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  };
}

export function noiseBurst(k: OneShotKit, dest: AudioNode, t: number, o: BurstOpts): void {
  const { ctx } = k;
  const src = ctx.createBufferSource();
  src.buffer = o.buffer;
  src.loop = true;
  src.playbackRate.value = safe(o.rate ?? 1, 0.25, 4);
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.Q.value = safe(o.q ?? 0.8, 0.0001, 40);
  const f0 = safe(o.freq, 20, 20000);
  f.frequency.setValueAtTime(f0, t);
  if (o.freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(safe(o.freqEnd, 20, 20000), t + safe(o.sweep ?? o.tau * 3, 0.005, 10));
  const g = ctx.createGain();
  g.gain.value = 0;
  const end = envelope(g.gain, t, safe(o.peak, 0, 4), safe(o.attack ?? 0.003, 0.001, 1), safe(o.tau, 0.002, 10));
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  src.start(t, k.rnd() * Math.max(0, o.buffer.duration - 0.1));
  src.stop(end);
  release([src, f, g], src);
}

export function toneBurst(
  k: OneShotKit, dest: AudioNode, t: number,
  o: { type: OscillatorType; freq: number; freqEnd?: number; sweep?: number; peak: number; attack?: number; tau: number },
): void {
  const { ctx } = k;
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(safe(o.freq, 10, 20000), t);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(safe(o.freqEnd, 10, 20000), t + safe(o.sweep ?? o.tau * 2, 0.005, 10));
  const g = ctx.createGain();
  g.gain.value = 0;
  const end = envelope(g.gain, t, safe(o.peak, 0, 4), safe(o.attack ?? 0.004, 0.001, 1), safe(o.tau, 0.002, 10));
  osc.connect(g);
  g.connect(dest);
  osc.start(t);
  osc.stop(end);
  release([osc, g], osc);
}

const PAVED = new Set<SurfaceType>(['runway', 'asphalt', 'urban']);

/** Tyre chirp(s) + strut thump, scaled by intensity 0..1. */
export function playTouchdown(k: OneShotKit, dest: AudioNode, t: number, intensity: number, surface: SurfaceType): void {
  const i = safe(intensity, 0, 1);
  // Strut/airframe thump: felt more than heard.
  toneBurst(k, dest, t, { type: 'sine', freq: 78, freqEnd: 40, sweep: 0.16, peak: 0.85 * Math.pow(i, 0.8), tau: 0.07 + 0.06 * i });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 380, q: 0.7, peak: 0.7 * i, tau: 0.08 + 0.08 * i });
  if (PAVED.has(surface)) {
    // Two mains spin up a few ms apart: rubber chirp (sweeping band of noise + a squeak).
    for (let w = 0; w < 2; w++) {
      const tw = t + w * (0.015 + 0.05 * k.rnd());
      const peak = (0.35 + 0.25 * k.rnd()) * Math.pow(i, 0.6);
      noiseBurst(k, dest, tw, { buffer: k.white, filter: 'bandpass', freq: 2400, freqEnd: 1250, sweep: 0.12, q: 3.5, peak, attack: 0.004, tau: 0.04 + 0.07 * i });
      toneBurst(k, dest, tw, { type: 'triangle', freq: 1300 + 200 * k.rnd(), freqEnd: 820, sweep: 0.1, peak: 0.08 * i, tau: 0.04 });
    }
  } else if (surface === 'water') {
    noiseBurst(k, dest, t, { buffer: k.white, filter: 'lowpass', freq: 3000, freqEnd: 700, sweep: 0.5, q: 0.5, peak: 0.55 * i, tau: 0.22 });
  } else {
    // Grass/dirt: a rustling thud instead of a chirp.
    noiseBurst(k, dest, t, { buffer: k.pink, filter: 'bandpass', freq: 700, q: 0.8, peak: 0.35 * i, tau: 0.13 });
  }
}

/** Gear down-and-locked / up-and-locked clunk. */
export function playGearClunk(k: OneShotKit, dest: AudioNode, t: number): void {
  toneBurst(k, dest, t, { type: 'sine', freq: 96, freqEnd: 58, sweep: 0.1, peak: 0.9, tau: 0.05 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'bandpass', freq: 380, q: 1.4, peak: 0.9, tau: 0.045 });
  toneBurst(k, dest, t + 0.004, { type: 'triangle', freq: 1150, peak: 0.06, tau: 0.1 });
}

/** The first irregular firings as the engine catches. */
export function playCatch(k: OneShotKit, dest: AudioNode, t: number): void {
  const pops = [0, 0.075, 0.13, 0.21];
  const peaks = [0.55, 0.3, 0.7, 0.45];
  for (let p = 0; p < pops.length; p++) {
    noiseBurst(k, dest, t + pops[p], { buffer: k.brown, filter: 'lowpass', freq: 520, q: 0.9, peak: peaks[p], attack: 0.002, tau: 0.035 });
  }
}

/** Impact boom, crunch, scraping wreck and flying debris. `intensity` 0.3..1. */
export function playCrash(k: OneShotKit, dest: AudioNode, t: number, intensity: number): void {
  const I = safe(intensity, 0.3, 1);
  toneBurst(k, dest, t, { type: 'sine', freq: 60, freqEnd: 24, sweep: 0.9, peak: 1.1 * I, attack: 0.003, tau: 0.35 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 1600, freqEnd: 150, sweep: 1.6, q: 0.6, peak: 1.2 * I, attack: 0.002, tau: 0.45 });
  noiseBurst(k, dest, t, { buffer: k.white, filter: 'bandpass', freq: 750, q: 0.8, peak: 0.6 * I, attack: 0.002, tau: 0.12 });
  noiseBurst(k, dest, t + 0.05, { buffer: k.white, filter: 'bandpass', freq: 1100, freqEnd: 500, sweep: 1.8, q: 1.2, peak: 0.28 * I, attack: 0.05, tau: 0.6 });
  const n = Math.round(10 + 12 * I);
  for (let d = 0; d < n; d++) {
    const r = k.rnd();
    const td = t + 0.03 + 2.4 * r * r;
    const fade = 1 - (td - t) / 3;
    noiseBurst(k, dest, td, {
      buffer: k.white, filter: 'bandpass', freq: 450 + 3200 * k.rnd(), q: 3 + 9 * k.rnd(),
      peak: (0.15 + 0.3 * k.rnd()) * I * fade, attack: 0.002, tau: 0.015 + 0.07 * k.rnd(),
    });
    if (k.rnd() < 0.35) toneBurst(k, dest, td, { type: 'triangle', freq: 800 + 1800 * k.rnd(), peak: 0.05 * I * fade, tau: 0.08 + 0.12 * k.rnd() });
  }
}

/** A single fire crackle/pop. */
export function playCrackle(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  const L = safe(level, 0, 1);
  if (k.rnd() < 0.8) {
    noiseBurst(k, dest, t, { buffer: k.white, filter: 'highpass', freq: 1500 + 2500 * k.rnd(), q: 0.7, peak: (0.05 + 0.12 * k.rnd()) * L, attack: 0.001, tau: 0.003 + 0.01 * k.rnd() });
  } else {
    noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 400, q: 0.9, peak: 0.25 * L, attack: 0.002, tau: 0.03 });
  }
}
