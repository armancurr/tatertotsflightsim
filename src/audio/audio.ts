/**
 * The aircraft's sound: a fully synthesised WebAudio graph (no sound files).
 *
 *   engine (Lycoming O-360 + 2-blade prop) ─┐
 *     cycle oscillator (PeriodicWave of one 4-stroke cycle, 4 uneven exhaust pulses) → tone LP
 *     exhaust noise (pink) → band-pass → AM at the firing rate (pulse oscillator → gain.gain)
 *     prop buzz (PeriodicWave blade pulse at the blade-pass rate) + blade-slap noise AM'd at it
 *     valve-train tick, starter motor (AM'd at the compression rate while cranking)
 *   rolling rumble (brown noise LP by speed/surface), brake scrub, touchdown one-shots ─┤
 *                                                                    → aircraft bus → view LP ×2
 *                                                                      (muffled cabin / open air,
 *                                                                      air absorption) → distance → master
 *   wind (pink band-pass sweeping with airspeed + hiss) → wind LP (duller in the cabin) → master
 *   cabin bus (stall horn reed, gear pump hum, flap motor whine, door-seal whistle, gear clunk) → master
 *   fx bus (crash boom/debris, fire bed + crackles) → master
 *   master (volume × mute × pause) → gentle compressor → destination
 *
 * Every continuous parameter moves with setTargetAtTime (and only when its target changes),
 * so there are no zipper noises or clicks. The AudioContext is created lazily in resume()
 * (call it on the first user gesture); without WebAudio every method is a harmless no-op.
 */
import { CONFIG } from '../config';
import type { AudioInputs, AudioLevels, AudioSystem } from './types';
import {
  bladePassFrequency, brakeScrubGain, cabinBusGain, clamp, crashIntensity, cycleFrequency, distanceGain, dopplerFactor,
  engineMix, exhaustCenterHz, firingFrequency, masterGain, rollingCutoffHz, rollingGain, stallHornOn, touchdownIntensity,
  viewCutoffHz, whistleGain, windCenterHz, windGain,
} from './mapping';
import { engineCycleWaveform, fourierSeries, hornWaveform, mulberry32, noiseSamples, propWaveform, pulseWaveform, type NoiseKind } from './waves';
import { playCatch, playCrackle, playCrash, playGearClunk, playTouchdown, type OneShotKit } from './oneshots';

const A = CONFIG.audio;

export interface CreateAudioOptions {
  /** Use this context (e.g. an OfflineAudioContext for the self-test); the graph is built immediately. */
  context?: BaseAudioContext;
  /** Factory used by resume() to create the real context (default: window.AudioContext). */
  createContext?: () => BaseAudioContext | null;
  seed?: number;
}

/** A parameter that is only re-targeted when its target actually changes. */
class Knob {
  last = Number.NaN;
  constructor(readonly param: AudioParam, private readonly eps = 1e-4) {}
  set(v: number, t: number, tau: number): void {
    if (!Number.isFinite(v)) return;
    if (Math.abs(v - this.last) <= this.eps * Math.max(1, Math.abs(this.last))) return;
    this.last = v;
    this.param.setTargetAtTime(v, t, tau);
  }
}

function defaultContext(): BaseAudioContext | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = g.AudioContext ?? g.webkitAudioContext;
  return C ? new C({ latencyHint: 'interactive' }) : null;
}

const isOffline = (c: BaseAudioContext) => typeof (c as OfflineAudioContext).startRendering === 'function';

interface Graph {
  ctx: BaseAudioContext;
  kit: OneShotKit;
  master: Knob;
  view1: Knob;
  view2: Knob;
  viewShelf: Knob;
  distance: Knob;
  cabin: Knob;
  windLP: Knob;
  cycleF: Knob;
  fireF: Knob;
  propF: Knob;
  bpfF: Knob;
  crankF: Knob;
  exRate: Knob;
  tone: Knob;
  toneLP: Knob;
  exBP: Knob;
  exhaust: Knob;
  propLP: Knob;
  prop: Knob;
  propNoise: Knob;
  mech: Knob;
  starter: Knob;
  crank: Knob;
  wind: Knob;
  windBP: Knob;
  hiss: Knob;
  whistle: Knob;
  roll: Knob;
  rollLP: Knob;
  scrub: Knob;
  horn: Knob;
  gear: Knob;
  flap: Knob;
  fire: Knob;
  acFx: GainNode;
  engineBus: GainNode;
  cabinFx: GainNode;
  fxBus: GainNode;
  nodes: AudioNode[];
}

