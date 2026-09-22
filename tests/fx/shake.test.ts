import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { cameraShakeFor, speedFovOffset, type ShakeInputs } from '../../src/fx/shake';
import { CONFIG } from '../../src/config';
import type { SurfaceType } from '../../src/types';

const S = CONFIG.fx.shake;
const calm: ShakeInputs = { onGround: false, groundSpeedKt: 0, surface: 'runway', aoaDeg: 3, stallAoaDeg: 16, airspeedKt: 100, vneKt: 163, crashAge: null };
const at = (p: Partial<ShakeInputs>) => cameraShakeFor({ ...calm, ...p });
const SURF = Object.keys(S.surfaceRoughness) as SurfaceType[];
const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));

describe('cameraShakeFor', () => {
  it('is 0 in calm cruise and at rest on the ground', () => {
    expect(at({})).toBe(0);
    expect(at({ onGround: true, groundSpeedKt: 0 })).toBe(0);
  });
  it('ground roll grows with speed; grass shakes more than the runway', () => {
    const slow = at({ onGround: true, groundSpeedKt: 15 });
    const fast = at({ onGround: true, groundSpeedKt: 55 });
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
    expect(at({ onGround: true, groundSpeedKt: 40, surface: 'grass' })).toBeGreaterThan(at({ onGround: true, groundSpeedKt: 40, surface: 'runway' }));
    expect(at({ onGround: false, groundSpeedKt: 55 })).toBe(0);
  });
  it('stall buffet builds as AoA approaches the stall', () => {
    expect(at({ aoaDeg: 10, airspeedKt: 55 })).toBe(0);
    const near = at({ aoaDeg: 14.5, airspeedKt: 50 });
    const past = at({ aoaDeg: 19, airspeedKt: 45 });
    expect(near).toBeGreaterThan(0);
    expect(past).toBeGreaterThan(near);
    expect(past).toBeCloseTo(S.buffetMax, 6);
  });
  it('overspeed vibration near Vne', () => {
    expect(at({ airspeedKt: 130 })).toBe(0);
    expect(at({ airspeedKt: 175 })).toBeGreaterThan(0.2);
  });
  it('a crash is a full shake that decays', () => {
    expect(at({ crashAge: 0 })).toBe(1);
    expect(at({ crashAge: 1 })).toBeLessThan(at({ crashAge: 0.2 }));
    expect(at({ crashAge: 30 })).toBeLessThan(0.01);
    expect(at({ crashAge: -1 })).toBe(0);
  });
  it('sources combine but never exceed 1', () => {
    const both = at({ onGround: true, groundSpeedKt: 60, surface: 'rock', aoaDeg: 20, airspeedKt: 60 });
    expect(both).toBeGreaterThan(at({ onGround: true, groundSpeedKt: 60, surface: 'rock', airspeedKt: 60 }));
    expect(both).toBeLessThanOrEqual(1);
  });
  it('fuzz: always finite in [0,1] for any input', () => {
    fc.assert(fc.property(fc.boolean(), wild, fc.constantFrom(...SURF, 'mystery' as SurfaceType), wild, wild, wild, wild, fc.option(wild, { nil: null }),
      (onGround, gs, surface, aoa, stall, ias, vne, crashAge) => {
        const v = cameraShakeFor({ onGround, groundSpeedKt: gs, surface, aoaDeg: aoa, stallAoaDeg: stall, airspeedKt: ias, vneKt: vne, crashAge });
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }));
  });
  it('fuzz: monotone in ground speed, AoA and airspeed; decreasing in crash age', () => {
    const n = (lo: number, hi: number) => fc.double({ min: lo, max: hi, noNaN: true });
    fc.assert(fc.property(n(0, 200), n(0, 200), n(-10, 40), n(-10, 40), n(0, 250), n(0, 250), n(0, 60), n(0, 60), fc.constantFrom(...SURF),
      (g1, g2, a1, a2, v1, v2, c1, c2, surface) => {
        const [gl, gh] = g1 <= g2 ? [g1, g2] : [g2, g1];
        const [al, ah] = a1 <= a2 ? [a1, a2] : [a2, a1];
        const [vl, vh] = v1 <= v2 ? [v1, v2] : [v2, v1];
        const [cl, ch] = c1 <= c2 ? [c1, c2] : [c2, c1];
        const b = { ...calm, surface, onGround: true };
        expect(cameraShakeFor({ ...b, groundSpeedKt: gl })).toBeLessThanOrEqual(cameraShakeFor({ ...b, groundSpeedKt: gh }) + 1e-12);
        expect(cameraShakeFor({ ...calm, aoaDeg: al })).toBeLessThanOrEqual(cameraShakeFor({ ...calm, aoaDeg: ah }) + 1e-12);
        expect(cameraShakeFor({ ...calm, aoaDeg: 3, airspeedKt: vl })).toBeLessThanOrEqual(cameraShakeFor({ ...calm, aoaDeg: 3, airspeedKt: vh }) + 1e-12);
        expect(cameraShakeFor({ ...calm, crashAge: ch })).toBeLessThanOrEqual(cameraShakeFor({ ...calm, crashAge: cl }) + 1e-12);
      }));
  });
});

describe('speedFovOffset', () => {
  const F = CONFIG.fx.fov;
  it('is 0 when slow, subtle and capped when fast', () => {
    expect(speedFovOffset(0)).toBe(0);
    expect(speedFovOffset(F.startKt)).toBe(0);
    expect(speedFovOffset(120)).toBeGreaterThan(0);
    expect(speedFovOffset(120)).toBeLessThan(F.maxDeg);
    expect(speedFovOffset(1000)).toBeCloseTo(F.maxDeg, 9);
    expect(F.maxDeg).toBeLessThanOrEqual(6);
  });
  it('fuzz: finite, within [0, maxDeg], monotone', () => {
    fc.assert(fc.property(wild, wild, (a, b) => {
      const fa = speedFovOffset(a);
      expect(Number.isFinite(fa)).toBe(true);
      expect(fa).toBeGreaterThanOrEqual(0);
      expect(fa).toBeLessThanOrEqual(F.maxDeg);
      if (Number.isFinite(a) && Number.isFinite(b) && a <= b) expect(fa).toBeLessThanOrEqual(speedFovOffset(b));
    }));
  });
});
