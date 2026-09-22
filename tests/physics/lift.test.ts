import { describe, it, expect } from 'vitest';
import { CONFIG } from '../../src/config';
import { liftCoefficient, stallAlphaRad, computeAero } from '../../src/physics';

const D = Math.PI / 180;
const NO_CONTROLS = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };
const bodyVel = (V: number, alpha: number) => ({ x: 0, y: -V * Math.sin(alpha), z: -V * Math.cos(alpha) });

function peak(flapsDeg: number): { alpha: number; cl: number } {
  let best = { alpha: 0, cl: -Infinity };
  for (let a = -5; a <= 35; a += 0.05) {
    const cl = liftCoefficient(a * D, flapsDeg);
    if (cl > best.cl) best = { alpha: a * D, cl };
  }
  return best;
}

describe('lift', () => {
  it('CL rises with angle of attack below the stall (≈ linear, slope ≈ clAlpha)', () => {
    let prev = -Infinity;
    for (let a = -8; a <= 12; a += 1) {
      const cl = liftCoefficient(a * D, 0);
      expect(cl).toBeGreaterThan(prev);
      prev = cl;
    }
    const slope = (liftCoefficient(8 * D, 0) - liftCoefficient(0, 0)) / (8 * D);
    expect(slope).toBeCloseTo(CONFIG.aircraft.aero.clAlpha, 1);
  });

  it('clean CL peaks at ~1.5–1.7 at the stall angle', () => {
    const p = peak(0);
    expect(p.cl).toBeGreaterThan(1.5);
    expect(p.cl).toBeLessThan(1.7);
    expect(Math.abs(p.alpha - stallAlphaRad(0))).toBeLessThan(0.2 * D);
    expect(stallAlphaRad(0)).toBeCloseTo(CONFIG.aircraft.aero.stallAlphaDeg * D, 6);
  });

  it('CL collapses past the stall angle toward the flat-plate curve', () => {
    const s = stallAlphaRad(0);
    const clMax = liftCoefficient(s, 0);
    expect(liftCoefficient(s + 2 * D, 0)).toBeLessThan(clMax);
    expect(liftCoefficient(s + CONFIG.aircraft.aero.stallBreakWidthDeg * D, 0)).toBeLessThan(0.75 * clMax);
    // Deep stall follows the flat plate k·sin(2α).
    expect(liftCoefficient(45 * D, 0)).toBeCloseTo(CONFIG.aircraft.aero.flatPlateLift, 2);
    expect(liftCoefficient(-45 * D, 0)).toBeCloseTo(-CONFIG.aircraft.aero.flatPlateLift, 2);
  });

  it('also stalls at the negative stall angle', () => {
    const neg = CONFIG.aircraft.aero.stallAlphaNegDeg * D;
    const clNeg = liftCoefficient(neg, 0);
    expect(liftCoefficient(neg + 3 * D, 0)).toBeGreaterThan(clNeg);
    expect(liftCoefficient(neg - 3 * D, 0)).toBeGreaterThan(clNeg);
  });

  it('is continuous (no jumps) from -180° to 180°, for every flap setting', () => {
    // Continuity: the biggest change between neighbouring samples shrinks in proportion to the step.
    const maxJump = (flaps: number, stepDeg: number) => {
      let prev = liftCoefficient(-Math.PI, flaps);
      let worst = 0;
      for (let a = -180; a <= 180; a += stepDeg) {
        const cl = liftCoefficient(a * D, flaps);
        expect(Number.isFinite(cl)).toBe(true);
        worst = Math.max(worst, Math.abs(cl - prev));
        prev = cl;
      }
      return worst;
    };
    for (const flaps of [0, 10, 20, 30]) {
      const coarse = maxJump(flaps, 0.04);
      const fine = maxJump(flaps, 0.02);
      expect(coarse).toBeLessThan(0.03);
      expect(fine).toBeLessThan(0.6 * coarse);
    }
  });

  it('flaps raise CL at the same angle and raise CLmax, stalling at a slightly lower angle', () => {
    for (const a of [-2, 0, 5, 10]) {
      expect(liftCoefficient(a * D, 10)).toBeGreaterThan(liftCoefficient(a * D, 0));
      expect(liftCoefficient(a * D, 30)).toBeGreaterThan(liftCoefficient(a * D, 10));
    }
    expect(peak(30).cl).toBeGreaterThan(peak(0).cl + 0.4);
    expect(stallAlphaRad(30)).toBeLessThan(stallAlphaRad(0));
    expect(Math.abs(peak(30).alpha - stallAlphaRad(30))).toBeLessThan(0.2 * D);
  });

  it('lift force grows with V² and points perpendicular to the airflow', () => {
    const a = 5 * D;
    const l1 = computeAero(bodyVel(30, a), { x: 0, y: 0, z: 0 }, 1.225, 0, 1, NO_CONTROLS, 0);
    const l2 = computeAero(bodyVel(60, a), { x: 0, y: 0, z: 0 }, 1.225, 0, 1, NO_CONTROLS, 0);
    expect(l2.lift / l1.lift).toBeCloseTo(4, 3);
    expect(l1.lift).toBeCloseTo(0.5 * 1.225 * 30 * 30 * CONFIG.aircraft.wingArea * liftCoefficient(a, 0), 3);
    // Perpendicular: lift + drag reconstruct the in-plane force; the lift part has no component along v.
    const v = bodyVel(1, a);
    const along = l1.fx * v.x + l1.fy * v.y + l1.fz * v.z;
    expect(along).toBeCloseTo(-l1.drag, 3);
    // Lift tilts forward of body-up when alpha > 0 (so it has a -Z component).
    expect(l1.fy).toBeGreaterThan(0);
  });

  it('lift fades smoothly to zero at very low airspeed (no NaN)', () => {
    for (const V of [0, 1e-9, 0.1, 0.5, 1, 2]) {
      const r = computeAero(bodyVel(V, 0.3), { x: 0.1, y: 0.2, z: -0.1 }, 1.225, 0, 1, NO_CONTROLS, 0);
      for (const k of ['fx', 'fy', 'fz', 'tx', 'ty', 'tz', 'lift', 'drag'] as const) expect(Number.isFinite(r[k])).toBe(true);
    }
    expect(computeAero(bodyVel(0, 0), { x: 0, y: 0, z: 0 }, 1.225, 0, 1, NO_CONTROLS, 0).lift).toBe(0);
  });
});
