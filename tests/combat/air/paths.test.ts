import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { circlePath, deltaS, nearestS, newPathSample, pursuitTurnRate, racetrack, samplePath, wrapS } from '../../../src/combat/air/paths';

const DEG = Math.PI / 180;

describe('air paths', () => {
  it('racetrack: length = 2 legs + one full circle; legs along the axis; turns to the right', () => {
    const p = racetrack(1000, -2000, 90, 6000, 3000, () => ({ alt: 2000, speed: 190 }));
    expect(p.length).toBeCloseTo(2 * 6000 + 2 * Math.PI * 3000, -2);
    const s = newPathSample();
    samplePath(p, 1000, s);
    expect(s.heading).toBeCloseTo(90 * DEG, 6);
    // First leg is left of the centre (north for an east-bound leg): z = −2000 − 3000.
    expect(s.z).toBeCloseTo(-5000, 6);
    // Halfway through the first turn the aircraft heads south (turned right from east).
    samplePath(p, 6000 + (Math.PI * 3000) / 2, s);
    expect(Math.abs(s.heading - 180 * DEG) < 0.05 || Math.abs(s.heading + 180 * DEG) < 0.05).toBe(true);
    expect(p.clockwise).toBe(true);
  });

  it('circle: radius and AGL altitude, clockwise', () => {
    const p = circlePath(0, 0, 1100, 90, 55);
    expect(p.agl).toBe(true);
    expect(p.length).toBeCloseTo(2 * Math.PI * 1100, -1);
    const s = newPathSample();
    for (let k = 0; k < 20; k++) {
      samplePath(p, (k * p.length) / 20, s);
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(1095);
      expect(Math.hypot(s.x, s.z)).toBeLessThan(1101);
      expect(s.alt).toBe(90);
    }
    // At the north point it flies east.
    samplePath(p, 1, s);
    expect(s.heading).toBeCloseTo(90 * DEG, 1);
  });

  it('wrapS / deltaS wrap around the loop', () => {
    const p = circlePath(0, 0, 1000, 100, 50);
    expect(wrapS(p, -10)).toBeCloseTo(p.length - 10, 9);
    expect(wrapS(p, p.length + 5)).toBeCloseTo(5, 9);
    expect(deltaS(p, 10, p.length - 10)).toBeCloseTo(20, 9);
    expect(deltaS(p, p.length - 10, 10)).toBeCloseTo(-20, 9);
  });

  it('nearestS finds the arc length of a point on the path (global and windowed)', () => {
    const p = racetrack(0, 0, 30, 5000, 2500, () => ({ alt: 1500, speed: 180 }));
    const s = newPathSample();
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (u) => {
        const at = u * p.length;
        samplePath(p, at, s);
        expect(Math.abs(deltaS(p, nearestS(p, s.x, s.z), at))).toBeLessThan(1);
        expect(Math.abs(deltaS(p, nearestS(p, s.x, s.z, at - 300), at))).toBeLessThan(1);
      }),
    );
  });

  it('pure pursuit: turns toward the point, harder when it is off to the side; saturates behind', () => {
    expect(pursuitTurnRate(0, 0, 0, 100, 100, -1000)).toBeGreaterThan(0);
    expect(pursuitTurnRate(0, 0, 0, 100, -100, -1000)).toBeLessThan(0);
    expect(Math.abs(pursuitTurnRate(0, 0, 0, 100, 500, -500))).toBeGreaterThan(Math.abs(pursuitTurnRate(0, 0, 0, 100, 100, -1000)));
    const behind = pursuitTurnRate(0, 0, 0, 100, 10, 1000);
    expect(behind).toBeCloseTo((2 * 100) / Math.hypot(10, 1000), 9);
    expect(pursuitTurnRate(0, 0, 0, 100, 0, 0)).toBe(0);
  });
});
