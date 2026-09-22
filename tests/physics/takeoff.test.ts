/**
 * Functional: takeoff rotation the way a player flies it (full throttle, a
 * firm keyboard pull at Vr), as reported from the live build.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, RAD_TO_DEG } from '../../src/config';
import type { AircraftState } from '../../src/types';
import { createInitialState, defaultControls } from '../../src/physics';
import { fly, iasKt, RUNWAY_ENV } from './helpers';

const VR = CONFIG.aircraft.limits.vrKt;

function rollToVr(): AircraftState {
  return fly(createInitialState(RUNWAY_ENV), { ...defaultControls(), throttle: 1 }, 60, {
    env: RUNWAY_ENV,
    until: (x) => iasKt(x) >= VR,
  });
}

describe('takeoff rotation (functional)', () => {
  it('full throttle, at 55 KIAS elevator +1 for 1.0 s then +0.3: airborne within 5 s, ≤ 12° pitch on the wheels, no crash', () => {
    let s = rollToVr();
    const t0 = s.time;
    let maxPitchOnWheels = -Infinity;
    let airborneAt = -1;
    // (A yank-and-relax lifts off early and may settle back once before it flies away — as a real 172 does.)
    s = fly(s, (x) => ({ ...defaultControls(), throttle: 1, elevator: x.time - t0 < 1.0 ? 1 : 0.3 }), 20, {
      env: RUNWAY_ENV,
      each: (x) => {
        if (x.onGround || x.wheelContact.some(Boolean)) maxPitchOnWheels = Math.max(maxPitchOnWheels, x.derived.pitchDeg);
        if (airborneAt < 0 && x.phase === 'airborne') airborneAt = x.time - t0;
      },
      until: (x) => x.phase === 'crashed' || x.airborneTime > 3,
    });
    expect(s.crash).toBeNull();
    expect(s.phase).toBe('airborne'); // and it climbs away
    expect(s.position.y - s.derived.altitudeAGL).toBeCloseTo(0, 3);
    expect(airborneAt).toBeGreaterThan(0);
    expect(airborneAt).toBeLessThan(5);
    expect(maxPitchOnWheels).toBeLessThan(12);
  });

  it('a firm pull at Vr raises the nose at a 172-like rate (≈ 3–6 °/s, never a snap), lifting off at ≈ 8–10° pitch', () => {
    let s = rollToVr();
    let maxRateOnWheels = 0;
    let liftoffPitch = NaN;
    s = fly(s, { ...defaultControls(), throttle: 1, elevator: 0.8 }, 8, {
      env: RUNWAY_ENV,
      each: (x) => {
        if (x.wheelContact[1] || x.wheelContact[2]) maxRateOnWheels = Math.max(maxRateOnWheels, x.derived.q * RAD_TO_DEG);
        if (Number.isNaN(liftoffPitch) && x.phase === 'airborne') liftoffPitch = x.derived.pitchDeg;
      },
      until: (x) => x.phase === 'crashed' || x.airborneTime > 1,
    });
    expect(s.crash).toBeNull();
    expect(maxRateOnWheels).toBeGreaterThan(2);
    expect(maxRateOnWheels).toBeLessThan(8);
    expect(liftoffPitch).toBeGreaterThan(6);
    expect(liftoffPitch).toBeLessThan(12);
  });

  it('holding full back yoke through the rotation still lifts off without a tail-strike crash', () => {
    let s = rollToVr();
    s = fly(s, { ...defaultControls(), throttle: 1, elevator: 1 }, 6, {
      env: RUNWAY_ENV,
      until: (x) => x.phase === 'crashed' || x.airborneTime > 2,
    });
    expect(s.crash).toBeNull();
    expect(s.phase).toBe('airborne');
  });
});
