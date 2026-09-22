import { describe, it, expect } from 'vitest';
import { createDynamicResolution } from '../../src/render/dynamicResolution';

const base = { targetFps: 60, minPixelRatio: 0.75, maxPixelRatio: 1.5 };

/** Feed `seconds` of frames at `fps` (or fps computed from the current ratio). Returns the number of changes. */
function run(dr: ReturnType<typeof createDynamicResolution>, seconds: number, fps: number | ((ratio: number) => number)) {
  let t = 0;
  let changes = 0;
  while (t < seconds) {
    const f = typeof fps === 'function' ? fps(dr.pixelRatio) : fps;
    const dt = 1 / f;
    t += dt;
    if (dr.update(dt) !== null) changes++;
  }
  return changes;
}

describe('dynamic resolution controller', () => {
  it('starts at the max pixel ratio (or the given initial ratio)', () => {
    expect(createDynamicResolution(base).pixelRatio).toBe(1.5);
    expect(createDynamicResolution({ ...base, initialPixelRatio: 1 }).pixelRatio).toBe(1);
  });

  it('leaves the ratio alone at a steady target frame rate', () => {
    const dr = createDynamicResolution(base);
    expect(run(dr, 20, 60)).toBe(0);
    expect(dr.pixelRatio).toBe(1.5);
  });

  it('lowers the ratio when fps sits below target, but never below the minimum', () => {
    const dr = createDynamicResolution(base);
    run(dr, 3, 40);
    expect(dr.pixelRatio).toBeLessThan(1.5);
    run(dr, 60, 20);
    expect(dr.pixelRatio).toBe(0.75);
  });

  it('ignores a brief dip (hysteresis)', () => {
    const dr = createDynamicResolution(base);
    run(dr, 5, 60);
    run(dr, 0.3, 30);
    run(dr, 5, 60);
    expect(dr.pixelRatio).toBe(1.5);
  });

  it('does nothing in the dead band between "slow" and "headroom"', () => {
    const dr = createDynamicResolution({ ...base, initialPixelRatio: 1 });
    expect(run(dr, 30, 57)).toBe(0);
    expect(dr.pixelRatio).toBe(1);
  });

  it('restores the ratio when there is headroom again, never above the maximum', () => {
    const dr = createDynamicResolution(base);
    run(dr, 30, 25);
    expect(dr.pixelRatio).toBe(0.75);
    run(dr, 120, 60);
    expect(dr.pixelRatio).toBe(1.5);
  });

  it('backs off instead of oscillating when raising the ratio keeps failing', () => {
    // A GPU that manages 60 fps up to ratio 1.0 and 45 fps above it.
    const dr = createDynamicResolution(base);
    const gpu = (ratio: number) => (ratio <= 1.0 + 1e-9 ? 60 : 45);
    const changes = run(dr, 240, gpu);
    expect(dr.pixelRatio).toBeLessThanOrEqual(1.2);
    // Without backoff a 3 s probe would flip ~2 times every ~4 s (~120 changes in 240 s).
    expect(changes).toBeLessThan(30);
  });

  it('ignores huge frame gaps (tab switch, breakpoint)', () => {
    const dr = createDynamicResolution(base);
    for (let i = 0; i < 20; i++) dr.update(2.0);
    expect(dr.pixelRatio).toBe(1.5);
  });

  it('reset() restores a ratio and clears the timers', () => {
    const dr = createDynamicResolution(base);
    run(dr, 5, 30);
    dr.reset(1.25);
    expect(dr.pixelRatio).toBe(1.25);
    dr.reset();
    expect(dr.pixelRatio).toBe(1.5);
  });
});
