import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planRibbons, buildRun, mergeRuns, ribbonColumns, TRIM_MARGIN, type RibbonRun, type RibbonData } from '../../../src/world/roads/ribbon';
import { getRoadNetwork, KIND_RANK } from '../../../src/world/roads/network';
import { pointSegmentDistance } from '../../../src/world/towns/geom';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT } from './fixtures';

const rc = CONFIG.world.towns.roads;
const NET = getRoadNetwork(LAYOUT, HEIGHT);
const PLAN = planRibbons(NET, LAYOUT.bridges, rc);
const runs = PLAN.runs;
const pick = <T,>(a: T[], n: number, salt: number): T[] => {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(a[(i * 7919 + salt * 104729) % a.length]);
  return out;
};
const built = new Map<RibbonRun, RibbonData>();
const data = (r: RibbonRun): RibbonData => {
  let d = built.get(r);
  if (!d) built.set(r, (d = buildRun(r, HEIGHT, rc)));
  return d;
};

describe('road ribbons: plan (xz)', () => {
  it('is deterministic and covers every road kind', () => {
    const again = planRibbons(NET, LAYOUT.bridges, rc);
    expect(again.runs.length).toBe(runs.length);
    const kinds = new Set(runs.map((r) => r.kind));
    for (const k of ['highway', 'road', 'access', 'lane', 'street', 'drive']) expect(kinds.has(k as never)).toBe(true);
  });

  it('assigns each run to the chunk holding its sections', () => {
    for (const r of pick(runs, 400, 1)) {
      const size = rc.chunkSize;
      for (let k = 1; k < r.n - 1; k++) {
        expect(Math.floor(r.xs[k] / size)).toBe(r.ci);
        expect(Math.floor(r.zs[k] / size)).toBe(r.cj);
      }
    }
  });

  it('trims lower-ranked roads where they meet higher-ranked ones (no overlapping ribbons)', () => {
    // every section centre stays outside the corridor of every road processed before it
    const order = PLAN.order; // road indices in processing order
    const pos = new Map<number, number>();
    order.forEach((ri, k) => pos.set(ri, k));
    for (const r of pick(runs, 300, 2)) {
      const mine = pos.get(r.road)!;
      for (let k = 0; k < r.n; k++) {
        for (let o = 0; o < mine; o++) {
          const other = NET.roads[order[o]];
          if (KIND_RANK[other.kind] < KIND_RANK[r.kind]) continue;
          const pts = other.points;
          for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            if (Math.abs(a.x - r.xs[k]) > 60 && Math.abs(b.x - r.xs[k]) > 60) continue;
            if (Math.abs(a.z - r.zs[k]) > 60 && Math.abs(b.z - r.zs[k]) > 60) continue;
            expect(pointSegmentDistance(r.xs[k], r.zs[k], a.x, a.z, b.x, b.z)).toBeGreaterThan(other.width / 2 + TRIM_MARGIN - 0.05);
          }
        }
      }
    }
  }, 60_000);

  it('pieces are continuous across chunk boundaries (runs share their end section)', () => {
    const byPiece = new Map<number, RibbonRun[]>();
    for (const r of runs) (byPiece.get(r.piece) ?? byPiece.set(r.piece, []).get(r.piece)!).push(r);
    for (const list of byPiece.values()) {
      list.sort((a, b) => a.ss[0] - b.ss[0]);
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        expect(b.xs[0]).toBe(a.xs[a.n - 1]);
        expect(b.zs[0]).toBe(a.zs[a.n - 1]);
        expect(b.nx[0]).toBe(a.nx[a.n - 1]);
        expect(b.ss[0]).toBe(a.ss[a.n - 1]);
      }
    }
  });
});

