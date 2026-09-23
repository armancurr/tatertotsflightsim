/**
 * Small helpers for building WebAudio graphs: a node builder that remembers every node and source
 * it made (so a sub-graph — an engine voice — can be torn down without leaks), and `Knob`, an
 * AudioParam that is only re-targeted when its target actually changes (no automation flood, no
 * zipper noise: every move is a setTargetAtTime).
 */
import { fourierSeries, noiseSamples, type NoiseKind } from './waves';
import type { EngineSound } from '../fleet/types';
import type { AudioInputs, AudioLevels } from './types';
import type { OneShotKit } from './oneshots';

/** A parameter that is only re-targeted when its target actually changes. */
export class Knob {
  last = Number.NaN;
  constructor(readonly param: AudioParam, private readonly eps = 1e-4) {}
  set(v: number, t: number, tau: number): void {
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - this.last) <= this.eps * Math.max(1, Math.abs(this.last))) return;
    this.last = v;
    this.param.setTargetAtTime(v, t, tau);
  }
}

export interface Builder {
  ctx: BaseAudioContext;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  gain(v: number): GainNode;
  filter(type: BiquadFilterType, f: number, q: number, dbGain?: number): BiquadFilterNode;
  osc(type: OscillatorType | PeriodicWave, f: number): OscillatorNode;
  /** A looping noise source started at a random offset. */
  loop(buf: AudioBuffer, rate?: number): AudioBufferSourceNode;
  /** PeriodicWave from one period of samples. */
  wave(samples: Float32Array, harmonics: number): PeriodicWave;
  /** Connect in series; returns the last node. */
  chain(...ns: AudioNode[]): AudioNode;
  knob(p: AudioParam, eps?: number): Knob;
}

export function createBuilder(ctx: BaseAudioContext, rnd: () => number): Builder {
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };
  return {
    ctx,
    nodes,
    sources,
    gain(v) {
      const g = keep(ctx.createGain());
      g.gain.value = v;
      return g;
    },
    filter(type, f, q, dbGain = 0) {
      const b = keep(ctx.createBiquadFilter());
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      b.gain.value = dbGain;
      return b;
    },
    osc(type, f) {
      const o = keep(ctx.createOscillator());
      if (typeof type === 'string') o.type = type as OscillatorType;
      else o.setPeriodicWave(type);
      o.frequency.value = f;
      o.start(0);
      sources.push(o);
      return o;
    },
    loop(buf, rate = 1) {
      const s = keep(ctx.createBufferSource());
      s.buffer = buf;
      s.loop = true;
      if (rate !== 1) s.playbackRate.value = rate;
      s.start(0, rnd() * buf.duration * 0.9);
      sources.push(s);
      return s;
    },
    wave(samples, harmonics) {
      const w = fourierSeries(samples, harmonics);
      return ctx.createPeriodicWave(w.real, w.imag, { disableNormalization: false });
    },
    chain(...ns) {
      for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]);
      return ns[ns.length - 1];
    },
    knob: (p, eps) => new Knob(p, eps),
  };
}

/** A mono noise buffer of `seconds`. */
export function noiseBuffer(ctx: BaseAudioContext, kind: NoiseKind, seconds: number, seed: number): AudioBuffer {
  const n = Math.max(1, Math.round(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  buf.getChannelData(0).set(noiseSamples(kind, n, seed));
  return buf;
}

/** Per-frame context handed to an engine voice by the sound engine. */
export interface VoiceFrame {
  /** Audio clock, s. */
  t: number;
  /** Frame dt, s (0 while paused). */
  dt: number;
  /** Default parameter ramp time constant, s. */
  tau: number;
  exterior: boolean;
  /** Doppler pitch factor (1 in the cockpit). */
  doppler: number;
  crashed: boolean;
  /** One-shots may be triggered (not on the very first frame). */
  primed: boolean;
}

/** Where a voice plays: the aircraft path (view filters + distance) and the cabin-only path. */
export interface VoiceOutputs {
  exterior: AudioNode;
  cabin: AudioNode;
  kit: OneShotKit;
}

/**
 * One aircraft's engine sound (and the systems sounds that differ per type: gear/flap motors,
 * hydraulics, door whistle, ECS). The sound engine swaps voices when the player switches aircraft.
 */
export interface EngineVoice {
  readonly kind: EngineSound;
  /** Exterior full-level distance for this aircraft, m. */
  readonly refDistanceM: number;
  /** Follow the inputs; write this voice's levels (and zero the other voice's) into L. Returns the number of one-shots played. */
  update(a: AudioInputs, f: VoiceFrame, L: AudioLevels): number;
  /** Fade out from `t`, stop every source, disconnect everything once the sources have ended. */
  retire(t: number, onGone: () => void): void;
}

/** Fade a voice's outputs, stop its sources after the fade, and disconnect it when they have ended. */
export function retireGraph(b: Builder, outs: GainNode[], t: number, onGone: () => void): void {
  for (const o of outs) {
    o.gain.cancelScheduledValues(t);
    o.gain.setTargetAtTime(0, t, 0.03);
  }
  const stopAt = t + 0.2;
  let pending = b.sources.length;
  const gone = () => {
    for (const n of b.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already */
      }
    }
    onGone();
  };
  if (pending === 0) {
    gone();
    return;
  }
  for (const s of b.sources) {
    s.onended = () => {
      pending--;
      if (pending === 0) gone();
    };
    try {
      s.stop(stopAt);
    } catch {
      pending--;
    }
  }
  if (pending <= 0) gone();
}
