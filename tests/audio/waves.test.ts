import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  fourierSeries, engineCycleWaveform, propWaveform, pulseWaveform, hornWaveform, noiseSamples, mulberry32, gateWaveform, beepWaveform,
} from '../../src/audio/waves';
import { rms, goertzelAmplitude, dominantFrequency } from '../../src/audio/analysis';

const harmonicEnergy = (w: { real: Float32Array; imag: Float32Array }, k: number) => w.real[k] ** 2 + w.imag[k] ** 2;
const allFinite = (a: ArrayLike<number>) => Array.from(a).every(Number.isFinite);

describe('fourierSeries', () => {
  it('recovers the harmonics of a known waveform (PeriodicWave convention)', () => {
    const n = 512;
    const s = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const t = j / n;
      s[j] = 0.7 * Math.cos(2 * Math.PI * 3 * t) + 0.25 * Math.sin(2 * Math.PI * 5 * t) + 0.3; // DC dropped
    }
    const w = fourierSeries(s, 16);
    expect(w.real.length).toBe(17);
    expect(w.real[0]).toBe(0);
    expect(w.imag[0]).toBe(0);
    expect(w.real[3]).toBeCloseTo(0.7, 4);
    expect(w.imag[5]).toBeCloseTo(0.25, 4);
    expect(Math.abs(w.real[4]) + Math.abs(w.imag[4])).toBeLessThan(1e-4);
  });
  it('fuzz: always finite, length harmonics+1', () => {
    fc.assert(fc.property(fc.array(fc.double({ min: -10, max: 10, noNaN: true }), { minLength: 4, maxLength: 200 }), fc.integer({ min: 1, max: 64 }), (arr, h) => {
      const w = fourierSeries(Float32Array.from(arr), h);
      expect(w.real.length).toBe(h + 1);
      expect(allFinite(w.real) && allFinite(w.imag)).toBe(true);
    }));
  });
});

describe('engine cycle waveform (one 4-stroke cycle = 2 revolutions)', () => {
  const s = engineCycleWaveform(1024);
  const w = fourierSeries(s, 48);
  it('is finite and normalised', () => {
    expect(allFinite(s)).toBe(true);
    expect(Math.max(...Array.from(s, Math.abs))).toBeLessThanOrEqual(1 + 1e-6);
  });
  it('its strongest low harmonic is the 4th = the firing frequency (4 cylinders per cycle)', () => {
    const e4 = harmonicEnergy(w, 4);
    for (const k of [1, 2, 3, 5, 6, 7]) expect(e4).toBeGreaterThan(harmonicEnergy(w, k));
  });
  it('has the half-order "lumpiness" of an aero engine (uneven cylinders → harmonics 1–3 present)', () => {
    const e4 = harmonicEnergy(w, 4);
    for (const k of [1, 2, 3]) {
      expect(harmonicEnergy(w, k)).toBeGreaterThan(e4 * 0.004);
      expect(harmonicEnergy(w, k)).toBeLessThan(e4 * 0.6);
    }
  });
  it('is rich in harmonics (pulse train, not a sine)', () => {
    expect(harmonicEnergy(w, 8)).toBeGreaterThan(harmonicEnergy(w, 4) * 0.05);
    expect(harmonicEnergy(w, 16)).toBeGreaterThan(0);
  });
});

describe('other waveforms', () => {
  it('prop blade pulse, AM pulse and horn are finite, normalised and non-trivial', () => {
    for (const s of [propWaveform(512), pulseWaveform(512, 0.25), hornWaveform(512), beepWaveform(512)]) {
      expect(allFinite(s)).toBe(true);
      const peak = Math.max(...Array.from(s, Math.abs));
      expect(peak).toBeLessThanOrEqual(1 + 1e-6);
      expect(rms(s)).toBeGreaterThan(0.05);
    }
  });
  it('the horn waveform is buzzy (strong upper harmonics like a reed)', () => {
    const w = fourierSeries(hornWaveform(1024), 12);
    expect(harmonicEnergy(w, 2) + harmonicEnergy(w, 3)).toBeGreaterThan(harmonicEnergy(w, 1) * 0.15);
  });
});

describe('gear horn gate', () => {
  it('is on for about `duty` of the period and off otherwise, spanning 0..1', () => {
    const g = gateWaveform(1000, 0.5);
    const on = Array.from(g).filter((v) => v > 0.5).length / g.length;
    expect(on).toBeGreaterThan(0.4);
    expect(on).toBeLessThan(0.6);
    expect(Math.min(...g)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...g)).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.max(...g)).toBeGreaterThan(0.999);
  });
  it('fuzz: soft edges (no clicks) — the gate never jumps by more than a raised-cosine ramp allows', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.1, max: 0.9, noNaN: true }), (duty) => {
        const n = 2048;
        const g = gateWaveform(n, duty);
        let maxStep = 0;
        for (let i = 0; i < n; i++) maxStep = Math.max(maxStep, Math.abs(g[(i + 1) % n] - g[i]));
        // A 6 %-of-period raised-cosine edge: max step ≈ π/2 / (0.06 n).
        expect(maxStep).toBeLessThan((Math.PI / 2) / (0.05 * n));
        expect(allFinite(g)).toBe(true);
      }),
    );
  });
});

