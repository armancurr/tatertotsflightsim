/**
 * Property tests for src/math (quat.ts, vec3.ts).
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  qConj, qFromAxisAngle, qIdentity, qIntegrateBody, qMul, qNormalize, qRotate, qRotateInverse, qSlerp,
} from '../../src/math/quat';
import { clamp, expApproach, moveToward, vLength, vNormalize, wrap180, wrap360 } from '../../src/math/vec3';
import type { Quat, Vec3 } from '../../src/types';
import { fcParams } from '../support/fc';
import { num, unitQuat, vec3 } from '../support/arbitraries';
import { quatNorm } from '../support/invariants';

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const vecNear = (a: Vec3, b: Vec3, tol: number) => near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.z, b.z, tol);
/** Same rotation (q and −q are the same rotation). */
const sameRotation = (a: Quat, b: Quat, tol: number) =>
  Math.abs(Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) - 1) <= tol;

const unitAxis = vec3(1).filter((v) => vLength(v) > 0.1).map(vNormalize);

describe('quaternion properties', () => {
  it('rotation preserves vector length', () => {
    fc.assert(fc.property(unitQuat, vec3(1e4), (q, v) => {
      const r = qRotate(q, v);
      return near(vLength(r), vLength(v), 1e-9 * Math.max(1, vLength(v)));
    }), fcParams(500));
  });

  it('rotate ∘ inverse-rotate is the identity (both orders)', () => {
    fc.assert(fc.property(unitQuat, vec3(1e4), (q, v) => {
      const tol = 1e-9 * Math.max(1, vLength(v));
      return vecNear(qRotateInverse(q, qRotate(q, v)), v, tol) && vecNear(qRotate(q, qRotateInverse(q, v)), v, tol);
    }), fcParams(500));
  });

  it('q · q* = identity and rotation by a product = composition of rotations', () => {
    fc.assert(fc.property(unitQuat, unitQuat, vec3(100), (a, b, v) => {
      const id = qMul(a, qConj(a));
      const composed = qRotate(qMul(a, b), v);
      const chained = qRotate(a, qRotate(b, v));
      return sameRotation(id, qIdentity(), 1e-12) && vecNear(composed, chained, 1e-9 * Math.max(1, vLength(v)));
    }), fcParams(300));
  });

  it('qIntegrateBody keeps unit norm over long random integrations', () => {
    const omega = fc.record({ x: num(-20, 20), y: num(-20, 20), z: num(-20, 20) });
    fc.assert(fc.property(unitQuat, fc.array(fc.tuple(omega, num(0, 0.25)), { minLength: 1, maxLength: 400 }), (q0, steps) => {
      let q = q0;
      for (const [w, dt] of steps) {
        q = qIntegrateBody(q, w, dt);
        if (!Number.isFinite(q.x + q.y + q.z + q.w) || Math.abs(quatNorm(q) - 1) > 1e-12) return false;
      }
      return true;
    }), fcParams(200));
  });

  it('qIntegrateBody about a fixed body axis matches the exact axis-angle rotation', () => {
    fc.assert(fc.property(unitQuat, unitAxis, num(-10, 10), fc.integer({ min: 1, max: 200 }), num(0.001, 0.05), (q0, axis, rate, n, dt) => {
      let q = q0;
      const w = { x: axis.x * rate, y: axis.y * rate, z: axis.z * rate };
      for (let i = 0; i < n; i++) q = qIntegrateBody(q, w, dt);
      const exact = qMul(q0, qFromAxisAngle(axis, rate * dt * n));
      return sameRotation(q, exact, 1e-9);
    }), fcParams(200));
  });

  it('slerp stays unit for t in [0,1] and hits both endpoints', () => {
    fc.assert(fc.property(unitQuat, unitQuat, num(0, 1), (a, b, t) => {
      const m = qSlerp(a, b, t);
      return near(quatNorm(m), 1, 1e-9)
        && sameRotation(qSlerp(a, b, 0), a, 1e-9)
        && sameRotation(qSlerp(a, b, 1), b, 1e-9);
    }), fcParams(500));
  });

  it('slerp moves monotonically: the angle to `a` grows with t (constant angular velocity)', () => {
    const angle = (p: Quat, q: Quat) => 2 * Math.acos(Math.min(1, Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w)));
    fc.assert(fc.property(unitQuat, unitQuat, num(0, 1), num(0, 1), (a, b, t1, t2) => {
      const [lo, hi] = t1 < t2 ? [t1, t2] : [t2, t1];
      const total = angle(a, b);
      const aLo = angle(a, qSlerp(a, b, lo));
      const aHi = angle(a, qSlerp(a, b, hi));
      return aLo <= aHi + 1e-6 && near(aHi, hi * total, 2e-3 + 1e-3 * total);
    }), fcParams(300));
  });

  it('qNormalize returns a unit quaternion for any non-degenerate input, identity for zero', () => {
    fc.assert(fc.property(num(-1e6, 1e6), num(-1e6, 1e6), num(-1e6, 1e6), num(-1e6, 1e6), (x, y, z, w) => {
      const n = qNormalize({ x, y, z, w });
      const l = Math.hypot(x, y, z, w);
      // Above the degeneracy threshold: unit. Exactly zero: identity. (In between either is acceptable.)
      if (l > 1e-9) return near(quatNorm(n), 1, 1e-12);
      if (l === 0) return n.w === 1 && n.x === 0 && n.y === 0 && n.z === 0;
      return near(quatNorm(n), 1, 1e-12);
    }), fcParams(300));
  });
});

