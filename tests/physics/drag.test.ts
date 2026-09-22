import { describe, it, expect } from 'vitest';
import { CONFIG } from '../../src/config';
import { dragCoefficient, stallAlphaRad, computeAero } from '../../src/physics';

const D = Math.PI / 180;
const NO_CONTROLS = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };
const bodyVel = (V: number, alpha: number) => ({ x: 0, y: -V * Math.sin(alpha), z: -V * Math.cos(alpha) });

describe('drag', () => {
  it('is close to the zero-lift drag near zero lift, clean and gear up', () => {
    const cd = dragCoefficient(0, 0, 0, 0);
    expect(cd).toBeGreaterThan(CONFIG.aircraft.aero.cd0);
    expect(cd).toBeLessThan(CONFIG.aircraft.aero.cd0 + 0.02);
  });

  it('grows with angle of attack (induced drag), and keeps growing through the stall', () => {
    let prev = dragCoefficient(0, 0, 0, 1);
    for (let a = 1; a <= 60; a += 1) {
      const cd = dragCoefficient(a * D, 0, 0, 1);
      expect(cd).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cd;
    }
    expect(dragCoefficient(10 * D, 0, 0, 1)).toBeGreaterThan(dragCoefficient(2 * D, 0, 0, 1) + 0.02);
    expect(dragCoefficient(stallAlphaRad(0) + 10 * D, 0, 0, 1)).toBeGreaterThan(dragCoefficient(stallAlphaRad(0), 0, 0, 1) + 0.1);
    expect(dragCoefficient(90 * D, 0, 0, 1)).toBeGreaterThan(1);
  });

  it('grows with flaps and with gear extension', () => {
    const a = 4 * D;
    expect(dragCoefficient(a, 0, 10, 0)).toBeGreaterThan(dragCoefficient(a, 0, 0, 0));
    expect(dragCoefficient(a, 0, 30, 0)).toBeGreaterThan(dragCoefficient(a, 0, 10, 0));
    expect(dragCoefficient(a, 0, 0, 1)).toBeCloseTo(dragCoefficient(a, 0, 0, 0) + CONFIG.aircraft.aero.cdGear, 6);
    expect(dragCoefficient(a, 0, 0, 0.5)).toBeGreaterThan(dragCoefficient(a, 0, 0, 0));
  });

  it('grows with sideslip', () => {
    expect(dragCoefficient(0.05, 10 * D, 0, 0)).toBeGreaterThan(dragCoefficient(0.05, 0, 0, 0));
    expect(dragCoefficient(0.05, -10 * D, 0, 0)).toBeCloseTo(dragCoefficient(0.05, 10 * D, 0, 0), 9);
  });

  it('drag force grows with V² and opposes the motion', () => {
    const a = 3 * D;
    const d1 = computeAero(bodyVel(25, a), { x: 0, y: 0, z: 0 }, 1.225, 0, 1, NO_CONTROLS, 0);
    const d2 = computeAero(bodyVel(50, a), { x: 0, y: 0, z: 0 }, 1.225, 0, 1, NO_CONTROLS, 0);
    expect(d2.drag / d1.drag).toBeCloseTo(4, 3);
    const v = bodyVel(1, a);
    expect(d1.fx * v.x + d1.fy * v.y + d1.fz * v.z).toBeLessThan(0);
    // Thinner air, less drag at the same true airspeed.
    const d3 = computeAero(bodyVel(50, a), { x: 0, y: 0, z: 0 }, 0.9, 0, 1, NO_CONTROLS, 0);
    expect(d3.drag).toBeLessThan(d2.drag);
  });
});
