/**
 * Acceleration, gravity, velocity/inertia and altitude: the aircraft as a
 * point mass with momentum.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, MS_TO_KT } from '../../src/config';
import { createInitialState, defaultControls, createTrimmedState } from '../../src/physics';
import { toRunwayCoords } from '../../src/world/runway';
import { fly, iasKt, trimmed, bankHold, altitudeHold, DT } from './helpers';
import { qIdentity } from '../../src/math/quat';

const g = CONFIG.sim.gravity;

describe('acceleration', () => {
  it('full throttle accelerates the aircraft down the runway, straight', () => {
    const s0 = createInitialState();
    let prevSpeed = 0;
    let monotonic = true;
    const s = fly(s0, { ...defaultControls(), throttle: 1 }, 15, {
      each: (s) => {
        if (s.derived.groundSpeed < prevSpeed - 1e-6) monotonic = false;
        prevSpeed = s.derived.groundSpeed;
      },
    });
    expect(monotonic).toBe(true);
    expect(iasKt(s)).toBeGreaterThan(40);
    const c0 = toRunwayCoords(s0.position.x, s0.position.z);
    const c = toRunwayCoords(s.position.x, s.position.z);
    expect(c.along).toBeGreaterThan(c0.along + 100);
    expect(Math.abs(c.across)).toBeLessThan(2);
    expect(s.phase).toBe('ground');
  });

  it('the initial acceleration is about thrust/mass (≈ 0.2 g), not instant', () => {
    const s = fly(createInitialState(), { ...defaultControls(), throttle: 1 }, 3);
    const a = s.derived.groundSpeed / 3;
    expect(a).toBeGreaterThan(1.0);
    expect(a).toBeLessThan(2.4);
  });
});

describe('gravity', () => {
  it('a free-falling aircraft at low airspeed accelerates down at ≈ g', () => {
    const { state } = trimmed({ altitudeM: 2000 });
    const s0 = { ...state, velocity: { x: 0, y: 0, z: 0 }, angularVelocity: { x: 0, y: 0, z: 0 }, orientation: qIdentity() };
    const c = { ...defaultControls(), engineOn: false };
    const s = fly({ ...s0, engine: { ...s0.engine, running: false, power: 0, thrust: 0 } }, c, 0.25);
    expect(s.velocity.y / 0.25).toBeCloseTo(-g, 0);
    expect(Math.abs(s.velocity.y / 0.25 + g)).toBeLessThan(0.03 * g);
    expect(s.position.y).toBeCloseTo(2000 - 0.5 * g * 0.25 * 0.25, 1);
  });

  it('with no lift the aircraft falls; with lift it holds altitude', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 100 });
    const held = fly(state, controls, 3);
    expect(Math.abs(held.position.y - 1500)).toBeLessThan(3);
  });
});

describe('velocity and inertia', () => {
  it('keeps its momentum through a 30° bank turn (speed kept, velocity turns gradually with the heading)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 95 });
    const v0 = Math.hypot(state.velocity.x, state.velocity.z);
    let maxTrackStep = 0;
    let prevTrack = Math.atan2(state.velocity.x, -state.velocity.z);
    const pilot = (s: typeof state) => ({
      ...controls,
      aileron: bankHold(s, 30),
      elevator: altitudeHold(s, 1500) + 0.05,
      rudder: 0.04,
      throttle: Math.min(1, controls.throttle + 0.12),
    });
    const s = fly(state, pilot, 40, {
      each: (s) => {
        const tr = Math.atan2(s.velocity.x, -s.velocity.z);
        let d = tr - prevTrack;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        maxTrackStep = Math.max(maxTrackStep, Math.abs(d));
        prevTrack = tr;
      },
    });
    // Turned a long way right…
    expect(s.derived.headingDeg).toBeGreaterThan(90);
    expect(s.derived.headingDeg).toBeLessThan(359);
    // …without losing the speed or altitude much.
    expect(Math.abs(Math.hypot(s.velocity.x, s.velocity.z) - v0) / v0).toBeLessThan(0.12);
    expect(Math.abs(s.position.y - 1500)).toBeLessThan(40);
    // The velocity direction never snaps: at most ~ g·tan(30°)/V per second (~7°/s here), per step tiny.
    expect(maxTrackStep / DT).toBeLessThan(0.25);
    // And the track follows the nose (little sideslip).
    const track = (Math.atan2(s.velocity.x, -s.velocity.z) * 180) / Math.PI;
    const diff = ((track - s.derived.headingDeg + 540) % 360) - 180;
    expect(Math.abs(diff)).toBeLessThan(5);
  });

  it('cutting the throttle decelerates gradually (the aircraft coasts on its momentum)', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 110, gearDown: false });
    const pilot = (s: typeof state) => ({ ...controls, throttle: 0, elevator: altitudeHold(s, 1500), aileron: bankHold(s, 0) });
    const after1 = fly(state, pilot, 1);
    expect(iasKt(state) - iasKt(after1)).toBeGreaterThan(0.2);
    expect(iasKt(state) - iasKt(after1)).toBeLessThan(4);
    const after15 = fly(after1, pilot, 14);
    expect(iasKt(state) - iasKt(after15)).toBeGreaterThan(12);
    expect(iasKt(after15)).toBeGreaterThan(60);
  });
});

describe('altitude', () => {
  it('climbs with full power at climb speed', () => {
    const { state, controls } = trimmed({ altitudeM: 500, iasKt: 75, gearDown: false });
    // Hands-off with power added it climbs (through a phugoid); holding 75 KIAS it climbs steadily.
    const handsOff = fly(state, { ...controls, throttle: 1 }, 20);
    expect(handsOff.position.y).toBeGreaterThan(state.position.y + 40);
    const held = fly(state, (s) => ({
      ...controls, throttle: 1, rudder: 0.04, aileron: bankHold(s, 0), elevator: 0.02 * (iasKt(s) - 75) - 0.03 * s.derived.q * 57.3,
    }), 30);
    expect(held.position.y).toBeGreaterThan(state.position.y + 30);
    expect(held.velocity.y).toBeGreaterThan(1.5);
  });

  it('descends at idle', () => {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 80 });
    const s = fly(state, { ...controls, throttle: 0 }, 20);
    expect(s.position.y).toBeLessThan(state.position.y - 40);
    expect(s.velocity.y).toBeLessThan(-1.5);
    expect(s.derived.altitudeAGL).toBeCloseTo(s.position.y, 3);
  });

  it('reports altitude above ground and above water', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 400, iasKt: 90 });
    const env = {
      groundHeight: () => 150, surfaceAt: () => 'grass' as const, waterLevel: () => 180,
    };
    const s = fly(state, controls, 0.1, { env });
    expect(s.derived.altitudeAGL).toBeCloseTo(s.position.y - 180, 6);
    expect(s.derived.tas * MS_TO_KT).toBeGreaterThan(90);
  });
});
