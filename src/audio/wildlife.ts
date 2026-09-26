/**
 * Wildlife sounds (WebAudio synthesis, no samples): herring gulls calling near the flocks and the
 * marina (a nasal "kyow" with a pitch rise and fall, sometimes the laughing "ha-ha-ha"), a burst of
 * calls when perched birds are flushed, the "pfff" of a dolphin breathing close by, the deep
 * whoosh of a humpback's blow (it carries a long way; heard late — sound takes d / 343 s) and the
 * thunder of a breach.
 *
 * Self-contained (its own AudioContext, unlocked on the first gesture like the main audio;
 * suspended while the tab is hidden), so the shared audio system stays untouched. Mute follows
 * the sim's M key (the system forwards the 'mute' action) and the sound pauses with the sim.
 * The pure mappings (distance gain, pan, call rate) are exported for tests.
 */

export type WildlifeSound = 'blow' | 'dolphinBlow' | 'breach' | 'flush' | 'gull';

/** How loud a source is at distance d (m): inverse distance from `ref`, silent beyond `max`. */
export function distanceGain(d: number, ref: number, max: number): number {
  if (!Number.isFinite(d) || d >= max) return 0;
  const g = ref / Math.max(ref, d);
  // fade the last 20 % to silence
  const edge = Math.min(1, (max - d) / (0.2 * max));
  return g * edge;
}

/** Stereo pan (−1 left … 1 right) of a source relative to the listener's right-hand axis. */
export function panOf(dx: number, dy: number, dz: number, rx: number, ry: number, rz: number): number {
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return 0;
  const p = (dx * rx + dy * ry + dz * rz) / d;
  return Math.max(-1, Math.min(1, p * 0.85));
}

/** Gull calls per second with `n` birds near the listener. */
export const gullCallRate = (n: number): number => Math.min(2.2, n * 0.11);

/** Air absorbs the highs: a low-pass cutoff (Hz) for distance d (m). */
export const airCutoff = (d: number): number => Math.max(700, 16000 / (1 + d / 250));

/** Where each sound is audible: reference distance and range (m). */
export const RANGES: Record<WildlifeSound, { ref: number; max: number; level: number }> = {
  gull: { ref: 14, max: 320, level: 0.22 },
  flush: { ref: 14, max: 320, level: 0.22 },
  dolphinBlow: { ref: 8, max: 160, level: 0.35 },
  blow: { ref: 45, max: 3000, level: 0.55 },
  breach: { ref: 60, max: 5000, level: 0.8 },
};

export interface WildlifeListener {
  x: number;
  y: number;
  z: number;
  /** The camera's right-hand axis (world). */
  rx: number;
  ry: number;
  rz: number;
  paused: boolean;
  dt: number;
  /** The gulls' poses (positions + visibility) for the calls. */
  gulls: { x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number>; visible: ArrayLike<number> };
  gullCount: number;
}

export interface WildlifeAudioOptions {
  /** Makes the real context on the first gesture (default: window.AudioContext). */
  createContext?: () => BaseAudioContext | null;
  /** Where to listen for the unlocking gesture (default: globalThis). */
  target?: { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void } | null;
  random?: () => number;
}

export interface WildlifeAudio {
  readonly context: BaseAudioContext | null;
  /** Starts (or resumes) the context — the first gesture calls it. */
  resume(): Promise<void>;
  event(kind: WildlifeSound, x: number, y: number, z: number, size: number): void;
  update(l: WildlifeListener): void;
  toggleMute(): void;
  setMuted(m: boolean): void;
  readonly muted: boolean;
  stats(): { state: string; voices: number; played: Record<string, number>; errors: number };
  dispose(): void;
}

const MAX_VOICES = 14;
const SPEED_OF_SOUND = 343;

const defaultContext = (): BaseAudioContext | null => {
  const w = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  const C = w.AudioContext ?? w.webkitAudioContext;
  return C ? new C() : null;
};

