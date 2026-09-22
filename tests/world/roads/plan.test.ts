import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planRoads, runsFor, TRIM_MARGIN, type RoadPiece, type RoadPlan } from '../../../src/world/roads/plan';
import { buildRoadNetwork, getRoadNetwork, KIND_RANK } from '../../../src/world/roads/network';
import { pointSegmentDistance } from '../../../src/world/towns/geom';
import { createStandInHeight } from '../../../src/world/towns/standin';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT, syntheticLayout } from '../towns/fixtures';

const rc = CONFIG.world.towns.roads;
const NET = getRoadNetwork(LAYOUT, HEIGHT);
const PLAN = planRoads(NET, LAYOUT.bridges, LAYOUT.towns, rc);

const endPoint = (p: RoadPiece, end: 0 | 1) => (end === 0 ? { x: p.xs[0], z: p.zs[0] } : { x: p.xs[p.n - 1], z: p.zs[p.n - 1] });

/** Structural invariants every plan must satisfy (used on the real world and in the fuzz). */
function checkPlan(plan: RoadPlan): void {
  const seen = new Set<number>();
  for (const p of plan.pieces) {
    expect(p.n).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < p.n; i++) {
      expect(Number.isFinite(p.xs[i]) && Number.isFinite(p.zs[i]) && Number.isFinite(p.ss[i])).toBe(true);
      expect(Math.hypot(p.nx[i], p.nz[i])).toBeCloseTo(1, 5);
      if (i > 0) expect(p.ss[i]).toBeGreaterThan(p.ss[i - 1]);
    }
    for (const end of [0, 1] as const) {
      const e = end === 0 ? p.start : p.end;
      if (e.node < 0) continue;
      const n = plan.nodes[e.node];
      expect(n.ends).toContain(p.id * 2 + end);
      seen.add(p.id * 2 + end);
      const q = endPoint(p, end);
      const d = Math.hypot(q.x - n.x, q.z - n.z);
      // a split end sits on the node; a cut end at the crossing road's edge (its `off`)
      // (several junctions merged into one node sit within a few metres of each other)
      if (!e.cut) expect(d).toBeLessThan(6);
      else expect(d).toBeLessThan(e.off + 6);
      expect(Number.isFinite(e.h) && Number.isFinite(e.y) && e.off >= 0).toBe(true);
    }
  }
  let refs = 0;
  for (const n of plan.nodes) {
    expect(n.ends.length).toBeGreaterThanOrEqual(1);
    for (const code of n.ends) {
      const p = plan.pieces[code >> 1];
      expect((code & 1 ? p.end : p.start).node).toBe(n.id);
      refs++;
    }
  }
  expect(refs).toBe(seen.size);
}

