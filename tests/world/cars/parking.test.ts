import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parkedSlots, ParkingField, carParkSlots } from '../../../src/world/cars/parking';
import { pcgHash } from '../../../src/world/fields';
import { PARK_BAND } from '../../../src/world/cars/lanes';
import { SPECS } from '../../../src/world/cars/specs';
import { cloneConfig } from '../../../src/config';
import { laneGraph, LAYOUT, HEIGHT } from './fixtures';

const g = laneGraph();
const parkedPieces = (): number[] => {
  const out: number[] = [];
  for (let p = 0; p < g.pieceCount; p++) if (g.pPark[p]) out.push(p);
  return out;
};

describe('parked cars', () => {
  it('line the kerb on the parking side(s), facing the traffic on that side, clear of the moving lanes and junctions', () => {
    let total = 0;
    for (const p of parkedPieces()) {
      const hw = g.pWidth[p] / 2;
      for (const c of parkedSlots(g, p, 7)) {
        total++;
        const sp = SPECS[c.type];
        // on the side's kerb band, inside the paved width
        const side = c.across > 0 ? 1 : 2;
        expect(g.pPark[p] & side).toBeTruthy();
        expect(Math.abs(c.across) + sp.width / 2).toBeLessThanOrEqual(hw - 0.15);
        expect(Math.abs(c.across) - sp.width / 2).toBeGreaterThanOrEqual(hw - PARK_BAND - 1e-6);
        // clear of the junction boxes
        expect(c.s - sp.length / 2).toBeGreaterThanOrEqual(g.pS0[p] + g.pClearS[p] - 1e-6);
        expect(c.s + sp.length / 2).toBeLessThanOrEqual(g.pS0[p] + g.pLen[p] - g.pClearE[p] + 1e-6);
        // facing the direction of travel on its side (right-hand traffic)
        const lane = side === 1 ? p * 2 : p * 2 + 1;
        const q = { x: 0, z: 0, hx: 0, hz: 0 };
        g.lanePoint(lane, side === 1 ? c.s - g.pS0[p] : g.pS0[p] + g.pLen[p] - c.s, q);
        expect(q.hx * c.hx + q.hz * c.hz).toBeGreaterThan(0.95);
      }
    }
    expect(total).toBeGreaterThan(1000);
  });

  it('neighbours on a kerb never overlap', () => {
    for (const p of parkedPieces().slice(0, 400)) {
      const list = parkedSlots(g, p, 3);
      for (const side of [1, -1]) {
        const mine = list.filter((c) => Math.sign(c.across) === side).sort((a, b) => a.s - b.s);
        for (let k = 1; k < mine.length; k++) expect(mine[k].s - mine[k - 1].s).toBeGreaterThanOrEqual((SPECS[mine[k].type].length + SPECS[mine[k - 1].type].length) / 2 + 0.3);
      }
    }
  });

  it('is deterministic per seed', () => {
    const p = parkedPieces()[10];
    expect(parkedSlots(g, p, 5)).toEqual(parkedSlots(g, p, 5));
  });

  it('property: the field around any camera stays within its radius and capacity', () => {
    const cfg = cloneConfig().world.cars;
    cfg.maxParked = 300;
    fc.assert(
      fc.property(fc.double({ min: -6000, max: 4000, noNaN: true }), fc.double({ min: 0, max: 8000, noNaN: true }), (x, z) => {
        const f = new ParkingField(g, cfg);
        f.refresh(x, z);
        expect(f.count).toBeLessThanOrEqual(300);
        for (let k = 0; k < f.count; k++) {
          const c = f.cars[k];
          expect(Number.isFinite(c.x) && Number.isFinite(c.z)).toBe(true);
          expect(Math.hypot(c.x - x, c.z - z)).toBeLessThanOrEqual(cfg.parkedRadius + 1e-6);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('fills a town from its centre outward', () => {
    const f = new ParkingField(g);
    f.refresh(2100, 2100);
    expect(f.count).toBeGreaterThan(200);
  });

  it('car parks: cars in the painted bays of commercial blocks (the terrain shader\'s own layout), never under a building', { timeout: 30_000 }, () => {
    const ti = LAYOUT.towns.findIndex((t) => t.name === 'Taterville');
    const t = LAYOUT.towns[ti];
    // a fake building across part of the town: slots there must be rejected
    const bx0 = t.x - 150;
    const bx1 = t.x + 150;
    const obstacleTop = (x: number, z: number) => (x > bx0 && x < bx1 && z > t.z - 40 && z < t.z + 40 ? 50 : -Infinity);
    const env = { heightAt: HEIGHT, obstacleTop, urban: () => 1 };
    const slots = carParkSlots(LAYOUT.towns, ti, 5, env);
    expect(slots.length).toBeGreaterThan(40);
    const th = (t.gridAngleDeg * Math.PI) / 180;
    const cs = Math.cos(th);
    const sn = Math.sin(th);
    const bs = Math.max(t.blockSize, 40);
    for (const c of slots) {
      expect(c.piece).toBe(-1);
      expect(Math.hypot(c.hx, c.hz)).toBeCloseTo(1, 6);
      expect(c.x > bx0 && c.x < bx1 && c.z > t.z - 40 && c.z < t.z + 40).toBe(false);
      // back into the town grid: a commercial block, in its car-park half, on a bay centre
      const dx = c.x - t.x;
      const dz = c.z - t.z;
      const q = [cs * dx + sn * dz, -sn * dx + cs * dz];
      const ci = Math.floor(q[0] / bs);
      const cj = Math.floor(q[1] / bs);
      const bh = pcgHash(ci + 71, cj + 71);
      expect(bh).toBeLessThan(0.06 + 0.3 * t.density);
      const half = pcgHash(ci + 3, cj + 3) >= 0.5 ? 1 : 0;
      const u = half ? q[1] / bs - cj : q[0] / bs - ci;
      const v = (half ? q[0] / bs - ci : q[1] / bs - cj) * bs;
      expect(u).toBeGreaterThan(0.55);
      expect(Math.abs(((v / 2.6) % 1) - 0.5)).toBeLessThan(0.02);
      // parked along the u axis
      const ux = half ? -sn : cs;
      const uz = half ? cs : sn;
      expect(Math.abs(c.hx * ux + c.hz * uz)).toBeCloseTo(1, 6);
    }
    // bays never overlap
    let minD = Infinity;
    for (let a = 0; a < slots.length; a++)
      for (let b = a + 1; b < slots.length; b++) {
        const d = Math.hypot(slots[a].x - slots[b].x, slots[a].z - slots[b].z);
        if (d < minD) minD = d;
      }
    expect(minD).toBeGreaterThan(2.5);
  });

  it('the field adds the car parks of the towns in range once their buildings are known', () => {
    let placed = false;
    // one "building" at the town centre, once the towns are placed
    const obstacleTop = (x: number, z: number) => (placed && Math.abs(x - 2100) < 120 && Math.abs(z - 2100) < 120 ? HEIGHT(x, z) + 12 : -Infinity);
    const f = new ParkingField(g, undefined, undefined, { heightAt: HEIGHT, obstacleTop, urban: () => 1, towns: LAYOUT.towns });
    f.refresh(2100, 2100);
    expect(f.cars.some((c) => c.piece === -1)).toBe(false);
    placed = true;
    f.refresh(2100, 2101);
    expect(f.cars.some((c) => c.piece === -1)).toBe(true);
    expect(f.cars.some((c) => c.piece >= 0)).toBe(true);
  });
});
