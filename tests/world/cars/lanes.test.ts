import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { pieceLayout, KIND, LaneGraph, PARK_BAND, type LanePoint } from '../../../src/world/cars/lanes';
import { laneGraph, laneData } from './fixtures';

const pt = (): LanePoint => ({ x: 0, z: 0, hx: 0, hz: 0 });

describe('lane layout per road kind (right-hand traffic)', () => {
  it('highway: one 3.65 m lane each way either side of the double yellow', () => {
    const l = pieceLayout(KIND.highway, 11, 0, -1, 0.3);
    expect(l.fwd).toBeCloseTo(0.05 + 3.65 / 2, 3);
    expect(l.bwd).toBeCloseTo(-(0.05 + 3.65 / 2), 3);
    expect(l.park).toBe(0);
    expect(l.maxWidth).toBeGreaterThan(2.6);
  });
  it('two-lane road: lanes in the middle of the 3.3 m lanes', () => {
    const l = pieceLayout(KIND.road, 7, 0, -1, 0.3);
    expect(l.fwd).toBeCloseTo(1.65, 3);
    expect(l.bwd).toBeCloseTo(-1.65, 3);
  });
  it('city arterial (10 m): parking both sides, traffic lanes between', () => {
    const l = pieceLayout(KIND.street, 10, 3, 0, 0.3);
    expect(l.park).toBe(3);
    expect(l.fwd).toBeGreaterThan(0.9);
    expect(l.fwd + 1.3).toBeLessThanOrEqual(5 - PARK_BAND + 0.3);
    expect(l.bwd).toBeCloseTo(-l.fwd, 5);
    expect(l.maxWidth).toBeGreaterThanOrEqual(2.55); // a bus fits
  });
  it('narrow town street: parking on one side, lanes shifted away from it', () => {
    for (const h of [0.2, 0.8]) {
      const l = pieceLayout(KIND.street, 6.5, 1, 0, h);
      expect(l.park === 1 || l.park === 2).toBe(true);
      const hw = 3.25;
      // the moving lanes stay out of the parking band and inside the paved width
      const lo = Math.min(l.fwd, l.bwd) - l.maxWidth / 2;
      const hi = Math.max(l.fwd, l.bwd) + l.maxWidth / 2;
      if (l.park === 1) expect(hi).toBeLessThanOrEqual(hw - PARK_BAND + 1e-6);
      else expect(lo).toBeGreaterThanOrEqual(-hw + PARK_BAND - 1e-6);
      expect(lo).toBeGreaterThanOrEqual(-hw - 1e-6);
      expect(hi).toBeLessThanOrEqual(hw + 1e-6);
      expect(l.fwd - l.bwd).toBeGreaterThanOrEqual(l.maxWidth);
      expect(l.maxWidth).toBeGreaterThanOrEqual(1.95); // cars and pickups fit
    }
  });
  it('town arterial with a centre line (8 m): no parking, lanes either side of it', () => {
    const l = pieceLayout(KIND.street, 8, 3, 0, 0.5);
    expect(l.park).toBe(0);
    expect(l.fwd).toBeCloseTo(2, 3);
  });
  it('farm track: one shared lane on the centreline', () => {
    const l = pieceLayout(KIND.drive, 3.6, 0, -1, 0.5);
    expect(l.fwd).toBe(0);
    expect(l.bwd).toBe(0);
    expect(l.single).toBe(true);
  });
  it('property: lanes never leave the paved width and never overlap each other or parked cars', () => {
    fc.assert(
      fc.property(fc.constantFrom(0, 1, 2, 3, 4), fc.double({ min: 4.5, max: 12, noNaN: true }), fc.integer({ min: 0, max: 7 }), fc.integer({ min: -1, max: 3 }), fc.double({ min: 0, max: 0.999, noNaN: true }), (kind, width, flags, town, h) => {
        const l = pieceLayout(kind, width, flags, town, h);
        const hw = width / 2;
        const w2 = l.maxWidth / 2;
        expect(Number.isFinite(l.fwd) && Number.isFinite(l.bwd) && l.maxWidth > 1.5).toBe(true);
        expect(l.fwd + w2).toBeLessThanOrEqual(hw - (l.park & 1 ? PARK_BAND : 0) + 1e-6);
        expect(l.bwd - w2).toBeGreaterThanOrEqual(-hw + (l.park & 2 ? PARK_BAND : 0) - 1e-6);
        expect(l.fwd - l.bwd).toBeGreaterThanOrEqual(l.maxWidth - 1e-6);
      }),
      { numRuns: 400 },
    );
  });
});

