import { describe, it, expect } from 'vitest';
import {
  quatFromEuler, eulerFromQuat, bodyAxesWorld, airDataFromBodyVelocity, pqrFromOmega,
  omegaFromPqr, torqueFromLMN, lmnFromTorque, worldToBody,
} from '../../src/physics/frames';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('frame conventions', () => {
  it('heading 0 points the nose north (-Z), heading 90 east (+X)', () => {
    close(bodyAxesWorld(quatFromEuler(0, 0, 0)).forward.z, -1);
    close(bodyAxesWorld(quatFromEuler(90, 0, 0)).forward.x, 1);
    close(bodyAxesWorld(quatFromEuler(180, 0, 0)).forward.z, 1);
    close(bodyAxesWorld(quatFromEuler(270, 0, 0)).forward.x, -1);
  });
  it('positive pitch raises the nose, positive roll lowers the right wing', () => {
    const q = quatFromEuler(0, 10, 0);
    expect(bodyAxesWorld(q).forward.y).toBeGreaterThan(0);
    const r = quatFromEuler(0, 0, 20);
    expect(bodyAxesWorld(r).right.y).toBeLessThan(0);
  });
  it('euler round-trips through the quaternion', () => {
    for (const [h, p, r] of [[0, 0, 0], [37, 12, -25], [270, -30, 60], [359, 5, 170], [123, 80, -45]]) {
      const e = eulerFromQuat(quatFromEuler(h, p, r));
      close(e.headingDeg, h, 1e-6); close(e.pitchDeg, p, 1e-6); close(e.rollDeg, r, 1e-6);
    }
  });
  it('angle of attack is positive when the air comes from below the nose', () => {
    // Flying north level at 50 m/s but sinking at 5 m/s, nose level → positive AoA.
    const q = quatFromEuler(0, 0, 0);
    const vb = worldToBody(q, { x: 0, y: -5, z: -50 });
    const ad = airDataFromBodyVelocity(vb);
    close(ad.alpha, Math.atan2(5, 50));
    close(ad.V, Math.hypot(5, 50));
    close(ad.beta, 0);
  });
  it('sideslip is positive when the air arrives from the right', () => {
    // Aircraft heading north but drifting east (to its right) relative to the air.
    const vb = worldToBody(quatFromEuler(0, 0, 0), { x: 5, y: 0, z: -50 });
    expect(airDataFromBodyVelocity(vb).beta).toBeGreaterThan(0);
  });
  it('p, q, r map to the body angular velocity with the documented signs', () => {
    expect(pqrFromOmega({ x: 0.1, y: 0, z: 0 }).q).toBeCloseTo(0.1); // +X = nose up
    expect(pqrFromOmega({ x: 0, y: 0, z: -0.2 }).p).toBeCloseTo(0.2); // -Z = right wing down
    expect(pqrFromOmega({ x: 0, y: -0.3, z: 0 }).r).toBeCloseTo(0.3); // -Y = nose right
    const w = omegaFromPqr(1, 2, 3);
    expect(pqrFromOmega(w)).toEqual({ p: 1, q: 2, r: 3 });
    expect(lmnFromTorque(torqueFromLMN(4, 5, 6))).toEqual({ L: 4, M: 5, N: 6 });
  });
});
