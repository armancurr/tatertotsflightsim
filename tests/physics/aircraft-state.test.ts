import { describe, it, expect } from 'vitest';
import { CONFIG, KT_TO_MS } from '../../src/config';
import type { Environment } from '../../src/types';
import {
  createInitialState, createApproachState, defaultControls, approachControls, step, simStateLabel, FLAT_ENV,
} from '../../src/physics';
import { runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { wrap180 } from '../../src/math/vec3';
import { DT, fly, deepFreeze, allFinite, iasKt, trimmed } from './helpers';

const A = CONFIG.aircraft;

describe('aircraft state', () => {
  it('createInitialState: on the runway-36 centreline, on its gear, engine idling, ready for takeoff', () => {
    const s = createInitialState();
    const rw = runwayFrame();
    expect(s.time).toBe(0);
    expect(s.phase).toBe('ground');
    expect(simStateLabel(s)).toBe('ground');
    expect(s.onGround).toBe(true);
    expect(s.wheelContact).toEqual([true, true, true]);
    for (const c of s.wheelCompression) {
      expect(c).toBeGreaterThan(0.02);
      expect(c).toBeLessThan(A.geometry.strutTravel);
    }
    const c = toRunwayCoords(s.position.x, s.position.z, rw);
    // Main wheels sit spawn.runwayStartOffset metres past the threshold (they are behind the CG).
    expect(c.along - A.geometry.leftMainWheel.z).toBeCloseTo(A.spawn.runwayStartOffset, 1);
    expect(Math.abs(c.across)).toBeLessThan(1e-6);
    expect(Math.abs(wrap180(s.derived.headingDeg - rw.headingDeg))).toBeLessThan(1e-6);
    expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(2);
    expect(Math.abs(s.derived.rollDeg)).toBeLessThan(1e-6);
    expect(s.derived.altitudeAGL).toBeGreaterThan(1.0);
    expect(s.derived.altitudeAGL).toBeLessThan(1.3);
    expect(s.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.angularVelocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(s.engine.running).toBe(true);
    expect(s.engine.starting).toBe(false);
    expect(s.engine.failed).toBe(false);
    expect(s.engine.rpm).toBeCloseTo(A.engine.idleRpm, 0);
    expect(s.engine.power).toBeCloseTo(A.engine.idlePower, 3);
    expect(s.flapsDeg).toBe(0);
    expect(s.gearPos).toBe(1);
    expect(s.stalled).toBe(false);
    expect(s.airborneTime).toBe(0);
    expect(s.touchdown).toBeNull();
    expect(s.crash).toBeNull();
    expect(s.derived.loadFactor).toBeCloseTo(1, 1);
    expect(allFinite(s)).toBe(true);
  });

  it('rests on its gear at spawn without bouncing', () => {
    const s0 = createInitialState();
    let maxVy = 0;
    const s = fly(s0, defaultControls(), 3, { each: (s) => { maxVy = Math.max(maxVy, Math.abs(s.velocity.y)); } });
    expect(maxVy).toBeLessThan(0.02);
    expect(Math.abs(s.derived.pitchDeg - s0.derived.pitchDeg)).toBeLessThan(0.2);
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(0.2);
    expect(s.phase).toBe('ground');
    expect(s.wheelContact).toEqual([true, true, true]);
  });

  it('spawns on the terrain height the environment reports', () => {
    const env: Environment = { ...FLAT_ENV, groundHeight: () => 30 };
    const s = createInitialState(env);
    expect(s.position.y - 30).toBeCloseTo(createInitialState().position.y, 6);
    const after = fly(s, defaultControls(), 1, { env });
    expect(Math.abs(after.velocity.y)).toBeLessThan(0.02);
  });

  it('defaultControls: idle, centred, flaps up, gear down, brakes off, engine on', () => {
    expect(defaultControls()).toEqual({
      throttle: 0, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0,
      gearDown: true, brake: 0, parkingBrake: false, engineOn: true,
    });
  });

  it('step returns a new state and never mutates its inputs', () => {
    for (const s0 of [createInitialState(), createApproachState()]) {
      const snapshot = JSON.stringify(s0);
      const c = deepFreeze({ ...defaultControls(), throttle: 1, elevator: 0.3, aileron: -0.2, rudder: 0.1 });
      const frozen = deepFreeze(JSON.parse(snapshot));
      const s1 = step(frozen, c, DT);
      expect(s1).not.toBe(frozen);
      expect(JSON.stringify(frozen)).toBe(snapshot);
      expect(s1.time).toBeCloseTo(DT, 12);
    }
  });

  it('is deterministic: the same inputs give bit-identical states', () => {
    const run = () => fly(createInitialState(), (s) => ({
      ...defaultControls(), throttle: 1, elevator: iasKt(s) > 55 ? 0.5 : 0, rudder: Math.sin(s.time) * 0.2,
    }), 25);
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it('handles odd time steps: dt 0 changes nothing, a long dt is sub-stepped', () => {
    const s0 = createInitialState();
    expect(step(s0, defaultControls(), 0)).toEqual(s0);
    const { state, controls } = trimmed({ iasKt: 90 });
    const big = step(state, controls, 0.1);
    let small = state;
    for (let i = 0; i < 12; i++) small = step(small, controls, 0.1 / 12);
    expect(big.position.z).toBeCloseTo(small.position.z, 6);
    expect(allFinite(big)).toBe(true);
  });

  it('flaps run at the motor rate to the selected notch; the gear takes transitTime and only counts when locked', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 80 });
    const notch = A.flaps.notchesDeg[3];
    let s = fly(state, { ...controls, flapsNotch: 3 }, 1);
    expect(s.flapsDeg).toBeCloseTo(A.flaps.rateDegPerSec * 1, 1);
    s = fly(s, { ...controls, flapsNotch: 3 }, notch / A.flaps.rateDegPerSec);
    expect(s.flapsDeg).toBe(notch);
    let g = fly(state, { ...controls, gearDown: false }, A.gear.transitTime / 2);
    expect(g.gearPos).toBeCloseTo(0.5, 2);
    g = fly(g, { ...controls, gearDown: false }, A.gear.transitTime / 2 + 0.1);
    expect(g.gearPos).toBe(0);
    g = fly(g, { ...controls, gearDown: true }, A.gear.transitTime - 0.5);
    expect(g.gearPos).toBeLessThan(0.999);
    g = fly(g, { ...controls, gearDown: true }, 0.6);
    expect(g.gearPos).toBe(1);
  });

  it('simStateLabel layers stalled on top of airborne and reports crashed', () => {
    const { state } = trimmed();
    expect(simStateLabel(state)).toBe('airborne');
    expect(simStateLabel({ ...state, stalled: true })).toBe('stalled');
    expect(simStateLabel({ ...state, phase: 'landed' })).toBe('landed');
    expect(simStateLabel({ ...state, phase: 'crashed', stalled: true })).toBe('crashed');
  });

  it('createApproachState: on final for runway 36, gear down, approach flaps, ~72 KIAS on a ~3° glide', () => {
    const s = createApproachState();
    const rw = runwayFrame();
    const ap = A.spawn.approach;
    const c = toRunwayCoords(s.position.x, s.position.z, rw);
    expect(c.along).toBeCloseTo(-ap.distance, 0);
    expect(c.across).toBeCloseTo(0, 6);
    expect(s.position.y).toBeCloseTo(ap.height, 0);
    expect(s.phase).toBe('airborne');
    expect(s.gearPos).toBe(1);
    expect(s.flapsDeg).toBe(A.flaps.notchesDeg[ap.flapsNotch]);
    expect(iasKt(s)).toBeCloseTo(ap.speedKt, 0);
    const gamma = Math.atan2(s.velocity.y, Math.hypot(s.velocity.x, s.velocity.z)) * 180 / Math.PI;
    expect(gamma).toBeLessThan(-2.5);
    expect(gamma).toBeGreaterThan(-3.5);
    expect(s.engine.running).toBe(true);
    const ctl = approachControls();
    expect(ctl.gearDown).toBe(true);
    expect(ctl.flapsNotch).toBe(ap.flapsNotch);
    expect(ctl.throttle).toBeGreaterThan(0.15);
    expect(ctl.throttle).toBeLessThan(0.8);
    expect(Math.abs(ctl.elevatorTrim)).toBeLessThanOrEqual(1);
    expect(ctl.elevator).toBe(0);
  });

  it('approachControls hold the approach state roughly hands-off (speed and glide stay put for 20 s)', () => {
    const s0 = createApproachState();
    const s = fly(s0, approachControls(), 20);
    expect(Math.abs(iasKt(s) - A.spawn.approach.speedKt)).toBeLessThan(3);
    expect(s.velocity.y).toBeLessThan(-1.2);
    expect(s.velocity.y).toBeGreaterThan(-2.8);
    expect(Math.abs(s.derived.rollDeg)).toBeLessThan(5);
    expect(s.velocity.z).toBeLessThan(-30 * KT_TO_MS * 1.9);
  });
});

describe('reset', () => {
  it('createInitialState after a crash gives back a clean, ready-to-fly aircraft', () => {
    const { state, controls } = trimmed({ altitudeM: 60, iasKt: 100 });
    const crashed = fly({ ...state, orientation: state.orientation }, { ...controls, elevator: -1 }, 30, {
      until: (s) => s.phase === 'crashed',
    });
    expect(crashed.phase).toBe('crashed');
    const fresh = createInitialState();
    expect(fresh).toEqual(createInitialState());
    expect(fresh.phase).toBe('ground');
    expect(fresh.crash).toBeNull();
    expect(fresh.engine.failed).toBe(false);
    expect(fresh.engine.running).toBe(true);
    // And it flies again.
    const rolling = fly(fresh, { ...defaultControls(), throttle: 1 }, 5);
    expect(rolling.derived.groundSpeed).toBeGreaterThan(5);
  });
});
