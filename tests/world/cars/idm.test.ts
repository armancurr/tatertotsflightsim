import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { idmAccel, approachSpeed, type IdmParams } from '../../../src/world/cars/idm';

const P: IdmParams = { T: 1.5, s0: 2.2, a: 1.8, b: 2.4, maxDecel: 8 };

/** Integrates one follower behind a leader with a given speed profile (semi-implicit Euler, like the sim). */
function follow(v0: number, gap0: number, vf0: number, leader: (t: number) => number, seconds: number, dt = 1 / 30) {
  let gap = gap0;
  let vf = vf0;
  let minGap = gap;
  for (let t = 0; t < seconds; t += dt) {
    const vl = leader(t);
    const a = idmAccel(vf, v0, gap, vf - vl, P);
    vf = Math.max(0, vf + a * dt);
    gap += (vl - vf) * dt;
    minGap = Math.min(minGap, gap);
  }
  return { gap, vf, minGap };
}

describe('intelligent driver model', () => {
  it('free road: accelerates to the desired speed and holds it', () => {
    let v = 0;
    for (let i = 0; i < 60 * 30; i++) v = Math.max(0, v + idmAccel(v, 25, Infinity, 0, P) / 30);
    expect(v).toBeGreaterThan(24.5);
    expect(v).toBeLessThanOrEqual(25.0001);
  });
  it('comes to rest behind a stopped car, a jam gap away, without touching it', () => {
    const r = follow(25, 150, 25, () => 0, 90);
    expect(r.vf).toBeLessThan(0.05);
    expect(r.minGap).toBeGreaterThan(1.0);
    expect(r.gap).toBeGreaterThan(1.5);
    expect(r.gap).toBeLessThan(P.s0 + 0.6);
  });
  it('follows a slower car at its speed, about s0 + v·T behind', () => {
    const r = follow(30, 80, 30, () => 20, 180);
    expect(r.vf).toBeCloseTo(20, 0);
    expect(r.gap).toBeGreaterThan(P.s0 + 20 * P.T - 3);
    expect(r.gap).toBeLessThan(P.s0 + 20 * P.T + 12);
  });
  it('the acceleration stays within [−maxDecel, a] and is never NaN', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 45, noNaN: true }),
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.oneof(fc.double({ min: -5, max: 500, noNaN: true }), fc.constant(Infinity)),
        fc.double({ min: -40, max: 40, noNaN: true }),
        (v, v0, gap, dv) => {
          const a = idmAccel(v, v0, gap, dv, P);
          expect(Number.isFinite(a)).toBe(true);
          expect(a).toBeGreaterThanOrEqual(-P.maxDecel);
          expect(a).toBeLessThanOrEqual(P.a);
        },
      ),
      { numRuns: 2000 },
    );
  });
  it('property: a follower behind a leader that brakes at ≤ b never collides', () => {
    fc.assert(
      fc.property(fc.double({ min: 5, max: 30, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0.5, max: 2.4, noNaN: true }), fc.double({ min: 0, max: 20, noNaN: true }), (v, g, brake, t0) => {
        // start at an equilibrium-ish gap for v, the leader brakes to a stop at t0
        const gap0 = P.s0 + v * P.T * (0.9 + g);
        const r = follow(v + 2, gap0, v, (t) => (t < t0 ? v : Math.max(0, v - brake * (t - t0))), 60);
        expect(r.minGap).toBeGreaterThan(0.3);
      }),
      { numRuns: 300 },
    );
  });
  it('approach speed: the fastest speed from which a target speed is reached by a point ahead', () => {
    expect(approachSpeed(5, 0, 2)).toBeCloseTo(5, 6);
    expect(approachSpeed(0, 50, 2)).toBeCloseTo(Math.sqrt(200), 6);
    expect(approachSpeed(10, -3, 2)).toBeCloseTo(10, 6);
  });
});
