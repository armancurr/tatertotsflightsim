import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { launchArcadeMissile, stepArcadeMissile } from '../../src/combat/missile';
import { A10_WEAPONS } from '../../src/config';

const cfg = A10_WEAPONS.missiles!;
const v = (x: number, y: number, z: number) => ({ x, y, z });
const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe('arcade missile: scripted path to the target', () => {
  it('leaves the rail along the launch direction and arrives exactly at the target after distance / speed', () => {
    const start = v(0, 500, 0);
    const target = v(0, 0, -3000);
    const m = launchArcadeMissile(1, 0, 7, start, v(0, 0, -1), target, cfg);
    expect(m.duration).toBeCloseTo(dist(start, target) / cfg.speed, 6);
    expect(m.pos).toEqual(start);
    stepArcadeMissile(m, 0.05, target);
    expect(m.dir.z).toBeLessThan(-0.8); // heading forward, not snapping onto the target line
    let t = 0.05;
    while (!m.arrived && t < 60) {
      stepArcadeMissile(m, 1 / 60, target);
      t += 1 / 60;
    }
    expect(m.arrived).toBe(true);
    expect(t).toBeGreaterThanOrEqual(m.duration - 1e-6);
    expect(t).toBeLessThan(m.duration + 1 / 30);
    expect(dist(m.pos, target)).toBeLessThan(1e-6);
  });

  it('follows a moving target to wherever it is at arrival; keeps the last point when the target is gone', () => {
    const tgt = v(200, 0, -4000);
    const m = launchArcadeMissile(1, 0, 7, v(0, 600, 0), v(0, 0, -1), tgt, cfg);
    while (!m.arrived) {
      tgt.x += 8 / 60; // an 8 m/s convoy
      stepArcadeMissile(m, 1 / 60, tgt);
    }
    expect(dist(m.pos, tgt)).toBeLessThan(1e-6);

    const m2 = launchArcadeMissile(2, 1, 8, v(0, 600, 0), v(0, 0, -1), v(0, 0, -2000), cfg);
    stepArcadeMissile(m2, 1, v(0, 0, -2000));
    while (!m2.arrived) stepArcadeMissile(m2, 1 / 60, null);
    expect(dist(m2.pos, v(0, 0, -2000))).toBeLessThan(1e-6);
  });

  it('fuzz: any launch geometry and frame times give finite positions, a unit direction and a timely arrival', () => {
    const coord = fc.double({ min: -9000, max: 9000, noNaN: true });
    fc.assert(
      fc.property(
        fc.record({ x: coord, y: fc.double({ min: 50, max: 4000, noNaN: true }), z: coord }),
        fc.record({ x: coord, y: fc.double({ min: -50, max: 300, noNaN: true }), z: coord }),
        fc.record({ x: fc.double({ min: -1, max: 1, noNaN: true }), y: fc.double({ min: -1, max: 1, noNaN: true }), z: fc.double({ min: -1, max: 1, noNaN: true }) }),
        fc.array(fc.double({ min: -0.1, max: 0.2, noNaN: false }), { minLength: 1, maxLength: 40 }),
        (start, target, fwd, dts) => {
          const m = launchArcadeMissile(1, 0, 1, start, fwd, target, cfg);
          expect(m.duration).toBeGreaterThan(0);
          let prevT = m.t;
          let ok = true;
          for (let i = 0; i < 400 && !m.arrived; i++) {
            stepArcadeMissile(m, dts[i % dts.length], target);
            ok &&= m.t >= prevT;
            prevT = m.t;
            ok &&= [m.pos.x, m.pos.y, m.pos.z, m.dir.x, m.dir.y, m.dir.z].every(Number.isFinite);
            ok &&= Math.abs(Math.hypot(m.dir.x, m.dir.y, m.dir.z) - 1) < 1e-6;
          }
          expect(ok).toBe(true);
          // Frames with bad dt don't advance time; keep stepping with a sane one.
          while (!m.arrived) stepArcadeMissile(m, 0.1, target);
          expect(dist(m.pos, target)).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 150 },
    );
  });
});
