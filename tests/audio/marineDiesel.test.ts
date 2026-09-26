/**
 * Functional: the Princess V50's 'marineDiesel' voice on the mock AudioContext and the vessel fields of
 * the input tracker — firing rate rpm/20 from the D6s, the detuned starboard engine, load hardening the
 * note, the turbo, start (catch) and stop (run-down + shudder), gearbox clunks, water rush / skim / hull
 * slaps / grinding, the saloon view, no aircraft sounds (horns, tyres, touchdowns, motors) on a boat,
 * the node budget, swapping voices without leaks, and fuzzing with wild vessel inputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import { createAudioInputTracker } from '../../src/audio/inputs';
import { MARINE as M, marineFiringHz } from '../../src/audio/marineMapping';
import type { MarineEngineAudioInputs, VesselAudioInputs } from '../../src/audio/types';
import type { EngineSound } from '../../src/fleet/types';
import type { AircraftState, CameraMode, Controls, PropulsorState, VesselState } from '../../src/types';
import { MockAudioContext, MockBiquad, MockGain, MockOscillator, MockScheduled, MockWaveShaper, violations } from './mockAudio';

const DT = 1 / 60;
const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const eng = (rpm: number, load = 0.1, boost = 0.05, gear = 0, thrustN = 0): MarineEngineAudioInputs => ({
  rpm, load, boost, gear, propRps: gear === 0 ? 0 : (gear * rpm) / M.gearRatio / 60, thrustN,
});
const hull = (e: MarineEngineAudioInputs, p: Partial<VesselAudioInputs> = {}): VesselAudioInputs => ({
  engines: [e, { ...e }], engineCount: 2, speedMs: 0, planing: 0, trimDeg: 0, aground: false, heaveMs: 0, pitchRate: 0, rollRate: 0,
  moored: false, ...p,
});
const BOAT_IDLE: AudioInputs = { ...IDLE, onGround: false, surface: 'water', rpm: 700, power: 0.05, engineRunning: true, vessel: hull(eng(700)) };
const BOAT_CRUISE: AudioInputs = {
  ...BOAT_IDLE, rpm: 3000, power: 0.75, airspeedKt: 29,
  vessel: hull(eng(3000, 0.8, 0.9, 1, 14000), { speedMs: 14.4, planing: 0.9, heaveMs: 0.3, pitchRate: 0.04 }),
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
/** The drive gains in front of the waveshapers (the "hard under load" stage). */
const drives = (ctx: MockAudioContext) =>
  ctx.nodes.filter((n): n is MockGain => n instanceof MockGain && !n.disconnected && n.outputs.some((o) => o instanceof MockWaveShaper)).map((g) => g.gain.value);

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('marineDiesel voice', () => {
  it('plays for sound "marineDiesel": firing rpm/20 (6-cyl 4-stroke), cycle rpm/120, the other voices silent', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    expect(audio.engine).toBe('marineDiesel');
    run(audio, ctx, BOAT_IDLE, 0.2);
    let L = audio.levels();
    expect(L.marine).toBe(1);
    expect(L.jet).toBe(0);
    expect(L.turbofan).toBe(0);
    expect(L.turboshaft).toBe(0);
    expect(L.firingHz).toBeCloseTo(35, 6);
    expect(L.cycleHz).toBeCloseTo(700 / 120, 6);
    expect(L.exhaust).toBeGreaterThan(0);
    expect(L.mechanical).toBeGreaterThan(0); // clatter
    const f = oscFreqs(ctx);
    // Port at exactly rpm/120 and rpm/20; starboard a little faster (they beat).
    expect(f.some((x) => Math.abs(x - 700 / 120) < 1e-9)).toBe(true);
    expect(f.some((x) => Math.abs(x - 35) < 1e-9)).toBe(true);
    const stbd = f.filter((x) => x > 35 * 1.001 && x < 35 * 1.01);
    expect(stbd.length).toBeGreaterThan(0);
    run(audio, ctx, BOAT_CRUISE, 0.2);
    L = audio.levels();
    expect(L.firingHz).toBeCloseTo(marineFiringHz(3000), 6);
    expect(L.firingHz).toBeCloseTo(150, 6);
    expect(L.bladeHz).toBeCloseTo((3000 / M.gearRatio / 60) * M.propBlades, 6);
  });

  it('load hardens and brightens the note; the turbo whistles with boost and rises in pitch', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const at = (load: number, boost: number) => ({ ...BOAT_IDLE, rpm: 2500, vessel: hull(eng(2500, load, boost, 1, 8000 * load)) });
    run(audio, ctx, at(0.1, 0.1), 0.2);
    const light = { drive: Math.max(...drives(ctx)), turbo: audio.levels().turbo, hz: audio.levels().turboHz };
    run(audio, ctx, at(1, 1), 0.2);
    const heavy = { drive: Math.max(...drives(ctx)), turbo: audio.levels().turbo, hz: audio.levels().turboHz };
    expect(heavy.drive).toBeGreaterThan(light.drive * 3);
    expect(heavy.turbo).toBeGreaterThan(light.turbo * 3);
    expect(heavy.hz).toBeGreaterThan(light.hz);
    expect(audio.levels().engineLoad).toBeCloseTo(1, 6);
  });

  it('start: the starter cranks, the engines catch once; stop: rpm runs down (not instantly), then a shudder', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const crank: AudioInputs = { ...BOAT_IDLE, engineRunning: false, starting: true, rpm: 180, vessel: hull(eng(180, 0, 0)) };
    run(audio, ctx, crank, 0.5);
    expect(audio.levels().starter).toBe(1);
    const shots0 = audio.levels().oneShots;
    run(audio, ctx, BOAT_IDLE, 0.3);
    expect(audio.levels().starter).toBe(0);
    expect(audio.levels().oneShots).toBe(shots0 + 1);
    // Stop: the physics drops rpm to 0 at once, the sound runs down over ~a second.
    const off: AudioInputs = { ...BOAT_IDLE, engineRunning: false, rpm: 0, vessel: hull(eng(0, 0, 0)) };
    const shots1 = audio.levels().oneShots;
    run(audio, ctx, off, 0.1);
    const r1 = audio.levels().marineRpm;
    expect(r1).toBeGreaterThan(500);
    expect(r1).toBeLessThan(700);
    expect(audio.levels().exhaust).toBe(0); // no combustion
    run(audio, ctx, off, 2);
    expect(audio.levels().marineRpm).toBe(0);
    expect(audio.levels().oneShots).toBe(shots1 + 1);
  });

  it('gearbox clunk on every shift between ahead, neutral and astern (per drive), not on the first frame, not in a wreck', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const g = (gear: number): AudioInputs => ({ ...BOAT_IDLE, vessel: hull(eng(700, 0.1, 0.05, gear, 1000)) });
    run(audio, ctx, g(1), 0.2);
    expect(audio.levels().gearClunks).toBe(0);
    run(audio, ctx, g(0), 0.2);
    expect(audio.levels().gearClunks).toBe(2);
    run(audio, ctx, g(-1), 0.2);
    expect(audio.levels().gearClunks).toBe(4);
    // One drive only (the port one stays astern).
    run(audio, ctx, { ...BOAT_IDLE, vessel: { ...hull(eng(700)), engines: [eng(700, 0.1, 0.05, -1, 800), eng(700)] } }, 0.2);
    expect(audio.levels().gearClunks).toBe(5);
    run(audio, ctx, { ...g(-1), crashed: true }, 0.2);
    expect(audio.levels().gearClunks).toBe(5);
  });

  it('water: rush grows with speed, skim only when planing, wash at displacement speeds, grinding when aground', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const at = (speedMs: number, planing: number, aground = false): AudioInputs => ({ ...BOAT_IDLE, vessel: hull(eng(1500, 0.5, 0.4, 1, 6000), { speedMs, planing, aground }) });
    run(audio, ctx, at(0, 0), 0.1);
    const rest = audio.levels();
    expect(rest.hullRush).toBe(0);
    expect(rest.skim).toBe(0);
    expect(rest.grind).toBe(0);
    run(audio, ctx, at(4, 0.1), 0.1);
    const slow = audio.levels();
    run(audio, ctx, at(15, 0.9), 0.1);
    const fast = audio.levels();
    expect(slow.hullRush).toBeGreaterThan(rest.hullRush);
    expect(fast.hullRush).toBeGreaterThan(slow.hullRush);
    expect(slow.wash).toBeGreaterThan(fast.wash);
    expect(slow.skim).toBe(0);
    expect(fast.skim).toBeGreaterThan(0.5);
    const shots = audio.levels().oneShots;
    run(audio, ctx, at(2, 0, true), 0.1);
    expect(audio.levels().grind).toBeGreaterThan(0.3);
    expect(audio.levels().oneShots).toBe(shots + 1); // the grounding thump, once
    run(audio, ctx, at(2, 0, true), 0.3);
    expect(audio.levels().oneShots).toBe(shots + 1);
  });

  it('hull slaps: the rate follows the hull working in the waves and the speed; none while paused', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const calm: AudioInputs = { ...BOAT_IDLE, vessel: hull(eng(700)) };
    const chop: AudioInputs = { ...BOAT_IDLE, vessel: hull(eng(700), { heaveMs: 0.9, pitchRate: 0.15, rollRate: 0.1 }) };
    run(audio, ctx, calm, 0.1);
    const calmRate = audio.levels().slapRate;
    run(audio, ctx, chop, 0.1);
    const chopRate = audio.levels().slapRate;
    expect(calmRate).toBeGreaterThan(0); // lapping at the berth
    expect(chopRate).toBeGreaterThan(calmRate * 3);
    const s0 = audio.levels().hullSlaps;
    run(audio, ctx, chop, 10);
    const n = audio.levels().hullSlaps - s0;
    expect(n).toBeGreaterThan(chopRate * 10 * 0.5);
    expect(n).toBeLessThan(chopRate * 10 * 1.6);
    const s1 = audio.levels().hullSlaps;
    const paused = { ...chop, paused: true };
    for (let i = 0; i < 300; i++) {
      ctx.advance(DT);
      audio.update(paused, 0);
    }
    expect(audio.levels().hullSlaps).toBe(s1);
  });

  it('saloon helm (cockpit): the engines are low-passed under the floor and a structure-borne rumble plays on the cabin path', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const lpAt = (hz: number) => ctx.nodes.filter((n) => n instanceof MockBiquad && !n.disconnected && n.type === 'lowpass' && Math.abs(n.frequency.value - hz) < 1e-6).length;
    /** Gains feeding the cabin bus straight from a 160 Hz low-pass (the structure-borne rumble). */
    const rumble = () => ctx.nodes.filter((n): n is MockGain => n instanceof MockGain && !n.disconnected).filter((g) =>
      ctx.nodes.some((f) => f instanceof MockBiquad && f.type === 'lowpass' && f.frequency.value === 160 && f.outputs.includes(g))).map((g) => g.gain.value);
    run(audio, ctx, BOAT_CRUISE, 0.2);
    const outside = lpAt(M.cockpitEngineLpHz);
    expect(Math.max(...rumble())).toBe(0);
    run(audio, ctx, { ...BOAT_CRUISE, cameraMode: 'cockpit' }, 0.2);
    expect(lpAt(M.cockpitEngineLpHz)).toBe(outside + 1);
    expect(Math.max(...rumble())).toBeGreaterThan(0);
    expect(audio.levels().cabin).toBe(1);
  });

  it('a boat has no stall or gear horn, no tyres, no touchdown, and only a little apparent wind', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    const wrong: AudioInputs = {
      ...BOAT_CRUISE, stallWarning: true, gearWarning: true, lowRotorRpm: true, onGround: true, groundSpeedKt: 30, brake: 1, surface: 'runway',
      airspeedKt: 34,
    };
    run(audio, ctx, wrong, 0.2);
    audio.update({ ...wrong, touchdownFpm: -800 }, DT);
    const L = audio.levels();
    expect(L.horn).toBe(0);
    expect(L.gearHorn).toBe(0);
    expect(L.rotorHorn).toBe(0);
    expect(L.rolling).toBe(0);
    expect(L.scrub).toBe(0);
    expect(L.lastTouchdown).toBe(0);
    const boatWind = L.wind;
    run(audio, ctx, { ...wrong, cameraMode: 'cockpit' }, 0.1);
    const saloonWind = audio.levels().wind;
    audio.setEngine('piston');
    run(audio, ctx, { ...IDLE, airspeedKt: 34, onGround: false }, 0.1);
    const planeWind = audio.levels().wind;
    expect(boatWind).toBeGreaterThan(0);
    expect(boatWind).toBeLessThan(planeWind);
    expect(saloonWind).toBeLessThan(boatWind * 0.5);
  });

  it('a crash silences the engines (the crash sound plays), no one-shots from the wreck', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    run(audio, ctx, BOAT_CRUISE, 0.2);
    run(audio, ctx, { ...BOAT_CRUISE, crashed: true, crashSpeedKt: 30 }, 0.2);
    const L = audio.levels();
    expect(L.crashes).toBe(1);
    expect(L.exhaust).toBe(0);
    expect(L.turbo).toBe(0);
    expect(L.slapRate).toBe(0);
  });

  it('without a vessel state (QA override) the engines follow rpm / power', async () => {
    const { audio, ctx } = await makeAudio('marineDiesel');
    run(audio, ctx, { ...IDLE, rpm: 2000, power: 0.6, engineRunning: true }, 0.2);
    const L = audio.levels();
    expect(L.firingHz).toBeCloseTo(100, 6);
    expect(L.engineLoad).toBeCloseTo(0.6, 6);
    expect(L.hullRush).toBe(0);
  });

  it('costs about what the other voices cost (nodes and running sources)', async () => {
    const count = async (e: EngineSound, a: AudioInputs) => {
      const { audio, ctx } = await makeAudio();
      run(audio, ctx, IDLE, 0.05);
      const before = ctx.nodes.length;
      audio.setEngine(e);
      audio.update(a, DT); // the first frame (no one-shots yet)
      const created = ctx.nodes.slice(before);
      return { nodes: created.length, sources: created.filter((n) => n instanceof MockScheduled).length };
    };
    const boat = await count('marineDiesel', BOAT_CRUISE);
    const jet = await count('jet', { ...IDLE, rpm: 100, power: 1, engineRunning: true });
    expect(boat.nodes).toBeLessThanOrEqual(jet.nodes * 1.5);
    expect(boat.sources).toBeLessThanOrEqual(jet.sources * 1.6);
  });

  it('swapping to and from the boat leaks nothing and zeroes its levels', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, IDLE, 0.1);
    ctx.advance(1);
    ctx.endFinished();
    const baseline = ctx.liveNodes();
    for (let i = 0; i < 4; i++) {
      audio.setEngine(i % 2 === 0 ? 'marineDiesel' : 'piston');
      run(audio, ctx, i % 2 === 0 ? { ...BOAT_CRUISE, vessel: hull(eng(3000, 0.8, 0.9, i === 2 ? -1 : 1, 14000), { speedMs: 14, planing: 0.9, heaveMs: 1, aground: i === 2 }) } : { ...IDLE, rpm: 2400, power: 0.7, engineRunning: true }, 0.5);
      ctx.advance(3);
      ctx.endFinished();
      expect(audio.levels().engineVoices).toBe(1);
    }
    const L = audio.levels();
    expect(L.marine).toBe(0);
    expect(L.hullRush).toBe(0);
    expect(L.turbo).toBe(0);
    expect(L.slapRate).toBe(0);
    expect(L.exhaust).toBeGreaterThan(0);
    audio.setEngine('piston');
    expect(ctx.liveNodes()).toBe(baseline);
  });

  it('fuzz: random vessel inputs never throw, never schedule a non-finite value, levels stay finite', async () => {
    const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300));
    const engine = fc.record({ rpm: wild, load: wild, boost: wild, gear: wild, propRps: wild, thrustN: wild });
    const vessel = fc.option(fc.record({
      engines: fc.array(engine, { minLength: 0, maxLength: 4 }), engineCount: wild, speedMs: wild, planing: wild, trimDeg: wild,
      aground: fc.boolean(), heaveMs: wild, pitchRate: wild, rollRate: wild, moored: fc.boolean(),
    }), { nil: undefined });
    const inputs = fc.record({
      rpm: wild, power: wild, engineRunning: fc.boolean(), starting: fc.boolean(), airspeedKt: wild, crashed: fc.boolean(),
      paused: fc.boolean(), cameraMode: fc.constantFrom(...MODES), aft: fc.option(wild, { nil: undefined }),
      listenerDistanceM: fc.option(wild, { nil: undefined }), closingSpeedMs: fc.option(wild, { nil: undefined }), vessel,
    });
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(inputs, fc.boolean(), fc.double({ min: 0, max: 0.5, noNaN: true })), { minLength: 1, maxLength: 25 }), async (seq) => {
      violations.length = 0;
      const { audio, ctx } = await makeAudio('marineDiesel');
      for (const [a, swap, dt] of seq) {
        ctx.advance(DT);
        if (swap) audio.setEngine(audio.engine === 'marineDiesel' ? 'turboshaft' : 'marineDiesel');
        audio.update({ ...IDLE, ...(a as Partial<AudioInputs>) }, dt);
      }
      expect(violations).toEqual([]);
      expect(audio.levels().errors).toBe(0);
      for (const [k, v] of Object.entries(audio.levels())) expect(Number.isFinite(v), k).toBe(true);
      audio.dispose();
    }), { numRuns: 40 });
  }, 30_000);
});

