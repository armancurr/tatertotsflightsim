/**
 * Humpback whales offshore (PURE, no three.js, no allocation per call).
 *
 * A few whales cruise slow loops far out (z > 11,500, ≥ 18 m of water), ≥ 4 km from the naval
 * gunnery range and ≥ 1.5 km from the oil platform. Everything is a pure function of the sea
 * clock: a whale lives through surfacing sequences — 3–6 surfacings ~30 s apart, each one a
 * head rising, a **blow** (the tall bushy spout, drawn by the renderer as vapour drifting
 * downwind), the long back rolling forward with the small dorsal hump; the last one arches high
 * and the **flukes come up** as it sounds; then a dive of 2–3 minutes. Some sequences open with a
 * **breach**: the whale drives up at 70°, clears two thirds of its length, twists and falls back
 * on its side in a huge splash. A mother may have her calf alongside.
 *
 * Heights are relative to the drawn sea (`dy`, + above the surface, body centre). Frame: world
 * +X east, +Z south; heading clockwise from north; pitch + nose up, roll + right side down.
 */
import { newPathSample, samplePath, type Path } from '../traffic/path';
import { h01, hRange } from '../traffic/rng';
import type { WaterWorld } from '../traffic/sea';
import { WILDLIFE } from './tuning';
import { fitLoop, type ZoneContext } from './zones';

const W = WILDLIFE.whale;
const SEED = WILDLIFE.seed;
/** Sequences in a whale's repeating schedule. */
const SEQS = 48;

export interface Sequence {
  start: number;
  blows: number;
  interval: number;
  dive: number;
  breach: boolean;
  duration: number;
}

export interface WhaleDef {
  id: string;
  route: Path;
  speed: number;
  phase: number;
  length: number;
  /** Index of the mother (calves share her schedule), or −1. */
  calfOf: number;
  /** Calf: lateral / along offset from the mother (m) and schedule delay (s). */
  offAcross: number;
  offAlong: number;
  delay: number;
  /** Schedule: SEQS sequences, their total length (s), and the whale's offset into it. */
  seqs: Sequence[];
  cycle: number;
  offset: number;
  key: number;
}

export interface WhalePlan {
  whales: WhaleDef[];
  rejected: string[];
}

function schedule(key: number): { seqs: Sequence[]; cycle: number } {
  const seqs: Sequence[] = [];
  let t = 0;
  for (let j = 0; j < SEQS; j++) {
    const blows = Math.round(hRange(SEED, 8100, key * 101 + j, W.blows[0], W.blows[1] + 0.49));
    const interval = hRange(SEED, 8101, key * 101 + j, W.blowInterval[0], W.blowInterval[1]);
    const dive = hRange(SEED, 8102, key * 101 + j, W.dive[0], W.dive[1]);
    const breach = h01(SEED, 8103, key * 101 + j) < W.breachChance;
    const duration = blows * interval + dive;
    seqs.push({ start: t, blows, interval, dive, breach, duration });
    t += duration;
  }
  return { seqs, cycle: t };
}

export function createWhalePlan(ctx: ZoneContext, water: WaterWorld): WhalePlan {
  const whales: WhaleDef[] = [];
  const rejected: string[] = [];
  W.whales.forEach((spec, i) => {
    const route = fitLoop(ctx, water, 'whale', spec, 200 + i, W.minDepth, 40, (_x, z) => z > W.minZ);
    if (!route) {
      rejected.push(`whale-${i}`);
      return;
    }
    const s = schedule(i);
    const mother = whales.length;
    whales.push({
      id: `whale-${i}`,
      route,
      speed: spec.speed,
      phase: h01(SEED, 8000, i) * route.length,
      length: spec.length,
      calfOf: -1,
      offAcross: 0,
      offAlong: 0,
      delay: 0,
      seqs: s.seqs,
      cycle: s.cycle,
      offset: hRange(SEED, 8001, i, 0, s.cycle),
      key: i,
    });
    if (spec.calf) {
      whales.push({ ...whales[mother], id: `whale-${i}-calf`, length: spec.length * 0.36, calfOf: mother, offAcross: 7.5, offAlong: -3, delay: 2.4, key: i + 50 });
    }
  });
  return { whales, rejected };
}

/** The sequence a whale is in at time t, and the time into it. */
export function sequenceAt(w: WhaleDef, t: number): { seq: Sequence; index: number; tau: number } {
  const tt = t + w.offset - w.delay;
  const r = ((tt % w.cycle) + w.cycle) % w.cycle;
  let lo = 0;
  let hi = w.seqs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (w.seqs[mid].start <= r) lo = mid;
    else hi = mid - 1;
  }
  const seq = w.seqs[lo];
  return { seq, index: lo, tau: r - seq.start };
}

