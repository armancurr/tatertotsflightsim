import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createWaveSpectrum, getSeaSpectrum, waterSurfaceAt, newWaterSurfaceSample } from '../../../src/world/water/waves';
import { waveWeights, shoalFactor, hullWaveMotion, newWaveMotion } from '../../../src/world/traffic/buoyancy';

const sea = getSeaSpectrum();

describe('buoyancy: the water shader\'s displacement weights', () => {
  it('near the camera every train the grid can carry is in; nothing beyond the displacement range', () => {
    const w = new Float64Array(16);
    waveWeights(sea, 0, 1500, w);
    for (let i = 0; i < sea.trains.length; i++) {
      const lam = sea.trains[i].wavelength;
      // spacing 0.6 m: trains longer than 3 m fully in, shorter partially
      if (lam >= 3) expect(w[i]).toBeCloseTo(1, 6);
      expect(w[i]).toBeGreaterThanOrEqual(0);
    }
    waveWeights(sea, 1600, 1500, w);
    for (let i = 0; i < sea.trains.length; i++) expect(w[i]).toBe(0);
    // at 300 m the grid spacing is 13.5 m: short trains are gone, long ones remain
    waveWeights(sea, 300, 1500, w);
    for (let i = 0; i < sea.trains.length; i++) {
      if (sea.trains[i].wavelength < 33) expect(w[i]).toBe(0);
    }
    expect(Math.max(...w)).toBeGreaterThan(0);
  });

  it('shoaling: 0.3 in very shallow water, 1 beyond 8 m', () => {
    expect(shoalFactor(0)).toBeCloseTo(0.3);
    expect(shoalFactor(8)).toBeCloseTo(1);
    expect(shoalFactor(100)).toBeCloseTo(1);
    expect(shoalFactor(4)).toBeGreaterThan(0.3);
    expect(shoalFactor(4)).toBeLessThan(1);
  });
});

describe('buoyancy: hull motion on the waves', () => {
  it('a tiny float rides exactly on waterSurfaceAt (full weights)', () => {
    const w = new Float64Array(16).fill(1);
    const m = newWaveMotion();
    const s = newWaterSurfaceSample();
    for (const [x, z, t] of [[10, 20, 3], [-4700, 7900, 100.5], [1234, 9876, 777.7]]) {
      hullWaveMotion(sea, w, 1, x, z, t, 0, 0.01, 0.01, m);
      waterSurfaceAt(x, z, t, sea, s);
      expect(m.heave).toBeCloseTo(s.height, 2);
      // bow-up pitch = slope toward north (−z); starboard-down roll = slope toward −x (surface falls to starboard)
      const slopeN = s.normal.z / s.normal.y; // dh/d(−z) = n_z / n_y
      const slopeE = -s.normal.x / s.normal.y;
      expect(m.pitch).toBeCloseTo((Math.atan(slopeN) * 180) / Math.PI, 0);
      expect(m.roll).toBeCloseTo((-Math.atan(slopeE) * 180) / Math.PI, 0);
    }
  });

  it('long hulls average the waves out (a container ship barely moves)', () => {
    const w = new Float64Array(16).fill(1);
    const m = newWaveMotion();
    let big = 0;
    let small = 0;
    for (let t = 0; t < 60; t += 0.7) {
      hullWaveMotion(sea, w, 1, 100, 200, t, 45, 294, 32, m);
      big = Math.max(big, Math.abs(m.heave), Math.abs(m.pitch) / 10, Math.abs(m.roll) / 10);
      hullWaveMotion(sea, w, 1, 100, 200, t, 45, 8, 2.6, m);
      small = Math.max(small, Math.abs(m.heave));
    }
    expect(big).toBeLessThan(0.05);
    expect(small).toBeGreaterThan(0.1);
  });

  it('zero weights or zero gain leave the hull still', () => {
    const m = newWaveMotion();
    hullWaveMotion(sea, new Float64Array(16), 1, 5, 5, 5, 0, 10, 3, m);
    expect([m.heave, m.pitch, m.roll]).toEqual([0, 0, 0]);
    hullWaveMotion(sea, new Float64Array(16).fill(1), 0, 5, 5, 5, 0, 10, 3, m);
    expect([m.heave, m.pitch, m.roll]).toEqual([0, 0, 0]);
  });

  it('fuzz: finite and bounded for any place, time, heading, size, distance and depth', () => {
    const w = new Float64Array(16);
    const m = newWaveMotion();
    const calm = createWaveSpectrum({ windKt: 25, windFromDeg: 90, count: 12, seed: 3, choppiness: 1 });
    fc.assert(
      fc.property(
        fc.double({ min: -60000, max: 60000, noNaN: true }), fc.double({ min: -60000, max: 60000, noNaN: true }), fc.double({ min: 0, max: 1e5, noNaN: true }),
        fc.double({ min: -720, max: 720, noNaN: true }), fc.double({ min: 0, max: 400, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }), fc.double({ min: -5, max: 60, noNaN: true }), fc.boolean(),
        (x, z, t, hd, L, r, depth, rough) => {
          const spec = rough ? calm : sea;
          waveWeights(spec, r, 1500, w);
          hullWaveMotion(spec, w, shoalFactor(depth), x, z, t, hd, L, L / 3, m);
          for (const v of [m.heave, m.pitch, m.roll]) expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(m.heave)).toBeLessThanOrEqual(spec.maxHeight + 1e-9);
          expect(Math.abs(m.pitch)).toBeLessThan(45);
          expect(Math.abs(m.roll)).toBeLessThan(45);
        },
      ),
      { numRuns: 300 },
    );
  });
});
