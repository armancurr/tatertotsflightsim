import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import {
  createWaveSpectrum,
  getSeaSpectrum,
  waterSurfaceAt,
  newWaterSurfaceSample,
  packWaveUniforms,
  gerstnerDisplace,
  GRAVITY,
  type WaveSpectrum,
} from '../../../src/world/water/waves';
import { CONFIG } from '../../../src/config';

const KT = 0.514444;
const sea = (over: Partial<Parameters<typeof createWaveSpectrum>[0]> = {}): WaveSpectrum =>
  createWaveSpectrum({ windKt: 12, windFromDeg: 215, count: 12, seed: 7, choppiness: 0.55, ...over });

describe('wave spectrum', () => {
  it('has the requested number of deep-water trains, longest first', () => {
    const s = sea();
    expect(s.trains.length).toBe(12);
    for (let i = 0; i < s.trains.length; i++) {
      const w = s.trains[i];
      expect(Math.hypot(w.dirX, w.dirZ)).toBeCloseTo(1, 9);
      expect(w.k).toBeCloseTo((2 * Math.PI) / w.wavelength, 9);
      expect(w.omega * w.omega).toBeCloseTo(GRAVITY * w.k, 6); // deep-water dispersion
      expect(w.amp).toBeGreaterThan(0);
      if (i > 0) expect(w.wavelength).toBeLessThan(s.trains[i - 1].wavelength);
    }
  });

  it('peaks at the Pierson–Moskowitz wavelength and has the right significant height', () => {
    const U = 12 * KT;
    const wp = (0.877 * GRAVITY) / U;
    const lambdaP = (2 * Math.PI * GRAVITY) / (wp * wp);
    const s = sea();
    expect(s.peakWavelength).toBeCloseTo(lambdaP, 6);
    // Hs = 4·σ, σ² = Σ A²/2; the discrete trains cover most of the PM energy
    const hs = 4 * Math.sqrt(s.trains.reduce((a, w) => a + (w.amp * w.amp) / 2, 0));
    const hsPM = (0.21 * U * U) / GRAVITY;
    expect(hs).toBeGreaterThan(0.75 * hsPM);
    expect(hs).toBeLessThan(1.1 * hsPM);
    // the biggest train is near the peak
    let best = s.trains[0];
    for (const w of s.trains) if (w.amp > best.amp) best = w;
    expect(best.wavelength).toBeGreaterThan(lambdaP * 0.6);
    expect(best.wavelength).toBeLessThan(lambdaP * 1.6);
  });

  it('travels downwind, spread around the wind', () => {
    const s = sea({ windFromDeg: 215 });
    // blowing from 215° → toward 35°: +x (east) and −z (north) components
    const tx = Math.sin((35 * Math.PI) / 180);
    const tz = -Math.cos((35 * Math.PI) / 180);
    expect(s.windDirX).toBeCloseTo(tx, 9);
    expect(s.windDirZ).toBeCloseTo(tz, 9);
    let mx = 0;
    let mz = 0;
    for (const w of s.trains) {
      const c = w.dirX * tx + w.dirZ * tz;
      expect(c).toBeGreaterThan(Math.cos((80 * Math.PI) / 180));
      mx += w.dirX * w.amp;
      mz += w.dirZ * w.amp;
    }
    expect((mx * tx + mz * tz) / Math.hypot(mx, mz)).toBeGreaterThan(0.9);
  });

  it('never folds: Σ k·s ≤ choppiness ≤ 1', () => {
    for (const ch of [0, 0.3, 0.55, 1]) {
      const s = sea({ choppiness: ch });
      const sum = s.trains.reduce((a, w) => a + w.k * w.chop, 0);
      expect(sum).toBeLessThanOrEqual(ch + 1e-9);
      expect(sum).toBeGreaterThanOrEqual(ch - 1e-9);
    }
  });

  it('is calm with no wind and scales with wavelength/height factors', () => {
    const calm = sea({ windKt: 0 });
    expect(calm.maxHeight).toBe(0);
    const o = waterSurfaceAt(123, 456, 7, calm);
    expect(o.height).toBe(0);
    expect(o.normal).toEqual({ x: 0, y: 1, z: 0 });
    const lake = sea({ wavelengthScale: 0.25, heightScale: 0.2 });
    expect(lake.trains[0].wavelength).toBeCloseTo(sea().trains[0].wavelength * 0.25, 6);
    expect(lake.maxHeight).toBeCloseTo(sea().maxHeight * 0.2 * 0.25, 6);
  });

  it('uses the config for the default sea', () => {
    const d = getSeaSpectrum();
    expect(d).toBe(getSeaSpectrum());
    expect(d.trains.length).toBe(CONFIG.world.water.waveCount);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = sea();
    const b = sea();
    expect(a).toEqual(b);
    const c = sea({ seed: 8 });
    expect(c.trains.map((w) => w.phase)).not.toEqual(a.trains.map((w) => w.phase));
  });

  it('packs the trains into shader uniform vec4 arrays', () => {
    const s = sea();
    const A = new Float32Array(16 * 4);
    const B = new Float32Array(16 * 4);
    packWaveUniforms(s, A, B);
    const w = s.trains[3];
    expect(A[12]).toBeCloseTo(w.dirX * w.k, 5);
    expect(A[13]).toBeCloseTo(w.dirZ * w.k, 5);
    expect(A[14]).toBeCloseTo(w.omega, 5);
    expect(A[15]).toBeCloseTo(w.phase, 5);
    expect(B[12]).toBeCloseTo(w.amp, 5);
    expect(B[13]).toBeCloseTo(w.chop, 5);
    expect(B[15]).toBeCloseTo(w.wavelength, 4);
    // unused slots are zero amplitude
    expect(B[12 * 4]).toBe(0);
  });
});

