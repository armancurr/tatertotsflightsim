/**
 * Builds one terrain tile's vertex data from the pure heightfield + landcover
 * (PURE; runs in the terrain worker, and in node for tests).
 *
 * Layout per tile (res quads per side):
 *   (res+1)² grid vertices, row-major (j = z index, i = x index), then 4·(res+1)
 *   skirt vertices (north, south, west, east edges) hanging `skirt` metres below.
 * Attributes:
 *   positions Float32 ×3 — x, z relative to the tile centre (precision); y absolute (m MSL)
 *   normals   Int16 ×3 (normalised)
 *   lc0, lc1  Uint8 ×4 (normalised) — landcover weights in LANDCOVER_KEYS order
 *   morph     Float32 ×3 — (Δy to the parent LOD's surface, water level, tile size)
 * The index buffer is identical for every tile (createChunkIndex) and shared.
 * Triangulation uses the anti-diagonal of each quad everywhere, so a tile fully
 * morphed to its parent grid lies exactly on the parent's triangles.
 */
import type { Heightfield } from '../heightfield';
import { newTerrainSample } from '../heightfield';
import type { Landcover } from '../landcover';
import { newLandcover } from '../landcover';

export interface ChunkRequest {
  /** Min corner (world x, z) and edge length, m. */
  x0: number;
  z0: number;
  size: number;
  /** Quads per side. */
  res: number;
  /** Skirt depth, m (default proportional to size). */
  skirt?: number;
}

export interface ChunkData {
  positions: Float32Array;
  normals: Int16Array;
  lc0: Uint8Array;
  lc1: Uint8Array;
  morph: Float32Array;
  /** Height range including skirts (for bounding volumes). */
  minY: number;
  maxY: number;
  /** Height range of the surface only. */
  surfaceMinY: number;
  surfaceMaxY: number;
  center: { x: number; z: number };
  size: number;
}

export function chunkVertexCount(res: number): number {
  return (res + 1) * (res + 1) + 4 * (res + 1);
}

export function defaultSkirt(size: number, res: number): number {
  return Math.max(3, (size / res) * 1.2 + size * 0.004);
}

