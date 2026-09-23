/**
 * Combat sound (procedural WebAudio, no samples), under the master bus (mute, pause, compressor,
 * limiter):
 *
 *   the gun      GAU-8/A "BRRRT" (65 rds/s → a 65 Hz buzz-saw of muzzle blasts, a heavy chest
 *                thump, the torn noise of each shot) or the M61A1's higher 100 Hz "brrrp"; the
 *                barrels' drive whine spinning up (0.55 s) and down. Cockpit: a deep vibrating growl
 *                through the structure plus the muffled blast through the canopy. Outside: the
 *                tearing BRRRT through a DELAY LINE of distance / 343 m/s (so it arrives late and
 *                Doppler-shifts as the distance changes), air absorption (low-pass) and attenuation.
 *   impacts      30 mm HEI cracks, armour clangs, splashes, ricochet whines — each one scheduled at
 *                its own distance / c, so a listener near the target hears the impacts FIRST and the
 *                BRRRT seconds later.
 *   missiles     launch roar + whoosh at the rail, the motor's hiss receding (its own delay line).
 *   explosions   Maverick detonation / vehicle cook-off: crack (near only), sub-bass boom, body, a
 *                long rumble tail that grows with distance, a terrain echo; the cook-off's
 *                ammunition pops and its secondary explosion.
 *
 * reset() stops every scheduled one-shot and rebuilds the continuous graph (flushing the delay lines).
 */
import { CONFIG } from '../config';
import { createBuilder, retireGraph, type Builder, type Knob } from './builder';
import { noiseBurst, toneBurst, type OneShotKit } from './oneshots';
import { airCutoffHz, combatDistanceGain, gunRateHz, gunTimbre, gunWhineHz, muzzleBlastWaveform, soundDelayS } from './combatMapping';
import { createRateLimiter } from './crashPlan';

const C = CONFIG.audio.combat;
const G = C.gun;
const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export interface CombatAudioFrame {
  /** The flown aircraft's gun (rate 0 = none). */
  gunRateRps: number;
  gunCaliberMm: number;
  /** Barrel spin 0..1 and rounds leaving the barrel now. */
  gunSpin: number;
  gunFiring: boolean;
  /** Listener → gun (≈ camera → aircraft), m. */
  gunDistanceM: number;
  cockpit: boolean;
  /** The nearest burning missile motor: level 0..1 and its distance, m. */
  motor: number;
  motorDistanceM: number;
}

export interface CombatAudioApi {
  update(f: CombatAudioFrame): void;
  impact(e: { distanceM: number; surface: string; ricochet?: boolean }): void;
  detonation(e: { distanceM: number; size?: number; air?: boolean }): void;
  launch(e: { distanceM: number }): void;
  /** A vehicle destroyed: the cook-off boom, ammunition pops, and a secondary after `secondaryDelayS`. */
  cookoff(e: { distanceM: number; size?: number; secondaryDelayS?: number | null; secondarySize?: number }): void;
  reset(): void;
}

export interface CombatLevels {
  gun: number;
  gunHz: number;
  gunDelayS: number;
  motor: number;
  combatLive: number;
  impactsPlayed: number;
  booms: number;
  launches: number;
}

interface Continuous {
  b: Builder;
  out: GainNode[];
  gate: Knob;
  cabGate: Knob;
  pulseF: Knob;
  thump: Knob;
  tearF: Knob;
  whineF: Knob;
  whine: Knob;
  extLevel: Knob;
  cabLevel: Knob;
  gunDelay: DelayNode;
  gunDuck: GainNode;
  gunAir: Knob;
  gunDist: Knob;
  lastGunDelay: number;
  motorLevel: Knob;
  motorDelay: DelayNode;
  motorDuck: GainNode;
  motorAir: Knob;
  motorDist: Knob;
  lastMotorDelay: number;
}

export interface CombatAudio extends CombatAudioApi {
  levels(out: CombatLevels): void;
  dispose(): void;
}

