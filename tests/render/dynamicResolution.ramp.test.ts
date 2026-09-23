/**
 * Dynamic resolution: the fast first ramp (`rampUpDelay`) from a conservative start, and the
 * start-up `warmup` during which slow frames (streaming, shader compiles) are not judged.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createDynamicResolution } from '../../src/render/dynamicResolution';
import { fcParams } from '../support/fc';

const base = { targetFps: 60, minPixelRatio: 0.5, maxPixelRatio: 1.5, initialPixelRatio: 1 };

function timeToMax(dr: ReturnType<typeof createDynamicResolution>, fps: (r: number) => number, limit = 120): number {
  let t = 0;
  while (t < limit) {
    const dt = 1 / fps(dr.pixelRatio);
    t += dt;
    dr.update(dt);
    if (dr.pixelRatio >= 1.5) return t;
  }
  return Infinity;
}

describe('dynamic resolution: first ramp and warm-up', () => {
  it('ramps up from a conservative start much faster with rampUpDelay than with the steady upDelay', () => {
    const slow = timeToMax(createDynamicResolution(base), () => 60);
    const fast = timeToMax(createDynamicResolution({ ...base, rampUpDelay: 1 }), () => 60);
    expect(fast).toBeLessThan(6);
    expect(slow).toBeGreaterThan(fast * 2);
  });

  it('a failed probe ends the ramp: after that, raising waits at least twice the steady upDelay', () => {
    // 60 fps up to ratio 1.2, 40 fps above.
    const gpu = (r: number) => (r <= 1.2 + 1e-9 ? 60 : 40);
    const dr = createDynamicResolution({ ...base, rampUpDelay: 1, upDelay: 4 });
    const raises: number[] = [];
    let t = 0;
    let prev = dr.pixelRatio;
    while (t < 60) {
      const dt = 1 / gpu(dr.pixelRatio);
      t += dt;
      dr.update(dt);
      if (dr.pixelRatio > prev) raises.push(t);
      prev = dr.pixelRatio;
    }
    expect(raises.length).toBeGreaterThanOrEqual(2);
    // Raises after the first failed probe are ≥ 8 s apart (2 × upDelay), not 1 s.
    const late = raises.filter((x) => x > 6);
    for (let i = 1; i < late.length; i++) expect(late[i] - late[i - 1]).toBeGreaterThan(7.5);
    expect(dr.pixelRatio).toBeLessThanOrEqual(1.4);
  });

  it('ignores slow frames during the warm-up, then judges normally', () => {
    const dr = createDynamicResolution({ ...base, warmup: 3 });
    let t = 0;
    while (t < 2.9) {
      t += 1 / 20;
      dr.update(1 / 20);
    }
    expect(dr.pixelRatio).toBe(1);
    while (t < 8) {
      t += 1 / 20;
      dr.update(1 / 20);
    }
    expect(dr.pixelRatio).toBeLessThan(1);
  });

  it('property: the ratio always stays within [min, max] whatever the frame times and options', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.double({ min: 0.001, max: 0.3, noNaN: true }), fc.constantFrom(NaN, -1, 0, 5)), { minLength: 1, maxLength: 400 }),
        fc.double({ min: 0.1, max: 5, noNaN: true }),
        fc.double({ min: 0, max: 5, noNaN: true }),
        (dts, ramp, warm) => {
          const dr = createDynamicResolution({ ...base, rampUpDelay: ramp, warmup: warm });
          for (const dt of dts) {
            dr.update(dt);
            expect(dr.pixelRatio).toBeGreaterThanOrEqual(0.5);
            expect(dr.pixelRatio).toBeLessThanOrEqual(1.5);
          }
        },
      ),
      fcParams(200),
    );
  });
});
