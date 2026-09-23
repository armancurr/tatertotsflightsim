/**
 * Unit + fuzz: the PURE combat-effects plan — which recipe each impact surface gets, dust colours,
 * the deterministic secondary explosion of a destroyed vehicle, and the camera-shake laws (gun
 * vibration, blasts arriving at the speed of sound and decaying).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  impactClass, dustAlbedo, secondaryPlan, gunShake, blastShake, combineShake, soundArrivalS, isAirBurst,
} from '../../../src/combat/fx/plan';
import { CONFIG } from '../../../src/config';
import type { TargetKind } from '../../../src/combat/types';

const C = CONFIG.fx.combat;
const KINDS: TargetKind[] = ['tank', 'ifv', 'apc', 'truck', 'aaa'];

describe('impact surface → recipe', () => {
  it('soft ground kicks up dust, pavement/rock sparks, water splashes, targets are armour', () => {
    for (const s of ['dirt', 'field', 'grass', 'sand', 'forest'] as const) expect(impactClass(s)).toBe('soil');
    for (const s of ['runway', 'asphalt', 'urban', 'rock'] as const) expect(impactClass(s)).toBe('hard');
    expect(impactClass('water')).toBe('water');
    expect(impactClass('snow')).toBe('snow');
    expect(impactClass('target')).toBe('armour');
  });
  it('anything unknown is treated as soil (never throws)', () => {
    expect(impactClass('lava' as never)).toBe('soil');
    expect(impactClass(undefined as never)).toBe('soil');
  });
  it('dust colours: sand is paler than dirt, pavement dust is grey, snow and water white', () => {
    const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    expect(lum(dustAlbedo('sand'))).toBeGreaterThan(lum(dustAlbedo('dirt')));
    const g = dustAlbedo('asphalt');
    expect(Math.abs(g[0] - g[2])).toBeLessThan(0.05);
    const d = dustAlbedo('dirt');
    expect(d[0]).toBeGreaterThan(d[2]); // brown
    expect(lum(dustAlbedo('snow'))).toBeGreaterThan(0.8);
    expect(lum(dustAlbedo('water'))).toBeGreaterThan(0.8);
  });
});

describe('secondary explosion of a destroyed vehicle', () => {
  it('a tank always cooks off 0.3–1.5 s after the kill; the plan is deterministic', () => {
    for (let id = 1; id < 60; id++) {
      const p = secondaryPlan(id, 'tank', id * 1.7);
      expect(p.delayS).not.toBeNull();
      expect(p.delayS!).toBeGreaterThanOrEqual(C.destroyed.secondary[0]);
      expect(p.delayS!).toBeLessThanOrEqual(C.destroyed.secondary[1]);
      expect(p.size).toBeGreaterThan(0.2);
      expect(p.size).toBeLessThanOrEqual(1);
      expect(secondaryPlan(id, 'tank', id * 1.7)).toEqual(p);
    }
  });
  it('lighter vehicles only sometimes have one (by their configured chance)', () => {
    let n = 0;
    for (let id = 1; id <= 400; id++) if (secondaryPlan(id, 'truck', 3).delayS !== null) n++;
    expect(n / 400).toBeGreaterThan(C.destroyed.secondaryChance.truck - 0.12);
    expect(n / 400).toBeLessThan(C.destroyed.secondaryChance.truck + 0.12);
  });
  it('fuzz: any id/time/kind gives a delay in range or none, a finite size', () => {
    fc.assert(
      fc.property(fc.integer(), fc.double(), fc.constantFrom(...KINDS), (id, t, kind) => {
        const p = secondaryPlan(id, kind, t);
        if (p.delayS !== null) {
          expect(p.delayS).toBeGreaterThanOrEqual(C.destroyed.secondary[0]);
          expect(p.delayS).toBeLessThanOrEqual(C.destroyed.secondary[1]);
        }
        expect(Number.isFinite(p.size)).toBe(true);
      }),
    );
  });
});

describe('camera shake', () => {
  it('the GAU-8 vibrates the cockpit strongly, the outside views lightly, only while it fires', () => {
    const cock = gunShake(1, true, true);
    const out = gunShake(1, true, false);
    expect(cock).toBeCloseTo(C.shake.gunCockpit, 5);
    expect(out).toBeCloseTo(C.shake.gunOutside, 5);
    expect(cock).toBeGreaterThan(out);
    expect(gunShake(1, false, true)).toBe(0);
    expect(gunShake(0.3, true, true)).toBeLessThan(cock);
  });
  it('a blast shakes only once its pressure wave arrives (d / 343 m/s), then decays', () => {
    const d = 343;
    expect(soundArrivalS(d)).toBeCloseTo(1, 5);
    expect(blastShake(1, d, 0.5)).toBe(0); // not arrived yet
    const at = blastShake(1, d, 1.0);
    expect(at).toBeGreaterThan(0);
    expect(blastShake(1, d, 1.5)).toBeLessThan(at);
    expect(blastShake(1, d, 5)).toBeLessThan(1e-3);
  });
  it('nearer and bigger blasts shake harder; never above blastMax', () => {
    expect(blastShake(1, 20, 0.06)).toBeGreaterThan(blastShake(1, 300, 0.875 + 0.001));
    expect(blastShake(1, 50, 0.146)).toBeGreaterThan(blastShake(0.4, 50, 0.146));
    expect(blastShake(2, 0, 0)).toBeLessThanOrEqual(C.shake.blastMax + 1e-9);
  });
  it('combining shakes never exceeds 1 and each source adds', () => {
    expect(combineShake(0.5, 0.5)).toBeCloseTo(0.75);
    expect(combineShake(1, 0.3)).toBe(1);
    expect(combineShake(0, 0.2)).toBeCloseTo(0.2);
  });
  it('fuzz: shake laws are total (garbage in → finite 0..1 out)', () => {
    const any = fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity), fc.constant(-Infinity));
    fc.assert(
      fc.property(any, any, any, fc.boolean(), fc.boolean(), (a, b, c, f, k) => {
        for (const v of [gunShake(a, f, k), blastShake(a, b, c), combineShake(a, b), soundArrivalS(a) / 1e9]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

describe('air burst', () => {
  it('a detonation more than airBurstM above the ground is an air burst', () => {
    expect(isAirBurst(10, 0)).toBe(true);
    expect(isAirBurst(1, 0)).toBe(false);
    expect(isAirBurst(Number.NaN, 0)).toBe(false);
  });
});