describe('scalar helpers', () => {
  const anyDeg = num(-1e7, 1e7);

  it('wrap360 ∈ [0, 360) and differs from the input by a whole number of turns', () => {
    fc.assert(fc.property(anyDeg, (d) => {
      const w = wrap360(d);
      const turns = (d - w) / 360;
      return w >= 0 && w < 360 && near(turns, Math.round(turns), 1e-6);
    }), fcParams(1000));
  });

  it('wrap180 ∈ (−180, 180] and agrees with wrap360 modulo 360', () => {
    fc.assert(fc.property(anyDeg, (d) => {
      const w = wrap180(d);
      return w > -180 && w <= 180 && near(wrap360(w), wrap360(d), 1e-9);
    }), fcParams(1000));
  });

  it('clamp lands in [lo, hi], is idempotent and is the identity inside the range', () => {
    fc.assert(fc.property(num(-1e9, 1e9), num(-1e6, 1e6), num(0, 1e6), (x, lo, width) => {
      const hi = lo + width;
      const c = clamp(x, lo, hi);
      return c >= lo && c <= hi && clamp(c, lo, hi) === c && (x < lo || x > hi || c === x);
    }), fcParams(1000));
  });

  it('moveToward never overshoots, moves at most maxDelta, and arrives exactly', () => {
    fc.assert(fc.property(num(-1e6, 1e6), num(-1e6, 1e6), num(0, 1e5), (cur, target, maxD) => {
      const r = moveToward(cur, target, maxD);
      const lo = Math.min(cur, target);
      const hi = Math.max(cur, target);
      const moved = Math.abs(r - cur);
      const arrived = Math.abs(target - cur) <= maxD ? r === target : true;
      return r >= lo && r <= hi && moved <= maxD * (1 + 1e-12) + 1e-9 && arrived;
    }), fcParams(1000));
  });

  it('expApproach stays between current and target, and is frame-rate independent', () => {
    fc.assert(fc.property(num(-1e4, 1e4), num(-1e4, 1e4), num(0.001, 10), num(0, 1), num(0, 1), (cur, target, tau, dt1, dt2) => {
      const one = expApproach(cur, target, tau, dt1);
      const lo = Math.min(cur, target) - 1e-9;
      const hi = Math.max(cur, target) + 1e-9;
      const split = expApproach(expApproach(cur, target, tau, dt1), target, tau, dt2);
      const whole = expApproach(cur, target, tau, dt1 + dt2);
      const scale = Math.max(1, Math.abs(cur), Math.abs(target));
      return one >= lo && one <= hi && near(split, whole, 1e-9 * scale)
        && near(expApproach(cur, target, tau, 0), cur, 1e-12 * scale) && expApproach(cur, target, 0, dt1) === target;
    }), fcParams(1000));
  });
});
