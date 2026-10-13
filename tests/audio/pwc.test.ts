/**
 * Functional: the Sea-Doo RXP-X 325's 'pwc' voice on the mock AudioContext and the waterjet fields of the
 * input tracker — the Rotax triple's firing rate rpm/40, the supercharger whine, the pump (roar, ventilation
 * sputter when airborne), start (catch) and stop (run-down + cough), the iBR bucket clunk, the blow-off,
 * landing a jump, the hull's slaps, the open-air rider view, no aircraft sounds on a jet ski, the node
 * budget, swapping voices without leaks, and fuzzing with wild inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import { createAudioInputTracker } from '../../src/audio/inputs';
import { PWC as P, pwcCycleHz, pwcFiringHz, superchargerWhineHz, impellerBladeHz } from '../../src/audio/pwcMapping';
import { CONFIG } from '../../src/config';
import type { MarineEngineAudioInputs, VesselAudioInputs } from '../../src/audio/types';
import type { EngineSound } from '../../src/fleet/types';
import type { AircraftState, CameraMode, Controls, PropulsorState, VesselState } from '../../src/types';
import { MockAudioContext, MockOscillator, MockScheduled, violations } from './mockAudio';

const DT = 1 / 60;
const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const jet = (rpm: number, load = 0.08, boost = 0.05, gear = 0, p: Partial<MarineEngineAudioInputs> = {}): MarineEngineAudioInputs => ({
  rpm, load, boost, gear, propRps: rpm / 60, thrustN: 0, flow: (0.28 * rpm) / 8000, jetSpeed: (47 * rpm) / 8000, ventilation: 0, bucket: gear < 0 ? 1 : gear === 0 ? 0.5 : 0, ...p,
});
const hull = (e: MarineEngineAudioInputs, p: Partial<VesselAudioInputs> = {}): VesselAudioInputs => ({
  engines: [e], engineCount: 1, speedMs: 0, planing: 0, trimDeg: 0, aground: false, heaveMs: 0, pitchRate: 0, rollRate: 0, moored: false, ...p,
});
const SKI_IDLE: AudioInputs = { ...IDLE, onGround: false, surface: 'water', rpm: P.idleRpm, power: 0.05, engineRunning: true, vessel: hull(jet(P.idleRpm)) };
const SKI_FULL: AudioInputs = {
  ...SKI_IDLE, rpm: 8000, power: 1, airspeedKt: 55,
  vessel: hull(jet(8000, 1, 1, 1, { flow: 0.28, jetSpeed: 47, thrustN: 6000 }), { speedMs: 28.3, planing: 1, heaveMs: 0.3, pitchRate: 0.05 }),
};
const SKI_AIR: AudioInputs = {
  ...SKI_FULL, rpm: P.ventRpm, power: 0.2,
  vessel: hull(jet(P.ventRpm, 0.12, 0.3, 1, { flow: 0.04, jetSpeed: 18, ventilation: 1 }), { speedMs: 25, planing: 0, heaveMs: -2, pitchRate: 0.2 }),
};

async function makeAudio(engine?: EngineSound) {
  let ctx: MockAudioContext | null = null;
  const audio = createAudio({
    createContext: () => {
      ctx = new MockAudioContext();
      return ctx as unknown as AudioContext;
    },
  });
  if (engine) audio.setEngine(engine);
  await audio.resume();
  return { audio, ctx: ctx as unknown as MockAudioContext };
}
function run(audio: ReturnType<typeof createAudio>, ctx: MockAudioContext, a: AudioInputs, seconds: number) {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    ctx.advance(DT);
    audio.update(a, DT);
  }
}
const oscFreqs = (ctx: MockAudioContext) => ctx.nodes.filter((n): n is MockOscillator => n instanceof MockOscillator && !n.disconnected).map((o) => o.frequency.value);

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('pwc voice', () => {
  it('plays for sound "pwc" (createAudio option and setEngine): firing rpm/40, cycle rpm/120, the other voices silent', async () => {
    const early = createAudio({ engine: 'pwc', createContext: () => new MockAudioContext() as unknown as AudioContext });
    expect(early.engine).toBe('pwc');
    const { audio, ctx } = await makeAudio('pwc');
    expect(audio.engine).toBe('pwc');
    run(audio, ctx, SKI_IDLE, 0.2);
    let L = audio.levels();
    expect(L.pwc).toBe(1);
    expect(L.marine).toBe(0);
    expect(L.jet).toBe(0);
    expect(L.turboshaft).toBe(0);
    expect(L.firingHz).toBeCloseTo(42.5, 6);
    expect(L.cycleHz).toBeCloseTo(P.idleRpm / 120, 6);
    expect(L.exhaust).toBeGreaterThan(0);
    expect(L.marineRpm).toBe(P.idleRpm);
    const f = oscFreqs(ctx);
    expect(f.some((x) => Math.abs(x - pwcCycleHz(P.idleRpm)) < 1e-9)).toBe(true);
    expect(f.some((x) => Math.abs(x - pwcFiringHz(P.idleRpm)) < 1e-9)).toBe(true);
    run(audio, ctx, SKI_FULL, 0.3);
    L = audio.levels();
    expect(L.firingHz).toBeCloseTo(200, 6);
    expect(L.turboHz).toBeCloseTo(superchargerWhineHz(8000), 6);
    expect(L.bladeHz).toBeCloseTo(impellerBladeHz(8000), 6);
    expect(oscFreqs(ctx).some((x) => Math.abs(x - superchargerWhineHz(8000)) < 1e-6)).toBe(true);
  });

  it('idle vs full throttle vs airborne: load, snarl, whine and pump roar rise; ventilating, the roar goes and the sputter comes', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, SKI_IDLE, 0.3);
    const idle = audio.levels();
    run(audio, ctx, SKI_FULL, 0.3);
    const full = audio.levels();
    run(audio, ctx, SKI_AIR, 0.3);
    const air = audio.levels();
    expect(full.engineLoad).toBeGreaterThan(0.9);
    expect(full.mechanical).toBeGreaterThan(idle.mechanical * 2);
    expect(full.turbo).toBeGreaterThan(idle.turbo * 3);
    expect(full.pump).toBeGreaterThan(idle.pump * 3);
    expect(full.pumpVent).toBe(0);
    expect(full.hullRush).toBeGreaterThan(0.8);
    expect(full.skim).toBeGreaterThan(0.5);
    expect(air.pumpVent).toBeGreaterThan(0.8);
    expect(air.pump).toBe(0);
    expect(air.engineLoad).toBeLessThan(0.05);
    expect(air.firingHz).toBeCloseTo(105, 6);
    expect(air.mechanical).toBeLessThan(full.mechanical);
    expect(air.slapRate).toBe(0);
    expect(air.hullRush).toBeLessThan(full.hullRush * 0.3);
  });

  it('start: the starter cranks, the Rotax catches once; stop (tether): the rpm runs down quickly (not instantly), then a cough', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    const crank: AudioInputs = { ...SKI_IDLE, engineRunning: false, starting: true, rpm: 500, vessel: hull(jet(500, 0, 0)) };
    run(audio, ctx, crank, 0.5);
    expect(audio.levels().starter).toBe(1);
    const s0 = audio.levels().oneShots;
    run(audio, ctx, SKI_IDLE, 0.3);
    expect(audio.levels().starter).toBe(0);
    expect(audio.levels().oneShots).toBe(s0 + 1);
    const off: AudioInputs = { ...SKI_IDLE, engineRunning: false, rpm: 0, vessel: hull(jet(0, 0, 0)) };
    const s1 = audio.levels().oneShots;
    run(audio, ctx, off, 0.1);
    const r1 = audio.levels().marineRpm;
    expect(r1).toBeGreaterThan(500);
    expect(r1).toBeLessThan(P.idleRpm);
    expect(audio.levels().exhaust).toBe(0);
    run(audio, ctx, off, 1.5);
    expect(audio.levels().marineRpm).toBe(0);
    expect(audio.levels().oneShots).toBe(s1 + 1);
  });

  it('iBR bucket clunk on every gear change, not on the first frame, not in a wreck', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    const g = (gear: number): AudioInputs => ({ ...SKI_IDLE, vessel: hull(jet(P.idleRpm, 0.1, 0.05, gear)) });
    run(audio, ctx, g(0), 0.2);
    expect(audio.levels().gearClunks).toBe(0);
    const s = audio.levels().oneShots;
    run(audio, ctx, g(-1), 0.2);
    expect(audio.levels().gearClunks).toBe(1);
    expect(audio.levels().oneShots).toBe(s + 1);
    run(audio, ctx, g(1), 0.2);
    expect(audio.levels().gearClunks).toBe(2);
    run(audio, ctx, { ...g(0), crashed: true }, 0.2);
    expect(audio.levels().gearClunks).toBe(2);
  });

  it('landing a jump: one slam + splash after ≥ 0.2 s in the air; a brief gulp of air is not a jump', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, SKI_FULL, 0.3);
    const sources = () => ctx.started('bufferSource') + ctx.started('oscillator');
    let s = audio.levels().oneShots;
    run(audio, ctx, SKI_AIR, 0.1);
    run(audio, ctx, SKI_FULL, 0.2);
    expect(audio.levels().oneShots).toBe(s); // too short
    run(audio, ctx, SKI_AIR, 0.8);
    s = audio.levels().oneShots;
    const n0 = sources();
    audio.update(SKI_FULL, DT);
    expect(audio.levels().oneShots).toBe(s + 1);
    expect(sources()).toBeGreaterThan(n0 + 3);
    run(audio, ctx, SKI_FULL, 0.5);
    expect(audio.levels().oneShots - s).toBeLessThanOrEqual(1);
  });

  it('blow-off: chopping the throttle at high rpm whooshes once; the ECU cut while ventilating does not', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    const chop: AudioInputs = { ...SKI_FULL, rpm: 6000, vessel: hull(jet(6000, 0.05, 0.4, 1), { speedMs: 25, planing: 1 }) };
    const calmFull: AudioInputs = { ...SKI_FULL, vessel: hull(jet(8000, 1, 1, 1), { speedMs: 28 }) };
    run(audio, ctx, calmFull, 0.5);
    let s = audio.levels().oneShots;
    run(audio, ctx, { ...chop, vessel: hull(jet(6000, 0.05, 0.4, 1), { speedMs: 25 }) }, 0.3);
    expect(audio.levels().oneShots).toBe(s + 1);
    run(audio, ctx, calmFull, 0.5);
    s = audio.levels().oneShots;
    // Airborne: the ECU cuts the engine; that is the landing's business, not a blow-off.
    run(audio, ctx, { ...SKI_AIR, vessel: hull(jet(P.ventRpm, 0.05, 0.3, 1, { ventilation: 1 }), { speedMs: 25 }) }, 0.1);
    expect(audio.levels().oneShots).toBe(s);
  });

  it('hull slaps: frequent at speed in a chop, fewer at rest, none while paused', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, SKI_IDLE, 0.1);
    const calmRate = audio.levels().slapRate;
    const chop: AudioInputs = { ...SKI_FULL, vessel: hull(jet(6500, 0.7, 0.8, 1), { speedMs: 20, planing: 0.9, heaveMs: 0.9, pitchRate: 0.25, rollRate: 0.1 }) };
    run(audio, ctx, chop, 0.1);
    const chopRate = audio.levels().slapRate;
    expect(calmRate).toBeGreaterThan(0);
    expect(chopRate).toBeGreaterThan(calmRate * 4);
    expect(chopRate).toBeGreaterThan(6);
    const s0 = audio.levels().hullSlaps;
    run(audio, ctx, chop, 5);
    const n = audio.levels().hullSlaps - s0;
    expect(n).toBeGreaterThan(chopRate * 5 * 0.5);
    expect(n).toBeLessThan(chopRate * 5 * 1.6);
    const s1 = audio.levels().hullSlaps;
    for (let i = 0; i < 120; i++) {
      ctx.advance(DT);
      audio.update({ ...chop, paused: true }, 0);
    }
    expect(audio.levels().hullSlaps).toBe(s1);
  });

  it('rider view (cockpit): open air — no cabin low-pass, the wind louder than from the chase camera, the seat rumble on the cabin path', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, SKI_FULL, 0.2);
    const chase = audio.levels();
    run(audio, ctx, { ...SKI_FULL, cameraMode: 'cockpit' }, 0.2);
    const rider = audio.levels();
    expect(rider.viewCutoff).toBe(P.riderCutoffHz);
    expect(rider.viewCutoff).toBeGreaterThan(CONFIG.audio.cabinCutoffHz * 5);
    expect(rider.wind).toBeGreaterThan(chase.wind);
    expect(rider.cabin).toBe(1);
    const lp140 = ctx.nodes.find((n) => n.kind === 'biquad' && (n as unknown as { frequency: { value: number } }).frequency.value === 140 && !n.disconnected);
    expect(lp140).toBeDefined();
    const rumble = lp140!.outputs[0] as unknown as { gain: { value: number } };
    expect(rumble.gain.value).toBeGreaterThan(0);
  });

  it('a jet ski is a boat: no stall or gear horn, no tyres, no touchdown', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    const wrong: AudioInputs = { ...SKI_FULL, stallWarning: true, gearWarning: true, lowRotorRpm: true, onGround: true, groundSpeedKt: 30, brake: 1, surface: 'runway' };
    run(audio, ctx, wrong, 0.2);
    audio.update({ ...wrong, touchdownFpm: -800 }, DT);
    const L = audio.levels();
    expect(L.horn).toBe(0);
    expect(L.gearHorn).toBe(0);
    expect(L.rotorHorn).toBe(0);
    expect(L.rolling).toBe(0);
    expect(L.scrub).toBe(0);
    expect(L.lastTouchdown).toBe(0);
  });

  it('a crash silences the engine and the pump; no one-shots from the wreck', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, SKI_FULL, 0.2);
    run(audio, ctx, { ...SKI_FULL, crashed: true, crashSpeedKt: 50 }, 0.2);
    const L = audio.levels();
    expect(L.crashes).toBe(1);
    expect(L.exhaust).toBe(0);
    expect(L.turbo).toBe(0);
    expect(L.pump).toBe(0);
    expect(L.slapRate).toBe(0);
  });

  it('without a vessel state (QA override) the engine follows rpm / power', async () => {
    const { audio, ctx } = await makeAudio('pwc');
    run(audio, ctx, { ...IDLE, rpm: 6000, power: 0.6, engineRunning: true }, 0.2);
    const L = audio.levels();
    expect(L.firingHz).toBeCloseTo(150, 6);
    expect(L.engineLoad).toBeCloseTo(0.6, 6);
    expect(L.pump).toBeGreaterThan(0);
    expect(L.hullRush).toBe(0);
  });

  it('costs about what the other voices cost (nodes and running sources)', async () => {
    const count = async (e: EngineSound, a: AudioInputs) => {
      const { audio, ctx } = await makeAudio();
      run(audio, ctx, IDLE, 0.05);
      const before = ctx.nodes.length;
      audio.setEngine(e);
      audio.update(a, DT);
      const created = ctx.nodes.slice(before);
      return { nodes: created.length, sources: created.filter((n) => n instanceof MockScheduled).length };
    };
    const ski = await count('pwc', SKI_FULL);
    const jetV = await count('jet', { ...IDLE, rpm: 100, power: 1, engineRunning: true });
    expect(ski.nodes).toBeLessThanOrEqual(jetV.nodes * 1.5);
    expect(ski.sources).toBeLessThanOrEqual(jetV.sources * 1.6);
  });

  it('swapping to and from the jet ski leaks nothing and zeroes its levels', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, IDLE, 0.1);
    ctx.advance(1);
    ctx.endFinished();
    const baseline = ctx.liveNodes();
    for (let i = 0; i < 4; i++) {
      audio.setEngine(i % 2 === 0 ? 'pwc' : 'piston');
      run(audio, ctx, i % 2 === 0 ? (i === 2 ? SKI_AIR : SKI_FULL) : { ...IDLE, rpm: 2400, power: 0.7, engineRunning: true }, 0.5);
      ctx.advance(3);
      ctx.endFinished();
      expect(audio.levels().engineVoices).toBe(1);
    }
    const L = audio.levels();
    expect(L.pwc).toBe(0);
    expect(L.pump).toBe(0);
    expect(L.pumpVent).toBe(0);
    expect(L.hullRush).toBe(0);
    expect(L.turbo).toBe(0);
    audio.setEngine('marineDiesel');
    run(audio, ctx, { ...SKI_FULL, vessel: hull(jet(3000, 0.8, 0.9, 1)) }, 0.2);
    expect(audio.levels().marine).toBe(1);
    expect(audio.levels().pwc).toBe(0);
    audio.setEngine('piston');
    run(audio, ctx, IDLE, 0.1);
    ctx.advance(3);
    ctx.endFinished();
    expect(ctx.liveNodes()).toBe(baseline);
  });

  it('fuzz: random inputs and voice swaps never throw, never schedule a non-finite value, levels stay finite', async () => {
    const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300));
    const engine = fc.record({ rpm: wild, load: wild, boost: wild, gear: wild, propRps: wild, thrustN: wild, flow: wild, jetSpeed: wild, ventilation: wild, bucket: wild });
    const vessel = fc.option(fc.record({
      engines: fc.array(engine, { minLength: 0, maxLength: 2 }), engineCount: wild, speedMs: wild, planing: wild, trimDeg: wild,
      aground: fc.boolean(), heaveMs: wild, pitchRate: wild, rollRate: wild, moored: fc.boolean(),
    }), { nil: undefined });
    const inputs = fc.record({
      rpm: wild, power: wild, engineRunning: fc.boolean(), starting: fc.boolean(), airspeedKt: wild, crashed: fc.boolean(),
      paused: fc.boolean(), cameraMode: fc.constantFrom(...MODES), aft: fc.option(wild, { nil: undefined }),
      listenerDistanceM: fc.option(wild, { nil: undefined }), closingSpeedMs: fc.option(wild, { nil: undefined }), vessel,
    });
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(inputs, fc.boolean(), fc.double({ min: 0, max: 0.5, noNaN: true })), { minLength: 1, maxLength: 25 }), async (seq) => {
      violations.length = 0;
      const { audio, ctx } = await makeAudio('pwc');
      for (const [a, swap, dt] of seq) {
        ctx.advance(DT);
        if (swap) audio.setEngine(audio.engine === 'pwc' ? 'marineDiesel' : 'pwc');
        audio.update({ ...IDLE, ...(a as Partial<AudioInputs>) }, dt);
      }
      expect(violations).toEqual([]);
      expect(audio.levels().errors).toBe(0);
      for (const [k, v] of Object.entries(audio.levels())) expect(Number.isFinite(v), k).toBe(true);
      audio.dispose();
    }), { numRuns: 40 });
  }, 30_000);
});

// ── The input tracker: the waterjet's fields ─────────────────────────────────

function controls(p: Partial<Controls> = {}): Controls {
  return { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true, ...p };
}
function propulsor(p: Partial<PropulsorState> = {}): PropulsorState {
  return {
    rpm: 8000, n: 8000 / 60, gear: 'ahead', thrust: 9000, steerDeg: 0, load: 1, boost: 1,
    jet: { bucket: 0, trimDeg: 0, flow: 0.27, jetSpeed: 46, ventilation: 0.1, nozzleClear: false }, ...p,
  };
}
function vesselState(p: Partial<VesselState> = {}): VesselState {
  return {
    seaTime: 5, propulsors: [propulsor()], tabs: 0, mooring: null, speedMs: 28, leewayDeg: 0, trimDeg: 3, planing: 1, wettedLength: 2,
    wettedArea: 2, displacedVolume: 0.5, resistance: 3000, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0, ...p,
  } as VesselState;
}
function state(p: Partial<AircraftState> = {}): AircraftState {
  return {
    time: 10, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: -28 }, orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 }, engine: { running: true, starting: false, startTimer: 0, failed: false, power: 1, rpm: 8000, thrust: 9000 },
    flapsDeg: 0, gearPos: 0, phase: 'afloat', stalled: false, onGround: true, wheelContact: [false, false, false], wheelCompression: [0, 0, 0],
    airborneTime: 0, touchdown: null, crash: null,
    derived: { tas: 28, ias: 28, groundSpeed: 28, alpha: 0, beta: 0, verticalSpeed: 0, altitudeAGL: 0.5, headingDeg: 0, pitchDeg: 3, rollDeg: 0, loadFactor: 1, density: 1.2, p: 0, q: 0, r: 0 },
    ...p,
  } as AircraftState;
}
const src = (st: AircraftState) => ({ state: st, controls: controls(), cameraMode: 'chase' as const, paused: false, dt: DT });

describe('createAudioInputTracker: waterjet fields', () => {
  it('copies flow, jet speed, ventilation and the bucket from PropulsorState.jet', () => {
    const track = createAudioInputTracker();
    const a = track(src(state({ vessel: vesselState() })));
    const e = a.vessel!.engines[0];
    expect(e.flow).toBe(0.27);
    expect(e.jetSpeed).toBe(46);
    expect(e.ventilation).toBe(0.1);
    expect(e.bucket).toBe(0);
    expect(e.rpm).toBe(8000);
  });
  it('a propulsor without a jet leaves no jet keys (a boat reusing the pool after a jet ski); wild jet values stay finite', () => {
    const track = createAudioInputTracker();
    track(src(state({ vessel: vesselState() })));
    const a = track(src(state({ vessel: vesselState({ propulsors: [propulsor({ jet: undefined })] }) })));
    const e = a.vessel!.engines[0];
    expect('flow' in e).toBe(false);
    expect('ventilation' in e).toBe(false);
    for (const [k, x] of Object.entries(e)) expect(Number.isFinite(x), k).toBe(true);
    const w = track(src(state({ vessel: vesselState({ propulsors: [propulsor({ jet: { bucket: Number.NaN, trimDeg: 0, flow: Infinity, jetSpeed: -Infinity, ventilation: 7, nozzleClear: true } })] }) })));
    const j = w.vessel!.engines[0];
    for (const [k, x] of Object.entries(j)) expect(Number.isFinite(x), k).toBe(true);
    expect(j.ventilation).toBe(1);
  });
});
