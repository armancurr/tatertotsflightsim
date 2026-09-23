/**
 * F-16 aerodynamics: speed of sound and Mach number from the ISA temperature, the transonic drag
 * rise, the high-α lift curve (vortex lift, CLmax ≈ 1.6 at 30–35°), the speed brake, and no
 * propeller effects (prop wash / P-factor). The Cessna is unaffected by Mach.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, F16_AIRCRAFT, RAD_TO_DEG } from '../../src/config';
import { computeAero, dragCoefficient, liftCoefficient, machDragFactor, machNumber, speedOfSound, temperatureK } from '../../src/physics';
import { F16_CFG, trimmed } from './helpers';

const D = Math.PI / 180;
const NO_CTL = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };
const bodyVel = (V: number, a: number) => ({ x: 0, y: -V * Math.sin(a), z: -V * Math.cos(a) });

describe('atmosphere: temperature and the speed of sound', () => {
  it('ISA: 288.15 K / 340.3 m/s at sea level, 216.65 K / 295.1 m/s from the tropopause up', () => {
    expect(temperatureK(0)).toBeCloseTo(288.15, 2);
    expect(speedOfSound(0)).toBeCloseTo(340.3, 0);
    expect(temperatureK(11000)).toBeCloseTo(216.65, 2);
    expect(speedOfSound(11000)).toBeCloseTo(295.1, 0);
    expect(speedOfSound(15000)).toBeCloseTo(295.1, 0);
    expect(speedOfSound(5000)).toBeCloseTo(320.5, 0);
  });
  it('fuzz: finite, positive, monotonically non-increasing with altitude', () => {
    fc.assert(fc.property(fc.double({ min: -1000, max: 40000, noNaN: true }), fc.double({ min: 0, max: 5000, noNaN: true }), (h, dh) => {
      const a = speedOfSound(h);
      return Number.isFinite(a) && a > 250 && speedOfSound(h + dh) <= a + 1e-9;
    }));
    expect(Number.isFinite(speedOfSound(NaN))).toBe(true);
  });
  it('machNumber(state) = TAS / a(altitude)', () => {
    const { state } = trimmed({ altitudeM: 3000, iasKt: 400, gearDown: false }, F16_CFG);
    expect(machNumber(state)).toBeCloseTo(state.derived.tas / speedOfSound(3000), 6);
  });
});

describe('transonic drag rise (F-16)', () => {
  it('CD0 factor: 1 subsonic, roughly doubles between M 0.95 and 1.1, peaks near 1.1, eases toward M 2', () => {
    expect(machDragFactor(0.5, F16_CFG)).toBe(1);
    expect(machDragFactor(0.8, F16_CFG)).toBe(1);
    expect(machDragFactor(0.95, F16_CFG)).toBeGreaterThan(1.2);
    expect(machDragFactor(1.1, F16_CFG)).toBeGreaterThan(2);
    expect(machDragFactor(1.1, F16_CFG)).toBeLessThan(2.6);
    expect(machDragFactor(2, F16_CFG)).toBeLessThan(machDragFactor(1.1, F16_CFG));
    expect(machDragFactor(2, F16_CFG)).toBeGreaterThan(1.4);
    // Continuous (no jumps).
    for (let m = 0; m < 2.5; m += 0.001) expect(Math.abs(machDragFactor(m + 0.001, F16_CFG) - machDragFactor(m, F16_CFG))).toBeLessThan(0.01);
  });
  it('shows up in the drag coefficient; the Cessna ignores Mach', () => {
    const lo = dragCoefficient(2 * D, 0, 0, 0, F16_CFG, undefined, 0.6);
    const hi = dragCoefficient(2 * D, 0, 0, 0, F16_CFG, undefined, 1.1);
    expect(hi - lo).toBeGreaterThan(0.018);
    expect(dragCoefficient(4 * D, 0, 0, 0, CONFIG, undefined, 0.9)).toBe(dragCoefficient(4 * D, 0, 0, 0, CONFIG));
  });
});

describe('F-16 lift curve', () => {
  it('CLα ≈ 3.5 / rad at low α', () => {
    const slope = (liftCoefficient(6 * D, 0, F16_CFG) - liftCoefficient(2 * D, 0, F16_CFG)) / (4 * D);
    expect(slope).toBeGreaterThan(3.2);
    expect(slope).toBeLessThan(3.8);
  });
  it('vortex lift: CLmax ≈ 1.6 at 30–35° α, and lift still ~1.3+ at 45°', () => {
    let best = { a: 0, cl: -Infinity };
    for (let a = 0; a <= 60; a += 0.25) {
      const cl = liftCoefficient(a * D, 0, F16_CFG);
      if (cl > best.cl) best = { a, cl };
    }
    expect(best.cl).toBeGreaterThan(1.5);
    expect(best.cl).toBeLessThan(1.7);
    expect(best.a).toBeGreaterThanOrEqual(29);
    expect(best.a).toBeLessThanOrEqual(35);
    expect(liftCoefficient(20 * D, 0, F16_CFG)).toBeGreaterThan(1.1);
    expect(liftCoefficient(45 * D, 0, F16_CFG)).toBeGreaterThan(1.2);
  });
});

describe('F-16 airframe forces', () => {
  it('the speed brake adds significant drag', () => {
    const v = bodyVel(150, 3 * D);
    const out = computeAero(v, { x: 0, y: 0, z: 0 }, 1.0, 0, 0, NO_CTL, 0, F16_CFG, Infinity, { speedBrake: 1 });
    const inn = computeAero(v, { x: 0, y: 0, z: 0 }, 1.0, 0, 0, NO_CTL, 0, F16_CFG, Infinity, { speedBrake: 0 });
    expect(out.CD - inn.CD).toBeCloseTo(F16_AIRCRAFT.aero.cdSpeedBrake, 6);
    expect(out.drag / inn.drag).toBeGreaterThan(2);
    // The Cessna has none.
    const c1 = computeAero(bodyVel(50, 3 * D), { x: 0, y: 0, z: 0 }, 1.0, 0, 0, NO_CTL, 0, CONFIG, Infinity, { speedBrake: 1 });
    const c0 = computeAero(bodyVel(50, 3 * D), { x: 0, y: 0, z: 0 }, 1.0, 0, 0, NO_CTL, 0, CONFIG);
    expect(c1.CD).toBe(c0.CD);
  });
  it('no propeller effects: thrust changes neither lift nor roll/yaw (no prop wash, no P-factor); pitch only by the thrust line', () => {
    const v = bodyVel(80, 12 * D);
    const w = { x: 0.1, y: -0.05, z: 0.2 };
    const ctl = { elevator: 0.3, aileron: 0.2, rudder: -0.3, elevatorTrim: 0 };
    const a0 = computeAero(v, w, 1.1, 20, 1, ctl, 0, F16_CFG);
    const a1 = computeAero(v, w, 1.1, 20, 1, ctl, 120000, F16_CFG);
    const tp = F16_AIRCRAFT.engine.jet!.thrustPoint;
    expect(a1.tx - a0.tx).toBeCloseTo(-tp.y * 120000, 3); // nozzle below the CG → nose-up
    expect(Math.abs(tp.y)).toBeLessThan(0.5);
    expect(a1.ty).toBeCloseTo(a0.ty, 6);
    expect(a1.tz).toBeCloseTo(a0.tz, 6);
    expect(a1.lift).toBeCloseTo(a0.lift, 6);
    expect(a0.fz - a1.fz).toBeCloseTo(120000, 3);
  });
  it('the ground-effect/strip/crossflow additions stay finite at any attitude (fuzz)', () => {
    fc.assert(fc.property(
      fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }), fc.double({ min: 0, max: 700, noNaN: true }), fc.double({ min: 0, max: 2.3, noNaN: true }),
      (a, V, mach) => {
        const r = computeAero(bodyVel(V, a), { x: 0.5, y: -0.3, z: 1 }, 0.8, 20, 1, { elevator: 1, aileron: -1, rudder: 1, elevatorTrim: 0 }, 50000, F16_CFG, 3, { mach, speedBrake: 1 });
        return [r.fx, r.fy, r.fz, r.tx, r.ty, r.tz, r.CL, r.CD].every(Number.isFinite) && r.alpha * RAD_TO_DEG <= 180;
      },
    ), { numRuns: 300 });
  });
});
