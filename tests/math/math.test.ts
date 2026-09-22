import { describe, it, expect } from 'vitest';
import { v3, vCross, vLength, vNormalize, moveToward, expApproach, wrap360, wrap180, clamp } from '../../src/math/vec3';
import { qFromAxisAngle, qRotate, qRotateInverse, qMul, qIntegrateBody, qSlerp, qIdentity } from '../../src/math/quat';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('vec3 helpers', () => {
  it('cross product follows the right-hand rule', () => {
    const z = vCross(v3(1, 0, 0), v3(0, 1, 0));
    expect(z).toEqual({ x: 0, y: 0, z: 1 });
  });
  it('normalizes and measures', () => {
    close(vLength(vNormalize(v3(3, 4, 12))), 1);
    expect(vNormalize(v3())).toEqual({ x: 0, y: 0, z: 0 });
  });
  it('moveToward never overshoots', () => {
    expect(moveToward(0, 1, 0.3)).toBeCloseTo(0.3);
    expect(moveToward(0.9, 1, 0.3)).toBe(1);
    expect(moveToward(0, -1, 0.5)).toBeCloseTo(-0.5);
  });
  it('expApproach is frame-rate independent', () => {
    let a = 0;
    for (let i = 0; i < 10; i++) a = expApproach(a, 1, 0.5, 0.01);
    const b = expApproach(0, 1, 0.5, 0.1);
    close(a, b, 1e-12);
  });
  it('wraps angles', () => {
    expect(wrap360(-10)).toBeCloseTo(350);
    expect(wrap360(725)).toBeCloseTo(5);
    expect(wrap180(190)).toBeCloseTo(-170);
    expect(clamp(5, 0, 1)).toBe(1);
  });
});

describe('quaternion helpers', () => {
  it('rotates a vector 90° about +Y (x → -z)', () => {
    const q = qFromAxisAngle(v3(0, 1, 0), Math.PI / 2);
    const r = qRotate(q, v3(1, 0, 0));
    close(r.x, 0); close(r.y, 0); close(r.z, -1);
  });
  it('inverse rotation undoes rotation', () => {
    const q = qMul(qFromAxisAngle(v3(0, 1, 0), 0.7), qFromAxisAngle(v3(1, 0, 0), -0.3));
    const v = v3(0.2, -1.5, 3);
    const back = qRotateInverse(q, qRotate(q, v));
    close(back.x, v.x); close(back.y, v.y); close(back.z, v.z);
  });
  it('integrating a body rate for 1 s rotates by rate radians', () => {
    let q = qIdentity();
    for (let i = 0; i < 120; i++) q = qIntegrateBody(q, v3(0.5, 0, 0), 1 / 120);
    const nose = qRotate(q, v3(0, 0, -1));
    // +X body rate pitches the nose (-Z) up.
    close(Math.asin(nose.y), 0.5, 1e-9);
  });
  it('slerp hits both ends and the middle', () => {
    const a = qIdentity();
    const b = qFromAxisAngle(v3(0, 1, 0), 1);
    const m = qSlerp(a, b, 0.5);
    const expected = qFromAxisAngle(v3(0, 1, 0), 0.5);
    close(m.w, expected.w, 1e-9); close(m.y, expected.y, 1e-9);
    expect(qSlerp(a, b, 0)).toEqual(a);
  });
});
