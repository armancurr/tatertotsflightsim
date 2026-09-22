/**
 * Landing state: touchdown detection and rating, landing crashes, bounces,
 * touch-and-go, and a full approach flown hands-off with a simple flare.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import {
  classifyTouchdown, createApproachState, approachControls, createInitialState, defaultControls,
} from '../../src/physics';
import { quatFromEuler, bodyToWorld } from '../../src/physics/frames';
import { runwayFrame, toRunwayCoords, fromRunwayCoords } from '../../src/world/runway';
import { clamp } from '../../src/math/vec3';
import { fly, trimmed, iasKt, RUNWAY_ENV, headingError, bankHold, pitchHold, DT } from './helpers';

const G = CONFIG.aircraft.geometry;
const L = CONFIG.aircraft.landing;

/** A flared aircraft at 60 KIAS just above the runway (main wheels `gap` m up), sinking at `fpm`. */
function flaredOver(fpm: number, opts: { bank?: number; pitch?: number; gap?: number; along?: number; across?: number } = {}) {
  const { state, controls } = trimmed({ altitudeM: 30, iasKt: 60, flapsNotch: 1 });
  // Keep the trimmed angle of attack on the new, descending flight path (so lift still ≈ weight).
  const gammaDeg = (Math.atan2(fpm / 196.8504, state.derived.tas) * 180) / Math.PI;
  const pitch = opts.pitch ?? state.derived.pitchDeg + gammaDeg;
  const q = quatFromEuler(0, pitch, opts.bank ?? 0);
  const p = fromRunwayCoords(opts.along ?? 400, opts.across ?? 0);
  let low = Infinity;
  for (const w of [G.noseWheel, G.leftMainWheel, G.rightMainWheel]) low = Math.min(low, bodyToWorld(q, w).y);
  const s: AircraftState = {
    ...state,
    orientation: q,
    position: { x: p.x, y: (opts.gap ?? 0.12) - low, z: p.z },
    velocity: { ...state.velocity, y: fpm / 196.8504 },
    airborneTime: 20,
  };
  return { state: s, controls: { ...controls, throttle: 0 } };
}