export function createWildlifeAudio(opts: WildlifeAudioOptions = {}): WildlifeAudio {
  const rnd = opts.random ?? Math.random;
  const target = opts.target === undefined ? (globalThis as unknown as WildlifeAudioOptions['target']) : opts.target;
  let ctx: BaseAudioContext | null = null;
  let master: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;
  let paused = false;
  let disposed = false;
  let voices = 0;
  let errors = 0;
  const played: Record<string, number> = {};
  const L = { x: 0, y: 0, z: 0, rx: 1, ry: 0, rz: 0, set: false };

  const build = (c: BaseAudioContext) => {
    ctx = c;
    master = c.createGain();
    master.gain.value = 0;
    master.connect(c.destination);
    const len = Math.floor(c.sampleRate * 2);
    noise = c.createBuffer(1, len, c.sampleRate);
    const d = noise.getChannelData(0);
    let seed = 0x1234567;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      d[i] = (seed / 4294967296) * 2 - 1;
    }
    applyMaster();
  };

  const applyMaster = () => {
    if (!ctx || !master) return;
    const on = !muted && !paused ? 1 : 0;
    master.gain.setTargetAtTime(on, ctx.currentTime, 0.08);
  };

  const unlock = () => {
    void api.resume();
  };
  const GESTURES = ['keydown', 'pointerdown', 'pointerup', 'touchend'];
  for (const g of GESTURES) target?.addEventListener?.(g, unlock);
  const doc = typeof document !== 'undefined' ? document : null;
  const onVis = () => {
    const c = ctx as AudioContext | null;
    if (!c || typeof c.suspend !== 'function') return;
    if (doc?.hidden) void c.suspend().catch(() => undefined);
    else void c.resume().catch(() => undefined);
  };
  doc?.addEventListener('visibilitychange', onVis);

  /** A voice chain: source(s) → band-pass → air low-pass → pan → gain envelope → master. */
  const chain = (c: BaseAudioContext, dist: number, pan: number, level: number) => {
    const g = c.createGain();
    g.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = airCutoff(dist);
    const sp = typeof c.createStereoPanner === 'function' ? c.createStereoPanner() : null;
    if (sp) {
      sp.pan.value = pan;
      lp.connect(sp);
      sp.connect(g);
    } else lp.connect(g);
    g.connect(master!);
    void level;
    return { g, lp, sp };
  };

  const retire = (nodes: AudioNode[]) => () => {
    voices = Math.max(0, voices - 1);
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already */
      }
    }
  };

  const gullCall = (c: BaseAudioContext, t0: number, amp: number, dist: number, pan: number, laugh: boolean) => {
    const v = chain(c, dist, pan, amp);
    const notes = laugh ? 3 + Math.floor(rnd() * 4) : 1 + Math.floor(rnd() * 3);
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.2;
    bp.frequency.value = 1900 + 500 * rnd();
    osc.connect(bp);
    bp.connect(v.lp);
    const base = 620 + 260 * rnd();
    let t = t0;
    for (let k = 0; k < notes; k++) {
      const dur = laugh ? 0.12 + 0.05 * rnd() : 0.26 + 0.14 * rnd();
      // "kyow": up, then a long fall
      osc.frequency.setValueAtTime(base * 0.95, t);
      osc.frequency.linearRampToValueAtTime(base * (laugh ? 1.18 : 1.38), t + dur * 0.28);
      osc.frequency.linearRampToValueAtTime(base * (laugh ? 0.9 : 0.72), t + dur);
      v.g.gain.setValueAtTime(0, t);
      v.g.gain.linearRampToValueAtTime(amp, t + 0.02);
      v.g.gain.setTargetAtTime(amp * 0.6, t + 0.05, dur * 0.4);
      v.g.gain.linearRampToValueAtTime(0, t + dur);
      t += dur + (laugh ? 0.05 + 0.04 * rnd() : 0.12 + 0.2 * rnd());
    }
    osc.start(t0);
    osc.stop(t + 0.05);
    voices++;
    osc.onended = retire([osc, bp, v.lp, v.g, ...(v.sp ? [v.sp] : [])]);
  };

  const breath = (c: BaseAudioContext, t0: number, amp: number, dist: number, pan: number, big: boolean, dur: number) => {
    const v = chain(c, dist, pan, amp);
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = big ? 0.7 : 1.1;
    bp.frequency.setValueAtTime(big ? 900 : 1500, t0);
    bp.frequency.exponentialRampToValueAtTime(big ? 260 : 600, t0 + dur);
    src.connect(bp);
    bp.connect(v.lp);
    v.g.gain.setValueAtTime(0, t0);
    v.g.gain.linearRampToValueAtTime(amp, t0 + (big ? 0.12 : 0.04));
    v.g.gain.setTargetAtTime(amp * 0.5, t0 + 0.15, dur * 0.35);
    v.g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.start(t0, rnd() * 1.5);
    src.stop(t0 + dur + 0.05);
    voices++;
    src.onended = retire([src, bp, v.lp, v.g, ...(v.sp ? [v.sp] : [])]);
  };

  const splash = (c: BaseAudioContext, t0: number, amp: number, dist: number, pan: number) => {
    const v = chain(c, dist, pan, amp);
    const src = c.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2200, t0);
    lp.frequency.exponentialRampToValueAtTime(300, t0 + 2.5);
    src.connect(lp);
    lp.connect(v.lp);
    const thump = c.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(70, t0);
    thump.frequency.exponentialRampToValueAtTime(32, t0 + 0.6);
    const tg = c.createGain();
    tg.gain.setValueAtTime(0, t0);
    tg.gain.linearRampToValueAtTime(amp * 1.2, t0 + 0.02);
    tg.gain.exponentialRampToValueAtTime(0.001, t0 + 0.8);
    thump.connect(tg);
    tg.connect(v.lp);
    v.g.gain.setValueAtTime(0, t0);
    v.g.gain.linearRampToValueAtTime(amp, t0 + 0.03);
    v.g.gain.setTargetAtTime(0, t0 + 0.2, 0.7);
    src.start(t0, rnd());
    src.stop(t0 + 3.2);
    thump.start(t0);
    thump.stop(t0 + 0.9);
    voices++;
    src.onended = retire([src, lp, thump, tg, v.lp, v.g, ...(v.sp ? [v.sp] : [])]);
  };

  const play = (kind: WildlifeSound, x: number, y: number, z: number, size: number) => {
    const c = ctx;
    if (!c || !master || disposed || !L.set || voices >= MAX_VOICES) return;
    const dx = x - L.x;
    const dy = y - L.y;
    const dz = z - L.z;
    const d = Math.hypot(dx, dy, dz);
    const R = RANGES[kind];
    const amp = distanceGain(d, R.ref, R.max) * R.level * Math.min(1.5, Math.max(0.4, size));
    if (amp < 0.004) return;
    try {
      const t0 = c.currentTime + 0.02 + d / SPEED_OF_SOUND;
      const pan = panOf(dx, dy, dz, L.rx, L.ry, L.rz);
      if (kind === 'gull') gullCall(c, t0, amp, d, pan, rnd() < 0.25);
      else if (kind === 'flush') {
        const n = Math.min(4, 1 + Math.floor(size / 2));
        for (let k = 0; k < n; k++) gullCall(c, t0 + k * (0.15 + 0.2 * rnd()), amp * (0.7 + 0.3 * rnd()), d, Math.max(-1, Math.min(1, pan + (rnd() - 0.5) * 0.6)), rnd() < 0.4);
      } else if (kind === 'dolphinBlow') breath(c, t0, amp, d, pan, false, 0.45 + 0.25 * rnd());
      else if (kind === 'blow') breath(c, t0, amp, d, pan, true, 1.3 + 0.6 * rnd());
      else splash(c, t0, amp, d, pan);
      played[kind] = (played[kind] ?? 0) + 1;
    } catch {
      errors++;
    }
  };

  const api: WildlifeAudio = {
    get context() {
      return ctx;
    },
    async resume() {
      if (disposed) return;
      try {
        if (!ctx) {
          const c = (opts.createContext ?? defaultContext)();
          if (!c) return;
          build(c);
        }
        const c = ctx as unknown as AudioContext | null;
        if (c && c.state === 'suspended' && typeof c.resume === 'function' && !doc?.hidden) await c.resume();
      } catch {
        /* blocked / unsupported: silent */
      }
    },
    event(kind, x, y, z, size) {
      play(kind, x, y, z, size);
    },
    update(l) {
      L.x = l.x;
      L.y = l.y;
      L.z = l.z;
      L.rx = l.rx;
      L.ry = l.ry;
      L.rz = l.rz;
      L.set = true;
      if (l.paused !== paused) {
        paused = l.paused;
        applyMaster();
      }
      if (!ctx || l.paused || !(l.dt > 0)) return;
      // gulls near the listener call now and then, from one of them
      let n = 0;
      const G = l.gulls;
      for (let i = 0; i < l.gullCount; i++) {
        if (!G.visible[i]) continue;
        if (Math.abs(G.x[i] - l.x) + Math.abs(G.z[i] - l.z) < 220) n++;
      }
      // a Poisson stream of calls, each from one of the near birds
      if (n === 0 || rnd() >= gullCallRate(n) * l.dt) return;
      let k = Math.floor(rnd() * n);
      for (let i = 0; i < l.gullCount; i++) {
        if (!G.visible[i] || Math.abs(G.x[i] - l.x) + Math.abs(G.z[i] - l.z) >= 220) continue;
        if (k-- === 0) {
          play('gull', G.x[i], G.y[i], G.z[i], 1);
          break;
        }
      }
    },
    toggleMute() {
      api.setMuted(!muted);
    },
    setMuted(m) {
      muted = m;
      applyMaster();
    },
    get muted() {
      return muted;
    },
    stats() {
      return { state: (ctx as AudioContext | null)?.state ?? 'none', voices, played: { ...played }, errors };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const g of GESTURES) target?.removeEventListener?.(g, unlock);
      doc?.removeEventListener('visibilitychange', onVis);
      try {
        master?.disconnect();
        const c = ctx as AudioContext | null;
        if (c && typeof c.close === 'function') void c.close().catch(() => undefined);
      } catch {
        /* ignore */
      }
    },
  };
  return api;
}
