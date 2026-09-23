import { describe, it, expect } from 'vitest';
import { generateParticleAtlas, ATLAS_COLS, ATLAS_ROWS, SMOKE_TILES, FLAME_TILES } from '../../src/fx/sprites';

const TILE = 64;
const atlas = generateParticleAtlas(TILE, 3);

function tilePixels(t: number) {
  const col = t % ATLAS_COLS;
  const row = Math.floor(t / ATLAS_COLS);
  const px: { x: number; y: number; r: number; g: number; b: number; a: number }[] = [];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const o = ((row * TILE + y) * atlas.width + col * TILE + x) * 4;
      px.push({ x, y, r: atlas.data[o], g: atlas.data[o + 1], b: atlas.data[o + 2], a: atlas.data[o + 3] });
    }
  }
  return px;
}

/**
 * Alpha statistics of a tile: fraction of the covered texels that are nearly opaque (> 0.9) or
 * clearly translucent (< 0.75), the largest alpha step between neighbouring texels, and how much the
 * silhouette radius (a > 0.5, measured from the alpha centroid) varies with angle (std / mean).
 */
function alphaStats(t: number) {
  const a = tilePixels(t).map((p) => p.a / 255);
  let cov = 0, opaque = 0, soft = 0, step = 0, sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const v = a[y * TILE + x];
      if (v > 0.03) {
        cov++;
        if (v > 0.9) opaque++;
        if (v < 0.75) soft++;
      }
      if (x + 1 < TILE) step = Math.max(step, Math.abs(a[y * TILE + x + 1] - v));
      if (y + 1 < TILE) step = Math.max(step, Math.abs(a[(y + 1) * TILE + x] - v));
      sx += x * v; sy += y * v; sw += v;
    }
  }
  const cx = sx / sw, cy = sy / sw;
  const radii: number[] = [];
  for (let k = 0; k < 64; k++) {
    const ang = (k / 64) * Math.PI * 2;
    let r = 0;
    for (let s = 0; s < TILE; s += 0.5) {
      const x = Math.round(cx + Math.cos(ang) * s), y = Math.round(cy + Math.sin(ang) * s);
      if (x < 0 || y < 0 || x >= TILE || y >= TILE) break;
      if (a[y * TILE + x] > 0.5) r = s;
    }
    radii.push(r);
  }
  const m = radii.reduce((s, r) => s + r, 0) / radii.length;
  const sd = Math.sqrt(radii.reduce((s, r) => s + (r - m) ** 2, 0) / radii.length);
  return { opaqueFrac: opaque / cov, softFrac: soft / cov, maxStep: step, radiusCV: m > 0 ? sd / m : 0 };
}

describe('generateParticleAtlas', () => {
  it('has the documented layout', () => {
    expect(atlas.width).toBe(TILE * ATLAS_COLS);
    expect(atlas.height).toBe(TILE * ATLAS_ROWS);
    expect(atlas.data.length).toBe(atlas.width * atlas.height * 4);
    expect(SMOKE_TILES.length + FLAME_TILES.length).toBe(ATLAS_COLS * ATLAS_ROWS);
  });
  it('is deterministic per seed', () => {
    const again = generateParticleAtlas(TILE, 3);
    expect(Buffer.from(again.data).equals(Buffer.from(atlas.data))).toBe(true);
    const other = generateParticleAtlas(TILE, 4);
    expect(Buffer.from(other.data).equals(Buffer.from(atlas.data))).toBe(false);
  });
  it('every tile is soft: zero alpha on its border (no hard edges, no mip bleeding), solid in the middle', () => {
    for (let t = 0; t < ATLAS_COLS * ATLAS_ROWS; t++) {
      const px = tilePixels(t);
      const border = px.filter((p) => p.x < 2 || p.y < 2 || p.x >= TILE - 2 || p.y >= TILE - 2);
      expect(Math.max(...border.map((p) => p.a))).toBe(0);
      expect(Math.max(...px.map((p) => p.a))).toBeGreaterThan(200);
      const mean = px.reduce((s, p) => s + p.a, 0) / px.length / 255;
      expect(mean).toBeGreaterThan(0.06);
      expect(mean).toBeLessThan(0.6);
    }
  });
  it('smoke puffs carry volumetric normals (left half faces left, right half faces right)', () => {
    for (const t of SMOKE_TILES) {
      const px = tilePixels(t).filter((p) => p.a > 60);
      const left = px.filter((p) => p.x < TILE * 0.35);
      const right = px.filter((p) => p.x > TILE * 0.65);
      const avg = (arr: typeof px) => arr.reduce((s, p) => s + p.r, 0) / arr.length;
      expect(avg(left)).toBeLessThan(118);
      expect(avg(right)).toBeGreaterThan(138);
    }
  });
  it('transparent texels have a neutral normal', () => {
    const px = tilePixels(SMOKE_TILES[0]).filter((p) => p.a === 0);
    for (const p of px) {
      expect(Math.abs(p.r - 128)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.g - 128)).toBeLessThanOrEqual(1);
    }
  });
  it('smoke puffs are soft, ragged billows — not solid discs (restored)', () => {
    for (const t of SMOKE_TILES) {
      const s = alphaStats(t);
      expect(s.opaqueFrac, `tile ${t} opaque`).toBeLessThan(0.3);
      expect(s.softFrac, `tile ${t} soft`).toBeGreaterThan(0.5);
      expect(s.radiusCV, `tile ${t} not a circle`).toBeGreaterThan(0.07);
      expect(s.maxStep, `tile ${t} step`).toBeLessThan(0.25);
    }
  });
  it('flames are soft licks — not clip-art icons with hard edges (restored)', () => {
    for (const t of FLAME_TILES) {
      const s = alphaStats(t);
      expect(s.maxStep, `tile ${t} step`).toBeLessThan(0.25);
      expect(s.opaqueFrac, `tile ${t} opaque`).toBeLessThan(0.35);
    }
  });
  it('flames are tongues: mass in the lower part, narrowing to the top', () => {
    for (const t of FLAME_TILES) {
      const px = tilePixels(t);
      const mass = px.reduce((s, p) => s + p.a, 0);
      const cy = px.reduce((s, p) => s + p.a * p.y, 0) / mass;
      expect(cy).toBeLessThan(TILE * 0.5);
      const rowWidth = (y0: number, y1: number) => px.filter((p) => p.y >= y0 && p.y < y1 && p.a > 40).length;
      expect(rowWidth(TILE * 0.2, TILE * 0.35)).toBeGreaterThan(rowWidth(TILE * 0.65, TILE * 0.8));
    }
  });
});