// ── The input tracker ──────────────────────────────────────────────────────────

function controls(p: Partial<Controls> = {}): Controls {
  return { throttle: 0.5, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true, ...p };
}
function propulsor(p: Partial<PropulsorState> = {}): PropulsorState {
  return { rpm: 3000, n: 3000 / 1.82 / 60, gear: 'ahead', thrust: 14000, steerDeg: 0, load: 0.8, boost: 0.9, ...p };
}
function vesselState(p: Partial<VesselState> = {}): VesselState {
  return {
    seaTime: 5, propulsors: [propulsor(), propulsor({ rpm: 3010 })], tabs: 0, mooring: null, speedMs: 14.4, leewayDeg: 0, trimDeg: 4,
    planing: 0.9, wettedLength: 9, wettedArea: 30, displacedVolume: 12, resistance: 26000, depthUnderKeel: Infinity, aground: false,
    capsizeTime: 0, surfaceY: 0, ...p,
  };
}
function state(p: Partial<AircraftState> = {}): AircraftState {
  return {
    time: 10,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -14.4 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.75, rpm: 3000, thrust: 28000 },
    flapsDeg: 0,
    gearPos: 0.5,
    phase: 'afloat',
    stalled: false,
    onGround: true,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 0,
    touchdown: { time: 9, verticalSpeedFpm: -900 },
    crash: null,
    derived: {
      tas: 15, ias: 15, groundSpeed: 14.4, alpha: 0.5, beta: 0, verticalSpeed: 0, altitudeAGL: 1, headingDeg: 0,
      pitchDeg: 4, rollDeg: 0, loadFactor: 1, density: 1.2, p: 0, q: 0, r: 0,
    },
    ...p,
  } as AircraftState;
}
const src = (st: AircraftState, extra: Record<string, unknown> = {}) => ({ state: st, controls: controls(), cameraMode: 'chase' as const, paused: false, dt: DT, ...extra });

