/**
 * The aircraft's sound: a fully synthesised WebAudio graph (no sound files).
 *
 *   engine voice (swapped per aircraft: piston.ts = Cessna O-360 + prop, jet.ts = F-16 F110 turbofan,
 *                 turbofan.ts = A-10 TF34s, turboshaft.ts = JetRanger Allison 250 + rotors)
 *     ├─ exterior path ─┐
 *   rolling rumble, brake scrub, touchdown one-shots ─┤→ aircraft bus → view LP ×2 + shelf
 *                                                        (muffled cabin / open air, air absorption)
 *                                                        → distance → master
 *     └─ cabin path (horns, motors, whistle, intake howl, ECS, hydraulics) → cabin bus → master
 *   wind (pink band-pass sweeping with airspeed + hiss) → wind LP (duller in the cabin) → master
 *   crash layer (impact, metal, debris, scraping, explosions, impacts, crackles) + fire bed → fx bus → master
 *   combat (gun, impacts, missiles, booms) and the enemy aircraft's engines (airTargets.ts) → master
 *   master (volume × mute × pause) → glue compressor → limiter → soft clipper → destination
 *
 * Every continuous parameter moves with setTargetAtTime (and only when its target changes),
 * so there are no zipper noises or clicks. The AudioContext is created lazily in resume()
 * (call it on the first user gesture); without WebAudio every method is a harmless no-op.
 */
import { CONFIG } from '../config';
import type { EngineSound } from '../fleet/types';
import type { AudioInputs, AudioLevels, AudioMeter, AudioSystem } from './types';
import {
  brakeScrubGain, cabinBusGain, clamp, crashIntensity, distanceGain, dopplerFactor, masterGain, rollingCutoffHz, rollingGain,
  stallHornOn, touchdownIntensity, viewCutoffHz, windCenterHz, windGain,
} from './mapping';
import { crashDistanceGain, createRateLimiter, explosionSize, fireLevel, impactIntensity, secondaryExplosions, type PlannedExplosion } from './crashPlan';
import { beepWaveform, gateWaveform, hornWaveform, mulberry32, softClipCurve } from './waves';
import { playCrackle, playCrash, playExplosion, playImpact, playTouchdown, type OneShotKit } from './oneshots';
import { createBuilder, noiseBuffer, type EngineVoice, type Knob, type VoiceOutputs } from './builder';
import { createPistonVoice } from './piston';
import { createJetVoice } from './jet';
import { createTurbofanVoice } from './turbofan';
import { createTurboshaftVoice } from './turboshaft';
import { TURBOSHAFT } from './turboshaftMapping';
import { createCombatAudio, type CombatAudio, type CombatAudioApi } from './combat';
import { createAirAudio, type AirAudio, type AirAudioApi } from './airTargets';

const A = CONFIG.audio;

export interface CreateAudioOptions {
  /** Use this context (e.g. an OfflineAudioContext for the self-test); the graph is built immediately. */
  context?: BaseAudioContext;
  /** Factory used by resume() to create the real context (default: window.AudioContext). */
  createContext?: () => BaseAudioContext | null;
  seed?: number;
  /** Initial engine voice (default 'piston'). */
  engine?: EngineSound;
}

function defaultContext(): BaseAudioContext | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = g.AudioContext ?? g.webkitAudioContext;
  return C ? new C({ latencyHint: 'interactive' }) : null;
}

const isOffline = (c: BaseAudioContext) => typeof (c as OfflineAudioContext).startRendering === 'function';

/** The crash one-shots play through a replaceable layer, so a reset can silence all of them at once. */
interface CrashLayer {
  bus: GainNode;
  kit: OneShotKit;
  live: Map<AudioScheduledSourceNode, number>;
  retired: boolean;
}