function buildGraph(ctx: BaseAudioContext, seed: number): Graph {
  const nodes: AudioNode[] = [];
  const keep = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };
  const gain = (v: number) => {
    const g = keep(ctx.createGain());
    g.gain.value = v;
    return g;
  };
  const filter = (type: BiquadFilterType, f: number, q: number, dbGain = 0) => {
    const b = keep(ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = dbGain;
    return b;
  };
  const buffer = (kind: NoiseKind, seconds: number, s: number) => {
    const n = Math.max(1, Math.round(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    buf.getChannelData(0).set(noiseSamples(kind, n, s));
    return buf;
  };
  const wave = (samples: Float32Array, harmonics: number) => {
    const w = fourierSeries(samples, harmonics);
    return ctx.createPeriodicWave(w.real, w.imag, { disableNormalization: false });
  };
  const rnd = mulberry32(seed);
  const white = buffer('white', 2.6, seed + 1);
  const pink = buffer('pink', 3.3, seed + 2);
  const brown = buffer('brown', 4.1, seed + 3);
  const loop = (buf: AudioBuffer) => {
    const s = keep(ctx.createBufferSource());
    s.buffer = buf;
    s.loop = true;
    s.start(0, rnd() * buf.duration * 0.9);
    return s;
  };
  const osc = (type: OscillatorType | PeriodicWave, f: number) => {
    const o = keep(ctx.createOscillator());
    if (typeof type === "string") o.type = type as OscillatorType;
    else o.setPeriodicWave(type);
    o.frequency.value = f;
    o.start(0);
    return o;
  };
  const chain = (...ns: AudioNode[]) => {
    for (let i = 0; i < ns.length - 1; i++) ns[i].connect(ns[i + 1]);
    return ns[ns.length - 1];
  };

  // ── Output ────────────────────────────────────────────────────────────────
  const master = gain(0);
  const comp = keep(ctx.createDynamicsCompressor());
  comp.threshold.value = -12;
  comp.knee.value = 10;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  chain(master, comp, ctx.destination);

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
  const engineBus = gain(A.engineVolume);
  engineBus.connect(acBus);
  const acFx = gain(A.effectsVolume);
  acFx.connect(acBus);
  const cabinFx = gain(A.effectsVolume);
  cabinFx.connect(cabin);

  // ── Engine ────────────────────────────────────────────────────────────────
  const engineWave = wave(engineCycleWaveform(2048), 72);
  const propWave = wave(propWaveform(1024), 40);
  const pulseWave = wave(pulseWaveform(1024, 0.3), 24);
  const cycleOsc = osc(engineWave, 0);
  const tone = gain(0);
  const toneLP = filter('lowpass', 400, 0.9);
  chain(cycleOsc, toneLP, tone, engineBus);

  const fireOsc = osc(pulseWave, 0);
  const exSrc = loop(pink);
  const exBP = filter('bandpass', 200, 0.9);
  const exAM = gain(0.4);
  const exAmDepth = gain(0.6);
  chain(fireOsc, exAmDepth).connect(exAM.gain);
  const exhaust = gain(0);
  chain(exSrc, exBP, exAM, exhaust, engineBus);

  const propOsc = osc(propWave, 0);
  const propLP = filter('lowpass', 900, 0.7);
  const prop = gain(0);
  chain(propOsc, propLP, prop, engineBus);
  const bpfOsc = osc(pulseWave, 0);
  const propSrc = loop(white);
  const propBP = filter('bandpass', 1700, 0.6);
  const propAM = gain(0.3);
  chain(bpfOsc, gain(0.7)).connect(propAM.gain);
  const propNoise = gain(0);
  chain(propSrc, propBP, propAM, propNoise, engineBus);

  const mechSrc = loop(white);
  const mechBP = filter('bandpass', 3200, 1.6);
  const mechAM = gain(0.2);
  chain(cycleOsc, gain(0.8)).connect(mechAM.gain);
  const mech = gain(0);
  chain(mechSrc, mechBP, mechAM, mech, engineBus);

  // Starter: motor whine + compression chug, both pulsing at the cranking firing rate.
  const crankLfo = osc('sine', 6);
  const starterOsc = osc('sawtooth', 96);
  const starterBP = filter('bandpass', 850, 1.2);
  const starterAM = gain(0.55);
  chain(crankLfo, gain(0.45)).connect(starterAM.gain);
  const starter = gain(0);
  chain(starterOsc, starterBP, starterAM, starter, engineBus);
  const crankSrc = loop(brown);
  const crankLP = filter('lowpass', 260, 0.8);
  const crankAM = gain(0.5);
  chain(crankLfo, gain(0.5)).connect(crankAM.gain);
  const crank = gain(0);
  chain(crankSrc, crankLP, crankAM, crank, engineBus);

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
  const whistleSrc = loop(white);
  const whistleBP = filter('bandpass', A.whistleHz, 22);
  chain(osc('sine', 0.31), gain(35)).connect(whistleBP.frequency);
  const whistle = gain(0);
  chain(whistleSrc, whistleBP, whistle, cabin);

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
  const hornOsc = osc(wave(hornWaveform(1024), 16), A.stallHornHz);
  chain(osc('sine', 5.5), gain(10)).connect(hornOsc.frequency);
  const hornBP = filter('bandpass', A.stallHornHz, A.stallHornQ);
  const hornNasal = filter('peaking', A.stallHornHz * 2, 3, 7);
  const horn = gain(0);
  chain(hornOsc, hornBP, hornNasal, horn, cabin);

  // ── Motors ────────────────────────────────────────────────────────────────
  const gearOsc = osc('sawtooth', 118);
  const gearBP = filter('bandpass', 430, 1.3);
  const gear = gain(0);
  chain(gearOsc, gearBP, gear, cabin);
  const gearWhine = osc('sine', 790);
  chain(gearWhine, gain(0.18), gear);
  const flapOsc = osc('sawtooth', 290);
  chain(osc('sine', 7), gain(5)).connect(flapOsc.frequency);
  const flapBP = filter('bandpass', 950, 2);
  const flap = gain(0);
  chain(flapOsc, flapBP, flap, cabin);

  // ── Fire bed after a crash ────────────────────────────────────────────────
  const fireSrc = loop(brown);
  const fireLP = filter('lowpass', 650, 0.7);
  const fire = gain(0);
  chain(fireSrc, fireLP, fire, fxBus);

  const k = (p: AudioParam, eps?: number) => new Knob(p, eps);
  return {
    ctx,
    kit: { ctx, white, pink, brown, rnd },
    master: k(master.gain),
    view1: k(view1.frequency, 1e-3),
    view2: k(view2.frequency, 1e-3),
    viewShelf: k(viewShelf.gain, 1e-3),
    distance: k(distance.gain),
    cabin: k(cabin.gain),
    windLP: k(windLP.frequency, 1e-3),
    cycleF: k(cycleOsc.frequency, 2e-4),
    fireF: k(fireOsc.frequency, 2e-4),
    propF: k(propOsc.frequency, 2e-4),
    bpfF: k(bpfOsc.frequency, 2e-4),
    crankF: k(crankLfo.frequency, 1e-3),
    exRate: k(exSrc.playbackRate, 1e-3),
    tone: k(tone.gain),
    toneLP: k(toneLP.frequency, 1e-3),
    exBP: k(exBP.frequency, 1e-3),
    exhaust: k(exhaust.gain),
    propLP: k(propLP.frequency, 1e-3),
    prop: k(prop.gain),
    propNoise: k(propNoise.gain),
    mech: k(mech.gain),
    starter: k(starter.gain),
    crank: k(crank.gain),
    wind: k(wind.gain),
    windBP: k(windBP.frequency, 1e-3),
    hiss: k(hiss.gain),
    whistle: k(whistle.gain),
    roll: k(roll.gain),
    rollLP: k(rollLP.frequency, 1e-3),
    scrub: k(scrub.gain),
    horn: k(horn.gain),
    gear: k(gear.gain),
    flap: k(flap.gain),
    fire: k(fire.gain),
    acFx,
    engineBus,
    cabinFx,
    fxBus,
    nodes,
  };
}

const fin = (v: number | undefined, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createAudio(opts: CreateAudioOptions = {}): AudioSystem {
  const seed = opts.seed ?? 4711;
  let ctx: BaseAudioContext | null = null;
  let graph: Graph | null = null;
  let disposed = false;
  let muted = false;
  let last: AudioInputs | null = null;
  let primed = false;
  let prev = { gear: false, starting: false, crashed: false };
  let crashAge = 0;
  const L: AudioLevels = {
    master: 0, engineVolume: A.engineVolume, exhaust: 0, prop: 0, mechanical: 0, starter: 0, cycleHz: 0, firingHz: 0,
    bladeHz: 0, doppler: 1, wind: 0, whistle: 0, rolling: 0, scrub: 0, horn: 0, gear: 0, flap: 0, fire: 0,
    viewCutoff: A.exteriorCutoffHz, distance: 1, cabin: A.exteriorCabinGain, oneShots: 0, lastTouchdown: 0, errors: 0,
  };

  const build = (c: BaseAudioContext) => {
    ctx = c;
    graph = buildGraph(c, seed);
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
    if (!g || !c) return;
    const t = c.currentTime;
    const dt = Number.isFinite(dtIn) ? clamp(dtIn, 0, 1) : 0;
    const tau = A.rampTau;
    const exterior = a.cameraMode !== 'cockpit';
    const crashed = !!a.crashed;
    const rpm = fin(a.rpm, 0);

    // Master
    L.master = masterGain(muted, !!a.paused);
    g.master.set(L.master, t, 0.06);

    // View / listener
    const dist = fin(a.listenerDistanceM, A.refDistanceM);
    L.viewCutoff = viewCutoffHz(a.cameraMode, dist);
    L.distance = distanceGain(a.cameraMode, dist);
    L.cabin = cabinBusGain(a.cameraMode);
    g.view1.set(L.viewCutoff, t, A.cameraRampTau);
    g.view2.set(exterior ? A.exteriorCutoffHz : L.viewCutoff * 1.6, t, A.cameraRampTau);
    g.viewShelf.set(exterior ? 0 : 5, t, A.cameraRampTau);
    g.distance.set(L.distance, t, A.cameraRampTau);
    g.cabin.set(L.cabin, t, A.cameraRampTau);
    g.windLP.set(exterior ? A.exteriorCutoffHz : 1500, t, A.cameraRampTau);

    // Engine
    const mix = engineMix({ rpm, power: a.power, engineRunning: !!a.engineRunning, starting: !!a.starting, crashed });
    const dop = exterior ? dopplerFactor(fin(a.closingSpeedMs, 0)) : 1;
    L.doppler = dop;
    L.exhaust = mix.exhaust;
    L.prop = mix.prop;
    L.mechanical = mix.mechanical;
    L.starter = mix.starter;
    L.cycleHz = cycleFrequency(rpm) * dop;
    L.firingHz = firingFrequency(rpm) * dop;
    L.bladeHz = bladePassFrequency(rpm) * dop;
    g.cycleF.set(L.cycleHz, t, tau);
    g.fireF.set(L.firingHz, t, tau);
    g.propF.set(L.bladeHz, t, tau);
    g.bpfF.set(L.bladeHz, t, tau);
    g.exRate.set(dop, t, tau);
    g.crankF.set(Math.max(3, firingFrequency(rpm)), t, tau);
    const rpmN = clamp(rpm / CONFIG.aircraft.engine.maxRpm, 0, 1);
    g.tone.set(0.6 * mix.exhaust, t, tau);
    g.toneLP.set(260 + 2600 * mix.brightness, t, tau);
    g.exBP.set(exhaustCenterHz(rpm), t, tau);
    g.exhaust.set(0.85 * mix.exhaust, t, tau);
    g.propLP.set(650 + 3800 * Math.pow(rpmN, 1.5), t, tau);
    g.prop.set(0.42 * mix.prop, t, tau);
    g.propNoise.set(0.3 * mix.prop, t, tau);
    g.mech.set(0.05 * mix.mechanical, t, tau);
    g.starter.set(0.32 * mix.starter, t, tau);
    g.crank.set(0.55 * mix.starter, t, tau);

    // Airflow
    const ias = fin(a.airspeedKt, 0);
    L.wind = windGain(ias);
    L.whistle = whistleGain(ias, a.cameraMode);
    g.wind.set(L.wind * A.windVolume, t, tau);
    g.windBP.set(windCenterHz(ias), t, tau);
    g.hiss.set(Math.pow(L.wind, 1.5) * A.windVolume * 0.3, t, tau);
    g.whistle.set(L.whistle * A.whistleVolume, t, tau);

    // Ground
    const gs = fin(a.groundSpeedKt, 0);
    L.rolling = rollingGain(gs, !!a.onGround, a.surface);
    L.scrub = brakeScrubGain(fin(a.brake, 0), gs, a.surface, !!a.onGround);
    g.roll.set(L.rolling * A.rollingVolume * 1.5, t, tau);
    g.rollLP.set(rollingCutoffHz(gs, a.surface), t, tau);
    g.scrub.set(L.scrub * A.rollingVolume * 0.4, t, tau);

    // Horn / motors
    L.horn = stallHornOn(!!a.stallWarning, ias, crashed) ? A.stallHornVolume : 0;
    g.horn.set(L.horn, t, 0.025);
    L.gear = a.gearMoving && !crashed ? A.motorVolume : 0;
    L.flap = a.flapsMoving && !crashed ? A.motorVolume : 0;
    g.gear.set(L.gear, t, 0.08);
    g.flap.set(L.flap, t, 0.06);

    // Discrete events (not on the first frame: its "edges" are just the initial state)
    const kit = g.kit;
    if (primed) {
      if (crashed && !prev.crashed) {
        crashAge = 0;
        playCrash(kit, g.fxBus, t, crashIntensity(fin(a.crashSpeedKt, ias)));
        L.oneShots++;
      }
      if (prev.gear && !a.gearMoving && !crashed) {
        playGearClunk(kit, g.cabinFx, t);
        L.oneShots++;
      }
      if (prev.starting && !a.starting && a.engineRunning && !crashed) {
        playCatch(kit, g.engineBus, t);
        L.oneShots++;
      }
    }
    if (a.touchdownFpm !== null && a.touchdownFpm !== undefined && !crashed) {
      const i = touchdownIntensity(a.touchdownFpm);
      if (i > 0) {
        playTouchdown(kit, g.acFx, t, i, a.surface);
        L.lastTouchdown = i;
        L.oneShots++;
      }
    }

    // Fire bed + crackles while the wreck burns
    if (crashed) {
      crashAge += dt;
      const burn = Math.exp(-crashAge / 22);
      L.fire = 0.55 * burn;
      if (!a.paused && kit.rnd() < dt * 9 * burn) playCrackle(kit, g.fxBus, t + 0.01, burn);
    } else {
      L.fire = 0;
    }
    g.fire.set(L.fire, t, 0.4);

    prev = { gear: !!a.gearMoving && !crashed, starting: !!a.starting, crashed };
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
    get context() {
      return ctx;
    },
    levels() {
      return { ...L };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const c = ctx as BaseAudioContext | null;
      const g = graph as Graph | null;
      graph = null;
      try {
        if (g) for (const n of g.nodes) n.disconnect();
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
