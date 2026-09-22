import { describe, it, expect } from 'vitest';
import { CONFIG } from '../../src/config';
import { createInitialState, defaultControls, propThrust, powerTarget } from '../../src/physics';
import { fly } from './helpers';

const E = CONFIG.aircraft.engine;

describe('throttle and engine', () => {
  const parked = { ...defaultControls(), parkingBrake: true };

  it('engine power lags the throttle, then converges on the target', () => {
    let s = createInitialState();
    const c = { ...parked, throttle: 1 };
    const target = powerTarget(1, s.derived.density);
    expect(target).toBeCloseTo(1, 2);
    s = fly(s, c, 0.2);
    expect(s.engine.power).toBeGreaterThan(E.idlePower);
    expect(s.engine.power).toBeLessThan(0.5 * target);
    s = fly(s, c, 6);
    expect(s.engine.power).toBeCloseTo(target, 2);
    expect(s.engine.rpm).toBeGreaterThan(E.maxRpm * 0.95);
  });

  it('power spools down with lag when the throttle is cut', () => {
    let s = fly(createInitialState(), { ...parked, throttle: 1 }, 6);
    s = fly(s, { ...parked, throttle: 0 }, 0.15);
    expect(s.engine.power).toBeGreaterThan(0.5);
    s = fly(s, { ...parked, throttle: 0 }, 6);
    expect(s.engine.power).toBeCloseTo(powerTarget(0, s.derived.density), 3);
    expect(Math.abs(s.engine.rpm - E.idleRpm)).toBeLessThan(10);
  });

  it('static thrust matches the config and thrust falls off with airspeed', () => {
    expect(propThrust(1, 0, 1.225)).toBeCloseTo(E.staticThrustN, 0);
    let prev = Infinity;
    for (let v = 0; v <= 80; v += 5) {
      const t = propThrust(1, v, 1.225);
      expect(t).toBeLessThan(prev);
      prev = t;
    }
    // At idle and speed, the windmilling prop makes net drag (negative thrust).
    expect(propThrust(E.idlePower, 36, 1.225)).toBeLessThan(0);
  });

  it('thrust is monotonic in throttle at every airspeed', () => {
    for (const v of [0, 15, 30, 45, 60, 75]) {
      let prev = -Infinity;
      for (let thr = 0; thr <= 1.0001; thr += 0.05) {
        const t = propThrust(powerTarget(thr, 1.225), v, 1.225);
        expect(t).toBeGreaterThan(prev);
        prev = t;
      }
    }
  });

  it('the state thrust grows with the throttle lever', () => {
    const thrusts = [0, 0.25, 0.5, 0.75, 1].map((t) => fly(createInitialState(), { ...parked, throttle: t }, 5).engine.thrust);
    for (let i = 1; i < thrusts.length; i++) expect(thrusts[i]).toBeGreaterThan(thrusts[i - 1]);
    expect(thrusts[4]).toBeGreaterThan(0.9 * E.staticThrustN);
  });

  it('engine off: power decays to zero and the propeller spins down', () => {
    let s = fly(createInitialState(), { ...parked, throttle: 0.6 }, 4);
    s = fly(s, { ...parked, throttle: 0.6, engineOn: false }, 0.1);
    expect(s.engine.running).toBe(false);
    s = fly(s, { ...parked, throttle: 0.6, engineOn: false }, 8);
    expect(s.engine.power).toBeLessThan(0.001);
    expect(s.engine.rpm).toBeLessThan(50); // parked: no windmilling
    expect(s.engine.thrust).toBeCloseTo(0, 1);
  });

  it('engine on again: cranks for startTime, then runs', () => {
    let s = fly(createInitialState(), { ...parked, engineOn: false }, 8);
    const on = { ...parked, engineOn: true };
    s = fly(s, on, 0.1);
    expect(s.engine.starting).toBe(true);
    expect(s.engine.running).toBe(false);
    expect(s.engine.power).toBe(0);
    s = fly(s, on, E.startTime - 0.3);
    expect(s.engine.starting).toBe(true);
    expect(s.engine.rpm).toBeGreaterThan(50); // starter turning the prop
    s = fly(s, on, 0.5);
    expect(s.engine.starting).toBe(false);
    expect(s.engine.running).toBe(true);
    s = fly(s, on, 3);
    expect(s.engine.rpm).toBeCloseTo(E.idleRpm, -1);
  });

  it('a failed engine never restarts', () => {
    const s0 = createInitialState();
    const failed = { ...s0, engine: { ...s0.engine, failed: true, running: false, power: 0 } };
    const s = fly(failed, { ...parked, engineOn: true, throttle: 1 }, 5);
    expect(s.engine.running).toBe(false);
    expect(s.engine.starting).toBe(false);
    expect(s.engine.power).toBe(0);
  });
});