describe('road plan: pieces and junction nodes', { timeout: 120_000 }, () => {
  it('is deterministic', () => {
    const again = planRoads(NET, LAYOUT.bridges, LAYOUT.towns, rc);
    expect(again.pieces.length).toBe(PLAN.pieces.length);
    expect(again.nodes.length).toBe(PLAN.nodes.length);
    expect(Array.from(again.pieces[100].xs)).toEqual(Array.from(PLAN.pieces[100].xs));
  });

  it('satisfies the structural invariants (ends ↔ nodes, finite, ordered)', () => {
    checkPlan(PLAN);
  });

  it('covers every road kind and has T and X junctions', () => {
    const kinds = new Set(PLAN.pieces.map((p) => p.kind));
    for (const k of ['highway', 'road', 'access', 'lane', 'street', 'drive']) expect(kinds.has(k as never)).toBe(true);
    const deg = new Map<number, number>();
    for (const n of PLAN.nodes) deg.set(n.ends.length, (deg.get(n.ends.length) ?? 0) + 1);
    expect(deg.get(3) ?? 0).toBeGreaterThan(100);
    expect(deg.get(4) ?? 0).toBeGreaterThan(100);
  });

  it('splits the through road at a junction: its two pieces share the junction sample', () => {
    let checked = 0;
    for (const n of PLAN.nodes) {
      const splits = n.ends.filter((c) => !((c & 1 ? PLAN.pieces[c >> 1].end : PLAN.pieces[c >> 1].start).cut));
      if (splits.length !== 2) continue;
      const [a, b] = splits.map((c) => endPoint(PLAN.pieces[c >> 1], (c & 1) as 0 | 1));
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('never lets a lower-ranked piece enter the corridor of a higher-ranked road', () => {
    const byRank = [...NET.roads].sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind]);
    for (let k = 0; k < PLAN.pieces.length; k += 13) {
      const p = PLAN.pieces[k];
      for (let i = 0; i < p.n; i++) {
        for (const other of byRank) {
          if (KIND_RANK[other.kind] <= KIND_RANK[p.kind]) break;
          const pts = other.points;
          for (let j = 1; j < pts.length; j++) {
            const a = pts[j - 1];
            const b = pts[j];
            if (Math.abs(a.x - p.xs[i]) > 60 && Math.abs(b.x - p.xs[i]) > 60) continue;
            if (Math.abs(a.z - p.zs[i]) > 60 && Math.abs(b.z - p.zs[i]) > 60) continue;
            expect(pointSegmentDistance(p.xs[i], p.zs[i], a.x, a.z, b.x, b.z)).toBeGreaterThan(other.width / 2 + TRIM_MARGIN - 0.05);
          }
        }
      }
    }
  }, 60_000);

  it('marks town grid junctions (crosswalks) with the crossing half width and sidewalk width', () => {
    const town = PLAN.pieces.filter((p) => p.kind === 'street' && p.style.sidewalk > 0);
    expect(town.length).toBeGreaterThan(200);
    let marked = 0;
    for (const p of town)
      for (const e of [p.start, p.end]) {
        if (e.h > 0) {
          marked++;
          expect(e.h).toBeGreaterThanOrEqual(2.4);
          expect(e.h).toBeLessThan(20);
          expect(e.y).toBeGreaterThanOrEqual(0);
        }
      }
    expect(marked).toBeGreaterThan(town.length * 0.8);
  });

  it('carries the two layout bridges on single pieces covering span + ramps', () => {
    for (const b of LAYOUT.bridges) {
      const ps = PLAN.pieces.filter((p) => p.bridge && p.bridge.x === b.x && p.bridge.z === b.z);
      expect(ps.length).toBeGreaterThan(0);
      const whole = ps.find((p) => p.ss[0] <= p.bridge!.s0 && p.ss[p.n - 1] >= p.bridge!.s1);
      expect(whole).toBeTruthy();
      expect(whole!.bridge!.s1 - whole!.bridge!.s0).toBeCloseTo(b.length, 0);
    }
  });

  it('runsFor cuts pieces per chunk, neighbours sharing their boundary sample', () => {
    const runs = runsFor(PLAN.pieces, rc.chunkSize);
    const byPiece = new Map<number, typeof runs>();
    for (const r of runs) (byPiece.get(r.piece.id) ?? byPiece.set(r.piece.id, []).get(r.piece.id)!).push(r);
    for (const [, list] of byPiece) {
      list.sort((a, b) => a.i0 - b.i0);
      expect(list[0].i0).toBe(0);
      expect(list[list.length - 1].i1).toBe(list[0].piece.n - 1);
      for (let i = 1; i < list.length; i++) expect(list[i].i0).toBe(list[i - 1].i1);
      for (const r of list)
        for (let k = r.i0 + 1; k < r.i1; k++) {
          expect(Math.floor(r.piece.xs[k] / rc.chunkSize)).toBe(r.ci);
          expect(Math.floor(r.piece.zs[k] / rc.chunkSize)).toBe(r.cj);
        }
    }
  });

  it('fuzz: random settlements always give a consistent plan', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const L = syntheticLayout(seed);
        const net = buildRoadNetwork(L, createStandInHeight(L), { ...CONFIG.world.towns, farmsteadChance: 0 });
        checkPlan(planRoads(net, L.bridges, L.towns, rc));
      }),
      { numRuns: 20 },
    );
  }, 60_000);
});
