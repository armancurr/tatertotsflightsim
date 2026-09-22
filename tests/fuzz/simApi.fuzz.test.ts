/**
 * Property tests for window.sim snapshots (src/game/simApi.ts): any valid
 * AircraftState + Controls must give a snapshot whose fields are finite, in
 * display units and range, and JSON-serialisable (browser tools read it via
 * page.evaluate).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildSimSnapshot, gearStateFromPos, installSimApi, stateLabel } from '../../src/game/simApi';
import { createInitialState, createApproachState, simStateLabel } from '../../src/physics';
import type { AircraftState, CameraMode, FlightPhase, SurfaceType, TouchdownRecord } from '../../src/types';
import { M_TO_FT, MS_TO_KT } from '../../src/config';
import { fcParams } from '../support/fc';
import { controls, num, unitQuat, vec3 } from '../support/arbitraries';
import { firstNonFinite } from '../support/invariants';

const PHASES: FlightPhase[] = ['ground', 'airborne', 'landed', 'crashed'];
const SURFACES: SurfaceType[] = ['runway', 'asphalt', 'grass', 'dirt', 'field', 'forest', 'rock', 'snow', 'sand', 'urban', 'water'];
const RATINGS: TouchdownRecord['rating'][] = ['butter', 'smooth', 'firm', 'hard'];
const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
const LABELS = new Set(['ground', 'airborne', 'stalled', 'landed', 'crashed']);

const touchdownArb: fc.Arbitrary<TouchdownRecord> = fc.record({
  time: num(0, 1e5),
  verticalSpeedFpm: num(-900, 100),
  airspeedKt: num(0, 120),
  rating: fc.constantFrom(...RATINGS),
  bankDeg: num(-15, 15),
  pitchDeg: num(-6, 20),
  surface: fc.constantFrom(...SURFACES),
  onRunway: fc.boolean(),
  centerlineOffsetM: fc.option(num(-15, 15), { nil: null }),
});

/** A structurally valid random AircraftState (all fields in their physical ranges). */
const stateArb: fc.Arbitrary<AircraftState> = fc.record({
  base: fc.constantFrom('runway', 'approach'),
  time: num(0, 1e5),
  position: fc.record({ x: num(-6e4, 6e4), y: num(-50, 5000), z: num(-6e4, 6e4) }),
  velocity: vec3(120),
  orientation: unitQuat,
  angularVelocity: vec3(8),
  flapsDeg: num(0, 30),
  gearPos: fc.oneof(num(0, 1), fc.constantFrom(0, 1, 0.999, 0.001, 0.5)),
  phase: fc.constantFrom(...PHASES),
  stalled: fc.boolean(),
  touchdown: fc.option(touchdownArb, { nil: null }),
  crashReason: fc.constantFrom('Hit terrain', 'Gear-up landing', 'Ditched in water', 'Prop strike'),
  derived: fc.record({
    tas: num(0, 120), ias: num(0, 120), groundSpeed: num(0, 120), alpha: num(-Math.PI, Math.PI), beta: num(-Math.PI / 2, Math.PI / 2),
    verticalSpeed: num(-100, 100), altitudeAGL: num(-5, 5000), headingDeg: num(0, 359.9999999), pitchDeg: num(-90, 90), rollDeg: num(-180, 180),
    loadFactor: num(-4, 7), density: num(0.7, 1.3), p: num(-8, 8), q: num(-8, 8), r: num(-8, 8),
  }),
  rpm: num(0, 2800),
  engineFlags: fc.record({ running: fc.boolean(), starting: fc.boolean(), failed: fc.boolean() }),
}).map((r) => {
  const b = r.base === 'runway' ? createInitialState() : createApproachState();
  const s: AircraftState = {
    ...b,
    time: r.time,
    position: r.position,
    velocity: r.velocity,
    orientation: r.orientation,
    angularVelocity: r.angularVelocity,
    flapsDeg: r.flapsDeg,
    gearPos: r.gearPos,
    phase: r.phase,
    stalled: r.phase === 'airborne' && r.stalled,
    touchdown: r.touchdown,
    crash: r.phase === 'crashed' ? { time: r.time, reason: r.crashReason, speedKt: 50, verticalSpeedFpm: -800, position: r.position } : null,
    derived: r.derived,
    engine: { ...b.engine, ...r.engineFlags, rpm: r.rpm },
  };
  return s;
});

const fpsArb = fc.record({ fps: num(0, 500), avg: num(0, 500), min: num(0, 500), onePercentLow: num(0, 500), longFrames: fc.nat(1e6), frames: fc.nat(1e9) });

