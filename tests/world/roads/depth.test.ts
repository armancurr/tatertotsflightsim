import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { terrainSpacingAt, lodLift, pulledDepth, coveredError, liftScreenShift } from '../../../src/world/roads/depth';
import { pavedLift } from '../../../src/world/roads/ribbon';
import { shouldSplit, morphRange, lodParamsFromConfig } from '../../../src/world/terrain/quadtree';
import { getLayout } from '../../../src/world/layout';
import { terrainHeight } from '../../../src/world/heightfield';
import { getRoadNetwork, type NetKind } from '../../../src/world/roads/network';
import { CONFIG } from '../../../src/config';

const rc = CONFIG.world.towns.roads;
const tc = CONFIG.world.terrain;
const LOD = lodParamsFromConfig(CONFIG);

/** The terrain mesh height at (x, z) for grid spacing D (tile vertices on multiples of D, anti-diagonal split as chunk.ts). */
function meshHeight(x: number, z: number, D: number): number {
  const i = Math.floor(x / D);
  const j = Math.floor(z / D);
  const fx = x / D - i;
  const fz = z / D - j;
  const h00 = terrainHeight(i * D, j * D);
  const h10 = terrainHeight((i + 1) * D, j * D);
  const h01 = terrainHeight(i * D, (j + 1) * D);
  const h11 = terrainHeight((i + 1) * D, (j + 1) * D);
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

/** Largest power-of-two grid spacing not above s (the terrain's spacings are rootSize/2^L/res). */
const gridSpacing = (s: number): number => 2 ** Math.floor(Math.log2(s) + 1e-9);

describe('road depth: terrain LOD spacing bound', { timeout: 120_000 }, () => {
  it('fuzz: a vertex at distance d is never on a coarser grid than terrainSpacingAt(d)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9 }), fc.double({ min: 0, max: 1, noNaN: true }), (level, f) => {
        const S = tc.minTileSize * 2 ** level;
        // this leaf exists only while its box is ≥ S·split away; its vertices are at least that far
        const dMin = S * LOD.splitFactor;
        const d = dMin + f * S * 4;
        expect(shouldSplit(S, dMin, LOD)).toBe(false);
        const [m0] = morphRange(S, tc.lodSplitFactor);
        const spacing = d >= m0 ? (2 * S) / tc.chunkResolution : S / tc.chunkResolution;
        expect(spacing).toBeLessThanOrEqual(terrainSpacingAt(d) * (1 + 1e-9));
      }),
      { numRuns: 400 },
    );
  });
});

describe('road depth: the LOD lift keeps roads above the coarse terrain mesh', { timeout: 120_000 }, () => {
  const layout = getLayout();
  const net = getRoadNetwork(layout, terrainHeight);
  const kinds: NetKind[] = ['highway', 'road', 'lane', 'street', 'drive'];
  for (const kind of kinds) {
    it(`${kind}: ≥ 99.5 % of road points stay above the mesh at every distance 150 m – 14 km`, () => {
      const pts: { x: number; z: number }[] = [];
      for (const r of net.roads) {
        if (r.kind !== kind) continue;
        for (let i = 0; i < r.points.length; i += 3) pts.push(r.points[i]);
      }
      const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 1500)) === 0);
      let bad = 0;
      let total = 0;
      for (const d of [150, 400, 1000, 2500, 5000, 9000, 14000]) {
        const D = gridSpacing(terrainSpacingAt(d));
        for (const p of sample) {
          const err = meshHeight(p.x, p.z, D) - terrainHeight(p.x, p.z);
          total++;
          if (err > pavedLift(kind, rc) + lodLift(kind, d, rc)) bad++;
        }
      }
      expect(bad / total).toBeLessThan(0.005);
    }, 60_000);
  }
});

describe('road depth: the view-space pull', { timeout: 120_000 }, () => {
  it('fuzz: leaves the screen position unchanged and pulls depth by pull·d (order preserved)', () => {
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 90000);
    cam.updateProjectionMatrix();
    fc.assert(
      fc.property(
        fc.double({ min: -2000, max: 2000, noNaN: true }),
        fc.double({ min: -1500, max: 1500, noNaN: true }),
        fc.double({ min: 20, max: 20000, noNaN: true }),
        fc.double({ min: 0.01, max: 50, noNaN: true }),
        (x, y, depth, gap) => {
          const p = new THREE.Vector4(x, y, -depth, 1);
          const q = new THREE.Vector4(x * (1 - rc.depthPull), y * (1 - rc.depthPull), -depth * (1 - rc.depthPull), 1);
          const a = p.clone().applyMatrix4(cam.projectionMatrix);
          const b = q.clone().applyMatrix4(cam.projectionMatrix);
          expect(a.x / a.w).toBeCloseTo(b.x / b.w, 9);
          expect(a.y / a.w).toBeCloseTo(b.y / b.w, 9);
          expect(depth - pulledDepth(depth)).toBeCloseTo(rc.depthPull * depth, 6);
          // two points on one ray keep their order
          expect(pulledDepth(depth + gap)).toBeGreaterThan(pulledDepth(depth));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('covers more vertical error from high up (pull·h) and never shifts a road by more than ~3 px', () => {
    expect(coveredError('street', 3000, 8000)).toBeGreaterThan(coveredError('street', 3000, 50));
    expect(coveredError('highway', 8000, 8000)).toBeGreaterThan(9);
    const pxPerRad = 900 / (2 * Math.tan((30 * Math.PI) / 180));
    for (const kind of ['highway', 'road', 'access', 'lane', 'street', 'drive'] as NetKind[])
      for (const d of [100, 1000, 10000]) expect(liftScreenShift(kind, d, 0) * pxPerRad).toBeLessThan(3);
  });
});
