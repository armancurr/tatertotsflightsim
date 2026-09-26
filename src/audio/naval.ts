/**
 * The naval guns' sound (procedural WebAudio, no samples), into the shared master bus (mute, pause,
 * glue compressor, limiter — `AudioSystem.masterInput`):
 *
 *   report   a 16-inch gun firing: near, a tearing crack, a chest-deep sub-bass thump (45 → 18 Hz),
 *            a roaring body and a long rolling rumble with echoes off the sea; far away only the low
 *            boom and the rumble survive (air absorption) and it arrives d / 343 m/s late — from
 *            10 km, half a minute after the flash, like the GAU-8's delayed "BRRRT"
 *   splash   a shell into the sea: a deep whump, the roar of the column going up, then the hiss of
 *            tons of water falling back
 *   burst    a shell bursting on a target / the land: crack, thump, body, rumble
 *
 * Every one-shot is scheduled at its own distance / c. `reset()` silences everything, including
 * sounds still on their way. The mappings (delay, gain, cut-off) are pure and exported for tests.
 * `shareAudio` / `sharedAudio` hand the scene's AudioSystem from the audio system to the navalAudio
 * system.
 */
import type { AudioSystem } from './types';

export const SPEED_OF_SOUND = 343;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Seconds a sound takes to travel `d` m (capped at 90 s: the longest range and then some). */
export function navalDelayS(d: number): number {
  return clamp(Math.max(0, fin(d, 0)) / SPEED_OF_SOUND, 0, 90);
}

/** Level at `d` m for a source that is 1 within `refM`: spherical spreading, softened. */
export function navalGain(d: number, refM = 120): number {
  const x = Math.max(0, fin(d, 0));
  if (x <= refM) return 1;
  const g = Math.pow(refM / x, 0.9);
  return clamp(Number.isFinite(g) ? g : 0, 0, 1);
}

/** Air absorption: the low-pass cut-off (Hz) at `d` m — halving every 1.8 km, 9 kHz … 90 Hz. */
export function navalCutoffHz(d: number): number {
  return clamp(9000 * Math.pow(0.5, Math.max(0, fin(d, 0)) / 1800), 90, 9000);
}

export interface NavalSound {
  report(e: { distanceM: number; size?: number }): void;
  splash(e: { distanceM: number; size?: number }): void;
  burst(e: { distanceM: number; size?: number }): void;
  reset(): void;
  readonly played: { reports: number; splashes: number; bursts: number };
  dispose(): void;
}

function noiseBuffer(ctx: BaseAudioContext, kind: 'white' | 'brown' | 'pink', seconds: number, seed: number): AudioBuffer {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  let last = 0;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    if (kind === 'white') d[i] = w * 0.6;
    else if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    } else {
      b0 = 0.99765 * b0 + w * 0.099;
      b1 = 0.963 * b1 + w * 0.2965;
      b2 = 0.57 * b2 + w * 1.0527;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
  }
  return b;
}

