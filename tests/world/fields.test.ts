import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fieldAt, newFieldInfo, pcgHash, valueNoise, FIELD_KINDS, FIELD_GLSL, WOODLOT_CHANCE } from '../../src/world/fields';

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

  it('keeps the woodlot and hedge layout of the original strip model (trees are placed from it)', () => {
    // legacy reference: the strip key and block margin exactly as before the realism pass
    const legacy = (x: number, z: number) => {
      const wx = x + 160 * (valueNoise(x * 0.0009, z * 0.0009) - 0.5);
      const wz = z + 160 * (valueNoise(x * 0.0009 + 17.3, z * 0.0009 + 17.3) - 0.5);
      const dcx = Math.floor(wx / 1500);
      const dcz = Math.floor(wz / 1500);
      const ang = (pcgHash(dcx + 91, dcz + 91) - 0.5) * 0.8;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      let qx = cs * x + sn * z;
      let qz = -sn * x + cs * z;
      qx += 14 * (valueNoise(x * 0.0045, z * 0.0045) - 0.5);
      qz += 14 * (valueNoise(x * 0.0045 + 9.1, z * 0.0045 + 9.1) - 0.5);
      const hs = pcgHash(dcx + 3, dcz + 3);
      const csx = 240 + (470 - 240) * hs;
      const csz = 170 + (320 - 170) * hs;
      const cx = Math.floor(qx / csx);
      const cz = Math.floor(qz / csz);
      const fx = qx / csx - cx;
      const fz = qz / csz - cz;
      const nStrips = 1 + Math.floor(pcgHash(cx + dcx * 57, cz + dcz * 57) * 3.3);
      const alongX = pcgHash(cx + dcx * 13 + 7, cz + dcz * 13 + 7) >= 0.5;
      const si = Math.floor((alongX ? fx : fz) * nStrips);
      const kx = cx * 4 + si + dcx * 131;
      const kz = cz * 4 + (alongX ? 2 : 0) + dcz * 131;
      const mk = pcgHash(cx + dcx * 3 + 11, cz + dcz * 3 + 11);
      return { woodlot: pcgHash(kx + 11, kz + 11) < WOODLOT_CHANCE, margin: mk < 0.45 ? 'hedge' : mk < 0.8 ? 'grass' : 'track' };
    };
    const f = newFieldInfo();
    fc.assert(
      fc.property(fc.double({ min: -40000, max: 40000, noNaN: true }), fc.double({ min: -40000, max: 12000, noNaN: true }), (x, z) => {
        fieldAt(x, z, f);
        const ref = legacy(x, z);
        expect(f.woodlot).toBe(ref.woodlot);
        expect(f.margin).toBe(ref.margin);
      }),
      { numRuns: 3000 },
    );
  });

  it('cuts some strips across and merges others, so field sizes vary widely (not a checkerboard)', () => {
    const f = newFieldInfo();
    const count = new Map<number, number>();
    let cut = 0;
    let merged = 0;
    let n = 0;
    for (let z = -12000; z < 4000; z += 23)
      for (let x = -12000; x < 12000; x += 29) {
        fieldAt(x, z, f);
        count.set(f.id, (count.get(f.id) ?? 0) + 1);
        if (f.sub === 1) cut++;
        if (f.merged) merged++;
        n++;
      }
    expect(cut / n).toBeGreaterThan(0.08);
    expect(merged / n).toBeGreaterThan(0.1);
    const areas = [...count.values()].filter((c) => c > 3).map((c) => (c * 23 * 29) / 10000);
    areas.sort((a, b) => a - b);
    const p10 = areas[Math.floor(areas.length * 0.1)];
    const p90 = areas[Math.floor(areas.length * 0.9)];
    expect(p90 / p10).toBeGreaterThan(4); // small paddocks and big fields side by side
  });

  it('mixes arable and pastoral districts: browns and golds cluster, greens dominate overall', () => {
    const f = newFieldInfo();
    const kinds = new Map<string, number>();
    const districts = new Map<string, number[]>();
    for (let z = -20000; z < 4000; z += 61)
      for (let x = -20000; x < 20000; x += 67) {
        fieldAt(x, z, f);
        kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
        const k = `${f.district}`;
        const brown = f.kind === 'ploughed' || f.kind === 'ploughed-dark' || f.kind === 'wheat' || f.kind === 'stubble' ? 1 : 0;
        const d = districts.get(k) ?? [0, 0];
        d[0] += brown;
        d[1]++;
        districts.set(k, d);
      }
    expect(kinds.size).toBe(FIELD_KINDS.length);
    const fr = [...districts.values()].filter((d) => d[1] > 200).map((d) => d[0] / d[1]);
    expect(Math.max(...fr) - Math.min(...fr)).toBeGreaterThan(0.25);
    // pale stubble is only occasional
    let total = 0;
    for (const v of kinds.values()) total += v;
    expect((kinds.get('stubble') ?? 0) / total).toBeLessThan(0.08);
  });

  it('has a GLSL twin that mirrors the constants', () => {
    expect(FIELD_GLSL).toContain('Field fieldAt(');
    expect(FIELD_GLSL).toContain(String(WOODLOT_CHANCE));
  });
});
