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
  it('without a (trusted) GPU timer, only a really low frame rate degrades, and only once dynamic resolution is at its minimum', () => {
    const b = createCloudBudget(opts);
    run(b, 10, null, 60, false); // past the start-up warm-up
    expect(run(b, 8, null, 30, false)).toEqual([]);
    // 40 fps at minimum resolution: busy, but the clouds (~0.5 ms) are not the problem
    expect(run(b, 10, null, 40, true)).toEqual([]);
    expect(run(b, 6, null, 30, true)).toContain('volumetric-low');
  });
  it('without a timer, the start-up stutter (shader compiles, streaming) never degrades the clouds', () => {
    const b = createCloudBudget(opts);
    expect(run(b, 7, null, 20, true)).toEqual([]);
    expect(b.quality).toBe('volumetric');
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
  it('overlapping timer queries (per-pass times adding up to more than the frame interval, as on ANGLE/Metal) are not trusted', () => {
    // 60 fps, yet "clouds 10 ms + scene 11 ms": the timers overlap, the cloud time is meaningless
    const b = createCloudBudget(opts);
    const dt = 1 / 60;
    for (let t = 0; t < 20; t += dt) b.update(dt, 10, false, 21.5);
    expect(b.quality).toBe('volumetric');
    expect(b.timerTrusted).toBe(false);
    // …then it degrades on the frame rate alone (really low, at minimum resolution)
    for (let t = 0; t < 6; t += 1 / 30) b.update(1 / 30, 10, true, 21.5);
    expect(b.quality).not.toBe('volumetric');
  });
  it('consistent timings (frame GPU time within the frame interval) are trusted and still enforce the budget', () => {
    const b = createCloudBudget(opts);
    const dt = 1 / 60;
    for (let t = 0; t < 3; t += dt) b.update(dt, 3.5, false, 12);
    expect(b.timerTrusted).toBe(true);
    expect(b.quality).toBe('volumetric-low');
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
