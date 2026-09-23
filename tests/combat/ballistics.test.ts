/**
 * Ballistics of the gun rounds: RK4 integration of gravity + quadratic drag (scaled by the ISA
 * air density), the seeded RNG / circular-Gaussian dispersion, and the segment-vs-terrain test
 * the rounds and the CCIP use. Unit + fast-check fuzz.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_WEAPONS, F16_WEAPONS, CONFIG } from '../../src/config';
import { stepBallistic, newBallistic, flyUntil, densityRatioAt } from '../../src/combat/ballistics';
import { createRng } from '../../src/combat/rng';
import { segmentSurfaceHit, surfaceHeight, lineOfSight } from '../../src/combat/ground';
import type { Environment } from '../../src/types';
import { FLAT_ENV } from '../../src/physics';
import { fcParams } from '../support/fc';

const GAU8 = A10_WEAPONS.gun!;
const M61 = F16_WEAPONS.gun!;
const G = CONFIG.sim.gravity;

/** Fire horizontally from a stationary gun at height y; returns speed and time at `range` m downrange. */
function downrange(gun: typeof GAU8, range: number, y = 0, dt = 1 / 120) {
  const b = newBallistic();
  b.y = y;
  b.vz = -gun.muzzleVelocity;
  const t = flyUntil(b, dt, gun.dragK, (s) => -s.z >= range, 10);
  return { t, speed: Math.hypot(b.vx, b.vy, b.vz), drop: y - b.y };
}

describe('ballistics: the 30 mm round (GAU-8/A)', () => {
  it('keeps ≈ 700 m/s at 1,220 m (4,000 ft) with ≈ 1.4–1.6 s time of flight', () => {
    const r = downrange(GAU8, 1220);
    expect(r.speed).toBeGreaterThan(670);
    expect(r.speed).toBeLessThan(730);
    expect(r.t).toBeGreaterThan(1.4);
    expect(r.t).toBeLessThan(1.6);
  });

  it('drops under gravity: a little under ½gt² (the drag damps the fall too: k·|v| ≈ 0.3 /s)', () => {
    const r = downrange(GAU8, 1220);
    const vacuum = 0.5 * G * r.t * r.t;
    expect(r.drop).toBeGreaterThan(0.8 * vacuum);
    expect(r.drop).toBeLessThan(vacuum);
    // Without drag the drop is exactly ½gt² (RK4 is exact for constant acceleration).
    const b = newBallistic();
    b.vz = -1000;
    let t = 0;
    for (let i = 0; i < 120; i++) {
      stepBallistic(b, 1 / 60, 0);
      t += 1 / 60;
    }
    expect(b.y).toBeCloseTo(-0.5 * G * t * t, 6);
    expect(b.z).toBeCloseTo(-1000 * t, 6);
  });

  it('thinner air at altitude: less drag (more speed left at 1,220 m)', () => {
    expect(densityRatioAt(0)).toBeCloseTo(1, 6);
    expect(densityRatioAt(3000)).toBeLessThan(0.75);
    expect(downrange(GAU8, 1220, 3000).speed).toBeGreaterThan(downrange(GAU8, 1220, 0).speed + 30);
  });

  it('the 20 mm M61 round slows faster than the 30 mm one', () => {
    expect(downrange(M61, 1220).speed).toBeLessThan(downrange(GAU8, 1220).speed);
  });

  it('the step size barely matters (RK4): 1/20 s vs 1/240 s land within 0.5 m', () => {
    const run = (dt: number) => {
      const b = newBallistic();
      b.y = 800;
      b.vx = 150;
      b.vy = -500;
      b.vz = -700;
      flyUntil(b, dt, GAU8.dragK, (s) => s.y <= 0, 10);
      return b;
    };
    // flyUntil stops at the first step that crosses: interpolate each to y = 0 for a fair comparison.
    const a = run(1 / 20);
    const c = run(1 / 240);
    const at0 = (b: ReturnType<typeof run>) => ({ x: b.x - (b.vx * b.y) / b.vy, z: b.z - (b.vz * b.y) / b.vy });
    const pa = at0(a);
    const pc = at0(c);
    expect(Math.hypot(pa.x - pc.x, pa.z - pc.z)).toBeLessThan(0.5);
  });

  it('fuzz: the integrator never produces NaN and drag never adds energy', () => {
    fc.assert(
      fc.property(
        fc.record({
          y: fc.double({ min: -500, max: 15000, noNaN: true }),
          vx: fc.double({ min: -1500, max: 1500, noNaN: true }),
          vy: fc.double({ min: -1500, max: 1500, noNaN: true }),
          vz: fc.double({ min: -1500, max: 1500, noNaN: true }),
        }),
        fc.double({ min: 0, max: 0.3, noNaN: true }),
        fc.double({ min: 0, max: 2e-3, noNaN: true }),
        (s, dt, k) => {
          const b = newBallistic();
          Object.assign(b, s);
          const v0 = Math.hypot(b.vx, b.vy, b.vz);
          stepBallistic(b, dt, k, 0);
          const v1 = Math.hypot(b.vx, b.vy, b.vz);
          expect(Number.isFinite(b.x + b.y + b.z + b.vx + b.vy + b.vz)).toBe(true);
          expect(v1).toBeLessThanOrEqual(v0 + 1e-6);
        },
      ),
      fcParams(300),
    );
  });

  it('hostile inputs (NaN dt, NaN drag) leave the round finite', () => {
    const b = newBallistic();
    b.vz = -1000;
    stepBallistic(b, Number.NaN, GAU8.dragK);
    stepBallistic(b, 1 / 60, Number.NaN);
    stepBallistic(b, Infinity, GAU8.dragK);
    expect(Number.isFinite(b.x + b.y + b.z + b.vx + b.vy + b.vz)).toBe(true);
  });
});