export function createCombatAudio(ctx: BaseAudioContext, dest: AudioNode, baseKit: OneShotKit): CombatAudio {
  const combatBus = ctx.createGain();
  combatBus.gain.value = C.volume;
  combatBus.connect(dest);
  // Exterior sounds go through the canopy in the cockpit.
  const canopy = ctx.createBiquadFilter();
  canopy.type = 'lowpass';
  canopy.frequency.value = C.maxCutoffHz;
  canopy.Q.value = 0.6;
  const canopyGain = ctx.createGain();
  canopyGain.gain.value = 1;
  const extBus = ctx.createGain();
  extBus.connect(canopy);
  canopy.connect(canopyGain);
  canopyGain.connect(combatBus);

  // ── One-shot layer (replaced on reset) ──
  interface Layer { bus: GainNode; kit: OneShotKit; live: Map<AudioScheduledSourceNode, number>; retired: boolean }
  const retired = new Set<Layer>();
  const makeLayer = (): Layer => {
    const bus = ctx.createGain();
    bus.connect(extBus);
    const live = new Map<AudioScheduledSourceNode, number>();
    const lay: Layer = { bus, live, retired: false, kit: { ...baseKit, live } };
    lay.kit.onEnded = () => {
      if (lay.retired && live.size === 0) {
        bus.disconnect();
        retired.delete(lay);
      }
    };
    return lay;
  };
  let layer = makeLayer();

  const setDelay = (node: DelayNode, duck: GainNode, last: number, d: number, t: number): number => {
    if (!Number.isFinite(d)) return last;
    if (!Number.isFinite(last) || Math.abs(d - last) > 0.08) {
      // A jump (camera change): duck, move the read head, un-duck — no "zip".
      duck.gain.cancelScheduledValues(t);
      duck.gain.setTargetAtTime(0, t, 0.008);
      node.delayTime.cancelScheduledValues(t);
      node.delayTime.setValueAtTime(d, t + 0.045);
      duck.gain.setTargetAtTime(1, t + 0.05, 0.02);
      return d;
    }
    if (Math.abs(d - last) > 5e-4) {
      node.delayTime.setTargetAtTime(d, t, 0.08);
      return d;
    }
    return last;
  };

  const buildContinuous = (): Continuous => {
    const b = createBuilder(ctx, baseKit.rnd);
    const { gain, filter, osc, loop, chain, knob } = b;
    const extOut = gain(1);
    const cabOut = gain(0);
    extOut.connect(extBus);
    cabOut.connect(combatBus);

    // Gun sources.
    const pulse = osc(b.wave(() => muzzleBlastWaveform(2048), 48, 'muzzle48'), 65);
    const extMix = gain(1);
    const cabMix = gain(1);
    const gate = gain(0);
    const cabGate = gain(0);
    chain(pulse, gain(G.pulse), extMix);
    const thumpLP = filter('lowpass', G.thumpHz, 0.9);
    const thump = gain(G.thump);
    chain(pulse, thumpLP, thump);
    thump.connect(extMix);
    thump.connect(cabMix);
    const growlLP = filter('lowpass', G.growlHz, 1.2);
    chain(pulse, growlLP, gain(G.growl), cabMix);
    const tearSrc = loop(baseKit.white);
    const tearBP = filter('bandpass', G.tearHz, 0.8);
    const tearAM = gain(0);
    pulse.connect(tearAM.gain);
    chain(tearSrc, tearBP, tearAM);
    chain(tearAM, gain(G.tear), extMix);
    chain(tearAM, gain(G.tear * 0.25), cabMix);
    const clatSrc = loop(baseKit.white);
    const clatHP = filter('highpass', 3200, 0.7);
    const clatAM = gain(0);
    pulse.connect(clatAM.gain);
    chain(clatSrc, clatHP, clatAM, gain(G.clatter), cabMix);
    chain(extMix, gate);
    chain(cabMix, cabGate);
    // Barrel drive whine (spinning, firing or not).
    const whineOsc = osc('sawtooth', G.whineHz[0]);
    const whineBP = filter('bandpass', 900, 1.6);
    const whine = gain(0);
    chain(whineOsc, whineBP, whine);
    const whineExt = gain(0.3);
    whine.connect(whineExt);
    // The whine goes around the gates (it sounds whenever the barrels turn).
    const gunExtIn = gain(1);
    const gunCabIn = gain(1);
    gate.connect(gunExtIn);
    whineExt.connect(gunExtIn);
    cabGate.connect(gunCabIn);
    whine.connect(gunCabIn);
    // Exterior path: delay line (d / c) → air absorption → distance.
    const gunDelay = ctx.createDelay(C.maxDelayS + 0.5);
    b.nodes.push(gunDelay);
    const gunDuck = gain(1);
    const gunAir = filter('lowpass', C.maxCutoffHz, 0.7);
    const gunDist = gain(1);
    chain(gunExtIn, gunDelay, gunDuck, gunAir, gunDist);
    const extLevel = gain(G.exterior);
    chain(gunDist, extLevel, extOut);
    const cabLevel = gain(0);
    chain(gunCabIn, cabLevel, cabOut);
    cabOut.gain.value = 1;

    // Missile motor: roar + hiss → delay → air → distance.
    const mRoarSrc = loop(baseKit.brown);
    const mRoarLP = filter('lowpass', 700, 0.7);
    const mHissSrc = loop(baseKit.pink);
    const mHissBP = filter('bandpass', C.missile.motorHz, 0.5);
    const motorLevel = gain(0);
    chain(mRoarSrc, mRoarLP, gain(1.2), motorLevel);
    chain(mHissSrc, mHissBP, gain(0.9), motorLevel);
    const motorDelay = ctx.createDelay(C.maxDelayS + 0.5);
    b.nodes.push(motorDelay);
    const motorDuck = gain(1);
    const motorAir = filter('lowpass', C.maxCutoffHz, 0.7);
    const motorDist = gain(0);
    chain(motorLevel, motorDelay, motorDuck, motorAir, motorDist, gain(C.missile.motor), extOut);

    return {
      b, out: [extOut, cabOut],
      gate: knob(gate.gain),
      cabGate: knob(cabGate.gain),
      pulseF: knob(pulse.frequency, 1e-3),
      thump: knob(thump.gain),
      tearF: knob(tearBP.frequency, 1e-3),
      whineF: knob(whineOsc.frequency, 1e-3),
      whine: knob(whine.gain),
      extLevel: knob(extLevel.gain),
      cabLevel: knob(cabLevel.gain),
      gunDelay, gunDuck, gunAir: knob(gunAir.frequency, 1e-3), gunDist: knob(gunDist.gain), lastGunDelay: Number.NaN,
      motorLevel: knob(motorLevel.gain), motorDelay, motorDuck, motorAir: knob(motorAir.frequency, 1e-3), motorDist: knob(motorDist.gain), lastMotorDelay: Number.NaN,
    };
  };
  let cont = buildContinuous();

  const limiter = createRateLimiter(C.impacts.maxPerS);
  const boomLimiter = createRateLimiter(C.boom.maxPerS);
  const L: CombatLevels = { gun: 0, gunHz: 0, gunDelayS: 0, motor: 0, combatLive: 0, impactsPlayed: 0, booms: 0, launches: 0 };
  let cockpit = false;

  const countLive = () => {
    let n = layer.live.size;
    for (const r of retired) n += r.live.size;
    return n;
  };

  /** Explosion heard from `d` m, starting (at the source) at t0: arrives at t0 + d / c. */
  const boom = (t0: number, d: number, size: number, level: number) => {
    const k = layer.kit;
    const t = t0 + soundDelayS(d);
    const cut = airCutoffHz(d);
    const g = combatDistanceGain(d, 60) * C.boom.level * level;
    const S = clamp(size, 0.1, 1.5);
    if (g < 1e-4) return;
    const hi = (f: number) => (f > cut ? cut / f : 1);
    toneBurst(k, layer.bus, t, { type: 'sine', freq: 58, freqEnd: 22, sweep: 0.8 + 0.4 * S, peak: 1.1 * g * Math.min(1, S), attack: 0.004, tau: 0.3 + 0.3 * S });
    noiseBurst(k, layer.bus, t, { buffer: k.white, filter: 'bandpass', freq: Math.min(1600, cut), q: 0.6, peak: 0.7 * g * hi(1600), attack: 0.001, tau: 0.03 });
    noiseBurst(k, layer.bus, t, { buffer: k.brown, filter: 'lowpass', freq: Math.min(1800, cut), freqEnd: 110, sweep: 1 + S, q: 0.6, peak: 1.4 * g, attack: 0.005, tau: 0.35 + 0.45 * S });
    const tail = C.boom.rumbleS + (C.boom.farRumbleS - C.boom.rumbleS) * clamp(d / 2500, 0, 1);
    noiseBurst(k, layer.bus, t + 0.1, { buffer: k.brown, filter: 'lowpass', freq: Math.min(260, cut), q: 0.5, peak: 0.55 * g, attack: 0.18, tau: tail * 0.45 });
    // Terrain echo.
    const echo = 0.35 + d * 0.0006 + 0.4 * k.rnd();
    noiseBurst(k, layer.bus, t + echo, { buffer: k.brown, filter: 'lowpass', freq: Math.min(420, cut), q: 0.6, peak: 0.35 * g, attack: 0.02, tau: 0.45 });
    L.booms++;
  };

  const api: CombatAudio = {
    update(f) {
      const t = ctx.currentTime;
      const c = cont;
      cockpit = !!f.cockpit;
      // Canopy.
      canopy.frequency.setTargetAtTime(cockpit ? C.canopyCutoffHz : C.maxCutoffHz, t, 0.1);
      canopyGain.gain.setTargetAtTime(cockpit ? C.canopyGain : 1, t, 0.1);
      // Gun.
      const rate = fin(f.gunRateRps, 0);
      const spin = clamp(fin(f.gunSpin, 0), 0, 1);
      const hz = gunRateHz(rate, spin);
      const firing = !!f.gunFiring && hz > 0;
      if (hz > 0) c.pulseF.set(hz, t, 0.04);
      const timbre = gunTimbre(fin(f.gunCaliberMm, 30));
      c.thump.set(timbre.thump, t, 0.1);
      c.tearF.set(timbre.tearHz, t, 0.1);
      c.gate.set(firing ? 1 : 0, t, 0.012);
      c.cabGate.set(firing ? 1 : 0, t, 0.012);
      c.whineF.set(gunWhineHz(spin), t, 0.05);
      c.whine.set(rate > 0 ? G.whine * Math.pow(spin, 0.8) : 0, t, 0.05);
      const gd = Math.max(0, fin(f.gunDistanceM, 0));
      c.lastGunDelay = setDelay(c.gunDelay, c.gunDuck, c.lastGunDelay, cockpit ? 0 : soundDelayS(gd), t);
      c.gunAir.set(cockpit ? C.maxCutoffHz : airCutoffHz(gd), t, 0.1);
      c.gunDist.set(cockpit ? 1 : combatDistanceGain(gd), t, 0.1);
      c.extLevel.set(cockpit ? G.exterior * 0.35 : G.exterior, t, 0.1);
      c.cabLevel.set(cockpit ? G.cockpit : 0, t, 0.1);
      // Missile motor.
      const ml = clamp(fin(f.motor, 0), 0, 1);
      const md = Math.max(0, fin(f.motorDistanceM, 0));
      c.motorLevel.set(ml, t, 0.08);
      if (ml > 0) {
        c.lastMotorDelay = setDelay(c.motorDelay, c.motorDuck, c.lastMotorDelay, soundDelayS(md), t);
        c.motorAir.set(airCutoffHz(md), t, 0.1);
        c.motorDist.set(combatDistanceGain(md, 20), t, 0.1);
      }
      L.gun = firing ? 1 : 0;
      L.gunHz = hz;
      L.gunDelayS = Number.isFinite(c.lastGunDelay) ? c.lastGunDelay : 0;
      L.motor = ml;
      L.combatLive = countLive();
    },
    impact(e) {
      const t = ctx.currentTime;
      if (!e || !limiter(t)) return;
      const d = Math.max(0, fin(e.distanceM, 0));
      const g = combatDistanceGain(d, 25) * C.impacts.level;
      if (g < 2e-4) return;
      const k = layer.kit;
      const at = t + soundDelayS(d);
      const cut = airCutoffHz(d);
      const hi = (f: number) => (f > cut ? cut / f : 1);
      const crackF = 1800 + 1600 * k.rnd();
      switch (e.surface) {
        case 'water':
          noiseBurst(k, layer.bus, at, { buffer: k.white, filter: 'lowpass', freq: Math.min(2600, cut), freqEnd: 500, sweep: 0.25, q: 0.5, peak: 0.45 * g, attack: 0.004, tau: 0.1 });
          break;
        case 'target':
          noiseBurst(k, layer.bus, at, { buffer: k.white, filter: 'bandpass', freq: Math.min(crackF, cut), q: 1.2, peak: 0.55 * g * hi(crackF), attack: 0.001, tau: 0.008 });
          for (const r of [1, 2.76, 5.4]) toneBurst(k, layer.bus, at, { type: 'sine', freq: Math.min((700 + 500 * k.rnd()) * r, cut), peak: (0.22 * g) / r, attack: 0.001, tau: 0.05 + 0.05 * k.rnd() });
          break;
        default:
          // HEI crack + the thud of the ground.
          noiseBurst(k, layer.bus, at, { buffer: k.white, filter: 'bandpass', freq: Math.min(crackF, cut), q: 0.9, peak: 0.6 * g * hi(crackF), attack: 0.001, tau: 0.006 + 0.006 * k.rnd() });
          noiseBurst(k, layer.bus, at, { buffer: k.brown, filter: 'lowpass', freq: Math.min(320, cut), q: 0.8, peak: 0.55 * g, attack: 0.002, tau: 0.035 });
      }
      if (e.ricochet) {
        toneBurst(k, layer.bus, at + 0.01, { type: 'sine', freq: Math.min(3200, cut), freqEnd: 700, sweep: 0.35, peak: 0.12 * g * hi(3200), attack: 0.004, tau: 0.12 });
      }
      L.impactsPlayed++;
    },
    detonation(e) {
      const t = ctx.currentTime;
      if (!e || !boomLimiter(t)) return;
      boom(t, Math.max(0, fin(e.distanceM, 0)), fin(e.size, 1), e.air ? 0.8 : 1);
    },
    cookoff(e) {
      const t = ctx.currentTime;
      if (!e || !boomLimiter(t)) return;
      const d = Math.max(0, fin(e.distanceM, 0));
      const size = fin(e.size, 1);
      boom(t, d, size * 1.1, 1.05);
      // Ammunition cooking off: irregular pops over a few seconds.
      const k = layer.kit;
      const g = combatDistanceGain(d, 40) * C.boom.level;
      const cut = airCutoffHz(d);
      const at = t + soundDelayS(d);
      const n = 5 + Math.round(8 * k.rnd());
      for (let i = 0; i < n; i++) {
        const tp = at + 0.25 + 3 * k.rnd() * k.rnd();
        noiseBurst(k, layer.bus, tp, { buffer: k.brown, filter: 'lowpass', freq: Math.min(900, cut), q: 0.7, peak: (0.2 + 0.3 * k.rnd()) * g, attack: 0.002, tau: 0.04 + 0.05 * k.rnd() });
        noiseBurst(k, layer.bus, tp, { buffer: k.white, filter: 'bandpass', freq: Math.min(2400, cut), q: 1, peak: 0.15 * g, attack: 0.001, tau: 0.01 });
      }
      if (e.secondaryDelayS !== null && e.secondaryDelayS !== undefined && Number.isFinite(e.secondaryDelayS)) {
        boom(t + Math.max(0, e.secondaryDelayS), d, size * fin(e.secondarySize, 0.6), 0.85);
      }
    },
    launch(e) {
      const t = ctx.currentTime;
      if (!e) return;
      const d = Math.max(0, fin(e.distanceM, 0));
      const k = layer.kit;
      const at = t + soundDelayS(d);
      const cut = airCutoffHz(d);
      const g = combatDistanceGain(d, 20) * C.missile.launch;
      toneBurst(k, layer.bus, at, { type: 'sine', freq: 75, freqEnd: 38, sweep: 0.15, peak: 0.7 * g, attack: 0.004, tau: 0.12 });
      noiseBurst(k, layer.bus, at, { buffer: k.pink, filter: 'bandpass', freq: Math.min(400, cut), freqEnd: Math.min(2200, cut), sweep: 0.5, q: 0.7, peak: 0.9 * g, attack: 0.03, tau: 0.45 });
      noiseBurst(k, layer.bus, at, { buffer: k.brown, filter: 'lowpass', freq: Math.min(1000, cut), q: 0.6, peak: 0.9 * g, attack: 0.01, tau: 0.8 });
      L.launches++;
    },
    reset() {
      const t = ctx.currentTime;
      // Stop every scheduled one-shot (future ones never start).
      const old = layer;
      old.retired = true;
      old.bus.gain.cancelScheduledValues(t);
      old.bus.gain.setTargetAtTime(0, t, 0.02);
      const stopAt = t + 0.1;
      for (const [src, end] of old.live) {
        if (end <= stopAt) continue;
        try {
          src.stop(stopAt);
        } catch {
          /* already stopped */
        }
      }
      if (old.live.size === 0) old.bus.disconnect();
      else retired.add(old);
      layer = makeLayer();
      // Rebuild the continuous graph: the delay lines still hold the last seconds of sound.
      const prev = cont;
      retireGraph(prev.b, prev.out, t, () => undefined);
      cont = buildContinuous();
      L.combatLive = countLive();
    },
    levels(out) {
      L.combatLive = countLive();
      Object.assign(out, L);
    },
    dispose() {
      try {
        retireGraph(cont.b, cont.out, ctx.currentTime, () => undefined);
        layer.bus.disconnect();
        extBus.disconnect();
        canopy.disconnect();
        canopyGain.disconnect();
        combatBus.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
  return api;
}