describe('window.sim snapshot', () => {
  it('every field is finite, in display units and range; labels and enums are valid', () => {
    fc.assert(fc.property(stateArb, controls, fpsArb, fc.constantFrom(...MODES), fc.boolean(), (s, c, fps, cam, paused) => {
      const snap = buildSimSnapshot({ state: s, controls: c, fps, cameraMode: cam, paused });
      const nf = firstNonFinite(snap);
      if (nf) throw new Error(`non-finite ${nf}`);
      expect(['down', 'up', 'transit']).toContain(snap.gear);
      expect(LABELS.has(snap.state)).toBe(true);
      expect(snap.heading).toBeGreaterThanOrEqual(0);
      expect(snap.heading).toBeLessThanOrEqual(360);
      expect(snap.throttle).toBeGreaterThanOrEqual(0);
      expect(snap.throttle).toBeLessThanOrEqual(100);
      expect(Number.isInteger(snap.throttle)).toBe(true);
      expect(snap.flaps).toBeGreaterThanOrEqual(0);
      expect(snap.flaps).toBeLessThanOrEqual(30);
      expect(snap.airspeed).toBeGreaterThanOrEqual(0);
      expect(Math.abs(snap.airspeed - s.derived.ias * MS_TO_KT)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(Math.abs(snap.altitude - s.position.y * M_TO_FT)).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(snap.camera).toBe(cam);
      expect(snap.paused).toBe(paused);
      expect(['running', 'starting', 'off', 'failed']).toContain(snap.engine);
      expect(snap.gearHandle).toBe(c.gearDown ? 'down' : 'up');
      expect(snap.crash === null).toBe(s.crash === null);
      expect(snap.lastLanding === null).toBe(s.touchdown === null);
      // JSON round-trip (what page.evaluate hands a test tool) loses nothing: no undefined, NaN, functions or cycles.
      const json = JSON.stringify(snap);
      expect(JSON.stringify(JSON.parse(json))).toBe(json);
      expect(Object.keys(JSON.parse(json)).sort()).toEqual(Object.keys(snap).sort());
    }), fcParams(500));
  });

  it("state label: 'crashed' wins, 'stalled' only while airborne, otherwise the phase — and it matches physics' simStateLabel", () => {
    fc.assert(fc.property(stateArb, fc.boolean(), (s0, stalled) => {
      const s = { ...s0, stalled };
      const l = stateLabel(s);
      expect(l).toBe(simStateLabel(s));
      if (s.phase === 'crashed') expect(l).toBe('crashed');
      else if (s.phase === 'airborne' && stalled) expect(l).toBe('stalled');
      else expect(l).toBe(s.phase);
    }), fcParams(300));
  });

  it("gear: 'down' only when locked down, 'up' only when fully up, 'transit' in between", () => {
    fc.assert(fc.property(num(-0.5, 1.5), (p) => {
      const g = gearStateFromPos(p);
      if (p >= 0.999) return g === 'down';
      if (p <= 0.001) return g === 'up';
      return g === 'transit';
    }), fcParams(500));
  });

  it('installSimApi keeps one live object: updates are visible through an old reference, methods survive', () => {
    fc.assert(fc.property(fc.array(fc.tuple(stateArb, controls), { minLength: 1, maxLength: 5 }), (frames) => {
      const win = {} as unknown as Window;
      const calls: string[] = [];
      const api = installSimApi(win, {
        reset: () => calls.push('reset'), resetApproach: () => calls.push('approach'),
        setCamera: (m) => calls.push(`cam:${m}`), setPaused: (p) => calls.push(`pause:${p}`),
      });
      const sim = (win as unknown as { sim: Record<string, unknown> }).sim;
      expect(sim).toBe(api.object);
      const fps = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 };
      for (const [s, c] of frames) {
        const snap = buildSimSnapshot({ state: s, controls: c, fps, cameraMode: 'chase', paused: false });
        api.update(snap);
        expect(sim.altitude).toBe(snap.altitude);
        expect(sim.state).toBe(snap.state);
      }
      (sim.reset as () => void)();
      (sim.resetApproach as () => void)();
      (sim.setCamera as (m: CameraMode) => void)('orbit');
      (sim.pause as () => void)();
      (sim.resume as () => void)();
      expect(calls).toEqual(['reset', 'approach', 'cam:orbit', 'pause:true', 'pause:false']);
    }), fcParams(100));
  });
});

it('snapshots of the real reset states are plausible', () => {
  const fps = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 };
  const c = { throttle: 0, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true };
  const r = buildSimSnapshot({ state: createInitialState(), controls: c, fps, cameraMode: 'chase', paused: false });
  expect(r).toMatchObject({ state: 'ground', gear: 'down', flaps: 0, airspeed: 0, throttle: 0, engine: 'running', onGround: true });
  expect(r.heading === 0 || r.heading === 360).toBe(true);
  const a = buildSimSnapshot({ state: createApproachState(), controls: c, fps, cameraMode: 'chase', paused: false });
  expect(a.state).toBe('airborne');
  expect(a.altitude).toBeGreaterThan(600);
  expect(a.airspeed).toBeGreaterThan(65);
});
