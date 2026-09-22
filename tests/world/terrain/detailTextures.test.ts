import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DETAIL_LAYERS, DETAIL_TILE_M, generateDetailLayer, generateDetailSet, generateNoiseTexture, NOISE_TEX_SIZE } from '../../../src/world/terrain/detailTextures';

const SIZE = 128; // small for speed; the generator is resolution-independent

function stats(a: Uint8Array, stride: number, ch: number) {
  let s = 0;
  let s2 = 0;
  let lo = 255;
  let hi = 0;
  const n = a.length / stride;
  for (let i = 0; i < n; i++) {
    const v = a[i * stride + ch];
    s += v;
    s2 += v * v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mean = s / n;
  return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)), lo, hi };
}

describe('detail textures (unit)', () => {
  it('has one tile size per layer, in plausible metres', () => {
    expect(DETAIL_LAYERS.length).toBe(DETAIL_TILE_M.length);
    for (const s of DETAIL_TILE_M) {
      expect(s).toBeGreaterThan(0.5);
      expect(s).toBeLessThan(20);
    }
    expect(DETAIL_LAYERS).toEqual(expect.arrayContaining(['grass', 'soil', 'gravel', 'rock', 'sand', 'snow']));
  });

  it('is deterministic for a seed and differs across seeds', () => {
    for (let l = 0; l < DETAIL_LAYERS.length; l++) {
      const a = generateDetailLayer(l, SIZE, 7);
      const b = generateDetailLayer(l, SIZE, 7);
      const c = generateDetailLayer(l, SIZE, 8);
      expect(a.albedo).toEqual(b.albedo);
      expect(a.normal).toEqual(b.normal);
      let diff = 0;
      for (let i = 0; i < a.albedo.length; i++) diff += a.albedo[i] !== c.albedo[i] ? 1 : 0;
      expect(diff / a.albedo.length).toBeGreaterThan(0.2);
    }
  });

  it('albedo is a neutral modulation (mean ≈ 0.5 per channel) with real structure; height uses the range', () => {
    for (let l = 0; l < DETAIL_LAYERS.length; l++) {
      const { albedo } = generateDetailLayer(l, SIZE, 3);
      expect(albedo.length).toBe(SIZE * SIZE * 4);
      for (let ch = 0; ch < 3; ch++) {
        const s = stats(albedo, 4, ch);
        expect(Math.abs(s.mean - 128), `${DETAIL_LAYERS[l]} ch${ch} mean ${s.mean}`).toBeLessThan(10);
        expect(s.sd, `${DETAIL_LAYERS[l]} ch${ch} sd`).toBeGreaterThan(DETAIL_LAYERS[l] === 'snow' ? 1.5 : 6);
        expect(s.sd).toBeLessThan(95);
      }
      const h = stats(albedo, 4, 3);
      expect(h.hi - h.lo, `${DETAIL_LAYERS[l]} height range`).toBeGreaterThan(120);
    }
  });

  it('normals decode to upward unit vectors with some relief', () => {
    for (let l = 0; l < DETAIL_LAYERS.length; l++) {
      const { normal } = generateDetailLayer(l, SIZE, 5);
      let tilt = 0;
      for (let i = 0; i < SIZE * SIZE; i++) {
        const nx = normal[i * 4] / 127.5 - 1;
        const nz = normal[i * 4 + 1] / 127.5 - 1;
        const l2 = nx * nx + nz * nz;
        expect(l2).toBeLessThanOrEqual(1.02);
        tilt += Math.sqrt(l2);
        const ao = normal[i * 4 + 2];
        expect(ao).toBeGreaterThan(40);
      }
      tilt /= SIZE * SIZE;
      expect(tilt, DETAIL_LAYERS[l]).toBeGreaterThan(0.03);
      expect(tilt, DETAIL_LAYERS[l]).toBeLessThan(0.75);
    }
  });

  it('tiles seamlessly: the wrap-around seam is no rougher than the interior', () => {
    for (let l = 0; l < DETAIL_LAYERS.length; l++) {
      const { albedo } = generateDetailLayer(l, SIZE, 11);
      const at = (x: number, y: number, c: number) => albedo[(y * SIZE + x) * 4 + c];
      let seam = 0;
      let inner = 0;
      for (let y = 0; y < SIZE; y++)
        for (let c = 0; c < 4; c++) {
          seam += Math.abs(at(SIZE - 1, y, c) - at(0, y, c));
          inner += Math.abs(at(SIZE / 2 - 1, y, c) - at(SIZE / 2, y, c));
        }
      expect(seam, DETAIL_LAYERS[l]).toBeLessThan(inner * 1.6 + SIZE * 4);
    }
  });

  it('packs all layers into one array-texture buffer, layer-major', () => {
    const set = generateDetailSet(32, 9);
    expect(set.layers).toBe(DETAIL_LAYERS.length);
    expect(set.albedo.length).toBe(32 * 32 * 4 * DETAIL_LAYERS.length);
    const l2 = generateDetailLayer(2, 32, 9);
    expect(set.albedo.subarray(2 * 32 * 32 * 4, 3 * 32 * 32 * 4)).toEqual(l2.albedo);
    expect(set.normal.subarray(2 * 32 * 32 * 4, 3 * 32 * 32 * 4)).toEqual(l2.normal);
  });
});

describe('noise texture (unit)', () => {
  const tex = generateNoiseTexture(NOISE_TEX_SIZE, 1);
  it('is RGBA, deterministic, uses the range in every channel and tiles', () => {
    expect(tex.length).toBe(NOISE_TEX_SIZE * NOISE_TEX_SIZE * 4);
    expect(generateNoiseTexture(NOISE_TEX_SIZE, 1)).toEqual(tex);
    for (let c = 0; c < 4; c++) {
      const s = stats(tex, 4, c);
      expect(s.hi - s.lo).toBeGreaterThan(150);
      expect(s.mean).toBeGreaterThan(80);
      expect(s.mean).toBeLessThan(175);
    }
    const N = NOISE_TEX_SIZE;
    const at = (x: number, y: number, c: number) => tex[(y * N + x) * 4 + c];
    let seam = 0;
    let inner = 0;
    for (let y = 0; y < N; y++)
      for (let c = 0; c < 4; c++) {
        seam += Math.abs(at(N - 1, y, c) - at(0, y, c));
        inner += Math.abs(at(N / 2 - 1, y, c) - at(N / 2, y, c));
      }
    expect(seam).toBeLessThan(inner * 1.5 + N * 4);
  });
  it('is smooth: neighbouring texels differ little in the value-noise channels (fuzz)', () => {
    const N = NOISE_TEX_SIZE;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: N - 1 }), fc.integer({ min: 0, max: N - 1 }), fc.integer({ min: 0, max: 1 }), (x, y, c) => {
        const a = tex[(y * N + x) * 4 + c];
        const b = tex[(y * N + ((x + 1) % N)) * 4 + c];
        expect(Math.abs(a - b)).toBeLessThan(48);
      }),
      { numRuns: 500 },
    );
  });
});

describe('detail textures (performance)', () => {
  it('generates the full 512² set in well under two seconds (runs in a worker at start-up)', () => {
    const t0 = performance.now();
    const set = generateDetailSet(512, 1);
    const ms = performance.now() - t0;
    expect(set.albedo.length).toBe(512 * 512 * 4 * DETAIL_LAYERS.length);
    expect(ms).toBeLessThan(2000);
  });
});
