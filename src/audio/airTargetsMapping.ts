/**
 * Pure maths for the enemy aircraft's sound (src/audio/airTargets.ts): which aircraft are heard
 * (the nearest few within range, keeping each voice on the same aircraft while it stays in the set),
 * and for each one its level (distance law + fade at the edge of range), Doppler factor (closing
 * speed of source and listener along the line of sight), air-absorption low-pass, left/right pan and
 * aspect (listener ahead of the jet = inlet whine, behind = exhaust roar). No WebAudio here.
 */
import { CONFIG } from '../config';

export type AirSoundKind = 'fighter' | 'attack' | 'helo';

/** One enemy aircraft this frame (world m, m/s). */
export interface AirSoundSource {
  id: number;
  kind: AirSoundKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** The listener (the camera): position, velocity, right vector (unit, world), cockpit view. */
export interface AirListener {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  cockpit: boolean;
}

/** What one voice should do this frame. */
export interface AirVoiceTarget {
  /** Aircraft id this voice follows, or -1 (silent). */
  id: number;
  kind: AirSoundKind;
  distanceM: number;
  /** 0..1 before the bus volume. */
  gain: number;
  doppler: number;
  cutoffHz: number;
  /** −1 left … +1 right. */
  pan: number;
  /** +1 listener straight ahead of the aircraft (inlet), −1 straight behind (exhaust), 0 abeam. */
  aspect: number;
  /** Closing speed, m/s (+ approaching). */
  closingMs: number;
}

export function createAirVoiceTarget(): AirVoiceTarget {
  return { id: -1, kind: 'fighter', distanceM: 0, gain: 0, doppler: 1, cutoffHz: 1000, pan: 0, aspect: 0, closingMs: 0 };
}

type Cfg = typeof CONFIG.audio.airTargets;
const fin = (x: number, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Level at a distance: 1 inside ref, (ref/d)^exponent beyond, faded smoothly to 0 between fadeFromM and maxRangeM. */
export function airVoiceGain(distanceM: number, cfg: Cfg = CONFIG.audio.airTargets): number {
  const d = fin(distanceM, Infinity);
  if (!(d >= 0) || d >= cfg.maxRangeM) return 0;
  const ref = Math.max(1, cfg.refDistanceM);
  const law = d <= ref ? 1 : Math.pow(ref / d, cfg.distanceExponent);
  const span = Math.max(1, cfg.maxRangeM - cfg.fadeFromM);
  const u = clamp((d - cfg.fadeFromM) / span, 0, 1);
  const fade = 1 - u * u * (3 - 2 * u);
  return clamp(law * fade, 0, 1);
}

/** Air absorption: the low-pass cutoff halves every absorptionHalfM (floor minCutoffHz). */
export function airVoiceCutoffHz(distanceM: number, cfg: Cfg = CONFIG.audio.airTargets): number {
  const d = Math.max(0, fin(distanceM, cfg.maxRangeM));
  return clamp(cfg.maxCutoffHz * Math.pow(0.5, d / Math.max(1, cfg.absorptionHalfM)), cfg.minCutoffHz, cfg.maxCutoffHz);
}

/** Closing speed of source and listener along the line between them, m/s (+ approaching). */
export function closingSpeedMs(s: AirSoundSource, l: AirListener): number {
  const dx = fin(s.x) - fin(l.x);
  const dy = fin(s.y) - fin(l.y);
  const dz = fin(s.z) - fin(l.z);
  const d = Math.hypot(dx, dy, dz);
  if (!(d > 1e-6)) return 0;
  // d/dt |s − l| = (s − l)·(vs − vl) / d; approaching = −that.
  const rv = (dx * (fin(s.vx) - fin(l.vx)) + dy * (fin(s.vy) - fin(l.vy)) + dz * (fin(s.vz) - fin(l.vz))) / d;
  return -rv;
}

/** Doppler pitch factor for a closing speed (+ approaching), with the speed of sound, clamped to the config range. */
export function airDoppler(closingMs: number, cfg: Cfg = CONFIG.audio.airTargets, c: number = CONFIG.audio.speedOfSoundMs): number {
  const v = clamp(fin(closingMs), -0.8 * c, 0.8 * c);
  return clamp(c / (c - v), cfg.dopplerMin, cfg.dopplerMax);
}

/** +1: the listener is dead ahead of the aircraft's velocity, −1: dead astern, 0: abeam (or it hovers). */
export function aspectOf(s: AirSoundSource, l: AirListener): number {
  const sp = Math.hypot(fin(s.vx), fin(s.vy), fin(s.vz));
  const dx = fin(l.x) - fin(s.x);
  const dy = fin(l.y) - fin(s.y);
  const dz = fin(l.z) - fin(s.z);
  const d = Math.hypot(dx, dy, dz);
  if (!(sp > 1) || !(d > 1e-6)) return 0;
  return clamp((dx * s.vx + dy * s.vy + dz * s.vz) / (sp * d), -1, 1);
}

/** Left/right pan of a source for the listener's right vector. */
export function panOf(s: AirSoundSource, l: AirListener, spread: number): number {
  const dx = fin(s.x) - fin(l.x);
  const dy = fin(s.y) - fin(l.y);
  const dz = fin(s.z) - fin(l.z);
  const d = Math.hypot(dx, dy, dz);
  if (!(d > 1e-6)) return 0;
  return clamp(((dx * fin(l.rx) + dy * fin(l.ry) + dz * fin(l.rz)) / d) * clamp(spread, 0, 1), -1, 1);
}

// Scratch for the selection (no allocation per frame).
const pickIdx: number[] = [];
const pickD: number[] = [];

/**
 * Fill `voices` for this frame: the nearest `voices.length` sources inside maxRangeM are heard; a
 * voice keeps the aircraft it had while that one is still among them (no swapping mid-flyby);
 * newcomers take the free voices; the rest are silent (id −1, gain 0). Returns how many are heard.
 */
export function assignAirVoices(voices: AirVoiceTarget[], sources: readonly AirSoundSource[], n: number, l: AirListener, cfg: Cfg = CONFIG.audio.airTargets): number {
  const V = Math.min(voices.length, Math.max(0, Math.floor(cfg.voices)));
  const N = Math.min(n, sources.length);
  // The nearest V in range (insertion into a short sorted list).
  pickIdx.length = 0;
  pickD.length = 0;
  for (let i = 0; i < N; i++) {
    const s = sources[i];
    const d = Math.hypot(fin(s.x, 1e9) - fin(l.x), fin(s.y, 1e9) - fin(l.y), fin(s.z, 1e9) - fin(l.z));
    if (!(d < cfg.maxRangeM)) continue;
    let k = pickD.length;
    if (k >= V && d >= pickD[k - 1]) continue;
    pickIdx.push(i);
    pickD.push(d);
    while (k > 0 && pickD[k - 1] > d) {
      pickD[k] = pickD[k - 1];
      pickIdx[k] = pickIdx[k - 1];
      k--;
    }
    pickD[k] = d;
    pickIdx[k] = i;
    if (pickD.length > V) {
      pickD.length = V;
      pickIdx.length = V;
    }
  }
  // Voices whose aircraft left the set fall silent; the chosen ones keep their voice.
  for (let v = 0; v < voices.length; v++) {
    const vo = voices[v];
    let keep = false;
    if (v < V && vo.id >= 0) for (const i of pickIdx) if (sources[i].id === vo.id) keep = true;
    if (!keep) {
      vo.id = -1;
      vo.gain = 0;
    }
  }
  for (const i of pickIdx) {
    const s = sources[i];
    let slot = -1;
    for (let v = 0; v < V; v++) if (voices[v].id === s.id) slot = v;
    if (slot < 0) for (let v = 0; v < V && slot < 0; v++) if (voices[v].id < 0) slot = v;
    if (slot < 0) continue;
    const vo = voices[slot];
    vo.id = s.id;
    vo.kind = s.kind;
    const d = Math.hypot(fin(s.x) - fin(l.x), fin(s.y) - fin(l.y), fin(s.z) - fin(l.z));
    vo.distanceM = d;
    vo.gain = airVoiceGain(d, cfg) * clamp(fin(cfg[s.kind]?.level ?? 1, 1), 0, 2);
    vo.closingMs = closingSpeedMs(s, l);
    vo.doppler = airDoppler(vo.closingMs, cfg);
    vo.cutoffHz = airVoiceCutoffHz(d, cfg);
    vo.pan = l.cockpit ? panOf(s, l, cfg.pan) * 0.7 : panOf(s, l, cfg.pan);
    vo.aspect = aspectOf(s, l);
  }
  let heard = 0;
  for (const vo of voices) if (vo.id >= 0 && vo.gain > 0) heard++;
  return heard;
}