// ─── Keyframed motions: [u (s), dy (fraction of L or m), pitch, flex, roll] ────

type Key = readonly [number, number, number, number, number];

/** A normal surfacing: head up and blow, the back rolls over, down again (dy in m, for a 14 m whale). */
const SURFACE: readonly Key[] = [
  [0, -5, 12, 0, 0],
  [1.6, -1.2, 9, 0, 0],
  [3.4, -0.75, 1, 0.1, 0],
  [6, -0.85, -8, 0.45, 0],
  [8.4, -1.7, -13, 0.3, 0],
  [11, -4.2, -10, 0, 0],
  [13, -6, -2, 0, 0],
];
/** The last surfacing: a high arch and the flukes lifted clear as it sounds. */
const SOUND: readonly Key[] = [
  [0, -5, 12, 0, 0],
  [1.6, -1.2, 9, 0, 0],
  [3.4, -0.7, 0, 0.15, 0],
  [6, -0.65, -13, 0.8, 0],
  [8, -1.3, -32, 1, 0],
  [10, -3.1, -56, 0.55, 0],
  [12, -6, -76, 0.25, 0],
  [14, -10.5, -80, 0, 0],
  [17, -19, -55, 0, 0],
  [20, -25, -10, 0, 0],
];
/** A breach: up at 70°, two thirds clear, twist onto the side, fall back, roll upright underwater. */
const BREACH: readonly Key[] = [
  [0, -16, 45, 0, 0],
  [2, -6, 68, -0.1, 0],
  [3.1, 2.4, 72, -0.2, 20],
  [3.9, 4.4, 52, -0.1, 65],
  [4.7, 2.2, 22, 0, 110],
  [5.3, -1.5, 2, 0, 150],
  [6.6, -4.2, -6, 0, 185],
  [9, -6, -2, 0, 330],
  [11, -6.5, 0, 0, 360],
];
/** Time into BREACH of the re-entry splash, and of the emergence. */
export const BREACH_SPLASH = 5.0;
export const BREACH_EMERGE = 2.6;
/** Time into a surfacing of the blow. */
export const BLOW_AT = 1.9;
/** SOUND: the flukes stream water from here. */
export const FLUKE_AT = 8.6;

function keyed(keys: readonly Key[], u: number, out: Float64Array): void {
  const n = keys.length;
  if (u <= keys[0][0]) {
    for (let c = 0; c < 4; c++) out[c] = keys[0][c + 1];
    return;
  }
  if (u >= keys[n - 1][0]) {
    for (let c = 0; c < 4; c++) out[c] = keys[n - 1][c + 1];
    return;
  }
  let i = 0;
  while (i < n - 2 && keys[i + 1][0] <= u) i++;
  const k0 = keys[Math.max(0, i - 1)];
  const k1 = keys[i];
  const k2 = keys[i + 1];
  const k3 = keys[Math.min(n - 1, i + 2)];
  const h = k2[0] - k1[0];
  const s = (u - k1[0]) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  for (let c = 1; c <= 4; c++) {
    // Catmull-Rom tangents on a non-uniform grid (zero at the ends)
    const m1 = i === 0 ? 0 : ((k2[c] - k0[c]) / (k2[0] - k0[0])) * h;
    const m2 = i + 2 >= n ? 0 : ((k3[c] - k1[c]) / (k3[0] - k1[0])) * h;
    out[c - 1] = (2 * s3 - 3 * s2 + 1) * k1[c] + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * k2[c] + (s3 - s2) * m2;
  }
}

export type WhalePhase = 'deep' | 'surfacing' | 'sounding' | 'breach';

export interface WhalePose {
  x: number;
  z: number;
  /** Body centre above the drawn surface (m). */
  dy: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Arch of the back (0 straight … 1 the high arch of a sounding dive; < 0 = hollow). */
  flex: number;
  length: number;
  phase: WhalePhase;
  /** Swimming speed (m/s): tail-beat rate. */
  speed: number;
}

export const newWhalePose = (): WhalePose => ({ x: 0, z: 0, dy: -20, heading: 0, pitch: 0, roll: 0, flex: 0, length: 14, phase: 'deep', speed: 1 });

const _ps = newPathSample();
const _k = new Float64Array(4);

