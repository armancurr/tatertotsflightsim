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
