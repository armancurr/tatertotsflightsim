import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { rotorVibration, shakeTarget } from '../../src/camera/cameraRig';

const W = 12750;
const calm = { vrs: 0, bladeStall: 0, thrust: W };

describe('helicopter vibration → camera shake', () => {
  it('shudders through translational lift (10–22 kt) only while the rotor carries the aircraft', () => {
    expect(rotorVibration(calm, 0, W, true)).toBe(0);
    expect(rotorVibration(calm, 16, W, true)).toBeGreaterThan(0.08);
    expect(rotorVibration(calm, 60, W, true)).toBe(0);
    expect(rotorVibration(calm, 16, W, false)).toBe(0);
  });
  it('the vortex ring state and blade stall shake it harder', () => {
    expect(rotorVibration({ ...calm, vrs: 1 }, 5, W, true)).toBeGreaterThan(0.4);
    expect(rotorVibration({ ...calm, bladeStall: 1 }, 120, W, true)).toBeGreaterThan(0.4);
  });
  it('feeds the camera shake, and fixed-wing aircraft are unaffected', () => {
    const base = { onGround: false, groundSpeed: 0, stalled: false, crashAge: null };
    expect(shakeTarget(base)).toBe(0);
    expect(shakeTarget({ ...base, rotorVibration: 0.3 })).toBeCloseTo(0.3, 6);
  });
  it('is finite and in 0..1 for any input', () => {
    fc.assert(fc.property(fc.double(), fc.double(), fc.double(), fc.double(), fc.boolean(), (vrs, bs, thrust, ias, air) => {
      const v = rotorVibration({ vrs, bladeStall: bs, thrust }, ias, W, air);
      return Number.isFinite(v) && v >= 0 && v <= 1;
    }));
  });
});