export function createNavalSound(ctx: BaseAudioContext, dest: AudioNode, seed = 0x16b1): NavalSound {
  const bus = ctx.createGain();
  bus.gain.value = 0.9;
  bus.connect(dest);
  const white = noiseBuffer(ctx, 'white', 2, seed);
  const brown = noiseBuffer(ctx, 'brown', 3, seed + 1);
  const pink = noiseBuffer(ctx, 'pink', 2, seed + 2);
  const live = new Set<AudioScheduledSourceNode>();
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const played = { reports: 0, splashes: 0, bursts: 0 };

  const env = (p: AudioParam, t: number, peak: number, attack: number, tau: number) => {
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(Math.max(0, peak), t + attack);
    p.setTargetAtTime(0, t + attack, tau);
    return t + attack + tau * 7;
  };
  const track = (src: AudioScheduledSourceNode, nodes: AudioNode[]) => {
    live.add(src);
    src.onended = () => {
      live.delete(src);
      for (const nd of nodes) {
        try {
          nd.disconnect();
        } catch {
          /* gone */
        }
      }
    };
  };
  const noise = (t: number, buf: AudioBuffer, type: BiquadFilterType, f0: number, peak: number, attack: number, tau: number, f1?: number, sweep?: number, q = 0.7) => {
    if (!(peak > 1e-5)) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(clamp(f0, 20, 20000), t);
    if (f1 !== undefined) f.frequency.exponentialRampToValueAtTime(clamp(f1, 20, 20000), t + Math.max(0.01, sweep ?? tau * 3));
    const g = ctx.createGain();
    g.gain.value = 0;
    const end = env(g.gain, t, peak, attack, tau);
    src.connect(f);
    f.connect(g);
    g.connect(bus);
    src.start(t, rnd() * Math.max(0, buf.duration - 0.2));
    src.stop(end);
    track(src, [src, f, g]);
  };
  const tone = (t: number, f0: number, f1: number, sweep: number, peak: number, attack: number, tau: number) => {
    if (!(peak > 1e-5)) return;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(clamp(f0, 10, 20000), t);
    o.frequency.exponentialRampToValueAtTime(clamp(f1, 10, 20000), t + Math.max(0.01, sweep));
    const g = ctx.createGain();
    g.gain.value = 0;
    const end = env(g.gain, t, peak, attack, tau);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(end);
    track(o, [o, g]);
  };
  const hi = (f: number, cut: number) => (f > cut ? cut / f : 1);

  /** Crack + thump + body + rumble + echoes: the shape of every big bang, scaled. */
  const bang = (d: number, size: number, level: number, tailS: number) => {
    const t = ctx.currentTime + navalDelayS(d);
    const g = navalGain(d, 120) * level;
    const cut = navalCutoffHz(d);
    if (g < 2e-4) return;
    const S = clamp(size, 0.2, 2);
    noise(t, white, 'highpass', 1400, 0.9 * g * hi(2500, cut), 0.0015, 0.028);
    noise(t, white, 'bandpass', Math.min(2200, cut), 0.7 * g * hi(1800, cut), 0.002, 0.06, undefined, undefined, 0.5);
    tone(t, 46, 18, 0.7 + 0.3 * S, 1.3 * g * Math.min(1.2, S), 0.005, 0.42 + 0.25 * S);
    noise(t, brown, 'lowpass', Math.min(1300, cut), 1.5 * g, 0.006, 0.55 + 0.35 * S, Math.min(90, cut), 1.4 + S);
    const tail = tailS + d / 3500;
    noise(t + 0.12, brown, 'lowpass', Math.min(240, cut), 0.7 * g, 0.25, tail * 0.45);
    // echoes off the sea / the far shore
    for (let k = 0; k < 2; k++) {
      const e = 0.5 + k * (0.9 + rnd()) + d * 0.0003;
      noise(t + e, brown, 'lowpass', Math.min(380, cut), (0.32 - 0.1 * k) * g, 0.04, 0.6 + 0.3 * k);
    }
  };

  return {
    played,
    report(e) {
      if (!e) return;
      played.reports++;
      bang(Math.max(0, fin(e.distanceM, 0)), fin(e.size, 1) * 1.25, 1, 3.2);
    },
    splash(e) {
      if (!e) return;
      played.splashes++;
      const d = Math.max(0, fin(e.distanceM, 0));
      const S = clamp(fin(e.size, 1), 0.2, 2);
      const t = ctx.currentTime + navalDelayS(d);
      const g = navalGain(d, 100) * 0.9;
      const cut = navalCutoffHz(d);
      if (g < 2e-4) return;
      tone(t, 72, 28, 0.35, 0.9 * g * S, 0.004, 0.28);
      noise(t, pink, 'bandpass', Math.min(700, cut), 1.0 * g * hi(700, cut), 0.01, 0.45, Math.min(260, cut), 1.2, 0.6);
      noise(t + 0.05, brown, 'lowpass', Math.min(500, cut), 0.8 * g, 0.05, 0.8);
      // the column falling back: a long hiss of rain on the sea
      noise(t + 1.6, white, 'lowpass', Math.min(3600, cut), 0.26 * g * hi(3000, cut), 1.2, 1.9);
    },
    burst(e) {
      if (!e) return;
      played.bursts++;
      bang(Math.max(0, fin(e.distanceM, 0)), fin(e.size, 1), 0.9, 2.4);
    },
    reset() {
      const t = ctx.currentTime;
      for (const src of [...live]) {
        try {
          src.stop(t);
        } catch {
          /* already stopped */
        }
      }
      live.clear();
    },
    dispose() {
      this.reset();
      try {
        bus.disconnect();
      } catch {
        /* gone */
      }
    },
  };
}

// ─── handing the scene's AudioSystem to the navalAudio system ────────────────

const shared = new WeakMap<object, AudioSystem>();
export function shareAudio(scene: object, audio: AudioSystem): void {
  shared.set(scene, audio);
}
export function sharedAudio(scene: object): AudioSystem | null {
  return shared.get(scene) ?? null;
}