interface Graph {
  ctx: BaseAudioContext;
  kit: OneShotKit;
  master: Knob;
  /** The master gain node (the combat sound joins the mix here). */
  masterNode: GainNode;
  view1: Knob;
  view2: Knob;
  viewShelf: Knob;
  distance: Knob;
  cabin: Knob;
  windLP: Knob;
  wind: Knob;
  windBP: Knob;
  hiss: Knob;
  roll: Knob;
  rollLP: Knob;
  scrub: Knob;
  horn: Knob;
  gearHorn: Knob;
  rotorHorn: Knob;
  fire: Knob;
  fireLP: Knob;
  acFx: GainNode;
  fxBus: GainNode;
  clip: WaveShaperNode;
  voiceOut: VoiceOutputs;
  nodes: AudioNode[];
}

function buildGraph(ctx: BaseAudioContext, seed: number): Graph {
  const rnd = mulberry32(seed);
  const b = createBuilder(ctx, rnd);
  const { gain, filter, osc, loop, chain, knob } = b;
  const white = noiseBuffer(ctx, 'white', 2.6, seed + 1);
  const pink = noiseBuffer(ctx, 'pink', 3.3, seed + 2);
  const brown = noiseBuffer(ctx, 'brown', 4.1, seed + 3);

  // ── Output: glue compressor → limiter → soft clipper ──────────────────────
  const master = gain(0);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = A.glueThresholdDb;
  comp.knee.value = 8;
  comp.ratio.value = A.glueRatio;
  comp.attack.value = 0.005;
  comp.release.value = 0.25;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = A.limiterThresholdDb;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve(4097, A.softClipKnee, A.softClipCeiling) as Float32Array<ArrayBuffer>;
  clip.oversample = '2x';
  b.nodes.push(comp, limiter, clip);
  chain(master, comp, limiter, clip, ctx.destination);

  // ── Buses ─────────────────────────────────────────────────────────────────
  const acBus = gain(1);
  const view1 = filter('lowpass', A.exteriorCutoffHz, 0.75);
  const view2 = filter('lowpass', A.exteriorCutoffHz, 0.55);
  const viewShelf = filter('lowshelf', 200, 0.7, 0);
  const distance = gain(1);
  chain(acBus, view1, view2, viewShelf, distance, master);
  const cabin = gain(A.exteriorCabinGain);
  cabin.connect(master);
  const windBus = gain(1);
  const windLP = filter('lowpass', A.exteriorCutoffHz, 0.6);
  chain(windBus, windLP, master);
  const fxBus = gain(A.effectsVolume);
  fxBus.connect(master);
  const acFx = gain(A.effectsVolume);
  acFx.connect(acBus);
  const engineOut = gain(1);
  engineOut.connect(acBus);

  // ── Wind ──────────────────────────────────────────────────────────────────
  const windSrc = loop(pink);
  const windBP = filter('bandpass', A.windMinHz, 0.55);
  const windAM = gain(0.85);
  // Slow gusting: two incommensurate LFOs on the wind level.
  chain(osc('sine', 0.17), gain(0.1)).connect(windAM.gain);
  chain(osc('sine', 0.43), gain(0.06)).connect(windAM.gain);
  const wind = gain(0);
  chain(windSrc, windBP, windAM, wind, windBus);
  const hissSrc = loop(white);
  const hissHP = filter('highpass', 3500, 0.5);
  const hiss = gain(0);
  chain(hissSrc, hissHP, hiss, windBus);

  // ── Ground ────────────────────────────────────────────────────────────────
  const rollSrc = loop(brown);
  const rollLP = filter('lowpass', 120, 0.9);
  const roll = gain(0);
  chain(rollSrc, rollLP, roll, acBus);
  const scrubSrc = loop(white);
  const scrubBP = filter('bandpass', 1500, 2.2);
  const scrub = gain(0);
  chain(scrubSrc, scrubBP, scrub, acBus);

  // ── Stall horn: reed tone with a little vibrato → band-pass → nasal formant ──
  const hornOsc = osc(b.wave(() => hornWaveform(1024), 16, 'horn'), A.stallHornHz);
  chain(osc('sine', 5.5), gain(10)).connect(hornOsc.frequency);
  const hornBP = filter('bandpass', A.stallHornHz, A.stallHornQ);
  const hornNasal = filter('peaking', A.stallHornHz * 2, 3, 7);
  const horn = gain(0);
  chain(hornOsc, hornBP, hornNasal, horn, cabin);

  // ── Gear warning horn: electronic tone through a small cabin speaker, beeped by a soft-edged gate ──
  const ghOsc = osc(b.wave(() => beepWaveform(1024), 14, 'beep'), A.gearHornHz);
  const ghSpeaker = filter('bandpass', A.gearHornHz * 1.6, 0.6);
  const ghBody = filter('peaking', A.gearHornHz, 2, 4);
  const ghGate = gain(0.5);
  chain(osc(b.wave(() => gateWaveform(1024, A.gearHornDuty), 32, `gate${A.gearHornDuty}`), A.gearHornRateHz), gain(0.5)).connect(ghGate.gain);
  const gearHorn = gain(0);
  chain(ghOsc, ghSpeaker, ghBody, ghGate, gearHorn, cabin);

  // ── Low rotor RPM horn (helicopters): a steady electronic tone through the same kind of cabin speaker ──
  const rhOsc = osc(b.wave(() => beepWaveform(1024), 14, 'beep'), TURBOSHAFT.hornHz);
  const rhSpeaker = filter('bandpass', TURBOSHAFT.hornHz * 1.6, 0.6);
  const rotorHorn = gain(0);
  chain(rhOsc, rhSpeaker, rotorHorn, cabin);

  // ── Fire bed after a crash: low roar with a slow, irregular flutter ──
  const fireSrc = loop(brown);
  const fireLP = filter('lowpass', 650, 0.7);
  const fireAM = gain(0.8);
  chain(osc('sine', 0.7), gain(0.12)).connect(fireAM.gain);
  chain(osc('sine', 1.9), gain(0.08)).connect(fireAM.gain);
  const fireHissSrc = loop(pink);
  const fireHissBP = filter('bandpass', 1800, 0.6);
  const fire = gain(0);
  chain(fireSrc, fireLP, fireAM, fire);
  chain(fireHissSrc, fireHissBP, gain(0.25), fireAM);
  fire.connect(fxBus);

  const kit: OneShotKit = { ctx, white, pink, brown, rnd };
  return {
    ctx,
    kit,
    master: knob(master.gain),
    masterNode: master,
    view1: knob(view1.frequency, 1e-3),
    view2: knob(view2.frequency, 1e-3),
    viewShelf: knob(viewShelf.gain, 1e-3),
    distance: knob(distance.gain),
    cabin: knob(cabin.gain),
    windLP: knob(windLP.frequency, 1e-3),
    wind: knob(wind.gain),
    windBP: knob(windBP.frequency, 1e-3),
    hiss: knob(hiss.gain),
    roll: knob(roll.gain),
    rollLP: knob(rollLP.frequency, 1e-3),
    scrub: knob(scrub.gain),
    horn: knob(horn.gain),
    gearHorn: knob(gearHorn.gain),
    rotorHorn: knob(rotorHorn.gain),
    fire: knob(fire.gain),
    fireLP: knob(fireLP.frequency, 1e-3),
    acFx,
    fxBus,
    clip,
    voiceOut: { exterior: engineOut, cabin, kit },
    nodes: b.nodes,
  };
}

