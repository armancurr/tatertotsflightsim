/**
 * The rotary cannon: barrel spin-up / spin-down, rate of fire with sub-frame round times, ammo,
 * the gunFiring logic, reload, and the circular-Gaussian dispersion. Unit + fast-check fuzz.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_WEAPONS, F16_WEAPONS } from '../../src/config';
import { createGunState, reloadGun, stepGun, newGunStep, disperse, GUN_MAX_ROUNDS_PER_STEP } from '../../src/combat/gun';
import { createRng } from '../../src/combat/rng';
import { fcParams } from '../support/fc';

const GAU8 = A10_WEAPONS.gun!;
const M61 = F16_WEAPONS.gun!;

/** Hold the trigger for `seconds` at a fixed frame rate; returns absolute round times. */
function hold(seconds: number, fps = 60, gun = GAU8, g = createGunState(gun)) {
  const times = new Float64Array(GUN_MAX_ROUNDS_PER_STEP);
  const out = newGunStep();
  const all: number[] = [];
  const dt = 1 / fps;
  let t = 0;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) {
    stepGun(g, gun, true, true, dt, times, out);
    for (let k = 0; k < out.count; k++) all.push(t + times[k]);
    t += dt;
  }
  return { all, g, out };
}

describe('gun: spin-up, rate of fire, ammo', () => {
  it('fires nothing before the barrels are at speed; the first round at spinUpS', () => {
    const { all } = hold(2);
    expect(all[0]).toBeGreaterThanOrEqual(GAU8.spinUpS - 1e-9);
    expect(all[0]).toBeLessThan(GAU8.spinUpS + 1 / 60);
  });

  it('then ≈ 65 rounds/s (3,900 rpm), evenly spaced across frames (no clumping)', () => {
    const { all } = hold(3.55);
    const rate = (all.length - 1) / (all[all.length - 1] - all[0]);
    expect(rate).toBeGreaterThan(64);
    expect(rate).toBeLessThan(66);
    expect(all.length).toBeGreaterThan(190);
    expect(all.length).toBeLessThan(198);
    for (let i = 1; i < all.length; i++) expect(all[i] - all[i - 1]).toBeCloseTo(1 / GAU8.rateRps, 6);
  });

  it('the M61A1 runs at ≈ 100 rounds/s after its 0.3 s spin-up', () => {
    const { all } = hold(1.3, 60, M61);
    expect(all[0]).toBeGreaterThanOrEqual(M61.spinUpS - 1e-9);
    const rate = (all.length - 1) / (all[all.length - 1] - all[0]);
    expect(rate).toBeCloseTo(100, 0);
  });

  it('counts the ammunition down and stops at 0 (then just clicks: barrels turn, nothing leaves)', () => {
    const g = createGunState(GAU8);
    g.rounds = 10;
    const { all, out } = hold(2, 60, GAU8, g);
    expect(all).toHaveLength(10);
    expect(g.rounds).toBe(0);
    expect(out.firing).toBe(false);
    expect(g.spin).toBe(1);
  });

  it('reload fills the magazine and stops the barrels', () => {
    const { g } = hold(1);
    expect(g.rounds).toBeLessThan(GAU8.rounds);
    reloadGun(g, GAU8);
    expect(g.rounds).toBe(GAU8.rounds);
    expect(g.spin).toBe(0);
    expect(g.firing).toBe(false);
  });

  it('spins down over spinDownS after the trigger is released', () => {
    const g = createGunState(GAU8);
    const times = new Float64Array(GUN_MAX_ROUNDS_PER_STEP);
    const out = newGunStep();
    for (let i = 0; i < 60; i++) stepGun(g, GAU8, true, true, 1 / 60, times, out);
    expect(g.spin).toBe(1);
    stepGun(g, GAU8, false, true, GAU8.spinDownS / 2, times, out);
    expect(g.spin).toBeCloseTo(0.5, 6);
    expect(out.firing).toBe(false);
    expect(out.count).toBe(0);
    stepGun(g, GAU8, false, true, GAU8.spinDownS, times, out);
    expect(g.spin).toBe(0);
  });
});

