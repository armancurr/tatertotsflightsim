/**
 * Property tests for src/physics/frames.ts — the frame conventions every module relies on.
 */
import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  airDataFromBodyVelocity, bodyAxesWorld, bodyToWorld, eulerFromQuat, lmnFromTorque, omegaFromPqr, pqrFromOmega,
  quatFromEuler, torqueFromLMN, worldToBody,
} from '../../src/physics/frames';
import { vCross, vDot, vLength, wrap180 } from '../../src/math/vec3';
import type { Vec3 } from '../../src/types';
import { fcParams } from '../support/fc';
import { attitude, num, unitQuat, vec3 } from '../support/arbitraries';
import { quatNorm } from '../support/invariants';

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const vecNear = (a: Vec3, b: Vec3, tol: number) => near(a.x, b.x, tol) && near(a.y, b.y, tol) && near(a.z, b.z, tol);

describe('euler ↔ quaternion', () => {
  it('quatFromEuler is unit and eulerFromQuat inverts it (|pitch| ≤ 85°)', () => {
    fc.assert(fc.property(attitude(85), ({ heading, pitch, roll }) => {
      const q = quatFromEuler(heading, pitch, roll);
      const e = eulerFromQuat(q);
      return near(quatNorm(q), 1, 1e-12)
        && near(wrap180(e.headingDeg - heading), 0, 1e-7)
        && near(e.pitchDeg, pitch, 1e-7)
        && near(wrap180(e.rollDeg - roll), 0, 1e-7);
    }), fcParams(1000));
  });

  it('eulerFromQuat ranges: heading [0,360), pitch [−90,90], roll [−180,180] for any orientation', () => {
    fc.assert(fc.property(unitQuat, (q) => {
      const e = eulerFromQuat(q);
      return e.headingDeg >= 0 && e.headingDeg < 360 && e.pitchDeg >= -90 && e.pitchDeg <= 90
        && e.rollDeg >= -180 && e.rollDeg <= 180;
    }), fcParams(1000));
  });

  it('quat → euler → quat reproduces the rotation for any orientation away from vertical', () => {
    fc.assert(fc.property(unitQuat, (q) => {
      const e = eulerFromQuat(q);
      fc.pre(Math.abs(e.pitchDeg) < 85);
      const back = quatFromEuler(e.headingDeg, e.pitchDeg, e.rollDeg);
      return near(Math.abs(q.x * back.x + q.y * back.y + q.z * back.z + q.w * back.w), 1, 1e-9);
    }), fcParams(1000));
  });

  it('sign conventions: nose up ⇒ forward.y > 0, right wing down ⇒ right.y < 0, heading is the nose direction', () => {
    fc.assert(fc.property(attitude(80), ({ heading, pitch, roll }) => {
      const { forward, right } = bodyAxesWorld(quatFromEuler(heading, pitch, roll));
      const D = Math.PI / 180;
      const hdgOk = near(wrap180(Math.atan2(forward.x, -forward.z) / D - heading), 0, 1e-6);
      return near(forward.y, Math.sin(pitch * D), 1e-9)
        && (Math.abs(Math.sin(roll * D)) < 1e-6 || Math.sign(right.y) === -Math.sign(Math.sin(roll * D)))
        && hdgOk;
    }), fcParams(1000));
  });

  it('body axes are orthonormal and right-handed (right × up = back)', () => {
    fc.assert(fc.property(unitQuat, (q) => {
      const { forward, right, up } = bodyAxesWorld(q);
      const back = { x: -forward.x, y: -forward.y, z: -forward.z };
      return near(vLength(forward), 1, 1e-9) && near(vLength(right), 1, 1e-9) && near(vLength(up), 1, 1e-9)
        && near(vDot(forward, right), 0, 1e-9) && near(vDot(forward, up), 0, 1e-9) && near(vDot(right, up), 0, 1e-9)
        && vecNear(vCross(right, up), back, 1e-9);
    }), fcParams(500));
  });

  it('worldToBody and bodyToWorld are inverse', () => {
    fc.assert(fc.property(unitQuat, vec3(1e4), (q, v) => {
      const tol = 1e-9 * Math.max(1, vLength(v));
      return vecNear(bodyToWorld(q, worldToBody(q, v)), v, tol) && vecNear(worldToBody(q, bodyToWorld(q, v)), v, tol);
    }), fcParams(500));
  });
});

describe('air data', () => {
  it('α ∈ [−π, π], β ∈ [−π/2, π/2], V = |v|, and (V, α, β) reconstruct (u, v, w)', () => {
    fc.assert(fc.property(vec3(400), (vb) => {
      const a = airDataFromBodyVelocity(vb);
      const V = vLength(vb);
      if (!(a.alpha >= -Math.PI && a.alpha <= Math.PI && a.beta >= -Math.PI / 2 && a.beta <= Math.PI / 2)) return false;
      if (!near(a.V, V, 1e-9 * Math.max(1, V))) return false;
      if (V < 1e-6) return Number.isFinite(a.alpha) && a.beta === 0;
      const tol = 1e-7 * Math.max(1, V);
      return near(a.u, V * Math.cos(a.beta) * Math.cos(a.alpha), tol)
        && near(a.w, V * Math.cos(a.beta) * Math.sin(a.alpha), tol)
        && near(a.v, V * Math.sin(a.beta), tol);
    }), fcParams(1000));
  });

  it('flying straight along the nose gives α = β = 0; air from below gives α > 0; air from the right gives β > 0', () => {
    fc.assert(fc.property(num(1, 300), num(0.01, 1), (speed, k) => {
      const straight = airDataFromBodyVelocity({ x: 0, y: 0, z: -speed });
      // Aircraft sinking relative to its nose (body velocity has a −y component) → relative wind from below.
      const sinking = airDataFromBodyVelocity({ x: 0, y: -k * speed, z: -speed });
      // Aircraft moving right relative to its nose → relative wind from the right.
      const slipping = airDataFromBodyVelocity({ x: k * speed, y: 0, z: -speed });
      return straight.alpha === 0 && straight.beta === 0 && sinking.alpha > 0 && slipping.beta > 0;
    }), fcParams(300));
  });

  it('pqr ↔ ω and LMN ↔ torque are bijections', () => {
    fc.assert(fc.property(vec3(100), num(-100, 100), num(-100, 100), num(-100, 100), (w, a, b, c) => {
      const pqr = pqrFromOmega(w);
      const back = omegaFromPqr(pqr.p, pqr.q, pqr.r);
      const o = omegaFromPqr(a, b, c);
      const r2 = pqrFromOmega(o);
      const lmn = lmnFromTorque(torqueFromLMN(a, b, c));
      const t = torqueFromLMN(...(Object.values(lmnFromTorque(w)) as [number, number, number]));
      return vecNear(back, w, 0) && r2.p === a && r2.q === b && r2.r === c
        && lmn.L === a && lmn.M === b && lmn.N === c && vecNear(t, w, 0);
    }), fcParams(500));
  });
});
