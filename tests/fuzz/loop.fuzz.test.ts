/**
 * Property tests for the frame plumbing: the fixed-step accumulator
 * (src/game/loop.ts), the fps meter (src/game/fps.ts) and render interpolation
 * (src/game/interpolate.ts), under random frame-time sequences.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import { FixedStepLoop } from '../../src/game/loop';
import { createFpsMeter, fpsStats, recordFrame } from '../../src/game/fps';
import { interpolatePose } from '../../src/game/interpolate';
import { CONFIG } from '../../src/config';
import { fcParams } from '../support/fc';
import { hostileNum, num, unitQuat, vec3 } from '../support/arbitraries';
import { firstNonFinite, quatNorm } from '../support/invariants';

const S = CONFIG.sim;
const frameDt = fc.oneof(
  { weight: 10, arbitrary: num(0, 0.05) },
  { weight: 3, arbitrary: num(0, 0.3) },
  { weight: 2, arbitrary: fc.constantFrom(1 / 60, 1 / 144, 1 / 30, 0, 0.25, 1, 10) },
  { weight: 1, arbitrary: hostileNum },
  { weight: 1, arbitrary: num(-1, 0) },
);
const loopParams = fc.record({
  fixedDt: fc.oneof(fc.constant(S.fixedDt), num(0.001, 0.05)),
  maxSubSteps: fc.oneof(fc.constant(S.maxSubSteps), fc.integer({ min: 1, max: 20 })),
  maxFrameDt: fc.oneof(fc.constant(S.maxFrameDt), num(0.01, 1)),
});

describe('FixedStepLoop', () => {
  it('steps ≤ maxSubSteps, alpha ∈ [0, 1), every step is exactly fixedDt, simulated time ≤ wall time', () => {
    fc.assert(fc.property(loopParams, fc.array(frameDt, { maxLength: 400 }), (p, dts) => {
      const loop = new FixedStepLoop(p.fixedDt, p.maxSubSteps, p.maxFrameDt);
      let wall = 0;
      let sim = 0;
      for (const dt of dts) {
        let n = 0;
        const { steps, alpha } = loop.advance(dt, (h) => {
          if (h !== p.fixedDt) throw new Error(`step of ${h}`);
          n++;
        });
        if (steps !== n) throw new Error(`reported ${steps} steps, ran ${n}`);
        if (steps > p.maxSubSteps) throw new Error(`${steps} > maxSubSteps`);
        if (!(alpha >= 0 && alpha < 1)) throw new Error(`alpha ${alpha}`);
        wall += Number.isFinite(dt) && dt > 0 ? Math.min(dt, p.maxFrameDt) : 0;
        sim += steps * p.fixedDt;
        if (sim > wall + 1e-9 * (1 + dts.length)) throw new Error(`sim ${sim} ahead of (clamped) wall ${wall}`);
      }
    }), fcParams(400));
  });

  it('when frames never saturate maxSubSteps, sim + alpha·fixedDt tracks wall time exactly (nothing dropped)', () => {
    fc.assert(fc.property(fc.array(num(0, (S.maxSubSteps - 1) * S.fixedDt), { maxLength: 600 }), (dts) => {
      const loop = new FixedStepLoop(S.fixedDt, S.maxSubSteps, S.maxFrameDt);
      let wall = 0;
      let sim = 0;
      for (const dt of dts) {
        const { steps, alpha } = loop.advance(dt, () => {});
        wall += dt;
        sim += steps * S.fixedDt;
        const lag = wall - (sim + alpha * S.fixedDt);
        if (Math.abs(lag) > 1e-8) throw new Error(`lost ${lag} s`);
      }
    }), fcParams(300));
  });

  it('reset() clears the accumulator', () => {
    fc.assert(fc.property(fc.array(frameDt, { maxLength: 50 }), (dts) => {
      const loop = new FixedStepLoop(S.fixedDt, S.maxSubSteps, S.maxFrameDt);
      for (const dt of dts) loop.advance(dt, () => {});
      loop.reset();
      const r = loop.advance(0, () => {});
      return r.steps === 0 && r.alpha === 0;
    }), fcParams(200));
  });
});

describe('fps meter', () => {
  // Real frame times are ≥ the timer resolution (~5 µs); a subnormal "frame" would make 1/dt overflow.
  const fpsDt = fc.oneof(
    { weight: 10, arbitrary: num(1e-6, 0.05) },
    { weight: 3, arbitrary: num(1e-6, 2) },
    { weight: 1, arbitrary: fc.constantFrom(0, -0.01, NaN, Infinity, -Infinity) },
  );

  it('stats stay finite and non-negative; frames and long frames are counted; 1 % low ≤ average', () => {
    fc.assert(fc.property(num(0, 1e6), fc.array(fpsDt, { maxLength: 1500 }), (t0, dts) => {
      const m = createFpsMeter();
      let now = t0;
      let valid = 0;
      let long = 0;
      for (const dt of dts) {
        if (Number.isFinite(dt) && dt > 0) {
          now += dt;
          valid++;
          if (dt > 0.05) long++;
        }
        recordFrame(m, dt, now);
      }
      const st = fpsStats(m);
      const nf = firstNonFinite(st);
      if (nf) throw new Error(`non-finite ${nf}`);
      for (const [k, v] of Object.entries(st)) if (v < 0) throw new Error(`${k} = ${v}`);
      if (st.frames !== valid) throw new Error(`frames ${st.frames} ≠ ${valid}`);
      if (st.longFrames !== long) throw new Error(`longFrames ${st.longFrames} ≠ ${long}`);
      if (st.onePercentLow > st.avg * (1 + 1e-9) + 1e-9) throw new Error(`1% low ${st.onePercentLow} > avg ${st.avg}`);
    }), fcParams(200));
  });

  it('a steady frame rate is reported as that rate (fps, avg, min, 1 % low)', () => {
    fc.assert(fc.property(num(20, 240), fc.integer({ min: 2, max: 6 }), (hz, seconds) => {
      const m = createFpsMeter();
      const dt = 1 / hz;
      let now = 0;
      for (let i = 0; i < Math.round(hz * seconds); i++) { now += dt; recordFrame(m, dt, now); }
      const st = fpsStats(m);
      const ok = (v: number) => Math.abs(v - hz) / hz < 0.02;
      return ok(st.fps) && ok(st.avg) && ok(st.onePercentLow) && ok(st.min);
    }), fcParams(100));
  });
});

describe('interpolatePose', () => {
  const pose = fc.record({ position: vec3(5e4), orientation: unitQuat });

  it('alpha 0 → prev, alpha 1 → next, unit orientation, position on the segment, NaN → next', () => {
    fc.assert(fc.property(pose, pose, num(0, 1), (a, b, t) => {
      const same = (p: typeof a['orientation'], q: typeof a['orientation']) =>
        Math.abs(Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w) - 1) < 1e-9;
      const at0 = interpolatePose(a, b, 0);
      const at1 = interpolatePose(a, b, 1);
      const mid = interpolatePose(a, b, t);
      const nan = interpolatePose(a, b, NaN);
      const tol = 1e-9 * 5e4;
      const onSeg = (['x', 'y', 'z'] as const).every((k) =>
        mid.position[k] >= Math.min(a.position[k], b.position[k]) - tol && mid.position[k] <= Math.max(a.position[k], b.position[k]) + tol);
      return (['x', 'y', 'z'] as const).every((k) => Math.abs(at0.position[k] - a.position[k]) <= tol && Math.abs(at1.position[k] - b.position[k]) <= tol)
        && same(at0.orientation, a.orientation) && same(at1.orientation, b.orientation)
        && Math.abs(quatNorm(mid.orientation) - 1) < 1e-9 && onSeg
        && same(nan.orientation, b.orientation);
    }), fcParams(500));
  });

  it('finite alpha outside [0, 1] is clamped; any non-finite alpha shows the newest state', () => {
    fc.assert(fc.property(pose, pose, fc.oneof(num(-1e6, -1e-9), num(1 + 1e-9, 1e6), fc.constantFrom(Infinity, -Infinity, NaN)), (a, b, t) => {
      const r = interpolatePose(a, b, t);
      const end = Number.isFinite(t) && t < 0 ? a : b;
      return (['x', 'y', 'z'] as const).every((k) => Math.abs(r.position[k] - end.position[k]) <= 1e-6)
        && Math.abs(quatNorm(r.orientation) - 1) < 1e-9;
    }), fcParams(300));
  });
});