describe('gun: gunFiring logic and burst events', () => {
  const run = (trigger: boolean, allowed: boolean, rounds = GAU8.rounds, spin = 1) => {
    const g = createGunState(GAU8);
    g.spin = spin;
    g.rounds = rounds;
    const out = newGunStep();
    stepGun(g, GAU8, trigger, allowed, 1 / 60, new Float64Array(GUN_MAX_ROUNDS_PER_STEP), out);
    return out;
  };
  it('fires only with the trigger, the barrels at speed, rounds left and firing allowed', () => {
    expect(run(true, true).firing).toBe(true);
    expect(run(false, true).firing).toBe(false);
    expect(run(true, true, GAU8.rounds, 0).firing).toBe(false);
    expect(run(true, true, 0).firing).toBe(false);
    expect(run(true, false).firing).toBe(false); // crashed
  });

  it('reports a burst start, then its stop with the rounds fired', () => {
    const g = createGunState(GAU8);
    const times = new Float64Array(GUN_MAX_ROUNDS_PER_STEP);
    const out = newGunStep();
    let started = 0;
    let fired = 0;
    for (let i = 0; i < 90; i++) {
      stepGun(g, GAU8, true, true, 1 / 60, times, out);
      if (out.started) started++;
      fired += out.count;
    }
    expect(started).toBe(1);
    stepGun(g, GAU8, false, true, 1 / 60, times, out);
    expect(out.stopped).toBe(true);
    expect(out.burst).toBe(fired);
    expect(GAU8.rounds - g.rounds).toBe(fired);
  });

  it('a null gun (the Cessna) never fires', () => {
    const g = createGunState(null);
    const out = newGunStep();
    stepGun(g, null, true, true, 1, new Float64Array(GUN_MAX_ROUNDS_PER_STEP), out);
    expect(out.firing).toBe(false);
    expect(out.count).toBe(0);
    expect(g.rounds).toBe(0);
  });

  it('fuzz: any frame-rate schedule fires at the rate, never more rounds than loaded, times inside the frame', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dt: fc.double({ min: 0, max: 0.25, noNaN: true }), trigger: fc.boolean() }), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 1150 }),
        (frames, rounds) => {
          const g = createGunState(GAU8);
          g.rounds = rounds;
          const times = new Float64Array(GUN_MAX_ROUNDS_PER_STEP);
          const out = newGunStep();
          let fired = 0;
          let firingTime = 0;
          for (const f of frames) {
            stepGun(g, GAU8, f.trigger, true, f.dt, times, out);
            for (let k = 0; k < out.count; k++) {
              expect(times[k]).toBeGreaterThanOrEqual(-1e-9);
              expect(times[k]).toBeLessThanOrEqual(f.dt + 1e-9);
            }
            fired += out.count;
            if (out.firing) firingTime += f.dt;
            expect(g.spin).toBeGreaterThanOrEqual(0);
            expect(g.spin).toBeLessThanOrEqual(1);
          }
          expect(fired).toBe(rounds - g.rounds);
          expect(g.rounds).toBeGreaterThanOrEqual(0);
          // Never faster than the rate (one extra round for the first of each burst).
          expect(fired).toBeLessThanOrEqual(Math.ceil(firingTime * GAU8.rateRps) + frames.length);
        },
      ),
      fcParams(200),
    );
  });
});

describe('gun: dispersion (circular Gaussian, 80 % inside dispersionMrad)', () => {
  it('≈ 80 % of 20,000 rounds fall inside the r80 cone, ≈ 99 % inside 1.7 × r80', () => {
    const rng = createRng(1234);
    const o = { a: 0, b: 0 };
    let in80 = 0;
    let in170 = 0;
    const n = 20000;
    const r80 = GAU8.dispersionMrad / 1000;
    for (let i = 0; i < n; i++) {
      disperse(rng, GAU8.dispersionMrad, o);
      const r = Math.hypot(o.a, o.b);
      if (r <= r80) in80++;
      if (r <= 1.7 * r80) in170++;
    }
    expect(in80 / n).toBeGreaterThan(0.785);
    expect(in80 / n).toBeLessThan(0.815);
    expect(in170 / n).toBeGreaterThan(0.98);
  });

  it('is centred (no bias) and isotropic', () => {
    const rng = createRng(99);
    const o = { a: 0, b: 0 };
    let sa = 0, sb = 0, saa = 0, sbb = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      disperse(rng, 5, o);
      sa += o.a; sb += o.b; saa += o.a * o.a; sbb += o.b * o.b;
    }
    const sigma = 5e-3 / 1.794;
    expect(Math.abs(sa / n)).toBeLessThan(0.05 * sigma);
    expect(Math.abs(sb / n)).toBeLessThan(0.05 * sigma);
    expect(Math.sqrt(saa / n) / sigma).toBeCloseTo(1, 1);
    expect(Math.sqrt(sbb / n) / sigma).toBeCloseTo(1, 1);
  });
});
