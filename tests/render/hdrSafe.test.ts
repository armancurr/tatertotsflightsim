/**
 * NaN/Inf containment in the HDR post stack (src/render/hdrSafe.ts). The bug it guards: one NaN
 * texel in the scene (the F-16 plume's pow() of an MSAA-extrapolated varying) was blurred by the
 * bloom chain into stair-stepped black blocks. Bloom and metering now sanitise every scene sample;
 * the eye-adaptation feedback loop can never keep a NaN.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HDR_SAFE_GLSL, hdrBad, hdrSafe, hdrSafe3 } from '../../src/render/hdrSafe';

const ROOT = join(__dirname, '../..');
const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('hdrSafe (TS twin of the GLSL)', () => {
  it('flags NaN and ±Infinity (exponent all ones), nothing else', () => {
    expect(hdrBad(Number.NaN)).toBe(true);
    expect(hdrBad(Infinity)).toBe(true);
    expect(hdrBad(-Infinity)).toBe(true);
    for (const x of [0, -0, 1, -1, 65504, 3.4e38, 1e-40, -3.4e38]) expect(hdrBad(x)).toBe(false);
  });
  it('maps NaN/Inf and negatives to 0 and leaves real light alone', () => {
    expect(hdrSafe(Number.NaN)).toBe(0);
    expect(hdrSafe(Infinity)).toBe(0);
    expect(hdrSafe(-2)).toBe(0);
    expect(hdrSafe(0.25)).toBe(0.25);
    expect(hdrSafe(60000)).toBe(60000);
  });
  it('a bad channel zeroes the whole texel (no hue from half a NaN)', () => {
    expect(hdrSafe3([1, Number.NaN, 2])).toEqual([0, 0, 0]);
    expect(hdrSafe3([1, 2, Infinity])).toEqual([0, 0, 0]);
    expect(hdrSafe3([1, -1, 2])).toEqual([1, 0, 2]);
  });
  it('is always finite and ≥ 0, and the identity on finite non-negative input (property)', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), fc.double(), (r, g, b) => {
        const out = hdrSafe3([r, g, b]);
        for (const v of out) expect(Number.isFinite(v) && v >= 0).toBe(true);
        const clean = [r, g, b].every((v) => Number.isFinite(v) && v >= 0);
        // === (not toEqual): −0 in, +0 out is the same light
        if (clean) expect(out.every((v, i) => v === [r, g, b][i])).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('hdrSafe GLSL', () => {
  it('tests the bits (floatBitsToUint), which fast-math shader compilers cannot fold away like isnan()', () => {
    expect(HDR_SAFE_GLSL).toMatch(/floatBitsToUint/);
    expect(HDR_SAFE_GLSL).toMatch(/0x7F800000u/);
    expect(HDR_SAFE_GLSL).not.toMatch(/\bisnan\s*\(|\bisinf\s*\(/);
    expect(HDR_SAFE_GLSL).toMatch(/vec3 hdrSafe\(/);
  });
  it('bloom sanitises every scene tap before the blur chain', () => {
    const b = src('src/render/bloom.ts');
    expect(b).toMatch(/HDR_SAFE_GLSL/);
    const fetch = b.slice(b.indexOf('vec3 fetchScene('), b.indexOf('void main()', b.indexOf('vec3 fetchScene(')));
    expect(fetch).toMatch(/hdrSafe\(/);
  });
  it('metering sanitises every luminance tap and the adaptation feedback loop', () => {
    const m = src('src/render/metering.ts');
    expect(m).toMatch(/HDR_SAFE_GLSL/);
    const lum = m.slice(m.indexOf('float lumAt('), m.indexOf('void main()', m.indexOf('float lumAt(')));
    expect(lum).toMatch(/hdrSafe\(/);
    const adapt = m.slice(m.indexOf('const ADAPT'));
    expect(adapt).toMatch(/hdrBad\(\s*prev\s*\)/);
    expect(adapt).toMatch(/hdrBad\(\s*a\s*\)/);
  });
});

/** Every .ts under src (the GLSL lives in template strings). */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|glsl|frag|vert)$/.test(e)) out.push(p);
  }
  return out;
}

describe('GLSL lint: pow() of a raw varying', () => {
  it('no shader takes pow() of a bare varying — MSAA extrapolates varyings past their vertex range at edges, and pow(x < 0) is NaN', () => {
    const offenders: string[] = [];
    for (const f of sources(join(ROOT, 'src'))) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/\bpow\s*\(\s*v[A-Z]\w*\s*,/.test(l)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
  it('the F-16 plume guards both pow() bases', () => {
    const n = src('src/aircraft/f16/nozzle.ts');
    const frag = n.slice(n.indexOf("name: 'f16.plume'"));
    const pows = frag.match(/pow\([^;]*;/g) ?? [];
    expect(pows.length).toBeGreaterThanOrEqual(2);
    for (const p of pows) expect(p).toMatch(/pow\(\s*(max|clamp)\(/);
  });
});
