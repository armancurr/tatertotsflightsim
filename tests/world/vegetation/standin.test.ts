import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createStandInWorld, GROUND } from '../../../src/world/vegetation/standin';
import { getLayout } from '../../../src/world/layout';
import { fromRunwayCoords } from '../../../src/world/runway';

const L = getLayout();
const W = createStandInWorld();

describe('stand-in world (tests + preview only; the real terrain/landcover replace it)', () => {
  it('fuzz: density in [0,1] and height finite everywhere', () => {
    fc.assert(
      fc.property(fc.double({ min: -60000, max: 60000, noNaN: true }), fc.double({ min: -60000, max: 60000, noNaN: true }), (x, z) => {
        const d = W.densityAt(x, z);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
        expect(Number.isFinite(W.heightAt(x, z))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('no trees on the runway, taxiways, apron and approach zone', () => {
    const rw = L.airport.runway;
    for (let a = -400; a <= rw.length + 400; a += 50) // along is measured from the threshold
      for (let c = -150; c <= 150; c += 25) {
        const p = fromRunwayCoords(a, c, rw);
        expect(W.densityAt(p.x, p.z)).toBe(0);
      }
    for (const r of L.airport.pavedAreas) expect(W.densityAt(r.center.x, r.center.z)).toBe(0);
  });

  it('the airport plateau is flat at field elevation', () => {
    expect(W.heightAt(0, 0)).toBeCloseTo(L.airport.elevation, 6);
    expect(W.heightAt(200, -600)).toBeCloseTo(L.airport.elevation, 6);
  });

  it('no trees on roads, rivers, lakes or the sea', () => {
    for (const road of L.roads) for (let i = 0; i < road.points.length; i += 7) expect(W.densityAt(road.points[i].x, road.points[i].z)).toBe(0);
    for (const river of L.rivers) for (let i = 0; i < river.points.length; i += 11) expect(W.densityAt(river.points[i].x, river.points[i].z)).toBe(0);
    for (const lake of L.lakes) expect(W.densityAt(lake.center.x, lake.center.z)).toBe(0);
    for (let x = -30000; x <= 30000; x += 1000) expect(W.densityAt(x, L.coast.zAt(x) + 300)).toBe(0);
  });

  it('has real forests: a sizeable share of the countryside is wooded, the rest open farmland', () => {
    let wood = 0;
    let open = 0;
    let n = 0;
    for (let x = -20000; x <= 20000; x += 410)
      for (let z = -20000; z <= 5000; z += 390) {
        const d = W.densityAt(x, z);
        n++;
        if (d > 0.5) wood++;
        else if (d > 0 && d < 0.1) open++;
      }
    expect(wood / n).toBeGreaterThan(0.2);
    expect(wood / n).toBeLessThan(0.65);
    expect(open / n).toBeGreaterThan(0.15);
  });

  it('classifies the ground for the preview terrain colours', () => {
    expect(W.groundAt(0, 0)).toBe(GROUND.PAVED);
    expect(W.groundAt(0, L.coast.zAt(0) + 2000)).toBe(GROUND.WATER);
    expect(W.groundAt(L.lakes[0].center.x, L.lakes[0].center.z)).toBe(GROUND.WATER);
  });
});
