import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fieldAt, newFieldInfo, pcgHash, valueNoise, FIELD_KINDS } from '../../src/world/fields';

describe('farm field model', () => {
  it('pcg hash matches the GLSL uint arithmetic (reference values)', () => {
    // reference: pcg(0) and pcg(1) computed with 32-bit unsigned arithmetic
    const pcg = (v: number) => {
      const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
      const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
      return ((w >>> 22) ^ w) >>> 0;
    };
    expect(pcgHash(0, 0)).toBe(pcg((0 + pcg(0)) >>> 0) / 4294967295);
    expect(pcgHash(-3, 7)).toBe(pcg((-3 + pcg(7)) >>> 0) / 4294967295);
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), fc.integer({ min: -1e6, max: 1e6 }), (a, b) => {
        const h = pcgHash(a, b);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('value noise is continuous and in [0,1]', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true }), (x, y) => {
        const v = valueNoise(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(Math.abs(valueNoise(x + 1e-4, y) - v)).toBeLessThan(1e-2);
      }),
    );
  });

  it('partitions the land into fields of realistic sizes with a varied crop mix', () => {
    const f = newFieldInfo();
    const ids = new Map<number, number>();
    const kinds = new Map<string, number>();
    let woodlots = 0;
    let n = 0;
    for (let z = -8000; z < 8000; z += 37)
      for (let x = -8000; x < 8000; x += 41) {
        fieldAt(x, z, f);
        ids.set(f.id, (ids.get(f.id) ?? 0) + 1);
        kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
        if (f.woodlot) woodlots++;
        n++;
        expect(f.dEdge).toBeGreaterThanOrEqual(0);
        expect(FIELD_KINDS).toContain(f.kind);
      }
    // mean field area between ~2 and ~15 ha
    const meanArea = (16000 * 16000) / ids.size / 10000;
    expect(meanArea).toBeGreaterThan(1.5);
    expect(meanArea).toBeLessThan(15);
    expect(woodlots / n).toBeGreaterThan(0.03);
    expect(woodlots / n).toBeLessThan(0.15);
    // greens dominate, bright cereals are a minority
    const green = (kinds.get('cereal-green') ?? 0) + (kinds.get('row-crop') ?? 0) + (kinds.get('grass-ley') ?? 0);
    expect(green / n).toBeGreaterThan(0.4);
    expect(kinds.size).toBeGreaterThanOrEqual(6);
  });

  it('reports the distance to the field edge consistently', () => {
    const f = newFieldInfo();
    const g = newFieldInfo();
    for (let i = 0; i < 2000; i++) {
      const x = i * 13.7 - 9000;
      const z = i * -7.3 + 4000;
      fieldAt(x, z, f);
      // stepping less than the edge distance stays in the same field
      if (f.dEdge > 2) {
        fieldAt(x + 1, z, g);
        expect(g.id).toBe(f.id);
      }
    }
  });
});
