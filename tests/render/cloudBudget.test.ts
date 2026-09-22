/**
 * Cloud frame-budget controller (cloudBudget.ts): degrades volumetric →
 * reduced-resolution volumetric → billboard clouds when the cloud pass (GPU
 * timer) or the frame rate stays over budget, and probes back up with
 * exponential back-off.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createCloudBudget, CLOUD_QUALITIES } from '../../src/render/cloudBudget';

const opts = { budgetMs: 2, targetFps: 60 };
const run = (b: ReturnType<typeof createCloudBudget>, seconds: number, gpu: number | null, fps = 60, atMin = false) => {
  const changes: string[] = [];
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) {
    const q = b.update(dt, gpu, atMin);
    if (q) changes.push(q);
  }
  return changes;
};

describe('cloud budget controller', () => {
  it('starts at the best quality and stays there within budget', () => {
    const b = createCloudBudget(opts);
    expect(b.quality).toBe('volumetric');
    expect(run(b, 30, 1.2)).toEqual([]);
  });
  it('degrades one level after sustained over-budget GPU time, then to billboards', () => {
    const b = createCloudBudget(opts);
    expect(run(b, 1.0, 3.5)).toEqual([]);
    expect(run(b, 1.5, 3.5)).toEqual(['volumetric-low']);
    expect(run(b, 3, 3.5)).toEqual(['billboard']);
    expect(b.level).toBe(2);
  });
  it('ignores short spikes and hitches', () => {
    const b = createCloudBudget(opts);
    for (let i = 0; i < 20; i++) {
      run(b, 0.3, 6);
      run(b, 1, 1);
    }
    expect(b.quality).toBe('volumetric');
    b.update(2.0, 50, false); // a 2 s hitch (tab switch) is ignored
    expect(b.quality).toBe('volumetric');
  });
  it('without a GPU timer, a low frame rate only degrades once dynamic resolution is at its minimum', () => {
    const b = createCloudBudget(opts);
    expect(run(b, 5, null, 40, false)).toEqual([]);
    expect(run(b, 3, null, 40, true)).toContain('volumetric-low');
  });
  it('probes back up after sustained headroom, and backs off after a failed probe', () => {
    const b = createCloudBudget({ ...opts, upDelay: 5 });
    run(b, 6, 4);
    expect(b.quality).toBe('billboard');
    // headroom: billboard costs 0.3 ms
    const up = run(b, 6, 0.3);
    expect(up).toEqual(['volumetric-low']);
    // the probe fails at once → back to billboard, and the next probe waits ≥ 2× longer
    expect(run(b, 3, 3)).toEqual(['billboard']);
    expect(run(b, 8, 0.3)).toEqual([]);
    expect(run(b, 4, 0.3)).toEqual(['volumetric-low']);
  });
  it('a forced quality pins the level', () => {
    const b = createCloudBudget({ ...opts, forced: 'billboard' });
    expect(b.quality).toBe('billboard');
    expect(run(b, 20, 0.1)).toEqual([]);
  });
  it('property: level stays in range and changes are separated by the settle time', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dt: fc.double({ min: 0, max: 0.4, noNaN: true }), gpu: fc.option(fc.double({ min: 0, max: 20, noNaN: true })), atMin: fc.boolean() }), { maxLength: 600 }),
        (frames) => {
          const b = createCloudBudget(opts);
          let t = 0;
          let lastChange = -Infinity;
          for (const f of frames) {
            t += f.dt <= 0.25 ? f.dt : 0;
            const q = b.update(f.dt, f.gpu, f.atMin);
            expect(b.level).toBeGreaterThanOrEqual(0);
            expect(b.level).toBeLessThan(CLOUD_QUALITIES.length);
            if (q) {
              expect(CLOUD_QUALITIES).toContain(q);
              expect(t - lastChange).toBeGreaterThanOrEqual(0.99);
              lastChange = t;
            }
          }
        },
      ),
    );
  });
});