describe('waterSurfaceAt', () => {
  const s = sea();

  it('returns the height of the displaced surface exactly above (x, z)', () => {
    const o = newWaterSurfaceSample();
    const p = { x: 0, y: 0, z: 0 };
    for (const [x, z, t] of [
      [0, 0, 0],
      [1234.5, -987.25, 13.7],
      [-40000, 12000, 5000],
    ]) {
      waterSurfaceAt(x, z, t, s, o);
      // the undisplaced point it found maps (horizontally) back onto (x, z)
      gerstnerDisplace(o.sourceX, o.sourceZ, t, s, p);
      expect(p.x).toBeCloseTo(x, 2);
      expect(p.z).toBeCloseTo(z, 2);
      expect(p.y).toBeCloseTo(o.height, 6);
    }
  });

  it('moves with the phase speed: a single train is a travelling wave', () => {
    const one: WaveSpectrum = { ...s, trains: [{ ...s.trains[0] }] };
    const w = one.trains[0];
    const c = w.omega / w.k;
    const t = 3.3;
    const a = waterSurfaceAt(10, 20, 0, one).height;
    const b = waterSurfaceAt(10 + w.dirX * c * t, 20 + w.dirZ * c * t, t, one).height;
    expect(b).toBeCloseTo(a, 5);
  });

  it('does not allocate a new sample when given one', () => {
    const o = newWaterSurfaceSample();
    const n = o.normal;
    expect(waterSurfaceAt(1, 2, 3, s, o)).toBe(o);
    expect(o.normal).toBe(n);
  });

  it('fuzz: bounded height, unit upward normal, finite everywhere, deterministic', () => {
    const o = newWaterSurfaceSample();
    fc.assert(
      fc.property(
        fc.double({ min: -60000, max: 60000, noNaN: true }),
        fc.double({ min: -60000, max: 60000, noNaN: true }),
        fc.double({ min: 0, max: 1e5, noNaN: true }),
        (x, z, t) => {
          waterSurfaceAt(x, z, t, s, o);
          const h = o.height;
          const n = { ...o.normal };
          expect(Number.isFinite(h)).toBe(true);
          expect(Math.abs(h)).toBeLessThanOrEqual(s.maxHeight + 1e-9);
          expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
          expect(n.y).toBeGreaterThan(0.3);
          const again = waterSurfaceAt(x, z, t, s, newWaterSurfaceSample());
          expect(again.height).toBe(h);
          expect(again.normal).toEqual(n);
        },
      ),
      fcParams(400),
    );
  });

  it('fuzz: continuous (Lipschitz in x, z and t)', () => {
    const o = newWaterSurfaceSample();
    let maxSlope = 0;
    let maxRate = 0;
    for (const w of s.trains) {
      maxSlope += w.k * w.amp;
      maxRate += w.omega * w.amp;
    }
    // horizontal displacement can compress the surface by up to 1/(1 − choppiness)
    const L = maxSlope / (1 - 0.55) + 1e-6;
    fc.assert(
      fc.property(
        fc.double({ min: -20000, max: 20000, noNaN: true }),
        fc.double({ min: -20000, max: 20000, noNaN: true }),
        fc.double({ min: 0, max: 1000, noNaN: true }),
        fc.double({ min: -0.05, max: 0.05, noNaN: true }),
        (x, z, t, d) => {
          const h0 = waterSurfaceAt(x, z, t, s, o).height;
          const hx = waterSurfaceAt(x + d, z, t, s, o).height;
          const hz = waterSurfaceAt(x, z + d, t, s, o).height;
          const ht = waterSurfaceAt(x, z, t + Math.abs(d), s, o).height;
          expect(Math.abs(hx - h0)).toBeLessThanOrEqual(L * Math.abs(d) + 1e-4);
          expect(Math.abs(hz - h0)).toBeLessThanOrEqual(L * Math.abs(d) + 1e-4);
          expect(Math.abs(ht - h0)).toBeLessThanOrEqual((maxRate / (1 - 0.55)) * Math.abs(d) + 1e-4);
        },
      ),
      fcParams(300),
    );
  });

  it('fuzz: any wind and choppiness gives a valid surface', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 40, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        (kt, from, count, seed, ch, x, z) => {
          const sp = createWaveSpectrum({ windKt: kt, windFromDeg: from, count, seed, choppiness: ch });
          expect(sp.trains.length).toBe(count);
          const o = waterSurfaceAt(x, z, 12.5, sp);
          expect(Number.isFinite(o.height)).toBe(true);
          expect(Math.abs(o.height)).toBeLessThanOrEqual(sp.maxHeight + 1e-9);
          expect(o.normal.y).toBeGreaterThan(0);
        },
      ),
      fcParams(200),
    );
  });
});