/** Where the whale's (or calf's) route puts it at time t. */
export function whaleXZ(plan: WhalePlan, i: number, t: number, out: { x: number; z: number; heading: number }): void {
  const w = plan.whales[i];
  samplePath(w.route, w.phase + w.speed * t, _ps);
  out.heading = _ps.heading;
  const h = (_ps.heading * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  out.x = _ps.x + fx * w.offAlong - fz * w.offAcross;
  out.z = _ps.z + fz * w.offAlong + fx * w.offAcross;
}

const lastKey = (keys: readonly Key[]): Key => keys[keys.length - 1];
const END = (keys: readonly Key[]) => lastKey(keys)[0];

function setKey(k: Key, out: Float64Array): void {
  out[0] = k[1];
  out[1] = k[2];
  out[2] = k[3];
  out[3] = k[4];
}

/** Blend `out` (a held end pose) toward the first key of what comes next over the last `span` s. */
function blendTo(next: Key, remaining: number, span: number, out: Float64Array): void {
  if (remaining >= span) return;
  const r = 1 - Math.max(0, remaining) / span;
  const s = r * r * (3 - 2 * r);
  out[0] += (next[1] - out[0]) * s;
  out[1] += (next[2] - out[1]) * s;
  out[2] += (next[3] - out[2]) * s;
  out[3] += (next[4] % 360 - out[3] % 360) * s;
}

/** The pose of whale i at sea-clock time t (pure, continuous). */
export function whalePose(plan: WhalePlan, i: number, t: number, out: WhalePose): WhalePose {
  const w = plan.whales[i];
  whaleXZ(plan, i, t, out);
  out.length = w.length;
  out.speed = w.speed;
  const { seq, index, tau } = sequenceAt(w, t);
  const calf = w.calfOf >= 0;
  const soundAt = (seq.blows - 1) * seq.interval;
  if (tau >= soundAt) {
    const us = tau - soundAt;
    if (us < END(SOUND)) {
      keyed(SOUND, us, _k);
      out.phase = us < 14 ? 'sounding' : 'deep';
    } else {
      // deep: level out at depth, then rise toward the next sequence's first surfacing
      setKey(lastKey(SOUND), _k);
      const e = Math.min(1, (us - END(SOUND)) / 20);
      _k[1] *= 1 - e * e * (3 - 2 * e);
      const next = w.seqs[(index + 1) % w.seqs.length];
      blendTo(next.breach && !calf ? BREACH[0] : SURFACE[0], seq.duration - tau, 25, _k);
      out.phase = 'deep';
    }
  } else {
    const j = Math.floor(tau / seq.interval);
    const u = tau - j * seq.interval;
    const keys = j === 0 && seq.breach && !calf ? BREACH : SURFACE;
    if (u < END(keys)) {
      keyed(keys, u, _k);
      out.phase = keys === BREACH ? 'breach' : u < 11 ? 'surfacing' : 'deep';
    } else {
      setKey(lastKey(keys), _k);
      // the next surfacing (the sounding one starts with the same keys)
      blendTo(SURFACE[0], seq.interval - u, Math.min(8, seq.interval - END(keys)), _k);
      out.phase = 'deep';
    }
  }
  out.dy = _k[0] * (w.length / 14);
  out.pitch = _k[1];
  out.flex = _k[2];
  out.roll = _k[3] % 360;
  return out;
}

/**
 * Water events of whale i within the last `life` s: `cb(kind, age, x, z, size)`, kind 0 = blow,
 * 1 = breach splash, 2 = emergence splash, 3 = flukes streaming water. Positions are where the
 * whale's blowhole / body was then.
 */
export function whaleEvents(plan: WhalePlan, i: number, t: number, life: number, cb: (kind: number, age: number, x: number, z: number, size: number) => void): void {
  const w = plan.whales[i];
  const { seq, tau } = sequenceAt(w, t);
  const calf = w.calfOf >= 0;
  const size = w.length / 14;
  const emit = (kind: number, at: number, fwd: number) => {
    const age = tau - at;
    if (age < 0 || age >= life) return;
    whaleXZ(plan, i, t - age, _xz);
    const h = (_xz.heading * Math.PI) / 180;
    cb(kind, age, _xz.x + Math.sin(h) * fwd * w.length, _xz.z - Math.cos(h) * fwd * w.length, size);
  };
  for (let j = 0; j < seq.blows; j++) {
    const s0 = j * seq.interval;
    if (tau < s0 || tau > s0 + 30 + life) continue;
    if (j === 0 && seq.breach && !calf) {
      emit(2, s0 + BREACH_EMERGE, 0.25);
      emit(1, s0 + BREACH_SPLASH, 0.05);
    } else {
      emit(0, s0 + BLOW_AT, 0.3);
      if (j === seq.blows - 1) emit(3, s0 + FLUKE_AT, -0.45);
    }
  }
  // a breach at the start of this sequence may still be settling when the previous one ended: fine,
  // events only look back `life` s (< the gap between sequences' starts)
}
const _xz = { x: 0, z: 0, heading: 0 };
