/**
 * Functional: the JetRanger's 'turboshaft' voice on the mock AudioContext and the rotor fields of the
 * input tracker — the rotor rates follow NR, slap follows thrust and vortex ring state, the low rotor
 * RPM horn, light-off, the node budget, swapping voices, and fixed-wing aircraft (no rotor state)
 * are unaffected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import { createAudioInputTracker } from '../../src/audio/inputs';
import { TURBOSHAFT as T, bladePassHz, tailRotorHz } from '../../src/audio/turboshaftMapping';
import type { RotorAudioInputs } from '../../src/audio/types';
import type { EngineSound } from '../../src/fleet/types';
import type { AircraftState, CameraMode, Controls, RotorState } from '../../src/types';
import { MockAudioContext, MockScheduled, violations } from './mockAudio';

const DT = 1 / 60;
const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const ROTOR: RotorAudioInputs = {
  nrRpm: 394, n1: 0.9, enginePowerW: 175000, torque: 0.78, thrustN: 12700, tailThrustN: 740, collective: 0.55,
  vrs: 0, bladeStall: 0, groundEffect: 0, climbMs: 0, decelMs2: 0,
};
const HOVER: AudioInputs = { ...IDLE, rpm: 394, power: 0.74, engineRunning: true, onGround: false, rotor: ROTOR };

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

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('turboshaft voice', () => {
  it('plays for sound "turboshaft": blade passage and tail-rotor rates from NR, the other voices silent', async () => {
    const { audio, ctx } = await makeAudio('turboshaft');
    expect(audio.engine).toBe('turboshaft');
    run(audio, ctx, HOVER, 0.2);
    const L = audio.levels();
    expect(L.turboshaft).toBe(1);
    expect(L.jet).toBe(0);
    expect(L.turbofan).toBe(0);
    expect(L.exhaust).toBe(0);
    expect(L.rotorPct).toBeCloseTo(100, 6);
    expect(L.bladeHz).toBeCloseTo(bladePassHz(394), 6);
    expect(L.tailHz).toBeCloseTo(tailRotorHz(394), 6);
    expect(L.tailRotor).toBeGreaterThan(0);
    expect(L.whine).toBeGreaterThan(0);
    expect(L.roar).toBeGreaterThan(0);
    expect(L.gearbox).toBeGreaterThan(0);
    // NR decays → the rates follow.
    run(audio, ctx, { ...HOVER, engineRunning: false, rotor: { ...ROTOR, nrRpm: 300, n1: 0.3, enginePowerW: 0 } }, 0.1);
    expect(audio.levels().bladeHz).toBeCloseTo(bladePassHz(300), 6);
  });

  it('blade slap grows with thrust and with vortex ring state', async () => {
    const { audio, ctx } = await makeAudio('turboshaft');
    run(audio, ctx, { ...HOVER, rotor: { ...ROTOR, thrustN: 4000 } }, 0.1);
    const light = audio.levels().slap;
    run(audio, ctx, HOVER, 0.1);
    const hover = audio.levels().slap;
    run(audio, ctx, { ...HOVER, rotor: { ...ROTOR, vrs: 0.9 } }, 0.1);
    const vrs = audio.levels().slap;
    expect(hover).toBeGreaterThan(light);
    expect(vrs).toBeGreaterThan(hover * 2);
    expect(audio.levels().slapSharpness).toBeGreaterThan(0.7);
  });

  it('the low rotor RPM horn sounds in the cabin while lowRotorRpm is set, never in a wreck', async () => {
    const { audio, ctx } = await makeAudio('turboshaft');
    run(audio, ctx, HOVER, 0.1);
    expect(audio.levels().rotorHorn).toBe(0);
    run(audio, ctx, { ...HOVER, lowRotorRpm: true }, 0.1);
    expect(audio.levels().rotorHorn).toBeCloseTo(T.hornVolume, 9);
    run(audio, ctx, { ...HOVER, lowRotorRpm: true, crashed: true }, 0.1);
    expect(audio.levels().rotorHorn).toBe(0);
  });

  it('light-off plays one "whump" when N1 crosses the light-off speed during a start', async () => {
    const { audio, ctx } = await makeAudio('turboshaft');
    const start = (n1: number): AudioInputs => ({ ...IDLE, starting: true, rotor: { ...ROTOR, nrRpm: 10, n1, enginePowerW: 0, thrustN: 0, collective: 0 } });
    run(audio, ctx, start(0.05), 0.2);
    const before = audio.levels().oneShots;
    run(audio, ctx, start(0.15), 0.2);
    run(audio, ctx, start(0.3), 0.2);
    expect(audio.levels().oneShots).toBe(before + 1);
  });

  it('costs about what the other voices cost (nodes and running sources)', async () => {
    const count = async (e: EngineSound, a: AudioInputs) => {
      const { audio, ctx } = await makeAudio();
      run(audio, ctx, IDLE, 0.05);
      const before = ctx.nodes.length;
      audio.setEngine(e);
      run(audio, ctx, a, 0.05);
      const created = ctx.nodes.slice(before);
      return { nodes: created.length, sources: created.filter((n) => n instanceof MockScheduled).length };
    };
    const heli = await count('turboshaft', HOVER);
    const jet = await count('jet', { ...IDLE, rpm: 100, power: 1, engineRunning: true });
    expect(heli.nodes).toBeLessThanOrEqual(jet.nodes);
    expect(heli.sources).toBeLessThanOrEqual(jet.sources);
  });

  it('swapping to and from the helicopter leaks nothing and zeroes its levels', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, IDLE, 0.1);
    ctx.advance(1);
    ctx.endFinished();
    const baseline = ctx.liveNodes();
    for (let i = 0; i < 4; i++) {
      audio.setEngine(i % 2 === 0 ? 'turboshaft' : 'piston');
      run(audio, ctx, i % 2 === 0 ? HOVER : { ...IDLE, rpm: 2400, power: 0.7, engineRunning: true }, 0.2);
      ctx.advance(1);
      ctx.endFinished();
      expect(audio.levels().engineVoices).toBe(1);
    }
    const L = audio.levels();
    expect(L.turboshaft).toBe(0);
    expect(L.rotorPct).toBe(0);
    expect(L.slap).toBe(0);
    expect(L.tailRotor).toBe(0);
    expect(L.exhaust).toBeGreaterThan(0);
    audio.setEngine('piston');
    expect(ctx.liveNodes()).toBe(baseline);
  });

  it('fuzz: random rotor inputs never throw, never schedule a non-finite value, levels stay finite', async () => {
    const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300));
    const rotor = fc.option(fc.record({
      nrRpm: wild, n1: wild, enginePowerW: wild, torque: wild, thrustN: wild, tailThrustN: wild, collective: wild, vrs: wild,
      bladeStall: wild, groundEffect: wild, climbMs: wild, decelMs2: wild,
    }), { nil: undefined });
    const inputs = fc.record({
      rpm: wild, power: wild, engineRunning: fc.boolean(), starting: fc.boolean(), airspeedKt: wild, onGround: fc.boolean(),
      crashed: fc.boolean(), cameraMode: fc.constantFrom(...MODES), aft: fc.option(wild, { nil: undefined }),
      listenerDistanceM: fc.option(wild, { nil: undefined }), closingSpeedMs: fc.option(wild, { nil: undefined }),
      lowRotorRpm: fc.boolean(), rotor,
    });
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(inputs, fc.boolean()), { minLength: 1, maxLength: 25 }), async (seq) => {
      violations.length = 0;
      const { audio, ctx } = await makeAudio('turboshaft');
      for (const [a, swap] of seq) {
        ctx.advance(DT);
        if (swap) audio.setEngine(audio.engine === 'turboshaft' ? 'jet' : 'turboshaft');
        audio.update({ ...IDLE, ...(a as Partial<AudioInputs>) }, DT);
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
const OMEGA_100 = (394 * 2 * Math.PI) / 60;
/** The fields the sound reads (RotorState grows with the physics; the rest does not matter here). */
function rotorState(p: Partial<RotorState> = {}): RotorState {
  return {
    omega: OMEGA_100, vi: 7, viTail: 9, thrust: 12700, tailThrust: 740, flapLong: 0, flapLat: 0, enginePower: 175000, n1: 0.9,
    govInt: 0, torque: 0.78, collective: 0.55, cyclicLong: 0, cyclicLat: 0, pedal: 0, sasOn: true, sasLong: 0, sasLat: 0, sasYaw: 0,
    headingRef: 0, vrs: 0, bladeStall: 0, groundEffect: 0, fx: 0, fy: 0, ...p,
  } as RotorState;
}
function state(p: Partial<AircraftState> = {}): AircraftState {
  return {
    time: 10,
    position: { x: 0, y: 100, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: true, starting: false, startTimer: 0, failed: false, power: 0.74, rpm: 394, thrust: 12700 },
    flapsDeg: 0,
    gearPos: 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 30,
    touchdown: null,
    crash: null,
    derived: {
      tas: 0, ias: 0, groundSpeed: 0, alpha: 0, beta: 0, verticalSpeed: 0, altitudeAGL: 70, headingDeg: 0,
      pitchDeg: 0, rollDeg: 0, loadFactor: 1, density: 1.2, p: 0, q: 0, r: 0,
    },
    ...p,
  } as AircraftState;
}
const src = (st: AircraftState, extra: Record<string, unknown> = {}) => ({ state: st, controls: controls(), cameraMode: 'chase' as const, paused: false, dt: DT, ...extra });