describe('road ribbons: geometry', () => {
  it('has the paved width between the edge columns and skirts outside', () => {
    for (const r of pick(runs, 300, 3)) {
      const d = data(r);
      const cols = ribbonColumns(r.kind, r.width);
      const eL = 1;
      const eR = cols.length - 2;
      for (let k = 0; k < d.n; k++) {
        const o = k * cols.length * 3;
        const w = Math.hypot(d.pos[o + eR * 3] - d.pos[o + eL * 3], d.pos[o + eR * 3 + 2] - d.pos[o + eL * 3 + 2]);
        expect(w).toBeCloseTo(r.width, 2);
      }
    }
  });

  it('puts road vertices at the terrain height + lift (off bridges), skirts slightly into the ground', () => {
    for (const r of pick(runs, 300, 4)) {
      const d = data(r);
      const nc = ribbonColumns(r.kind, r.width).length;
      for (let k = 0; k < d.n; k++) {
        if (d.bridge[k] !== 0) continue;
        for (let c = 1; c < nc - 1; c++) {
          const o = (k * nc + c) * 3;
          expect(d.pos[o + 1]).toBeCloseTo(HEIGHT(d.pos[o], d.pos[o + 2]) + rc.lift, 3);
        }
        for (const c of [0, nc - 1]) {
          const o = (k * nc + c) * 3;
          expect(d.pos[o + 1]).toBeLessThan(HEIGHT(d.pos[o], d.pos[o + 2]) + 0.05);
        }
      }
    }
  });

  it('keeps consecutive sections close (continuity) and simplifies flat straight stretches', () => {
    let total = 0;
    let samples = 0;
    for (const r of pick(runs, 300, 5)) {
      const d = data(r);
      const nc = ribbonColumns(r.kind, r.width).length;
      const c = (nc - 1) / 2;
      total += d.n;
      samples += r.n;
      for (let k = 1; k < d.n; k++) {
        const a = ((k - 1) * nc + c) * 3;
        const b = (k * nc + c) * 3;
        expect(Math.hypot(d.pos[b] - d.pos[a], d.pos[b + 2] - d.pos[a + 2])).toBeLessThanOrEqual(rc.maxSegment + 1e-3);
      }
      // ends are kept exactly
      expect(d.pos[c * 3]).toBeCloseTo(r.xs[0], 2);
      expect(d.pos[((d.n - 1) * nc + c) * 3 + 2]).toBeCloseTo(r.zs[r.n - 1], 2);
    }
    expect(total).toBeLessThan(samples * 0.8);
  });

  it('fuzz: between kept sections the ribbon stays within the drape tolerance of the terrain', () => {
    const plain = runs.filter((r) => !r.bridge);
    fc.assert(
      fc.property(fc.nat({ max: plain.length - 1 }), fc.double({ min: 0, max: 1, noNaN: true }), (ri, t) => {
        const r = plain[ri];
        const d = data(r);
        const nc = ribbonColumns(r.kind, r.width).length;
        const c = (nc - 1) / 2;
        const k = Math.min(d.n - 2, Math.floor(t * (d.n - 1)));
        const f = t * (d.n - 1) - k;
        const a = (k * nc + c) * 3;
        const b = ((k + 1) * nc + c) * 3;
        const x = d.pos[a] + (d.pos[b] - d.pos[a]) * f;
        const y = d.pos[a + 1] + (d.pos[b + 1] - d.pos[a + 1]) * f;
        const z = d.pos[a + 2] + (d.pos[b + 2] - d.pos[a + 2]) * f;
        expect(Math.abs(y - (HEIGHT(x, z) + rc.lift))).toBeLessThan(rc.drapeTolerance * 4 + 0.02);
      }),
      { numRuns: 400 },
    );
  });

  it('lifts bridge decks above the river with approach ramps', () => {
    const bridged = runs.filter((r) => r.bridge);
    expect(bridged.length).toBeGreaterThanOrEqual(LAYOUT.bridges.length);
    for (const b of LAYOUT.bridges) {
      const mine = bridged.filter((r) => r.bridge!.x === b.x && r.bridge!.z === b.z);
      expect(mine.length).toBeGreaterThan(0);
      let spanSections = 0;
      for (const r of mine) {
        const d = data(r);
        const nc = ribbonColumns(r.kind, r.width).length;
        for (let k = 0; k < d.n; k++) {
          if (d.bridge[k] !== 2) continue;
          spanSections++;
          const o = (k * nc + (nc - 1) / 2) * 3;
          expect(d.pos[o + 1]).toBeGreaterThanOrEqual(b.waterLevel + rc.bridgeClearance);
          expect(d.pos[o + 1]).toBeGreaterThan(HEIGHT(d.pos[o], d.pos[o + 2]));
        }
      }
      expect(spanSections).toBeGreaterThanOrEqual(2);
    }
  });

  it('merges runs into one indexed geometry per chunk', () => {
    const some = pick(runs, 20, 6);
    const ds = some.map(data);
    const m = mergeRuns(some, ds);
    let verts = 0;
    let tris = 0;
    some.forEach((r, i) => {
      const nc = ribbonColumns(r.kind, r.width).length;
      verts += ds[i].n * nc;
      tris += (ds[i].n - 1) * (nc - 1) * 2;
    });
    expect(m.position.length).toBe(verts * 3);
    expect(m.road.length).toBe(verts * 4);
    expect(m.index.length).toBe(tris * 3);
    for (const i of m.index) expect(i).toBeLessThan(verts);
  });
});
