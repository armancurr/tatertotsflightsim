/**
 * One-shot sounds (touchdown chirp/thump, gear clunk, engine catch, afterburner light-off, the
 * layered crash — boom, crunch, metal tearing, clang, debris clatter, scraping — explosions, debris
 * impacts, fire crackle). Each builds a few short-lived nodes, shapes them with a click-free envelope
 * (0 → linear attack → exponential decay) and stops/disconnects them when done. A kit with `live`
 * records every source still playing (with its stop time) so a reset can silence them all.
 */
import type { SurfaceType } from '../types';

export interface OneShotKit {
  ctx: BaseAudioContext;
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  rnd: () => number;
  /** Optional: sources still playing → their scheduled stop time (removed when they end). */
  live?: Map<AudioScheduledSourceNode, number>;
  /** Optional: called after a tracked source has ended. */
  onEnded?: () => void;
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
  return t + attack + tau * 6;
}

function release(k: OneShotKit, nodes: AudioNode[], src: AudioScheduledSourceNode, end: number) {
  k.live?.set(src, end);
  src.onended = () => {
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    if (k.live) {
      k.live.delete(src);
      k.onEnded?.();
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
  release(k, [src, f, g], src, end);
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
  release(k, [osc, g], osc, end);
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

/**
 * Metal tearing / screeching: noise through three narrow resonances whose centres glide and wobble
 * (skin panels ripping, spars bending), plus a low bending groan. `dur` seconds.
 */
export function playMetalTear(k: OneShotKit, dest: AudioNode, t: number, level: number, dur: number): void {
  const L = safe(level, 0, 2);
  const D = safe(dur, 0.2, 4);
  const { ctx } = k;
  for (let i = 0; i < 3; i++) {
    const src = ctx.createBufferSource();
    src.buffer = k.white;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 18 + 20 * k.rnd();
    const f0 = 900 + 2200 * k.rnd();
    bp.frequency.setValueAtTime(f0, t);
    // A few random glides (the tear catches and runs), ending lower.
    const steps = 4;
    for (let s2 = 1; s2 <= steps; s2++) {
      const f = f0 * (0.45 + 0.9 * k.rnd()) * (1 - (0.35 * s2) / steps);
      bp.frequency.linearRampToValueAtTime(safe(f, 150, 9000), t + (D * s2) / steps);
    }
    const g = ctx.createGain();
    g.gain.value = 0;
    const start = t + 0.02 * i + 0.05 * k.rnd();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(safe(L * (0.5 + 0.4 * k.rnd()), 0, 4), start + 0.03);
    g.gain.setTargetAtTime(safe(L * 0.25, 0, 4), start + 0.08, D * 0.25);
    g.gain.setTargetAtTime(0, start + D * 0.7, D * 0.12);
    const end = start + D * 1.6;
    src.connect(bp);
    bp.connect(g);
    g.connect(dest);
    src.start(start, k.rnd() * Math.max(0, k.white.duration - 0.1));
    src.stop(end);
    release(k, [src, bp, g], src, end);
  }
  // Bending groan: a sawtooth sagging in pitch through a resonant low band.
  const o = ctx.createOscillator();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(95 + 40 * k.rnd(), t);
  o.frequency.exponentialRampToValueAtTime(48, t + D);
  const lp = ctx.createBiquadFilter();
  lp.type = 'bandpass';
  lp.frequency.value = 420;
  lp.Q.value = 3;
  const g = ctx.createGain();
  g.gain.value = 0;
  const end = envelope(g.gain, t, safe(0.35 * L, 0, 4), 0.06, D * 0.3);
  o.connect(lp);
  lp.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(end);
  release(k, [o, lp, g], o, end);
}

/** A struck metal part: inharmonic plate/beam modes (1, 2.76, 5.40, 8.93 × f) ringing down. */
export function playClang(k: OneShotKit, dest: AudioNode, t: number, freq: number, level: number): void {
  const ratios = [1, 2.76, 5.4, 8.93];
  const f0 = safe(freq, 60, 3000);
  const L = safe(level, 0, 2);
  for (let i = 0; i < ratios.length; i++) {
    toneBurst(k, dest, t, { type: 'sine', freq: f0 * ratios[i] * (1 + 0.01 * (k.rnd() - 0.5)), peak: (L * 0.5) / (1 + i * 0.8), attack: 0.002, tau: (0.12 + 0.2 * k.rnd()) / (1 + 0.5 * i) });
  }
}

/** The wreck sliding and scraping along the ground: wandering band of noise, irregularly modulated. */
export function playScrape(k: OneShotKit, dest: AudioNode, t: number, level: number, dur: number): void {
  const { ctx } = k;
  const L = safe(level, 0, 2);
  const D = safe(dur, 0.2, 6);
  const src = ctx.createBufferSource();
  src.buffer = k.pink;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(900 + 500 * k.rnd(), t);
  for (let s2 = 1; s2 <= 5; s2++) bp.frequency.linearRampToValueAtTime(350 + 1100 * k.rnd(), t + (D * s2) / 5);
  const am = ctx.createGain();
  am.gain.value = 0.6;
  const lfo = ctx.createOscillator();
  lfo.type = 'sawtooth';
  lfo.frequency.setValueAtTime(9 + 8 * k.rnd(), t);
  lfo.frequency.linearRampToValueAtTime(3, t + D);
  const depth = ctx.createGain();
  depth.gain.value = 0.4;
  lfo.connect(depth);
  depth.connect(am.gain);
  const g = ctx.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(L, t + 0.05);
  g.gain.setTargetAtTime(L * 0.6, t + 0.05, D * 0.4);
  g.gain.setTargetAtTime(0, t + D * 0.75, D * 0.15);
  const end = t + D * 1.6;
  src.connect(bp);
  bp.connect(am);
  am.connect(g);
  g.connect(dest);
  src.start(t, k.rnd() * Math.max(0, k.pink.duration - 0.1));
  src.stop(end);
  lfo.start(t);
  lfo.stop(end);
  release(k, [src, bp, am, g], src, end);
  release(k, [lfo, depth], lfo, end);
}

/**
 * The crash: a massive layered impact — sub-bass boom, crunch, metal tearing and clangs, flying
 * debris clattering down for seconds, the wreck scraping to a stop, and the fuel fireball.
 * `intensity` 0.3..1 (impact speed); `level` 0..1 (distance to the camera).
 */
export function playCrash(k: OneShotKit, dest: AudioNode, t: number, intensity: number, level = 1): void {
  const I = safe(intensity, 0.3, 1);
  const V = safe(level, 0, 1);
  const IV = I * V;
  // Boom: sub-bass sweep + a lower thump underneath.
  toneBurst(k, dest, t, { type: 'sine', freq: 62, freqEnd: 22, sweep: 1.1, peak: 1.0 * IV, attack: 0.003, tau: 0.45 });
  toneBurst(k, dest, t, { type: 'sine', freq: 34, freqEnd: 18, sweep: 1.5, peak: 0.6 * IV, attack: 0.01, tau: 0.7 });
  // Crunch: the airframe crushing (broadband, fast, falling in brightness).
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 2200, freqEnd: 140, sweep: 1.6, q: 0.6, peak: 1.2 * IV, attack: 0.002, tau: 0.5 });
  noiseBurst(k, dest, t, { buffer: k.white, filter: 'bandpass', freq: 800, q: 0.7, peak: 0.7 * IV, attack: 0.001, tau: 0.13 });
  noiseBurst(k, dest, t + 0.03, { buffer: k.white, filter: 'bandpass', freq: 2600, q: 0.9, peak: 0.35 * IV, attack: 0.001, tau: 0.07 });
  // Metal tearing + clangs.
  playMetalTear(k, dest, t + 0.02, 0.38 * IV, 0.9 + 0.8 * I);
  for (let c = 0; c < 3; c++) playClang(k, dest, t + 0.01 + 0.25 * k.rnd(), 140 + 380 * k.rnd(), 0.45 * IV);
  // Debris: many small, bright impacts (bits of airframe, glass, gravel) thinning out over ~3.5 s.
  const n = Math.round(14 + 16 * I);
  for (let d = 0; d < n; d++) {
    const r = k.rnd();
    const td = t + 0.05 + 3.4 * r * r;
    const fade = 1 - (td - t) / 4.2;
    noiseBurst(k, dest, td, {
      buffer: k.white, filter: 'bandpass', freq: 450 + 3600 * k.rnd(), q: 3 + 9 * k.rnd(),
      peak: (0.08 + 0.22 * k.rnd()) * IV * fade, attack: 0.002, tau: 0.012 + 0.05 * k.rnd(),
    });
    if (k.rnd() < 0.3) playClang(k, dest, td, 380 + 1400 * k.rnd(), 0.18 * IV * fade);
    else if (k.rnd() < 0.25) noiseBurst(k, dest, td, { buffer: k.brown, filter: 'lowpass', freq: 500, q: 0.8, peak: 0.25 * IV * fade, attack: 0.003, tau: 0.05 });
  }
  // The wreck grinding to a stop.
  playScrape(k, dest, t + 0.15, 0.28 * IV, 1.4 + 1.4 * I);
  // The fuel fireball goes up a moment later.
  playExplosion(k, dest, t + 0.12 + 0.1 * k.rnd(), 0.75 + 0.25 * I, V);
}

/** An explosion: sub-bass boom, a sharp crack, a rolling low roar and a few crackles. `size` 0..1, `level` 0..1. */
export function playExplosion(k: OneShotKit, dest: AudioNode, t: number, size: number, level = 1): void {
  const S = safe(size, 0.05, 1);
  const L = safe(level, 0, 1) * (0.35 + 0.65 * S);
  toneBurst(k, dest, t, { type: 'sine', freq: 48 + 20 * (1 - S), freqEnd: 21, sweep: 0.8 + 0.6 * S, peak: 1.2 * L, attack: 0.004, tau: 0.3 + 0.4 * S });
  noiseBurst(k, dest, t, { buffer: k.white, filter: 'bandpass', freq: 1400, q: 0.6, peak: 0.5 * L, attack: 0.001, tau: 0.035 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 1500, freqEnd: 110, sweep: 1 + S, q: 0.6, peak: 1.4 * L, attack: 0.006, tau: 0.35 + 0.55 * S });
  noiseBurst(k, dest, t + 0.08, { buffer: k.pink, filter: 'lowpass', freq: 420, freqEnd: 160, sweep: 2, q: 0.5, peak: 0.45 * L, attack: 0.15, tau: 0.5 + 0.6 * S });
  const pops = 2 + Math.round(4 * S);
  for (let p = 0; p < pops; p++) playCrackle(k, dest, t + 0.1 + 0.9 * S * k.rnd(), 0.8 * L);
}

/** Debris or airframe hitting the ground: thud + crunch + a metallic knock. `intensity` 0..1, `level` 0..1. */
export function playImpact(k: OneShotKit, dest: AudioNode, t: number, intensity: number, level = 1): void {
  const I = safe(intensity, 0, 1) * safe(level, 0, 1);
  toneBurst(k, dest, t, { type: 'sine', freq: 95, freqEnd: 42, sweep: 0.12, peak: 0.8 * I, attack: 0.002, tau: 0.08 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 700, freqEnd: 200, sweep: 0.2, q: 0.7, peak: 0.8 * I, attack: 0.002, tau: 0.09 });
  noiseBurst(k, dest, t + 0.005, { buffer: k.white, filter: 'bandpass', freq: 2200 + 1500 * k.rnd(), q: 1.5, peak: 0.25 * I, attack: 0.001, tau: 0.03 });
  if (k.rnd() < 0.6) playClang(k, dest, t, 200 + 700 * k.rnd(), 0.35 * I);
}

/** Afterburner light-off: a low "whoomph" as the flame front fills the nozzle. */
export function playWhoomph(k: OneShotKit, dest: AudioNode, t: number, level: number): void {
  const L = safe(level, 0, 2);
  toneBurst(k, dest, t, { type: 'sine', freq: 28, freqEnd: 52, sweep: 0.18, peak: 0.9 * L, attack: 0.03, tau: 0.22 });
  noiseBurst(k, dest, t, { buffer: k.brown, filter: 'lowpass', freq: 180, freqEnd: 900, sweep: 0.35, q: 0.9, peak: 1.0 * L, attack: 0.04, tau: 0.3 });
  noiseBurst(k, dest, t + 0.03, { buffer: k.pink, filter: 'bandpass', freq: 300, freqEnd: 1300, sweep: 0.4, q: 0.7, peak: 0.45 * L, attack: 0.06, tau: 0.25 });
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
