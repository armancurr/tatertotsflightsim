/**
 * What you see is what you hit: the cruise terminal's and the naval pier's obstacle columns
 * (src/world/harbour/obstacles.ts) against their drawn geometry (models.ts), the landable decks, the
 * navaid obstacles (buoys, lighthouse), and the physics' environment answering them once registered.
 */
import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import { getLayout } from '../../../src/world/layout';
import { portWorks, pierWorld } from '../../../src/world/harbour/layout';
import { buildCruiseTerminal, buildNavalPier } from '../../../src/world/harbour/models';
import { createPortObstacles, cruisePrims, navalPrims } from '../../../src/world/harbour/obstacles';
import { buildSet, obstacleSetTop } from '../../../src/world/traffic/harbourObstacles';
import { navaids, navaidObstacles, BUOY_DIMS, LIGHTHOUSE_DIMS } from '../../../src/world/harbour/navaids';
import { buildLighthouse } from '../../../src/world/harbour/navaidModels';

const works = portWorks(getLayout());

/** The top of the drawn geometry (max over triangles covering (u, w) in the model frame), −Infinity if none. */
export function drawnTops(g: THREE.BufferGeometry, cell = 2): (x: number, z: number) => number {
  const P = g.attributes.position.array as Float32Array;
  const I = g.index!.array;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 1_000_003 + j;
  for (let t = 0; t < I.length; t += 3) {
    const xs = [P[I[t] * 3], P[I[t + 1] * 3], P[I[t + 2] * 3]];
    const zs = [P[I[t] * 3 + 2], P[I[t + 1] * 3 + 2], P[I[t + 2] * 3 + 2]];
    for (let i = Math.floor(Math.min(...xs) / cell); i <= Math.floor(Math.max(...xs) / cell); i++)
      for (let j = Math.floor(Math.min(...zs) / cell); j <= Math.floor(Math.max(...zs) / cell); j++) {
        const k = key(i, j);
        const l = grid.get(k);
        if (l) l.push(t);
        else grid.set(k, [t]);
      }
  }
  return (u, w) => {
    const l = grid.get(key(Math.floor(u / cell), Math.floor(w / cell)));
    if (!l) return -Infinity;
    let top = -Infinity;
    for (const t of l) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const d = (P[b + 2] - P[c + 2]) * (P[a] - P[c]) + (P[c] - P[b]) * (P[a + 2] - P[c + 2]);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((P[b + 2] - P[c + 2]) * (u - P[c]) + (P[c] - P[b]) * (w - P[c + 2])) / d;
      const l2 = ((P[c + 2] - P[a + 2]) * (u - P[c]) + (P[a] - P[c]) * (w - P[c + 2])) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * P[a + 1] + l2 * P[b + 1] + l3 * P[c + 1];
      if (y > top) top = y;
    }
    return top;
  };
}

const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function compare(drawn: (u: number, w: number) => number, top: (u: number, w: number) => number, box: { u0: number; u1: number; w0: number; w1: number }, n: number, seed: number) {
  const rnd = rng(seed);
  let drawnN = 0, missed = 0, solidN = 0, phantom = 0;
  for (let k = 0; k < n; k++) {
    const u = box.u0 + (box.u1 - box.u0) * rnd();
    const w = box.w0 + (box.w1 - box.w0) * rnd();
    const dt = drawn(u, w);
    const ot = top(u, w);
    // (above the water: piles and camels below it don't count)
    if (dt > 1.2) {
      drawnN++;
      if (ot < dt - 0.5) missed++;
    }
    if (ot > 1.2) {
      solidN++;
      let best = dt;
      for (const [du, dw] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) best = Math.max(best, drawn(u + du, w + dw));
      if (best < ot - 0.5) phantom++;
    }
  }
  return { drawnN, solidN, missed: missed / Math.max(1, drawnN), phantom: phantom / Math.max(1, solidN) };
}