describe('createAudioInputTracker: rotor fields', () => {
  it('fixed-wing aircraft (no rotor state): no rotor inputs, no rotor horn, the stall horn unchanged', () => {
    const track = createAudioInputTracker();
    const a = track(src(state(), { stallWarning: true, gearWarning: true }));
    expect(a.rotor).toBeUndefined();
    expect(a.lowRotorRpm).toBe(false);
    expect(a.stallWarning).toBe(true);
    expect(a.gearWarning).toBe(true);
  });
  it('a helicopter: NR in rpm from omega, the rotor and engine fields, vertical speed', () => {
    const track = createAudioInputTracker();
    const a = track(src(state({ rotor: rotorState({ vrs: 0.4 }), velocity: { x: 0, y: -2.5, z: 0 } })));
    expect(a.rotor).toBeDefined();
    const r = a.rotor!;
    expect(r.nrRpm).toBeCloseTo(394, 6);
    expect(r.n1).toBe(0.9);
    expect(r.enginePowerW).toBe(175000);
    expect(r.thrustN).toBe(12700);
    expect(r.tailThrustN).toBe(740);
    expect(r.vrs).toBe(0.4);
    expect(r.climbMs).toBe(-2.5);
    expect(a.lowRotorRpm).toBe(false);
  });
  it('a helicopter has no stall-warning vane or gear horn', () => {
    const track = createAudioInputTracker();
    const a = track(src(state({ rotor: rotorState() }), { stallWarning: true, gearWarning: true }));
    expect(a.stallWarning).toBe(false);
    expect(a.gearWarning).toBe(false);
  });
  it('the low rotor RPM horn: below 95 % airborne; not on the ground at flat pitch; on the ground with the collective up', () => {
    const track = createAudioInputTracker();
    const low = OMEGA_100 * 0.9;
    expect(track(src(state({ rotor: rotorState({ omega: low }) }))).lowRotorRpm).toBe(true);
    expect(track(src(state({ rotor: rotorState({ omega: OMEGA_100 }) }))).lowRotorRpm).toBe(false);
    const ground: Partial<AircraftState> = { onGround: true, phase: 'ground' };
    expect(track(src(state({ ...ground, rotor: rotorState({ omega: OMEGA_100 * 0.6, collective: 0 }) }))).lowRotorRpm).toBe(false);
    expect(track(src(state({ ...ground, rotor: rotorState({ omega: low, collective: 0.4 }) }))).lowRotorRpm).toBe(true);
    const off = { ...ground, engine: { running: false, starting: false, startTimer: 0, failed: false, power: 0, rpm: 100, thrust: 0 } } as Partial<AircraftState>;
    expect(track(src(state({ ...off, rotor: rotorState({ omega: OMEGA_100 * 0.25, collective: 0.4 }) }))).lowRotorRpm).toBe(false);
    expect(track(src(state({ phase: 'crashed', rotor: rotorState({ omega: low }) }))).lowRotorRpm).toBe(false);
  });
  it('slowing down horizontally reads as a deceleration (the flare), speeding up as negative', () => {
    const track = createAudioInputTracker();
    let v = 30;
    let a = track(src(state({ rotor: rotorState(), velocity: { x: 0, y: 0, z: -v } })));
    for (let i = 0; i < 90; i++) {
      v -= 3 * DT;
      a = track(src(state({ rotor: rotorState(), velocity: { x: 0, y: 0, z: -v } })));
    }
    expect(a.rotor!.decelMs2).toBeGreaterThan(2.5);
    expect(a.rotor!.decelMs2).toBeLessThan(3.2);
    for (let i = 0; i < 90; i++) {
      v += 2 * DT;
      a = track(src(state({ rotor: rotorState(), velocity: { x: 0, y: 0, z: -v } })));
    }
    expect(a.rotor!.decelMs2).toBeLessThan(-1.5);
  });
  it('a rotor state full of NaN/∞ still gives finite inputs; switching back to a fixed-wing state clears them', () => {
    const track = createAudioInputTracker();
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));
    fc.assert(fc.property(wild, wild, wild, wild, wild, wild, wild, (omega, n1, pw, th, tt, vrs, vy) => {
      const a = track(src(state({ rotor: rotorState({ omega, n1, enginePower: pw, thrust: th, tailThrust: tt, vrs, collective: vrs }), velocity: { x: vy, y: vy, z: 0 } })));
      for (const [k, v] of Object.entries(a.rotor!)) expect(Number.isFinite(v), k).toBe(true);
      expect(typeof a.lowRotorRpm).toBe('boolean');
    }), { numRuns: 500 });
    const a = track(src(state()));
    expect(a.rotor).toBeUndefined();
    expect(a.lowRotorRpm).toBe(false);
  });
});