describe('noise', () => {
  it('is deterministic per seed and bounded', () => {
    const a = noiseSamples('white', 4096, 7);
    const b = noiseSamples('white', 4096, 7);
    const c = noiseSamples('white', 4096, 8);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    for (const kind of ['white', 'pink', 'brown'] as const) {
      const s = noiseSamples(kind, 8192, 3);
      expect(allFinite(s)).toBe(true);
      expect(Math.max(...Array.from(s, Math.abs))).toBeLessThanOrEqual(1);
      expect(Math.abs(s.reduce((x, y) => x + y, 0) / s.length)).toBeLessThan(0.1);
    }
  });
  it('brown < pink < white in high-frequency content', () => {
    const hf = (s: Float32Array) => {
      let d = 0;
      for (let i = 1; i < s.length; i++) d += (s[i] - s[i - 1]) ** 2;
      return d / rms(s) ** 2;
    };
    const w = hf(noiseSamples('white', 16384, 1));
    const p = hf(noiseSamples('pink', 16384, 1));
    const b = hf(noiseSamples('brown', 16384, 1));
    expect(b).toBeLessThan(p);
    expect(p).toBeLessThan(w);
  });
  it('mulberry32 is in [0,1)', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });
});

describe('analysis', () => {
  const sr = 8000;
  const sine = (f: number, amp: number, n = 8000) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
  it('rms of a sine is amp/√2; of silence 0; of empty 0', () => {
    expect(rms(sine(440, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(rms(new Float32Array(100))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });
  it('goertzel measures the amplitude at a frequency', () => {
    const s = sine(90, 0.4);
    expect(goertzelAmplitude(s, sr, 90)).toBeCloseTo(0.4, 2);
    expect(goertzelAmplitude(s, sr, 140)).toBeLessThan(0.02);
  });
  it('dominantFrequency finds the peak', () => {
    const s = sine(1780, 0.3);
    for (let i = 0; i < s.length; i++) s[i] += 0.05 * Math.sin((2 * Math.PI * 300 * i) / sr);
    expect(dominantFrequency(s, sr, 100, 3000, 10)).toBeCloseTo(1780, -1);
  });
});

describe('jet waveforms and the soft clipper', () => {
  it('buzz-saw: rich in shaft harmonics (many multiple pure tones), finite, normalised', async () => {
    const { buzzsawWaveform } = await import('../../src/audio/waves');
    const s = buzzsawWaveform(2048, 5);
    expect(s.every(Number.isFinite)).toBe(true);
    expect(Math.max(...s.map(Math.abs))).toBeCloseTo(1, 6);
    const f = fourierSeries(s, 40);
    const amp = (k: number) => Math.hypot(f.real[k], f.imag[k]);
    let strong = 0;
    for (let k = 1; k <= 36; k++) if (amp(k) > 0.05 * amp(1)) strong++;
    expect(strong).toBeGreaterThan(25);
  });
  it('whine partial: mostly the fundamental', async () => {
    const { whineWaveform } = await import('../../src/audio/waves');
    const f = fourierSeries(whineWaveform(1024), 6);
    const amp = (k: number) => Math.hypot(f.real[k], f.imag[k]);
    expect(amp(1)).toBeGreaterThan(3 * amp(2));
    expect(amp(2)).toBeGreaterThan(amp(4));
  });
  it('fuzz: soft-clip curve is odd, monotone, linear below the knee and never reaches the ceiling', async () => {
    const { softClipCurve } = await import('../../src/audio/waves');
    fc.assert(fc.property(fc.integer({ min: 3, max: 4096 }), fc.double({ min: 0.1, max: 0.95, noNaN: true }), fc.double({ min: 0.5, max: 1, noNaN: true }), (n, knee, ceil) => {
      const c = softClipCurve(n, knee, ceil);
      expect(c.length % 2).toBe(1);
      const top = Math.max(knee + 0.01, ceil);
      for (let i = 0; i < c.length; i++) {
        expect(Number.isFinite(c[i])).toBe(true);
        expect(Math.abs(c[i])).toBeLessThan(top);
        expect(c[i]).toBeCloseTo(-c[c.length - 1 - i], 6);
        if (i) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
        const x = (i / (c.length - 1)) * 2 - 1;
        if (Math.abs(x) <= knee) expect(c[i]).toBeCloseTo(x, 6);
      }
    }), { numRuns: 40 });
  });
});
