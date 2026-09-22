import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { writeWake, wakeIndices, wakeAges, kelvinAngle, WAKE_VERTS_PER_SAMPLE, type WakeSample, type WakeSpec, type WakeBuffers } from '../../../src/world/traffic/wake';

const N = 22;
const buffers = (vessels = 1): WakeBuffers => ({
  position: new Float32Array(vessels * N * WAKE_VERTS_PER_SAMPLE * 3),
  data: new Float32Array(vessels * N * WAKE_VERTS_PER_SAMPLE * 4),
  type: new Float32Array(vessels * N * WAKE_VERTS_PER_SAMPLE),
});
const spec: WakeSpec = { length: 20, beam: 6, maxAge: 60, fullSpeed: 4.5, kelvin: 0.8, level: 0 };

/** A hull steaming north at v m/s along x = 0: samples at the given ages. */
function straight(v: number, ages: Float32Array): WakeSample[] {
  return Array.from(ages, (a) => ({ x: 0, z: v * a, course: 0, speed: v, travelled: 1000 - v * a, age: a }));
}

describe('wake geometry', () => {
  it('Kelvin angle is 19.47° for displacement speeds and narrows for planing hulls', () => {
    expect((kelvinAngle(4, 20) * 180) / Math.PI).toBeCloseTo(19.47, 2);
    const fast = (kelvinAngle(14, 7) * 180) / Math.PI;
    expect(fast).toBeLessThan(12);
    expect(fast).toBeGreaterThanOrEqual(6);
  });

  it('the Kelvin arms open at ±19.47° from the track behind the bow', () => {
    const ages = new Float32Array(N);
    wakeAges(N, spec.maxAge, ages);
    const b = buffers();
    const n = writeWake(b, 0, straight(4, ages), N, spec);
    expect(n).toBe(N * WAKE_VERTS_PER_SAMPLE);
    // right arm centre line (between its inner and outer edge) at the last sample
    const j = N - 1;
    const arm = (a: number) => {
      const q = (2 + 2 * a) * N + 2 * j;
      return { x: (b.position[q * 3] + b.position[(q + 1) * 3]) / 2, z: (b.position[q * 3 + 2] + b.position[(q + 1) * 3 + 2]) / 2 };
    };
    const bowZ = -spec.length * 0.43; // bow is ahead (north, −z) of the hull centre
    for (const a of [0, 1]) {
      const p = arm(a);
      const behind = p.z - bowZ;
      const lateral = Math.abs(p.x) - spec.beam * 0.5 * 0.85;
      expect(behind).toBeGreaterThan(200);
      expect((Math.atan2(lateral, behind) * 180) / Math.PI).toBeCloseTo(19.47, 0);
      expect(Math.sign(p.x)).toBe(a === 0 ? -1 : 1);
    }
  });

  it('the foam trail starts at the stern, widens and fades with age', () => {
    const ages = new Float32Array(N);
    wakeAges(N, spec.maxAge, ages);
    const b = buffers();
    writeWake(b, 0, straight(4, ages), N, spec);
    let prevW = 0;
    let prevI = Infinity;
    for (let j = 0; j < N; j++) {
      const l = 2 * j;
      const w = Math.hypot(b.position[l * 3] - b.position[(l + 1) * 3], b.position[l * 3 + 2] - b.position[(l + 1) * 3 + 2]);
      expect(w).toBeGreaterThanOrEqual(prevW);
      prevW = w;
      const inten = b.data[l * 4 + 3];
      expect(inten).toBeLessThanOrEqual(prevI + 1e-6);
      prevI = inten;
      expect(b.position[l * 3 + 1]).toBeGreaterThan(spec.level);
    }
    // stern of a 20 m hull: ~9 m behind the centre (+z)
    expect(b.position[2]).toBeCloseTo(0.46 * spec.length, 0);
    expect(b.data[(2 * (N - 1)) * 4 + 3]).toBeCloseTo(0, 5);
  });

  it('a stopped hull leaves no wake (zero intensity)', () => {
    const ages = new Float32Array(N);
    wakeAges(N, spec.maxAge, ages);
    const s = Array.from(ages, (a) => ({ x: 5, z: 5, course: 90, speed: 0, travelled: 0, age: a }));
    const b = buffers();
    writeWake(b, 0, s, N, spec);
    for (let k = 0; k < N * WAKE_VERTS_PER_SAMPLE; k++) expect(b.data[k * 4 + 3]).toBe(0);
  });

  it('index buffer stitches three strips per vessel within range', () => {
    const idx = wakeIndices(3, N);
    expect(idx.length).toBe(3 * 3 * (N - 1) * 6);
    let mx = 0;
    for (const i of idx) mx = Math.max(mx, i);
    expect(mx).toBe(3 * N * WAKE_VERTS_PER_SAMPLE - 1);
  });

  it('fuzz: any track writes finite geometry with bounded attributes', () => {
    const sample = fc.record({
      x: fc.double({ min: -5e4, max: 5e4, noNaN: true }),
      z: fc.double({ min: -5e4, max: 5e4, noNaN: true }),
      course: fc.double({ min: 0, max: 359.99, noNaN: true }),
      speed: fc.double({ min: 0, max: 20, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(sample, { minLength: N, maxLength: N }), fc.double({ min: 1, max: 300, noNaN: true }), fc.double({ min: 3, max: 300, noNaN: true }), (raw, maxAge, len) => {
        const ages = new Float32Array(N);
        wakeAges(N, maxAge, ages);
        let trav = 1e5;
        const s: WakeSample[] = raw.map((r, j) => {
          if (j > 0) trav -= Math.abs(r.speed) * (ages[j] - ages[j - 1]);
          return { ...r, travelled: trav, age: ages[j] };
        });
        const b = buffers();
        writeWake(b, 0, s, N, { ...spec, length: len, beam: len * 0.3, maxAge });
        for (const v of b.position) expect(Number.isFinite(v)).toBe(true);
        for (let k = 0; k < N * WAKE_VERTS_PER_SAMPLE; k++) {
          expect(Math.abs(b.data[k * 4 + 1])).toBe(1);
          expect(b.data[k * 4 + 2]).toBeGreaterThanOrEqual(0);
          expect(b.data[k * 4 + 2]).toBeLessThanOrEqual(1);
          expect(b.data[k * 4 + 3]).toBeGreaterThanOrEqual(0);
          expect(b.data[k * 4 + 3]).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 150 },
    );
  });
});