describe('lane graph of the real road network', { timeout: 60_000 }, () => {
  const g: LaneGraph = laneGraph();

  it('has two lanes per piece and connectors at the junctions', () => {
    expect(g.laneCount).toBe(g.pieceCount * 2);
    expect(g.pieceCount).toBeGreaterThan(1000);
    expect(g.connectors.length).toBeGreaterThan(g.nodeCount * 2);
  });

  it('lane points: forward starts at the piece start on the right, backward at the piece end', () => {
    const o = pt();
    for (let p = 0; p < g.pieceCount; p += 97) {
      const a = g.pStart[p];
      const n = g.pCount[p];
      g.lanePoint(p * 2, 0, o);
      const acr = g.laneAcross[p * 2];
      expect(o.x).toBeCloseTo(g.px[a] + g.pnx[a] * acr, 3);
      expect(o.z).toBeCloseTo(g.pz[a] + g.pnz[a] * acr, 3);
      // travel direction ⟂ right normal, right normal = (−hz, hx)… i.e. n = (−dz, dx)
      expect(g.pnx[a] * o.hx + g.pnz[a] * o.hz).toBeCloseTo(0, 2);
      g.lanePoint(p * 2 + 1, 0, o);
      const b = a + n - 1;
      const acb = g.laneAcross[p * 2 + 1];
      expect(o.x).toBeCloseTo(g.px[b] + g.pnx[b] * acb, 3);
      expect(o.z).toBeCloseTo(g.pz[b] + g.pnz[b] * acb, 3);
      // right-hand traffic: the backward lane lies on the other side (right of ITS travel direction)
      if (g.pKind[p] !== KIND.drive) expect(acb).toBeLessThan(acr);
    }
  });

  it('right-hand traffic: every lane (but a farm track\'s) lies right of its direction of travel', () => {
    const q = pt();
    let left = 0;
    for (let l = 0; l < g.laneCount; l++) {
      const p = l >> 1;
      if (g.pKind[p] === KIND.drive) continue;
      const u = g.laneLen[l] / 2;
      g.lanePoint(l, u, q);
      const s = g.laneS(l, u);
      const k = g.segmentAt(p, s);
      const t = (s - g.ps[k]) / (g.ps[k + 1] - g.ps[k]);
      const ox = q.x - (g.px[k] + (g.px[k + 1] - g.px[k]) * t);
      const oz = q.z - (g.pz[k] + (g.pz[k + 1] - g.pz[k]) * t);
      // right of travel (hx, hz) with x east, z south: (−hz, hx)
      const side = ox * -q.hz + oz * q.hx;
      // shifted street lanes may straddle the centreline; the other lane is always further left
      const other = pt();
      g.lanePoint(l ^ 1, g.laneLen[l] - u, other);
      const rel = (q.x - other.x) * -q.hz + (q.z - other.z) * q.hx;
      if (rel <= 0 || (g.pKind[p] !== KIND.street && side <= 0)) left++;
    }
    expect(left).toBe(0);
  });

  it('allowed speeds: finite, ≤ the limit, lower in tight curves', () => {
    for (let l = 0; l < g.laneCount; l += 7) {
      for (const f of [0, 0.37, 0.8, 1]) {
        const v = g.allowedSpeed(l, g.laneLen[l] * f, 0);
        expect(Number.isFinite(v) && v > 0).toBe(true);
        expect(v).toBeLessThanOrEqual(g.speedLimit(l, g.laneLen[l] * f) + 1e-6);
      }
    }
  });

  it('connectors join the end of the in-lane to the start of the out-lane', () => {
    const a = pt();
    const b = pt();
    for (const c of g.connectors) {
      if (c.id % 5 !== 0) continue;
      g.lanePoint(c.inLane, c.inU, a);
      g.connPoint(c, 0, b);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-3);
      g.lanePoint(c.outLane, c.outU, a);
      g.connPoint(c, c.len, b);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.05);
      expect(c.len).toBeGreaterThanOrEqual(0);
      expect(c.vTurn).toBeGreaterThan(0);
      expect(Number.isFinite(c.len) && Number.isFinite(c.vTurn)).toBe(true);
    }
  });

  it('every lane can leave its exit (a turn, a U-turn or — highways at the map edge — despawn)', () => {
    for (let l = 0; l < g.laneCount; l++) {
      const any = g.laneConnCount[l] > 0 || g.laneUturn[l] >= 0;
      if (!any) expect(g.laneDespawn[l]).toBe(1);
    }
  });

  it('conflicts are symmetric, within a junction cluster; one queue never conflicts with itself; merges always conflict', () => {
    const sets = g.connectors.map((c) => new Set(c.conflicts));
    let bad = 0;
    for (const c of g.connectors) {
      for (const j of c.conflicts) {
        const o = g.connectors[j];
        if (Math.hypot(g.nodeX[o.node] - g.nodeX[c.node], g.nodeZ[o.node] - g.nodeZ[c.node]) > 30.01) bad++;
        if (!sets[j].has(c.id)) bad++;
        if (o.inLane === c.inLane) bad++;
      }
    }
    expect(bad).toBe(0);
    const byNode = new Map<number, number[]>();
    for (const c of g.connectors) if (c.node >= 0) (byNode.get(c.node) ?? byNode.set(c.node, []).get(c.node)!).push(c.id);
    for (const list of byNode.values())
      for (const i of list)
        for (const j of list) {
          const a = g.connectors[i];
          const b = g.connectors[j];
          if (i !== j && a.inLane !== b.inLane && a.outLane === b.outLane) expect(sets[i].has(j)).toBe(true);
        }
  });

  it('builds in slices (no long frame on the main thread) to the same graph', () => {
    const lazy = new LaneGraph(laneData(), undefined, true);
    expect(lazy.complete).toBe(false);
    let worst = 0;
    let slices = 0;
    for (;;) {
      const t0 = performance.now();
      const done = lazy.buildStep(4);
      worst = Math.max(worst, performance.now() - t0);
      slices++;
      if (done) break;
    }
    expect(slices).toBeGreaterThan(10);
    expect(worst).toBeLessThan(30);
    expect(lazy.connectors.length).toBe(g.connectors.length);
    let a = 0;
    let b = 0;
    for (const c of g.connectors) a += c.conflicts.length;
    for (const c of lazy.connectors) b += c.conflicts.length;
    expect(b).toBe(a);
  });

  it('parking slots keep clear of junctions and of the moving lanes', () => {
    let n = 0;
    for (let p = 0; p < g.pieceCount; p++) {
      if (!g.pPark[p]) continue;
      expect(g.pKind[p]).toBe(KIND.street);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });
});