describe('rng: seeded, uniform and Gaussian', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = createRng(42);
    const b = createRng(42);
    const c = createRng(43);
    const sa = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
    for (const v of sa) expect(v >= 0 && v < 1).toBe(true);
  });

  it('gauss() has mean ≈ 0 and standard deviation ≈ 1', () => {
    const r = createRng(7);
    let s = 0;
    let s2 = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const g = r.gauss();
      s += g;
      s2 += g * g;
    }
    expect(Math.abs(s / n)).toBeLessThan(0.03);
    expect(Math.sqrt(s2 / n)).toBeGreaterThan(0.97);
    expect(Math.sqrt(s2 / n)).toBeLessThan(1.03);
  });
});

/** A ridge 40 m high between x = 400 and 600 (flat elsewhere), and a lake at x > 2000. */
const RIDGE_ENV: Environment = {
  groundHeight: (x) => (x > 400 && x < 600 ? 40 : 0),
  surfaceAt: () => 'grass',
  waterLevel: (x) => (x > 2000 ? 2 : null),
};

describe('ground: segment vs terrain and water, line of sight', () => {
  it('finds where a descending segment meets flat ground (refined to < 0.5 m)', () => {
    const out = { x: 0, y: 0, z: 0, water: false };
    const f = segmentSurfaceHit(FLAT_ENV, 0, 10, 0, 40, -10, 0, out);
    expect(f).toBeGreaterThan(0);
    expect(out.x).toBeCloseTo(20, 0);
    expect(Math.abs(out.y)).toBeLessThan(0.5);
    expect(out.water).toBe(false);
    expect(segmentSurfaceHit(FLAT_ENV, 0, 10, 0, 40, 5, 0, out)).toBe(-1);
  });

  it('hits the face of a ridge and lands on water above the lake bed', () => {
    const out = { x: 0, y: 0, z: 0, water: false };
    expect(segmentSurfaceHit(RIDGE_ENV, 390, 20, 0, 420, 20, 0, out)).toBeGreaterThan(0);
    expect(out.x).toBeGreaterThan(399);
    expect(out.x).toBeLessThan(402);
    expect(segmentSurfaceHit(RIDGE_ENV, 2100, 10, 0, 2110, -5, 0, out)).toBeGreaterThan(0);
    expect(out.water).toBe(true);
    expect(out.y).toBeCloseTo(2, 0);
    expect(surfaceHeight(RIDGE_ENV, 2100, 0)).toBe(2);
  });

  it('line of sight: blocked by the ridge, clear over flat ground', () => {
    expect(lineOfSight(RIDGE_ENV, { x: 0, y: 20, z: 0 }, { x: 1000, y: 1, z: 0 })).toBe(false);
    expect(lineOfSight(RIDGE_ENV, { x: 0, y: 500, z: 0 }, { x: 1000, y: 1, z: 0 })).toBe(true);
    expect(lineOfSight(FLAT_ENV, { x: 0, y: 200, z: 0 }, { x: 3000, y: 1.1, z: 0 })).toBe(true);
  });

  it('fuzz: any reported hit lies on the segment and at the surface (±0.5 m)', () => {
    fc.assert(
      fc.property(
        fc.record({ x0: fc.double({ min: 300, max: 700, noNaN: true }), y0: fc.double({ min: 0.1, max: 80, noNaN: true }), dx: fc.double({ min: -40, max: 40, noNaN: true }), y1: fc.double({ min: -20, max: 80, noNaN: true }) }),
        ({ x0, y0, dx, y1 }) => {
          fc.pre(y0 > RIDGE_ENV.groundHeight(x0, 0) + 0.01);
          const out = { x: 0, y: 0, z: 0, water: false };
          const f = segmentSurfaceHit(RIDGE_ENV, x0, y0, 0, x0 + dx, y1, 0, out);
          if (f < 0) return;
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThanOrEqual(1);
          const along = x0 + dx * f;
          expect(out.x).toBeCloseTo(along, 6);
          expect(out.y - surfaceHeight(RIDGE_ENV, out.x, 0)).toBeLessThan(0.5);
        },
      ),
      fcParams(300),
    );
  });
});
