/**
 * The dynamic-resolution MSAA ladder: where the frame cost scales with the MSAA sample count rather
 * than the pixel count (a dense terrain mesh at grazing angles is shaded once per covering triangle
 * per pixel under MSAA), the controller must step MSAA down instead of blurring the image to the floor.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDynamicResolution } from '../../src/render/dynamicResolution';
import { msaaLadder, planQuality } from '../../src/render/quality';

const base = { targetFps: 60, minPixelRatio: 0.5, maxPixelRatio: 1, msaaLevels: [4, 2, 0] };

type DR = ReturnType<typeof createDynamicResolution>;
/** Run `seconds` of frames whose duration (ms) the GPU model gives for the current ratio and MSAA. */
function fly(dr: DR, seconds: number, gpuMs: (ratio: number, msaa: number) => number, tail = 10) {
  let t = 0;
  let frames = 0;
  let tailT = 0;
  while (t < seconds) {
    const dt = Math.max(1 / 60, gpuMs(dr.pixelRatio, dr.msaa) / 1000);
    t += dt;
    dr.update(dt);
    if (t > seconds - tail) {
      frames++;
      tailT += dt;
    }
  }
  return { fps: frames / tailT, ratio: dr.pixelRatio, msaa: dr.msaa };
}

// Measured shape of the Taterville view (M2 Max, 1440×900): 38 fps at 4×, 46 at 2×, 55 at 0×, and
// the pixel ratio barely matters (the cost follows the triangle edges, not the pixels).
const edgeBound = (ratio: number, msaa: number) => (msaa === 4 ? 26 : msaa === 2 ? 21.5 : 17.5) * (0.85 + 0.15 * ratio * ratio);
// A fill-bound scene: the cost follows the pixels, MSAA adds a little.
const fillBound = (ratio: number, msaa: number) => (6 + 20 * ratio * ratio) * (1 + msaa * 0.03);

describe('dynamic resolution: MSAA ladder', () => {
  it('without a ladder MSAA is never touched (the old behaviour)', () => {
    const dr = createDynamicResolution({ ...base, msaaLevels: undefined });
    const r = fly(dr, 60, (ratio) => edgeBound(ratio, 4)); // the target keeps its 4×
    expect(dr.msaa).toBe(0); // (no ladder: the renderer leaves its samples alone)
    expect(r.ratio).toBeCloseTo(0.5, 5); // it can only blur — and still misses the target
    expect(r.fps).toBeLessThan(45);
  });

  it('an edge-bound scene steps MSAA down instead of blurring to the floor, and gets to ≥ 55 fps', () => {
    const dr = createDynamicResolution(base);
    const r = fly(dr, 60, edgeBound);
    expect(r.msaa).toBe(0);
    expect(r.ratio).toBeGreaterThanOrEqual(0.72);
    expect(r.fps).toBeGreaterThanOrEqual(55);
  });

  it('a fill-bound scene keeps full MSAA while the ratio does the work down to the knee', () => {
    const light = (ratio: number, msaa: number) => fillBound(ratio, msaa) * 0.75; // ~ 57 fps at 1×
    const dr = createDynamicResolution(base);
    fly(dr, 60, light);
    expect(dr.pixelRatio).toBeGreaterThanOrEqual(0.85 - 1e-9);
    expect(dr.msaa).toBe(4);
  });

  it('restores MSAA (before raising the ratio past the knee) once there is headroom again', () => {
    const dr = createDynamicResolution(base);
    fly(dr, 40, edgeBound);
    expect(dr.msaa).toBeLessThan(4);
    const r = fly(dr, 200, () => 8); // the heavy view is gone
    expect(r.msaa).toBe(4);
    expect(r.ratio).toBeCloseTo(1, 5);
  });

  it('property: ratio stays in [min, max], MSAA is always a ladder rung, and it never drops MSAA above the knee', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1 / 240, max: 0.2, noNaN: true }), { minLength: 1, maxLength: 1500 }),
        fc.double({ min: 0.5, max: 1, noNaN: true }),
        (dts, knee) => {
          const dr = createDynamicResolution({ ...base, msaaKnee: knee });
          const kneeRatio = Math.max(base.minPixelRatio, base.maxPixelRatio * knee);
          let prevMsaa = dr.msaa;
          for (const dt of dts) {
            const before = dr.pixelRatio;
            dr.update(dt);
            if (dr.pixelRatio < base.minPixelRatio - 1e-9 || dr.pixelRatio > base.maxPixelRatio + 1e-9) return false;
            if (!base.msaaLevels.includes(dr.msaa)) return false;
            if (dr.msaa < prevMsaa && before > kneeRatio + 1e-3) return false;
            prevMsaa = dr.msaa;
          }
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('quality plan: which presets may drop MSAA', () => {
  const probe = { devicePixelRatio: 2, cssWidth: 1440, cssHeight: 900, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max)' };
  it('auto and medium adapt; high keeps its 4× fixed; low has none', () => {
    expect(msaaLadder(planQuality('auto', probe))).toEqual([4, 2, 0]);
    expect(msaaLadder(planQuality('medium', probe))).toEqual([2, 0]);
    expect(msaaLadder(planQuality('high', probe))).toBeUndefined();
    expect(msaaLadder(planQuality('low', probe))).toBeUndefined();
  });
  it('software rendering (auto → low) never gets a ladder', () => {
    expect(msaaLadder(planQuality('auto', { ...probe, renderer: 'SwiftShader' }))).toBeUndefined();
  });
});