/** Shared triangle index buffer for a tile of `res` quads per side (grid + skirts). */
export function createChunkIndex(res: number): Uint16Array | Uint32Array {
  const n = res + 1;
  const nv = chunkVertexCount(res);
  const tris = res * res * 2 + 4 * res * 2;
  const idx = nv > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
  let k = 0;
  const g = (i: number, j: number) => j * n + i;
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) {
      const a = g(i, j);
      const b = g(i + 1, j);
      const c = g(i, j + 1);
      const d = g(i + 1, j + 1);
      // anti-diagonal b–c; counter-clockwise seen from +Y
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  const base = n * n;
  const north = base; // j = 0
  const south = base + n; // j = res
  const west = base + 2 * n; // i = 0
  const east = base + 3 * n; // i = res
  for (let i = 0; i < res; i++) {
    // north edge, outward −z
    let e0 = g(i, 0);
    let e1 = g(i + 1, 0);
    let s0 = north + i;
    let s1 = north + i + 1;
    idx[k++] = e0;
    idx[k++] = e1;
    idx[k++] = s0;
    idx[k++] = e1;
    idx[k++] = s1;
    idx[k++] = s0;
    // south edge, outward +z
    e0 = g(i, res);
    e1 = g(i + 1, res);
    s0 = south + i;
    s1 = south + i + 1;
    idx[k++] = e0;
    idx[k++] = s0;
    idx[k++] = e1;
    idx[k++] = e1;
    idx[k++] = s0;
    idx[k++] = s1;
  }
  for (let j = 0; j < res; j++) {
    // west edge, outward −x
    let e0 = g(0, j);
    let e1 = g(0, j + 1);
    let s0 = west + j;
    let s1 = west + j + 1;
    idx[k++] = e0;
    idx[k++] = s0;
    idx[k++] = e1;
    idx[k++] = e1;
    idx[k++] = s0;
    idx[k++] = s1;
    // east edge, outward +x
    e0 = g(res, j);
    e1 = g(res, j + 1);
    s0 = east + j;
    s1 = east + j + 1;
    idx[k++] = e0;
    idx[k++] = e1;
    idx[k++] = s0;
    idx[k++] = e1;
    idx[k++] = s1;
    idx[k++] = s0;
  }
  return idx;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Builds a tile. Allocates its output arrays (they are transferred to the main thread). */
export function buildChunk(hf: Heightfield, lc: Landcover, req: ChunkRequest): ChunkData {
  const { x0, z0, size, res } = req;
  const skirt = req.skirt ?? defaultSkirt(size, res);
  const n = res + 1;
  const step = size / res;
  const cx = x0 + size / 2;
  const cz = z0 + size / 2;
  const nv = chunkVertexCount(res);
  const positions = new Float32Array(nv * 3);
  const normals = new Int16Array(nv * 3);
  const lc0 = new Uint8Array(nv * 4);
  const lc1 = new Uint8Array(nv * 4);
  const morph = new Float32Array(nv * 3);

  // Heights on a grid with a one-vertex border (for central-difference normals); full terrain
  // samples for the interior vertices, stored field-by-field (no per-vertex objects).
  const B = n + 2;
  const H = new Float64Array(B * B);
  const nn = n * n;
  const F = new Float64Array(nn * 11);
  const lakeIdx = new Int16Array(nn);
  const s = newTerrainSample();
  for (let jj = 0; jj < B; jj++) {
    const z = z0 + (jj - 1) * step;
    for (let ii = 0; ii < B; ii++) {
      const x = x0 + (ii - 1) * step;
      if (ii < 1 || ii > n || jj < 1 || jj > n) {
        H[jj * B + ii] = hf.height(x, z);
        continue;
      }
      hf.sample(x, z, s);
      H[jj * B + ii] = s.h;
      const o = ((jj - 1) * n + (ii - 1)) * 11;
      F[o] = s.h;
      F[o + 1] = s.base;
      F[o + 2] = s.coast;
      F[o + 3] = s.footMask;
      F[o + 4] = s.rangeMask;
      F[o + 5] = s.riverD;
      F[o + 6] = s.riverLevel;
      F[o + 7] = s.riverHalfWidth;
      F[o + 8] = s.lakeSd;
      F[o + 9] = s.roadD;
      F[o + 10] = s.roadHalfWidth;
      lakeIdx[(jj - 1) * n + (ii - 1)] = s.lakeIndex;
    }
  }
  let minY = Infinity;
  let maxY = -Infinity;
  const w = newLandcover();
  const nrm = { x: 0, y: 1, z: 0 };
  const lakes = hf.layout.lakes;
  const apX = hf.layout.airport.runway.center.x;
  const apZ = hf.layout.airport.runway.center.z;
  for (let j = 0; j < n; j++) {
    const z = z0 + j * step;
    for (let i = 0; i < n; i++) {
      const x = x0 + i * step;
      const v = j * n + i;
      const hc = H[(j + 1) * B + (i + 1)];
      let nx = H[(j + 1) * B + i] - H[(j + 1) * B + (i + 2)];
      let ny = 2 * step;
      let nz = H[j * B + (i + 1)] - H[(j + 2) * B + (i + 1)];
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= l;
      ny /= l;
      nz /= l;
      positions[v * 3] = x - cx;
      positions[v * 3 + 1] = hc;
      positions[v * 3 + 2] = z - cz;
      normals[v * 3] = Math.round(nx * 32767);
      normals[v * 3 + 1] = Math.round(ny * 32767);
      normals[v * 3 + 2] = Math.round(nz * 32767);
      if (hc < minY) minY = hc;
      if (hc > maxY) maxY = hc;
      // Landcover. Coarse tiles average slopes away; in the mountains use the local slope so
      // far ranges still show their rock and snow.
      const o = v * 11;
      s.h = F[o];
      s.base = F[o + 1];
      s.coast = F[o + 2];
      s.footMask = F[o + 3];
      s.rangeMask = F[o + 4];
      s.riverD = F[o + 5];
      s.riverLevel = F[o + 6];
      s.riverHalfWidth = F[o + 7];
      s.lakeSd = F[o + 8];
      s.roadD = F[o + 9];
      s.roadHalfWidth = F[o + 10];
      s.lakeIndex = lakeIdx[v];
      s.valleyT = 1;
      s.airportD = Math.hypot(x - apX, z - apZ);
      let slopeY = ny;
      if (step > 12 && hc > 900) slopeY = Math.min(ny, hf.normalInto(x, z, nrm).y * 0.5 + ny * 0.5);
      lc.fromSample(s, slopeY, x, z, w, nz, false);
      lc0[v * 4] = Math.round(clamp01(w.forest) * 255);
      lc0[v * 4 + 1] = Math.round(clamp01(w.field) * 255);
      lc0[v * 4 + 2] = Math.round(clamp01(w.grass) * 255);
      lc0[v * 4 + 3] = Math.round(clamp01(w.rock) * 255);
      lc1[v * 4] = Math.round(clamp01(w.snow) * 255);
      lc1[v * 4 + 1] = Math.round(clamp01(w.sand) * 255);
      lc1[v * 4 + 2] = Math.round(clamp01(w.urban) * 255);
      lc1[v * 4 + 3] = Math.round(clamp01(w.water) * 255);
      // water level for the underwater tint: the lake near lakes, the river near the river, else the sea
      let wl = 0;
      if (s.lakeIndex >= 0 && s.lakeSd < 360) wl = lakes[s.lakeIndex].level;
      else if (s.riverD < s.riverHalfWidth + 80) wl = s.riverLevel;
      morph[v * 3 + 1] = wl;
      morph[v * 3 + 2] = size;
    }
  }
  // Morph targets: the parent grid (even indices) with the same anti-diagonal triangulation.
  const Hg = (i: number, j: number) => H[(j + 1) * B + (i + 1)];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const oi = (i & 1) === 1;
      const oj = (j & 1) === 1;
      let coarse = Hg(i, j);
      if (oi && !oj) coarse = (Hg(i - 1, j) + Hg(i + 1, j)) / 2;
      else if (!oi && oj) coarse = (Hg(i, j - 1) + Hg(i, j + 1)) / 2;
      else if (oi && oj) coarse = (Hg(i + 1, j - 1) + Hg(i - 1, j + 1)) / 2;
      morph[(j * n + i) * 3] = coarse - Hg(i, j);
    }
  // Skirts: copies of the edge vertices, lowered.
  const base = n * n;
  const copy = (dst: number, src: number) => {
    positions[dst * 3] = positions[src * 3];
    positions[dst * 3 + 1] = positions[src * 3 + 1] - skirt;
    positions[dst * 3 + 2] = positions[src * 3 + 2];
    normals[dst * 3] = normals[src * 3];
    normals[dst * 3 + 1] = normals[src * 3 + 1];
    normals[dst * 3 + 2] = normals[src * 3 + 2];
    for (let k = 0; k < 4; k++) {
      lc0[dst * 4 + k] = lc0[src * 4 + k];
      lc1[dst * 4 + k] = lc1[src * 4 + k];
    }
    morph[dst * 3] = morph[src * 3];
    morph[dst * 3 + 1] = morph[src * 3 + 1];
    morph[dst * 3 + 2] = morph[src * 3 + 2];
  };
  for (let i = 0; i < n; i++) {
    copy(base + i, i); // north (j = 0)
    copy(base + n + i, res * n + i); // south (j = res)
    copy(base + 2 * n + i, i * n); // west (i = 0), indexed by j
    copy(base + 3 * n + i, i * n + res); // east (i = res), indexed by j
  }
  return {
    positions,
    normals,
    lc0,
    lc1,
    morph,
    minY: minY - skirt,
    maxY,
    surfaceMinY: minY,
    surfaceMaxY: maxY,
    center: { x: cx, z: cz },
    size,
  };
}
