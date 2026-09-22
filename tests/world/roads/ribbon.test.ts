import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planRoads, runsFor, type RibbonRun } from '../../../src/world/roads/plan';
import { buildRun, mergeRibbons, ribbonColumns, pavedLift, VERGE_LIFT, FLAG_SIDEWALK, type RibbonData } from '../../../src/world/roads/ribbon';
import { getRoadNetwork } from '../../../src/world/roads/network';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT } from '../towns/fixtures';

const rc = CONFIG.world.towns.roads;
const PLAN = planRoads(getRoadNetwork(LAYOUT, HEIGHT), LAYOUT.bridges, LAYOUT.towns, rc);
const runs = runsFor(PLAN.pieces, rc.chunkSize);
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
const col = (d: RibbonData, k: number, c: number) => (k * d.nc + c) * 3;

describe('road ribbons: cross-sections', { timeout: 120_000 }, () => {
  it('columns are symmetric, contain the paved edges and the centre, outermost = verge edge', () => {
    for (const p of pick(PLAN.pieces, 200, 1)) {
      for (const mode of ['near', 'far'] as const) {
        const cols = ribbonColumns(p, mode);
        const hw = p.width / 2;
        expect(cols).toContain(hw);
        expect(cols).toContain(-hw);
        expect(cols).toContain(0);
        for (let i = 0; i < cols.length; i++) expect(cols[i]).toBeCloseTo(-cols[cols.length - 1 - i], 9);
        for (let i = 1; i < cols.length; i++) expect(cols[i]).toBeGreaterThan(cols[i - 1]);
        const outer = hw + (p.style.sidewalk > 0 ? p.style.sidewalk : p.style.shoulder) + p.style.fade;
        expect(cols[cols.length - 1]).toBeCloseTo(outer, 9);
      }
    }
  });

  it('has exactly the paved width between the edge columns', () => {
    for (const r of pick(runs, 300, 3)) {
      const d = data(r);
      const cols = ribbonColumns(r.piece);
      const eL = cols.indexOf(-r.piece.width / 2);
      const eR = cols.indexOf(r.piece.width / 2);
      for (let k = 0; k < d.n; k++) {
        const a = col(d, k, eL);
        const b = col(d, k, eR);
        expect(Math.hypot(d.pos[b] - d.pos[a], d.pos[b + 2] - d.pos[a + 2])).toBeCloseTo(r.piece.width, 2);
      }
    }
  });

  it('drapes paved columns at terrain + paved lift (off bridges) and the verge edge at terrain + VERGE_LIFT', () => {
    for (const r of pick(runs, 300, 4)) {
      const d = data(r);
      const cols = ribbonColumns(r.piece);
      const hw = r.piece.width / 2;
      for (let k = 0; k < d.n; k++) {
        if (d.bridge[k] !== 0) continue;
        for (let c = 0; c < d.nc; c++) {
          const o = col(d, k, c);
          const g = HEIGHT(d.pos[o], d.pos[o + 2]);
          if (Math.abs(cols[c]) <= hw + 1e-9) expect(d.pos[o + 1]).toBeCloseTo(g + pavedLift(r.piece.kind, rc), 3);
          if (c === 0 || c === d.nc - 1) expect(d.pos[o + 1]).toBeCloseTo(g + VERGE_LIFT, 3);
        }
      }
    }
  });

  it('keeps paved surfaces above every verge (junction overlaps resolve to the road)', () => {
    for (const r of pick(runs, 200, 5)) {
      const d = data(r);
      for (let k = 0; k < d.n; k++) {
        if (d.bridge[k] !== 0) continue;
        const c = (d.nc - 1) / 2;
        const o = col(d, k, c);
        expect(d.pos[o + 1] - HEIGHT(d.pos[o], d.pos[o + 2])).toBeGreaterThan(VERGE_LIFT + 0.05);
      }
    }
  });

  it('keeps consecutive sections within maxSegment and simplifies flat straight stretches', () => {
    let kept = 0;
    let samples = 0;
    for (const r of pick(runs, 300, 6)) {
      const d = data(r);
      const c = (d.nc - 1) / 2;
      kept += d.n;
      samples += r.i1 - r.i0 + 1;
      for (let k = 1; k < d.n; k++) {
        const a = col(d, k - 1, c);
        const b = col(d, k, c);
        expect(Math.hypot(d.pos[b] - d.pos[a], d.pos[b + 2] - d.pos[a + 2])).toBeLessThanOrEqual(rc.maxSegment + 0.01);
      }
      expect(d.src[0]).toBe(r.i0);
      expect(d.src[d.n - 1]).toBe(r.i1);
    }
    expect(kept).toBeLessThan(samples * 0.8);
  });

  it('fuzz: between kept sections the centreline stays within the drape tolerance of the terrain', () => {
    const plain = runs.filter((r) => !r.piece.bridge);
    fc.assert(
      fc.property(fc.nat({ max: plain.length - 1 }), fc.double({ min: 0, max: 1, noNaN: true }), (ri, t) => {
        const r = plain[ri];
        const d = data(r);
        const c = (d.nc - 1) / 2;
        const k = Math.min(d.n - 2, Math.floor(t * (d.n - 1)));
        const f = t * (d.n - 1) - k;
        const a = col(d, k, c);
        const b = col(d, k + 1, c);
        const x = d.pos[a] + (d.pos[b] - d.pos[a]) * f;
        const y = d.pos[a + 1] + (d.pos[b + 1] - d.pos[a + 1]) * f;
        const z = d.pos[a + 2] + (d.pos[b + 2] - d.pos[a + 2]) * f;
        expect(Math.abs(y - (HEIGHT(x, z) + pavedLift(r.piece.kind, rc)))).toBeLessThan(rc.drapeTolerance * 4 + 0.02);
      }),
      { numRuns: 400 },
    );
  });

  it('lifts bridge decks above the river with approach ramps, verges tucked under the parapet on the span', () => {
    for (const b of LAYOUT.bridges) {
      const mine = runs.filter((r) => r.piece.bridge && r.piece.bridge.x === b.x && r.piece.bridge.z === b.z);
      expect(mine.length).toBeGreaterThan(0);
      let span = 0;
      let ramp = 0;
      for (const r of mine) {
        const d = data(r);
        for (let k = 0; k < d.n; k++) {
          const o = col(d, k, (d.nc - 1) / 2);
          if (d.bridge[k] === 2) {
            span++;
            expect(d.pos[o + 1]).toBeGreaterThanOrEqual(b.waterLevel + rc.bridgeClearance);
            expect(d.pos[o + 1]).toBeGreaterThan(HEIGHT(d.pos[o], d.pos[o + 2]));
            // outer columns right under the deck edge
            const e = col(d, k, 0);
            expect(d.pos[e + 1]).toBeLessThan(d.pos[o + 1]);
            expect(d.pos[o + 1] - d.pos[e + 1]).toBeLessThan(1);
          }
          if (d.bridge[k] === 1) ramp++;
        }
      }
      expect(span).toBeGreaterThanOrEqual(2);
      expect(ramp).toBeGreaterThanOrEqual(2);
    }
  });

  it('writes the shader attributes: across/along/half width/info and linear junction distances', () => {
    for (const r of pick(runs, 200, 7)) {
      const d = data(r);
      const p = r.piece;
      const cols = ribbonColumns(p);
      const len = p.ss[p.n - 1] - p.ss[0];
      for (let k = 0; k < d.n; k++)
        for (let c = 0; c < d.nc; c++) {
          const v = k * d.nc + c;
          expect(d.road[v * 4]).toBeCloseTo(cols[c], 5);
          expect(d.road[v * 4 + 2]).toBeCloseTo(p.width / 2, 5);
          const info = d.road[v * 4 + 3];
          expect(info % 8).toBe(['highway', 'road', 'access', 'lane', 'street', 'drive'].indexOf(p.kind));
          expect(((Math.floor(info / 8) % 8) & FLAG_SIDEWALK) !== 0).toBe(p.style.sidewalk > 0);
          const dS = d.junc[v * 4];
          const dE = d.junc[v * 4 + 1];
          expect(dS + dE).toBeCloseTo(len + p.start.off + p.end.off, 2);
          expect(dS).toBeGreaterThanOrEqual(p.start.off - 1e-3);
          expect(d.junc[v * 4 + 2]).toBe(Math.fround(p.start.h));
          expect(d.junc[v * 4 + 3]).toBe(Math.fround(p.end.h));
        }
      for (let k = 1; k < d.n; k++) expect(d.road[k * d.nc * 4 + 1]).toBeGreaterThan(d.road[(k - 1) * d.nc * 4 + 1]);
    }
  });

  it('has unit, upward normals', () => {
    for (const r of pick(runs, 200, 8)) {
      const d = data(r);
      for (let v = 0; v < d.n * d.nc; v++) {
        expect(Math.hypot(d.normal[v * 3], d.normal[v * 3 + 1], d.normal[v * 3 + 2])).toBeCloseTo(1, 4);
        expect(d.normal[v * 3 + 1]).toBeGreaterThan(0.2);
      }
    }
  });

  it('far LOD: 5 columns, fewer sections', () => {
    let near = 0;
    let far = 0;
    for (const r of pick(runs.filter((q) => q.piece.kind !== 'drive'), 150, 9)) {
      const f = buildRun(r, HEIGHT, rc, { mode: 'far', stride: rc.farStride, tolerance: rc.farTolerance, maxSegment: rc.farMaxSegment });
      expect(f.nc).toBe(5);
      near += data(r).n;
      far += f.n;
    }
    expect(far).toBeLessThan(near);
  });

  it('merges runs and structure parts into one indexed geometry (CCW seen from above)', () => {
    const some = pick(runs, 20, 10);
    const ds = some.map(data);
    const m = mergeRibbons(ds, [], 1000, 2000);
    let verts = 0;
    let tris = 0;
    for (const d of ds) {
      verts += d.n * d.nc;
      tris += (d.n - 1) * (d.nc - 1) * 2;
    }
    expect(m.position.length).toBe(verts * 3);
    expect(m.index.length).toBe(tris * 3);
    for (const i of m.index) expect(i).toBeLessThan(verts);
    // counter-clockwise from above → geometric normal points up
    let up = 0;
    for (let t = 0; t < m.index.length; t += 3) {
      const [a, b, c] = [m.index[t], m.index[t + 1], m.index[t + 2]];
      const ux = m.position[b * 3] - m.position[a * 3];
      const uz = m.position[b * 3 + 2] - m.position[a * 3 + 2];
      const vx = m.position[c * 3] - m.position[a * 3];
      const vz = m.position[c * 3 + 2] - m.position[a * 3 + 2];
      const ny = uz * vx - ux * vz;
      if (ny > 0) up++;
      else if (ny < 0) up--;
    }
    expect(up).toBeGreaterThan(tris * 0.95);
    expect(m.minY).toBeLessThanOrEqual(m.maxY);
  });
});