describe('landing state', () => {
  it('classifies touchdowns by vertical speed', () => {
    expect(classifyTouchdown(-60)).toBe('butter');
    expect(classifyTouchdown(-L.butterFpm)).toBe('butter');
    expect(classifyTouchdown(-250)).toBe('smooth');
    expect(classifyTouchdown(-450)).toBe('firm');
    expect(classifyTouchdown(-700)).toBe('hard');
    expect(classifyTouchdown(-L.hardFpm)).toBe('hard');
    expect(classifyTouchdown(-L.hardFpm - 1)).toBe('crash');
    expect(classifyTouchdown(700)).toBe('hard'); // magnitude
  });

  it('a ~300 fpm touchdown on the runway: phase "landed", a rating and a TouchdownRecord', () => {
    const { state, controls } = flaredOver(-290, { across: 3 });
    const s = fly(state, controls, 3, { env: RUNWAY_ENV });
    expect(s.phase).toBe('landed');
    const td = s.touchdown!;
    expect(td).not.toBeNull();
    expect(Math.abs(td.verticalSpeedFpm + 290)).toBeLessThan(30);
    expect(td.rating).toBe(classifyTouchdown(td.verticalSpeedFpm));
    expect(['smooth', 'firm']).toContain(td.rating);
    expect(td.onRunway).toBe(true);
    expect(td.surface).toBe('runway');
    expect(td.centerlineOffsetM!).toBeCloseTo(3, 0);
    expect(td.airspeedKt).toBeGreaterThan(50);
    expect(td.airspeedKt).toBeLessThan(70);
    expect(Math.abs(td.bankDeg)).toBeLessThan(1);
    expect(td.pitchDeg).toBeGreaterThan(0);
    expect(td.time).toBeGreaterThan(state.time);
  });

  it('a ~700 fpm arrival is rated "hard" but the gear holds', () => {
    const { state, controls } = flaredOver(-700);
    const s = fly(state, controls, 3, { env: RUNWAY_ENV });
    expect(s.phase).toBe('landed');
    expect(s.touchdown!.rating).toBe('hard');
  });

  it('more than 900 fpm collapses the gear: crash', () => {
    const { state, controls } = flaredOver(-1100);
    const s = fly(state, controls, 3, { env: RUNWAY_ENV });
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toBe('Hard landing — gear collapsed');
    expect(s.crash!.verticalSpeedFpm).toBeLessThan(-900);
  });

  it('touching down in a steep bank or nose-first is a crash', () => {
    const banked = flaredOver(-200, { bank: 20, gap: 0.05 });
    const b = fly(banked.state, banked.controls, 3, { env: RUNWAY_ENV });
    expect(b.phase).toBe('crashed');
    const nose = flaredOver(-300, { pitch: -8, gap: 0.05 });
    const n = fly(nose.state, nose.controls, 3, { env: RUNWAY_ENV });
    expect(n.phase).toBe('crashed');
    expect(n.crash!.reason).toMatch(/nose|Prop/i);
  });

  it('a touchdown off the runway is recorded as such', () => {
    const { state, controls } = flaredOver(-200, { across: 60 });
    const s = fly(state, controls, 3, { env: RUNWAY_ENV });
    expect(s.phase).toBe('landed');
    expect(s.touchdown!.onRunway).toBe(false);
    expect(s.touchdown!.surface).toBe('grass');
    expect(s.touchdown!.centerlineOffsetM).toBeNull();
  });

  it('a short bounce does not re-rate the landing; a touch-and-go flies away', () => {
    const { state, controls } = flaredOver(-250);
    let s = fly(state, controls, 2, { env: RUNWAY_ENV });
    expect(s.phase).toBe('landed');
    const first = s.touchdown!;
    // A small hop: airborne for well under minAirborneTime.
    const hop = { ...s, position: { ...s.position, y: s.position.y + 0.25 }, velocity: { ...s.velocity, y: 0.6 } };
    let wasAirborne = false;
    s = fly(hop, controls, 2, { env: RUNWAY_ENV, each: (x) => { if (x.phase === 'airborne') wasAirborne = true; } });
    expect(wasAirborne).toBe(true);
    expect(s.phase).toBe('landed');
    expect(s.touchdown).toEqual(first);
    // Touch-and-go: full power, rotate at 55 KIAS to ~8° nose-up, fly off.
    s = fly(s, (x) => ({ ...controls, throttle: 1, elevator: pitchHold(x, iasKt(x) > 55 ? 8 : 0), aileron: bankHold(x, 0), flapsNotch: 1 }), 20, { env: RUNWAY_ENV });
    expect(s.phase).toBe('airborne');
    expect(s.airborneTime).toBeGreaterThan(3);
    expect(s.touchdown).toEqual(first);
  });

  it('a takeoff goes ground → airborne and airborneTime accumulates', () => {
    let s = createInitialState(RUNWAY_ENV);
    s = fly(s, (x) => ({ ...defaultControls(), throttle: 1, elevator: pitchHold(x, iasKt(x) > 55 ? 8 : 0), aileron: bankHold(x, 0) }), 40, {
      env: RUNWAY_ENV,
      until: (x) => x.airborneTime > 5,
    });
    expect(s.phase).toBe('airborne');
    expect(s.onGround).toBe(false);
    expect(s.wheelContact).toEqual([false, false, false]);
    expect(s.airborneTime).toBeGreaterThan(5);
    expect(s.touchdown).toBeNull();
  });

  it('from createApproachState, hands-off with a simple flare, it touches down on the runway and ends "landed"', () => {
    const rw = runwayFrame();
    const base = approachControls();
    let integ = 0;
    const pilot = (s: AircraftState): Controls => {
      const c = { ...base };
      // Lateral: a gentle wing-leveller that tracks the centreline.
      const { across } = toRunwayCoords(s.position.x, s.position.z, rw);
      const wantHdg = clamp(-across * 0.15, -8, 8);
      c.aileron = bankHold(s, clamp((wantHdg - headingError(s, rw.headingDeg)) * 1.5, -8, 8));
      // After touchdown: idle, hold the yoke back a little, brake once the nosewheel is down.
      if (s.touchdown) return { ...c, throttle: 0, elevator: 0.2, brake: s.wheelContact[0] ? 1 : 0, aileron: 0 };
      // Longitudinal: hands off (trimmed) until the flare, then ease the sink rate off and close the throttle.
      const h = s.derived.altitudeAGL - 1.2; // main wheels above the runway
      if (h < 6) {
        const err = -Math.max(0.3, 0.3 * h) - s.velocity.y;
        integ = clamp(integ + DT * 0.25 * err, -0.2, 0.8);
        c.elevator = clamp(0.15 * err + integ - 0.03 * s.derived.q * RAD_TO_DEG, -0.3, 1);
        c.throttle = base.throttle * clamp(h / 6, 0, 1);
      }
      return c;
    };
    const s = fly(createApproachState(RUNWAY_ENV), pilot, 240, {
      env: RUNWAY_ENV,
      until: (x) => x.phase === 'crashed' || (x.phase === 'landed' && x.derived.groundSpeed < 1),
    });
    expect(s.crash).toBeNull();
    expect(s.phase).toBe('landed');
    const td = s.touchdown!;
    expect(td.onRunway).toBe(true);
    expect(Math.abs(td.centerlineOffsetM!)).toBeLessThan(10);
    expect(['butter', 'smooth', 'firm']).toContain(td.rating);
    const c = toRunwayCoords(s.position.x, s.position.z, rw);
    expect(c.along).toBeGreaterThan(0);
    expect(c.along).toBeLessThan(rw.length);
    expect(Math.abs(td.bankDeg)).toBeLessThan(5);
    expect(s.derived.alpha * RAD_TO_DEG).toBeLessThan(20);
  });
});
