import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeAero } from '../../src/physics/aero';
import { CONFIG } from '../../src/config';

const ctl = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };
// 60 kt, 6° angle of attack, level wings.
const V = 31;
const a = (6 * Math.PI) / 180;
const vb = { x: 0, y: -V * Math.sin(a), z: -V * Math.cos(a) };
const w0 = { x: 0, y: 0, z: 0 };
const liftAndDrag = (h: number) => {
  const r = computeAero(vb, w0, 1.225, 0, 1, ctl, 0, CONFIG, h);
  return { lift: r.lift, drag: r.drag };
};

describe('ground effect (lift and induced drag)', () => {
  it('near the runway the wing makes a little more lift and less drag', () => {
    const free = liftAndDrag(Infinity);
    const near = liftAndDrag(2.2);
    expect(near.lift).toBeGreaterThan(free.lift * 1.004);
    expect(near.drag).toBeLessThan(free.drag * 0.97);
  });
  it('vanishes above about one wingspan', () => {
    const free = liftAndDrag(Infinity);
    const high = liftAndDrag(2 * CONFIG.aircraft.wingSpan);
    expect(Math.abs(high.lift / free.lift - 1)).toBeLessThan(0.002);
    expect(Math.abs(high.drag / free.drag - 1)).toBeLessThan(0.01);
  });
  it('fuzz: the effect grows monotonically as the wing gets closer to the ground', () => {
    fc.assert(fc.property(fc.double({ min: 0.5, max: 30, noNaN: true }), fc.double({ min: 0.5, max: 30, noNaN: true }), (h1, h2) => {
      const lo = Math.min(h1, h2), hi = Math.max(h1, h2);
      const L = liftAndDrag(lo), H = liftAndDrag(hi);
      expect(L.lift).toBeGreaterThanOrEqual(H.lift - 1e-6);
      expect(L.drag).toBeLessThanOrEqual(H.drag + 1e-6);
      expect(Number.isFinite(L.lift) && Number.isFinite(L.drag)).toBe(true);
    }), { numRuns: 60 });
  });
});