describe('createAudioInputTracker: vessel fields', () => {
  it('aircraft (no vessel state): no vessel inputs', () => {
    const track = createAudioInputTracker();
    const a = track(src(state({ phase: 'airborne', onGround: false }), { stallWarning: true }));
    expect(a.vessel).toBeUndefined();
    expect(a.stallWarning).toBe(true);
  });
  it('a vessel: engines per propulsor (rpm, load, boost, gear, prop speed, thrust) and the hull', () => {
    const track = createAudioInputTracker();
    const a = track(src(state({ vessel: vesselState({ propulsors: [propulsor(), propulsor({ rpm: 3010, gear: 'astern', n: -20 })], aground: true, mooring: { x: 0, z: 0, headingDeg: 0 } }), angularVelocity: { x: 0.05, y: 0.1, z: -0.02 } })));
    const v = a.vessel!;
    expect(v).toBeDefined();
    expect(v.engineCount).toBe(2);
    expect(v.engines[0]).toEqual({ rpm: 3000, load: 0.8, boost: 0.9, gear: 1, propRps: 3000 / 1.82 / 60, thrustN: 14000 });
    expect(v.engines[1].rpm).toBe(3010);
    expect(v.engines[1].gear).toBe(-1);
    expect(v.engines[1].propRps).toBe(-20);
    expect(v.speedMs).toBe(14.4);
    expect(v.planing).toBe(0.9);
    expect(v.trimDeg).toBe(4);
    expect(v.aground).toBe(true);
    expect(v.moored).toBe(true);
    expect(v.pitchRate).toBe(0.05);
    expect(v.rollRate).toBe(-0.02);
  });
  it('a vessel has no stall or gear horn, no gear / flap motors, no touchdown, is not "on the ground", and floats on water', () => {
    const track = createAudioInputTracker();
    track(src(state({ vessel: vesselState(), touchdown: null })));
    const a = track(src(state({ vessel: vesselState(), gearPos: 0.7, flapsDeg: 10 }), { stallWarning: true, gearWarning: true, surface: 'runway' }));
    expect(a.stallWarning).toBe(false);
    expect(a.gearWarning).toBe(false);
    expect(a.gearMoving).toBe(false);
    expect(a.flapsMoving).toBe(false);
    expect(a.touchdownFpm).toBeNull();
    expect(a.onGround).toBe(false);
    expect(a.surface).toBe('water');
  });
  it('heave is the hull\'s vertical speed relative to the water: riding a swell up and down is ~0, pounding is not', () => {
    const track = createAudioInputTracker();
    let a = track(src(state({ vessel: vesselState({ surfaceY: 0 }) })));
    // Rising with the swell at 1 m/s: surface and hull together.
    for (let i = 1; i <= 60; i++) a = track(src(state({ velocity: { x: 0, y: 1, z: -14 }, vessel: vesselState({ surfaceY: i * DT }) })));
    expect(Math.abs(a.vessel!.heaveMs)).toBeLessThan(0.02);
    // Falling off a crest while the water under the hull stays put.
    for (let i = 0; i < 30; i++) a = track(src(state({ velocity: { x: 0, y: -1.5, z: -14 }, vessel: vesselState({ surfaceY: 1 }) })));
    expect(a.vessel!.heaveMs).toBeLessThan(-1.3);
  });
  it('a vessel state full of NaN/∞ still gives finite inputs; switching back to an aircraft clears them', () => {
    const track = createAudioInputTracker();
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));
    fc.assert(fc.property(wild, wild, wild, wild, wild, wild, (rpm, load, n, speed, surf, w) => {
      const a = track(src(state({
        angularVelocity: { x: w, y: w, z: w }, velocity: { x: w, y: w, z: w },
        vessel: vesselState({ propulsors: [propulsor({ rpm, load, boost: load, n, thrust: n })], speedMs: speed, planing: speed, trimDeg: speed, surfaceY: surf }),
      })));
      const v = a.vessel!;
      for (const k of ['speedMs', 'planing', 'trimDeg', 'heaveMs', 'pitchRate', 'rollRate'] as const) expect(Number.isFinite(v[k]), k).toBe(true);
      for (const [k, x] of Object.entries(v.engines[0])) expect(Number.isFinite(x), k).toBe(true);
    }), { numRuns: 400 });
    const a = track(src(state({ phase: 'airborne' })));
    expect(a.vessel).toBeUndefined();
  });
});
