import { describe, it, expect } from 'vitest';
import type * as THREE from 'three';
import { getLayout } from '../../../src/world/layout';
import { createMarina, createSeaPlan, toWorld, VESSEL_DIMS } from '../../../src/world/traffic/sea';
import { buildMarina, buildFerryTerminal } from '../../../src/world/traffic/models/marina';
import { createHarbourObstacles, marinaObstacles, marinaObstacleTop, obstacleSetTop, terminalObstacles, HARBOUR_DIMS } from '../../../src/world/traffic/harbourObstacles';
import { createEnvironment } from '../../../src/world/environment';

const m = createMarina(getLayout());

/** The top of the drawn geometry (max over triangles covering (x, z) in the model frame), −Infinity if none. */
function drawnTops(g: THREE.BufferGeometry, cell = 2): (x: number, z: number) => number {
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

describe('harbour obstacles: the marina', () => {
  const set = marinaObstacles(m, { boats: false });
  const drawn = drawnTops(buildMarina(m, 0).build());
  const top = (u: number, w: number) => {
    const p = toWorld(m.frame, u, w);
    return obstacleSetTop(set, p.x, p.z);
  };

  it('match the drawn model: what is drawn above the water is solid, what is solid is drawn', () => {
    const rnd = rng(7);
    let drawnN = 0, missed = 0, solidN = 0, phantom = 0;
    for (let n = 0; n < 60000; n++) {
      const u = -380 + 760 * rnd();
      const w = -30 + 400 * rnd();
      const dt = drawn(u, w);
      const ot = top(u, w);
      if (dt > 0.3) {
        drawnN++;
        if (ot < dt - 0.5) missed++;
      }
      // the harbour works (lattice boom, portal hoist, hulls on stands) are solid columns over their outline
      if (ot > 0.3 && !(u > 225 && w < 0)) {
        solidN++;
        // rubble: the drawn stones within 1 m
        let best = dt;
        for (const [du, dw] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) best = Math.max(best, drawn(u + du, w + dw));
        if (best < ot - 0.5) phantom++;
      }
    }
    expect(drawnN).toBeGreaterThan(5000);
    expect(missed / drawnN).toBeLessThan(0.03);
    expect(phantom / solidN).toBeLessThan(0.03);
  });

  it('pontoons, fingers and the visitors\' pontoon match the drawn decks exactly', () => {
    const rnd = rng(11);
    let n = 0, bad = 0;
    for (let k = 0; k < 20000; k++) {
      const u = -250 + 450 * rnd();
      const w = 8 + 215 * rnd();
      const dt = drawn(u, w);
      const ot = top(u, w);
      // skip the outlines (±0.15 m) where either side may be sampled
      let edge = false;
      for (const [du, dw] of [[0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]]) if ((drawn(u + du, w + dw) > 0.3) !== (dt > 0.3)) edge = true;
      if (edge) continue;
      n++;
      if ((dt > 0.3) !== (ot > 0.3) || (dt > 0.3 && Math.abs(dt - ot) > 0.1 && dt < 1.5)) bad++;
    }
    expect(n).toBeGreaterThan(15000);
    expect(bad).toBeLessThan(n * 0.002);
  });

  it('piles, pontoons, fingers, quay, breakwaters and beacons are solid at the right heights', () => {
    for (const pl of m.piles.slice(0, 20)) expect(top(pl.u, pl.w)).toBeCloseTo(HARBOUR_DIMS.pileTop, 5);
    for (const p of m.pontoons) expect(top(p.u, (p.w0 + p.w1) / 2)).toBeCloseTo(p.top + 0.02, 5);
    for (const f of m.fingers.slice(0, 40)) expect(top((f.u0 + f.u1) / 2, f.w)).toBeCloseTo(HARBOUR_DIMS.fingerTop, 5);
    expect(top(0, -10)).toBeCloseTo(m.quay.top, 5);
    for (const bw of m.breakwaters) {
      const a = bw.pts[1];
      expect(top(a.u, a.w)).toBeGreaterThanOrEqual(bw.crestY);
    }
    for (const bc of m.beacons) expect(top(bc.u, bc.w)).toBeCloseTo(HARBOUR_DIMS.beaconTop, 5);
    const v = m.visitor;
    expect(top(v.u, (v.w0 + v.w1) / 2)).toBeCloseTo(v.top + 0.02, 5);
    for (const pl of v.piles) expect(top(pl.u, pl.w)).toBeCloseTo(HARBOUR_DIMS.pileTop, 5);
  });

  it('the berth water is free: between fingers, the basin, the entrance, the visitors\' berth', () => {
    const p = m.pontoons[1];
    // mid-way between two fingers, a boat length out from the pontoon
    const f0 = m.fingers.find((f) => f.u0 > p.u && f.w > 50)!;
    expect(top(p.u + p.half + 4, f0.w + 2.7)).toBe(-Infinity);
    // between pontoons (the fairway) and the basin
    expect(top((m.pontoons[1].u + m.pontoons[2].u) / 2, 100)).toBe(-Infinity);
    expect(top(0, 260)).toBe(-Infinity);
    expect(top(m.entrance.u, m.entrance.w)).toBe(-Infinity);
    const vb = m.visitor.berth;
    for (let u = vb.u0 + 0.05; u <= vb.u1; u += 0.25) for (let w = vb.w0; w <= vb.w1; w += 0.5) expect(top(u, w)).toBe(-Infinity);
    // the open sea
    const sea = toWorld(m.frame, 0, 1500);
    expect(marinaObstacleTop(m, sea.x, sea.z)).toBe(-Infinity);
  });

  it('moored boats are solid up to their deck edge (runtime set), the visitors\' berth stays empty', () => {
    const full = marinaObstacles(m);
    expect(full.count).toBe(set.count + m.berths.length);
    for (const b of m.berths.slice(0, 30)) expect(marinaObstacleTop(m, b.x, b.z)).toBeGreaterThanOrEqual(VESSEL_DIMS[b.kind].freeboard * b.scale - 1e-9);
    const vb = m.visitor.berth;
    const c = toWorld(m.frame, (vb.u0 + vb.u1) / 2, (vb.w0 + vb.w1) / 2);
    expect(marinaObstacleTop(m, c.x, c.z)).toBe(-Infinity);
  });

  it('is fast: 200k lookups well under 100 ms, open water rejected by the box', () => {
    const rnd = rng(3);
    const pts = Array.from({ length: 200000 }, () => toWorld(m.frame, -400 + 800 * rnd(), -40 + 420 * rnd()));
    marinaObstacleTop(m, pts[0].x, pts[0].z);
    const t0 = performance.now();
    let s = 0;
    for (const p of pts) s += marinaObstacleTop(m, p.x, p.z) > 0 ? 1 : 0;
    expect(performance.now() - t0).toBeLessThan(100);
    expect(s).toBeGreaterThan(1000);
  });
});

describe('harbour obstacles: ferry terminals and the environment', () => {
  it('a terminal matches its drawn model', () => {
    const plan = createSeaPlan(getLayout(), null);
    const t = plan.terminals[0];
    const set = terminalObstacles(t);
    const drawn = drawnTops(buildFerryTerminal(t.pierLen, 0).build(), 1);
    const h = (t.heading * Math.PI) / 180;
    const [ux, uz] = [Math.sin(h), -Math.cos(h)];
    const rnd = rng(5);
    let drawnN = 0, missed = 0, solidN = 0, phantom = 0;
    for (let n = 0; n < 30000; n++) {
      const u = -45 + (t.pierLen + 150) * rnd();
      const w = -25 + 50 * rnd();
      const x = t.x + ux * u - uz * w;
      const z = t.z + uz * u + ux * w;
      const dt = drawn(u, w);
      const ot = obstacleSetTop(set, x, z);
      if (dt > 0.3) {
        drawnN++;
        if (ot < dt - 0.5) missed++;
      }
      if (ot > 0.3) {
        solidN++;
        let best = dt;
        for (const [du, dw] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) best = Math.max(best, drawn(u + du, w + dw));
        if (best < ot - 0.5) phantom++;
      }
    }
    expect(drawnN).toBeGreaterThan(1500);
    expect(missed / drawnN).toBeLessThan(0.03);
    expect(phantom / solidN).toBeLessThan(0.05);
  }, 30_000);

  it('registers on a world environment: marina solid, open water and the airport untouched', () => {
    const env = createEnvironment();
    const h = createHarbourObstacles(m);
    env.registerObstacleSource(h.top);
    const pl = toWorld(m.frame, m.piles[0].u, m.piles[0].w);
    expect(env.obstacleTop(pl.x, pl.z)).toBeCloseTo(HARBOUR_DIMS.pileTop, 5);
    expect(env.obstacleTop(0, 0)).toBe(-Infinity);
    const plan = createSeaPlan(getLayout(), null);
    const t = plan.terminals[0];
    const hd = (t.heading * Math.PI) / 180;
    const px = t.x + Math.sin(hd) * t.pierLen * 0.5;
    const pz = t.z - Math.cos(hd) * t.pierLen * 0.5;
    expect(env.obstacleTop(px, pz)).toBe(-Infinity);
    h.setTerminals(plan.terminals);
    expect(env.obstacleTop(px, pz)).toBeCloseTo(HARBOUR_DIMS.terminalDeckY, 5);
  });
});
