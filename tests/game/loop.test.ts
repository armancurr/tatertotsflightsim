import { describe, it, expect } from 'vitest';
import { FixedStepLoop } from '../../src/game/loop';
import { createFpsMeter, recordFrame, fpsStats } from '../../src/game/fps';
import { interpolatePose } from '../../src/game/interpolate';
import { quatFromEuler, eulerFromQuat } from '../../src/physics/frames';
import { CONFIG } from '../../src/config';

const FIXED = 1 / 120;

describe('FixedStepLoop', () => {
  it('60 Hz frames run exactly 2 physics steps of 1/120 s each', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    const dts: number[] = [];
    const counts: number[] = [];
    for (let i = 0; i < 30; i++) counts.push(loop.advance(1 / 60, (dt) => dts.push(dt)).steps);
    expect(counts.every((c) => c === 2)).toBe(true);
    expect(dts.length).toBe(60);
    expect(dts.every((d) => d === FIXED)).toBe(true);
  });
  it('144 Hz frames alternate 0/1 steps and keep 120 steps per simulated second', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    let total = 0;
    const counts = new Set<number>();
    for (let i = 0; i < 144; i++) {
      const r = loop.advance(1 / 144, () => {});
      total += r.steps;
      counts.add(r.steps);
    }
    expect([...counts].sort()).toEqual([0, 1]);
    expect(Math.abs(total - 120)).toBeLessThanOrEqual(1);
  });
  it('30 Hz frames run 4 steps', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    for (let i = 0; i < 5; i++) expect(loop.advance(1 / 30, () => {}).steps).toBe(4);
  });
  it('jittery frame times still average out to real time', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    let steps = 0;
    let t = 0;
    for (let i = 0; i < 600; i++) {
      const dt = 1 / 60 + (i % 2 === 0 ? 0.002 : -0.002) + (i % 7 === 0 ? 0.001 : 0);
      t += dt;
      steps += loop.advance(dt, () => {}).steps;
    }
    expect(Math.abs(steps * FIXED - t)).toBeLessThan(FIXED + 1e-9);
  });
  it('clamps a huge frame (tab switch) to maxFrameDt and never runs more than maxSubSteps', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    let n = 0;
    const r = loop.advance(5, () => n++);
    expect(r.steps).toBe(10);
    expect(n).toBe(10);
    expect(r.alpha).toBeGreaterThanOrEqual(0);
    expect(r.alpha).toBeLessThan(1);
    // the excess was dropped: the next normal frame does not spiral
    expect(loop.advance(1 / 60, () => {}).steps).toBe(2);
  });
  it('alpha is the leftover fraction of a step, always in [0, 1)', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    const r = loop.advance(FIXED * 2.5, () => {});
    expect(r.steps).toBe(2);
    expect(r.alpha).toBeCloseTo(0.5, 9);
    for (let i = 0; i < 500; i++) {
      const a = loop.advance(Math.abs(Math.sin(i * 12.9898)) * 0.05, () => {}).alpha;
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });
  it('ignores negative / NaN frame times and reset() clears the accumulator', () => {
    const loop = new FixedStepLoop(FIXED, 10, 0.25);
    expect(loop.advance(-1, () => {}).steps).toBe(0);
    expect(loop.advance(NaN, () => {}).steps).toBe(0);
    expect(loop.advance(Infinity, () => {}).steps).toBe(0);
    loop.advance(FIXED * 0.9, () => {});
    loop.reset();
    const r = loop.advance(FIXED * 0.5, () => {});
    expect(r.steps).toBe(0);
    expect(r.alpha).toBeCloseTo(0.5, 9);
  });
  it('works with the configured sim constants', () => {
    const loop = new FixedStepLoop(CONFIG.sim.fixedDt, CONFIG.sim.maxSubSteps, CONFIG.sim.maxFrameDt);
    expect(loop.advance(1 / 60, () => {}).steps).toBe(2);
  });
});