const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const isEngine = (k: unknown): k is EngineSound => k === 'piston' || k === 'jet' || k === 'turbofan' || k === 'turboshaft';

export function createAudio(opts: CreateAudioOptions = {}): AudioSystem {
  const seed = opts.seed ?? 4711;
  let ctx: BaseAudioContext | null = null;
  let graph: Graph | null = null;
  let voice: EngineVoice | null = null;
  let voiceFresh = true;
  let engineKind: EngineSound = isEngine(opts.engine) ? opts.engine : 'piston';
  let disposed = false;
  let muted = false;
  let last: AudioInputs | null = null;
  let primed = false;
  let prevCrashed = false;
  let crashAge = 0;
  let pending: PlannedExplosion[] = [];
  let layer: CrashLayer | null = null;
  const retiredLayers = new Set<CrashLayer>();
  let listenerDist: number = A.refDistanceM;
  let analyser: AnalyserNode | null = null;
  let meterBuf: Float32Array<ArrayBuffer> | null = null;
  /** Reused per-frame voice context (no allocation in update). */
  const vf = { t: 0, dt: 0, tau: A.rampTau, exterior: false, doppler: 1, crashed: false, primed: false };
  const explosionOk = createRateLimiter(A.crash.maxExplosionsPerS);
  const impactOk = createRateLimiter(A.crash.maxImpactsPerS);
  const L: AudioLevels = {
    master: 0, engineVolume: A.engineVolume, exhaust: 0, prop: 0, mechanical: 0, starter: 0, cycleHz: 0, firingHz: 0,
    bladeHz: 0, doppler: 1, wind: 0, whistle: 0, rolling: 0, scrub: 0, horn: 0, gearHorn: 0, gear: 0, flap: 0, fire: 0,
    viewCutoff: A.exteriorCutoffHz, distance: 1, cabin: A.exteriorCabinGain, oneShots: 0, lastTouchdown: 0, errors: 0,
    jet: 0, corePct: 0, whineHz: 0, fanHz: 0, whine: 0, fan: 0, roar: 0, afterburner: 0, crackle: 0, intake: 0, ecs: 0,
    hydraulic: 0, aft: 0, engineVoices: 0, crashes: 0, explosions: 0, impacts: 0, pendingExplosions: 0, crashLive: 0,
    turbofan: 0, gun: 0, gunHz: 0, gunDelayS: 0, motor: 0, combatLive: 0, impactsPlayed: 0, booms: 0, launches: 0,
    airVoices: 0, airLevel: 0, airDoppler: 1,
    turboshaft: 0, rotorPct: 0, slap: 0, slapSharpness: 0, tailRotor: 0, tailHz: 0, gearbox: 0, rotorHorn: 0,
  };

  const makeVoice = (g: Graph, kind: EngineSound): EngineVoice =>
    kind === 'jet'
      ? createJetVoice(g.ctx, g.voiceOut, g.kit.rnd)
      : kind === 'turbofan'
        ? createTurbofanVoice(g.ctx, g.voiceOut, g.kit.rnd)
        : kind === 'turboshaft'
          ? createTurboshaftVoice(g.ctx, g.voiceOut, g.kit.rnd)
          : createPistonVoice(g.ctx, g.voiceOut, g.kit.rnd);
  let combat: CombatAudio | null = null;
  /** Always present; a no-op until the context exists (every call is guarded). */
  const combatApi: CombatAudioApi = {
    update: (f) => guard(() => combat?.update(f)),
    impact: (e) => guard(() => combat?.impact(e)),
    detonation: (e) => guard(() => combat?.detonation(e)),
    launch: (e) => guard(() => combat?.launch(e)),
    cookoff: (e) => guard(() => combat?.cookoff(e)),
    reset: () => guard(() => combat?.reset()),
  };
  let air: AirAudio | null = null;
  const airApi: AirAudioApi = {
    update: (f) => guard(() => air?.update(f)),
    reset: () => guard(() => air?.reset()),
  };
  function guard(fn: () => void): void {
    if (disposed) return;
    try {
      fn();
    } catch {
      L.errors++;
    }
  }

  const makeLayer = (g: Graph): CrashLayer => {
    const bus = g.ctx.createGain();
    bus.gain.value = 1;
    bus.connect(g.fxBus);
    const live = new Map<AudioScheduledSourceNode, number>();
    const lay: CrashLayer = { bus, live, retired: false, kit: { ...g.kit, live } };
    lay.kit.onEnded = () => {
      if (lay.retired && live.size === 0) {
        bus.disconnect();
        retiredLayers.delete(lay);
      }
    };
    return lay;
  };

  const countLive = () => {
    let n = layer ? layer.live.size : 0;
    for (const r of retiredLayers) n += r.live.size;
    return n;
  };

  /** Fade and stop every crash sound, forget the pending explosions, put the fire out. */
  const silenceCrash = (t: number) => {
    pending = [];
    crashAge = 0;
    L.pendingExplosions = 0;
    L.fire = 0;
    const g = graph;
    if (!g) return;
    g.fire.set(0, t, 0.05);
    if (layer) {
      const old = layer;
      old.retired = true;
      old.bus.gain.cancelScheduledValues(t);
      old.bus.gain.setTargetAtTime(0, t, 0.03);
      const stopAt = t + 0.15;
      for (const [src, end] of old.live) {
        if (end <= stopAt) continue;
        try {
          src.stop(stopAt);
        } catch {
          /* already stopped */
        }
      }
      if (old.live.size === 0) old.bus.disconnect();
      else retiredLayers.add(old);
      layer = makeLayer(g);
    }
    L.crashLive = countLive();
  };

  const build = (c: BaseAudioContext) => {
    ctx = c;
    graph = buildGraph(c, seed);
    voice = makeVoice(graph, engineKind);
    voiceFresh = true;
    L.engineVoices = 1;
    layer = makeLayer(graph);
    combat = createCombatAudio(c, graph.masterNode, graph.kit);
    air = createAirAudio(c, graph.masterNode, seed + 17);
    primed = false;
    if (last) apply({ ...last, touchdownFpm: null }, 0);
  };

  if (opts.context) {
    try {
      build(opts.context);
    } catch {
      L.errors++;
      ctx = null;
      graph = null;
      voice = null;
    }
  }

  const applyMaster = () => {
    if (!graph || !ctx) return;
    L.master = masterGain(muted, last?.paused ?? false);
    graph.master.set(L.master, ctx.currentTime, 0.06);
  };

  function apply(a: AudioInputs, dtIn: number): void {
    const g = graph;
    const c = ctx;
    const v = voice;
    if (!g || !c || !v || !layer) return;
    const t = c.currentTime;
    const paused = !!a.paused;
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 1) : 0;
    const dtRun = paused ? 0 : dt;
    const tau = A.rampTau;
    const exterior = a.cameraMode !== 'cockpit';
    const crashed = !!a.crashed;

    // Master
    L.master = masterGain(muted, paused);
    g.master.set(L.master, t, 0.06);

    // View / listener
    const dist = fin(a.listenerDistanceM, v.refDistanceM);
    listenerDist = exterior ? Math.max(0, dist) : 0;
    L.viewCutoff = viewCutoffHz(a.cameraMode, dist);
    L.distance = distanceGain(a.cameraMode, dist, v.refDistanceM);
    L.cabin = cabinBusGain(a.cameraMode);
    g.view1.set(L.viewCutoff, t, A.cameraRampTau);
    g.view2.set(exterior ? A.exteriorCutoffHz : L.viewCutoff * 1.6, t, A.cameraRampTau);
    g.viewShelf.set(exterior ? 0 : 5, t, A.cameraRampTau);
    g.distance.set(L.distance, t, A.cameraRampTau);
    g.cabin.set(L.cabin, t, A.cameraRampTau);
    g.windLP.set(exterior ? A.exteriorCutoffHz : 1500, t, A.cameraRampTau);

    // Engine voice
    const dop = exterior ? dopplerFactor(fin(a.closingSpeedMs, 0)) : 1;
    L.doppler = dop;
    L.aft = clamp(fin(a.aft, 0), -1, 1);
    vf.t = t;
    vf.dt = dtRun;
    vf.tau = tau;
    vf.exterior = exterior;
    vf.doppler = dop;
    vf.crashed = crashed;
    vf.primed = primed && !voiceFresh;
    L.oneShots += v.update(a, vf, L);
    voiceFresh = false;

    // Airflow
    const ias = fin(a.airspeedKt, 0);
    L.wind = windGain(ias);
    g.wind.set(L.wind * A.windVolume, t, tau);
    g.windBP.set(windCenterHz(ias), t, tau);
    g.hiss.set(Math.pow(L.wind, 1.5) * A.windVolume * 0.3, t, tau);

    // Ground
    const gs = fin(a.groundSpeedKt, 0);
    L.rolling = rollingGain(gs, !!a.onGround, a.surface);
    L.scrub = brakeScrubGain(fin(a.brake, 0), gs, a.surface, !!a.onGround);
    g.roll.set(L.rolling * A.rollingVolume * 1.5, t, tau);
    g.rollLP.set(rollingCutoffHz(gs, a.surface), t, tau);
    g.scrub.set(L.scrub * A.rollingVolume * 0.4, t, tau);

    // Horns
    L.horn = stallHornOn(!!a.stallWarning, ias, crashed) ? A.stallHornVolume : 0;
    g.horn.set(L.horn, t, 0.025);
    L.gearHorn = a.gearWarning === true && !crashed ? A.gearHornVolume : 0;
    g.gearHorn.set(L.gearHorn, t, 0.02);
    L.rotorHorn = a.lowRotorRpm === true && !crashed ? TURBOSHAFT.hornVolume : 0;
    g.rotorHorn.set(L.rotorHorn, t, 0.02);

    // Touchdown
    const kit = g.kit;
    if (a.touchdownFpm !== null && a.touchdownFpm !== undefined && !crashed) {
      const i = touchdownIntensity(a.touchdownFpm);
      if (i > 0) {
        playTouchdown(kit, g.acFx, t, i, a.surface);
        L.lastTouchdown = i;
        L.oneShots++;
      }
    }

    // Crash: layered impact, secondary explosions on a randomised schedule, fire, crackles; reset silences it.
    const near = crashDistanceGain(listenerDist);
    if (primed && crashed && !prevCrashed) {
      const I = crashIntensity(fin(a.crashSpeedKt, ias));
      crashAge = 0;
      playCrash(layer.kit, layer.bus, t, I, near);
      pending = secondaryExplosions(kit.rnd, I);
      L.crashes++;
      L.oneShots++;
    } else if (!crashed && prevCrashed) {
      silenceCrash(t);
    }
    if (crashed) {
      crashAge += dtRun;
      while (pending.length && pending[0].at <= crashAge) {
        const e = pending.shift() as PlannedExplosion;
        playExplosion(layer.kit, layer.bus, t + 0.005, e.size, near);
        L.explosions++;
      }
      L.fire = fireLevel(crashAge);
      const burn = L.fire / Math.max(1e-6, A.crash.fireLevel);
      if (!paused && kit.rnd() < dtRun * 10 * burn) playCrackle(layer.kit, layer.bus, t + 0.01, burn * near);
      g.fire.set(L.fire * near, t, 0.4);
      g.fireLP.set(420 + 500 * burn, t, 0.5);
    } else {
      L.fire = 0;
      g.fire.set(0, t, 0.05);
    }
    L.pendingExplosions = pending.length;
    L.crashLive = countLive();

    prevCrashed = crashed;
    primed = true;
  }

  return {
    async resume() {
      if (disposed) return;
      try {
        if (!ctx) {
          const c = (opts.createContext ?? defaultContext)();
          if (!c) return;
          build(c);
        }
        const c = ctx as BaseAudioContext | null;
        if (c && !isOffline(c) && c.state === 'suspended') await (c as AudioContext).resume();
      } catch {
        L.errors += 0; // blocked/unsupported audio is not an error of ours
      }
    },
    update(a, dt) {
      if (disposed || !a) return;
      last = a;
      try {
        apply(a, dt);
      } catch {
        L.errors++;
      }
    },
    setMuted(m) {
      muted = !!m;
      try {
        applyMaster();
      } catch {
        L.errors++;
      }
    },
    get muted() {
      return muted;
    },
    setEngine(kind) {
      if (disposed || !isEngine(kind) || kind === engineKind) return;
      engineKind = kind;
      const g = graph;
      const c = ctx as BaseAudioContext | null;
      if (!g || !c) return;
      try {
        const old = voice;
        voice = makeVoice(g, kind);
        voiceFresh = true;
        L.engineVoices++;
        if (old) old.retire(c.currentTime, () => void (L.engineVoices = Math.max(1, L.engineVoices - 1)));
        if (last) apply({ ...last, touchdownFpm: null }, 0);
      } catch {
        L.errors++;
      }
    },
    get engine() {
      return engineKind;
    },
    explosion(e) {
      const g = graph;
      const c = ctx as BaseAudioContext | null;
      if (disposed || !g || !c || !layer || !e) return;
      try {
        const t = c.currentTime;
        if (!explosionOk(t)) return;
        // The crash effects drive the explosions: follow them instead of the randomised schedule.
        pending = [];
        L.pendingExplosions = 0;
        const size = explosionSize(typeof e.size === 'number' ? e.size : Number.NaN);
        playExplosion(layer.kit, layer.bus, t, size, crashDistanceGain(fin(e.distanceM, listenerDist)));
        L.explosions++;
        L.crashLive = countLive();
      } catch {
        L.errors++;
      }
    },
    impact(e) {
      const g = graph;
      const c = ctx as BaseAudioContext | null;
      if (disposed || !g || !c || !layer || !e) return;
      try {
        const I = impactIntensity(fin(e.speed ?? e.speedMs, 0));
        if (I < 0.02) return;
        const t = c.currentTime;
        if (!impactOk(t)) return;
        playImpact(layer.kit, layer.bus, t, I, crashDistanceGain(fin(e.distanceM, listenerDist)));
        L.impacts++;
        L.crashLive = countLive();
      } catch {
        L.errors++;
      }
    },
    get combat() {
      return combatApi;
    },
    get air() {
      return airApi;
    },
    reset() {
      const c = ctx as BaseAudioContext | null;
      try {
        combat?.reset();
        air?.reset();
        if (c) silenceCrash(c.currentTime);
        else {
          pending = [];
          L.pendingExplosions = 0;
          L.fire = 0;
        }
      } catch {
        L.errors++;
      }
    },
    meter(): AudioMeter | null {
      const g = graph;
      if (!g || disposed) return null;
      try {
        if (!analyser) {
          analyser = g.ctx.createAnalyser();
          analyser.fftSize = 2048;
          g.clip.connect(analyser);
          meterBuf = new Float32Array(analyser.fftSize);
        }
        const buf = meterBuf as Float32Array<ArrayBuffer>;
        analyser.getFloatTimeDomainData(buf);
        let s = 0;
        let p = 0;
        for (let i = 0; i < buf.length; i++) {
          const x = buf[i];
          s += x * x;
          const ax = Math.abs(x);
          if (ax > p) p = ax;
        }
        return { rms: Math.sqrt(s / buf.length), peak: p };
      } catch {
        L.errors++;
        return null;
      }
    },
    get context() {
      return ctx;
    },
    levels() {
      L.crashLive = countLive();
      if (combat) combat.levels(L);
      if (air) air.levels(L);
      return { ...L };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const c = ctx as BaseAudioContext | null;
      const g = graph as Graph | null;
      const v = voice as EngineVoice | null;
      graph = null;
      voice = null;
      try {
        combat?.dispose();
        combat = null;
        air?.dispose();
        air = null;
        if (v && c) v.retire(c.currentTime, () => undefined);
        if (g) for (const n of g.nodes) n.disconnect();
        analyser?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        if (c && !isOffline(c)) void (c as AudioContext).close().catch(() => undefined);
      } catch {
        /* ignore */
      }
    },
  };
}