describe('port obstacles match the drawn piers', () => {
  it('cruise terminal: what is drawn is solid, what is solid is drawn (LOD 0)', () => {
    const c = works.cruise;
    const set = buildSet(c.frame, cruisePrims(c));
    const top = (u: number, w: number) => {
      const p = pierWorld(c.frame, u, w);
      return obstacleSetTop(set, p.x, p.z);
    };
    const drawn = drawnTops(buildCruiseTerminal(c, 0).build());
    const r = compare(drawn, top, { u0: c.apron.u0 - 5, u1: c.pier.u1 + 5, w0: c.apron.w0 - 5, w1: c.pier.w1 + 6 }, 60000, 11);
    expect(r.drawnN).toBeGreaterThan(3000);
    expect(r.missed).toBeLessThan(0.02);
    expect(r.phantom).toBeLessThan(0.02);
    // the berth side: over the water off the face (past the fenders) nothing stands up to the jet bridges' height
    for (let u = c.pier.u0; u < c.pier.u1; u += 1) expect(top(u, c.pier.w1 + c.face.gap + 0.05)).toBe(-Infinity);
  });

  it('naval pier: what is drawn is solid, what is solid is drawn (LOD 0)', () => {
    const n = works.naval;
    const set = buildSet(n.frame, navalPrims(n));
    const top = (u: number, w: number) => {
      const p = pierWorld(n.frame, u, w);
      return obstacleSetTop(set, p.x, p.z);
    };
    const drawn = drawnTops(buildNavalPier(n, 0).build());
    const r = compare(drawn, top, { u0: n.apron.u0 - 5, u1: n.head.u1 + 6, w0: n.head.w0 - 5, w1: n.head.w1 + 5 }, 60000, 12);
    expect(r.drawnN).toBeGreaterThan(1500);
    expect(r.missed).toBeLessThan(0.02);
    expect(r.phantom).toBeLessThan(0.02);
    for (let w = n.head.w0; w < n.head.w1; w += 1) expect(top(n.head.u1 + n.face.gap + 0.05, w)).toBe(-Infinity);
  });

  it('LOD 1 draws within the same envelope (nothing above the obstacles)', () => {
    for (const [g, prims, f, box] of [
      [buildCruiseTerminal(works.cruise, 1).build(), cruisePrims(works.cruise), works.cruise.frame, { u0: works.cruise.apron.u0, u1: works.cruise.pier.u1, w0: works.cruise.apron.w0, w1: works.cruise.pier.w1 + 3 }],
      [buildNavalPier(works.naval, 1).build(), navalPrims(works.naval), works.naval.frame, { u0: works.naval.apron.u0, u1: works.naval.head.u1 + 3, w0: works.naval.head.w0, w1: works.naval.head.w1 }],
    ] as const) {
      const set = buildSet(f, prims);
      const drawn = drawnTops(g);
      const r = compare(drawn, (u, w) => {
        const p = pierWorld(f, u, w);
        return obstacleSetTop(set, p.x, p.z);
      }, box, 30000, 5);
      expect(r.missed).toBeLessThan(0.02);
    }
  });

  it('the decks are landable where they are flat, and the physics sees both once registered', () => {
    const po = createPortObstacles(works);
    const c = works.cruise;
    const mid = pierWorld(c.frame, (c.pier.u0 + c.building.u0) / 2, 12);
    expect(po.deckTop(mid.x, mid.z)).toBeCloseTo(c.deckY, 6);
    expect(po.top(mid.x, mid.z)).toBeCloseTo(c.deckY, 6);
    const roof = pierWorld(c.frame, (c.building.u0 + c.building.u1) / 2, (c.building.w0 + c.building.w1) / 2);
    expect(po.top(roof.x, roof.z)).toBeGreaterThan(c.deckY + 10);
    const sea = pierWorld(c.frame, c.pier.u1 + 50, 0);
    expect(po.top(sea.x, sea.z)).toBe(-Infinity);
    expect(po.deckTop(sea.x, sea.z)).toBe(-Infinity);
  });
});

describe('navaid obstacles', () => {
  const n = navaids();
  const ob = navaidObstacles(n);

  it('every buoy is a small solid column; the water between them is free', () => {
    for (const b of n.buoys) {
      expect(ob.top(b.x, b.z)).toBeCloseTo(BUOY_DIMS.topmarkTop, 6);
      expect(ob.top(b.x + BUOY_DIMS.floatR * 0.9, b.z)).toBeCloseTo(BUOY_DIMS.topmarkTop, 6);
      expect(ob.top(b.x + BUOY_DIMS.floatR + 0.2, b.z)).toBe(-Infinity);
      expect(ob.top(b.x + 30, b.z + 30)).toBe(-Infinity);
    }
  });

  it('the lighthouse tower and the keeper\'s house match the drawn model', () => {
    const lh = n.lighthouse;
    const g = buildLighthouse(lh, 0).build();
    // the model is built round the tower's foot (x, groundY, z)
    const drawn = drawnTops(g, 1);
    let bad = 0;
    let count = 0;
    const rnd = rng(3);
    for (let k = 0; k < 8000; k++) {
      const dx = -12 + 30 * rnd();
      const dz = -12 + 24 * rnd();
      const d = drawn(dx, dz);
      if (d === -Infinity) continue;
      count++;
      const t = ob.top(lh.x + dx, lh.z + dz);
      if (t < lh.groundY + d - 0.5) bad++;
    }
    expect(count).toBeGreaterThan(500);
    expect(bad / count).toBeLessThan(0.02);
    expect(ob.top(lh.x, lh.z)).toBeGreaterThan(lh.focalY);
    expect(ob.top(lh.x, lh.z)).toBeLessThan(lh.groundY + LIGHTHOUSE_DIMS.towerH + 8);
  });
});