describe('FPS meter', () => {
  function feed(dts: number[]) {
    const m = createFpsMeter();
    let now = 0;
    for (const dt of dts) {
      now += dt;
      recordFrame(m, dt, now);
    }
    return m;
  }
  it('reports 60 fps for a steady 60 Hz stream', () => {
    const s = fpsStats(feed(new Array(180).fill(1 / 60)));
    expect(s.fps).toBeCloseTo(60, 0);
    expect(s.avg).toBeCloseTo(60, 0);
    expect(s.min).toBeCloseTo(60, 0);
    expect(s.onePercentLow).toBeCloseTo(60, 0);
    expect(s.longFrames).toBe(0);
    expect(s.frames).toBe(180);
  });
  it('an empty meter reports zeros, not NaN', () => {
    const s = fpsStats(createFpsMeter());
    for (const v of Object.values(s)) expect(Number.isFinite(v)).toBe(true);
    expect(s.frames).toBe(0);
  });
  it('a hitch shows in min, 1% low and longFrames but barely moves the average', () => {
    const dts = [...new Array(300).fill(1 / 60), 0.2, ...new Array(300).fill(1 / 60)];
    const s = fpsStats(feed(dts));
    expect(s.longFrames).toBe(1);
    expect(s.frames).toBe(601);
    expect(s.min).toBeLessThan(55);
    expect(s.onePercentLow).toBeLessThan(30);
    expect(s.avg).toBeGreaterThan(55);
    expect(s.fps).toBeCloseTo(60, 0); // the last second is clean again
  });
  it('fps follows the last second: a drop to 30 Hz is reported within about a second', () => {
    const dts = [...new Array(120).fill(1 / 60), ...new Array(40).fill(1 / 30)];
    const s = fpsStats(feed(dts));
    expect(s.fps).toBeCloseTo(30, 0);
    expect(s.min).toBeLessThanOrEqual(31);
    expect(s.avg).toBeGreaterThan(30);
    expect(s.avg).toBeLessThan(60);
  });
  it('counts frames longer than 50 ms', () => {
    const s = fpsStats(feed([1 / 60, 0.051, 0.049, 0.3, 1 / 60]));
    expect(s.longFrames).toBe(2);
  });
});

describe('interpolatePose', () => {
  const prev = { position: { x: 0, y: 10, z: 0 }, orientation: quatFromEuler(0, 0, 0) };
  const next = { position: { x: 10, y: 20, z: -40 }, orientation: quatFromEuler(90, 0, 0) };
  it('returns the endpoints at alpha 0 and 1', () => {
    const a = interpolatePose(prev, next, 0);
    expect(a.position).toEqual(prev.position);
    expect(eulerFromQuat(a.orientation).headingDeg).toBeCloseTo(0, 6);
    const b = interpolatePose(prev, next, 1);
    expect(b.position.x).toBeCloseTo(10, 9);
    expect(b.position.z).toBeCloseTo(-40, 9);
    expect(eulerFromQuat(b.orientation).headingDeg).toBeCloseTo(90, 6);
  });
  it('lerps the position and slerps the orientation at the midpoint', () => {
    const m = interpolatePose(prev, next, 0.5);
    expect(m.position).toEqual({ x: 5, y: 15, z: -20 });
    const e = eulerFromQuat(m.orientation);
    expect(e.headingDeg).toBeCloseTo(45, 6);
    expect(e.pitchDeg).toBeCloseTo(0, 6);
    expect(Math.hypot(m.orientation.x, m.orientation.y, m.orientation.z, m.orientation.w)).toBeCloseTo(1, 9);
  });
  it('takes the short way round (359° → 1°)', () => {
    const a = { position: prev.position, orientation: quatFromEuler(359, 0, 0) };
    const b = { position: prev.position, orientation: quatFromEuler(1, 0, 0) };
    const e = eulerFromQuat(interpolatePose(a, b, 0.5).orientation);
    expect(Math.min(e.headingDeg, 360 - e.headingDeg)).toBeCloseTo(0, 5);
  });
  it('does not mutate its inputs', () => {
    const snap = JSON.stringify([prev, next]);
    interpolatePose(prev, next, 0.3);
    expect(JSON.stringify([prev, next])).toBe(snap);
  });
});
