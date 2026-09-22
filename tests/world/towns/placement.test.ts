import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { placeBuildings, buildingRect, roofTopAt, type Building } from '../../../src/world/towns/placement';
import { buildRoadNetwork, type RoadNetwork } from '../../../src/world/roads/network';
import { createConstraints } from '../../../src/world/towns/constraints';
import { SegmentGrid, rectCorners, rectsOverlap, frontVector, type Rect } from '../../../src/world/towns/geom';
import { createStandInHeight } from '../../../src/world/towns/standin';
import { CONFIG } from '../../../src/config';
import type { WorldLayout } from '../../../src/world/layout';
import { LAYOUT, HEIGHT, syntheticLayout } from './fixtures';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NET = buildRoadNetwork(LAYOUT, HEIGHT);
const B = placeBuildings(LAYOUT, NET, HEIGHT);

function roadGrid(net: RoadNetwork): SegmentGrid {
  const g = new SegmentGrid(64);
  net.roads.forEach((r, i) => g.addPolyline(r.points, r.width / 2, i));
  g.build();
  return g;
}

/** Every invariant the placement promises, for any layout. */
function checkInvariants(layout: WorldLayout, net: RoadNetwork, bs: Building[], heightAt: (x: number, z: number) => number): void {
  const C = createConstraints(layout);
  const roads = roadGrid(net);
  const q = roads.newQuery();
  // no overlaps: ≥ 0.5 m between any two buildings, except a church's steeple, which is joined to its nave
  const cells = new Map<string, number[]>();
  const rects = bs.map(buildingRect);
  rects.forEach((r, i) => {
    const k = `${Math.floor(r.x / 80)},${Math.floor(r.z / 80)}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(i);
  });
  rects.forEach((r, i) => {
    const ci = Math.floor(r.x / 80);
    const cj = Math.floor(r.z / 80);
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        for (const j of cells.get(`${ci + di},${cj + dj}`) ?? []) {
          if (j <= i) continue;
          const a = bs[i];
          const b = bs[j];
          const joined = a.town === b.town && ((a.use === 'church' && b.use === 'steeple') || (a.use === 'steeple' && b.use === 'church'));
          expect(rectsOverlap(r, rects[j], joined ? 0 : 0.5)).toBe(false);
        }
  });
  for (const b of bs) {
    const r = buildingRect(b);
    // clear of every road ribbon (incl. streets and farm tracks)
    expect(roads.clearance(r, 40)).toBeGreaterThan(0.5);
    // clear of the sea, lakes and the river
    expect(C.rectWaterClearance(r)).toBeGreaterThan(1);
    // off the airport and its approach corridors
    expect(C.rectInAirport(r, 0)).toBe(false);
    // standing on the ground: base at or below the lowest corner, not buried deep
    let lo = Infinity;
    for (const c of rectCorners(r)) lo = Math.min(lo, heightAt(c.x, c.z));
    expect(b.y).toBeLessThanOrEqual(lo + 1e-9);
    expect(b.y).toBeGreaterThan(lo - 1.5);
    expect(b.wallHeight).toBeGreaterThan(2);
    expect(Number.isFinite(b.roofHeight)).toBe(true);
    // town & roadside buildings face the nearest road segment
    if (b.farm < 0 && b.use !== 'steeple') {
      expect(roads.nearest(b.x, b.z, 400, q)).toBe(true);
      const f = frontVector(b.headingDeg);
      expect(Math.abs(f.x * q.dx + f.z * q.dz)).toBeLessThan(1e-6);
      expect(f.x * (q.px - b.x) + f.z * (q.pz - b.z)).toBeGreaterThan(0);
    }
  }
}

describe('building placement', () => {
  it('is deterministic for a seed and varies with it', () => {
    const again = placeBuildings(LAYOUT, NET, HEIGHT);
    expect(again.length).toBe(B.length);
    expect(JSON.stringify(again.slice(0, 500))).toBe(JSON.stringify(B.slice(0, 500)));
    expect(JSON.stringify(again)).toBe(JSON.stringify(B));
    const other = placeBuildings(LAYOUT, NET, HEIGHT, { seed: 12345 });
    expect(JSON.stringify(other.slice(0, 200))).not.toBe(JSON.stringify(B.slice(0, 200)));
  });

  it('fills the world with thousands of buildings, most of them in the settlements', () => {
    expect(B.length).toBeGreaterThan(8000);
    const inTowns = B.filter((b) => b.town >= 0).length;
    expect(inTowns).toBeGreaterThan(B.length * 0.5);
  });

  it('gives the coastal city a downtown of towers near its centre and none elsewhere', () => {
    const cityIdx = LAYOUT.towns.findIndex((t) => t.kind === 'city');
    const city = LAYOUT.towns[cityIdx];
    const towers = B.filter((b) => b.use === 'tower');
    expect(towers.length).toBeGreaterThan(10);
    for (const t of towers) {
      expect(t.town).toBe(cityIdx);
      expect(Math.hypot(t.x - city.x, t.z - city.z)).toBeLessThan(city.radius * 0.45);
      expect(t.wallHeight).toBeGreaterThan(30);
    }
    expect(Math.max(...towers.map((t) => t.wallHeight))).toBeGreaterThan(70);
    expect(B.some((b) => b.town === cityIdx && b.use === 'apartment')).toBe(true);
  });

  it('puts one church with a spire near the centre of every village', () => {
    LAYOUT.towns.forEach((t, ti) => {
      if (t.kind !== 'village') return;
      const naves = B.filter((b) => b.town === ti && b.use === 'church');
      const spires = B.filter((b) => b.town === ti && b.use === 'steeple');
      expect(naves.length).toBe(1);
      expect(spires.length).toBe(1);
      expect(Math.hypot(naves[0].x - t.x, naves[0].z - t.z)).toBeLessThan(t.radius * 0.6);
      const s = spires[0];
      expect(s.archetype).toBe('hip');
      expect(s.ridge).toBe(0); // a pyramid spire
      expect(s.roofHeight).toBeGreaterThan(s.width * 1.2);
      expect(s.wallHeight + s.roofHeight).toBeGreaterThan(naves[0].wallHeight + naves[0].roofHeight + 5);
    });
  });

  it('builds farmsteads (farmhouse + red barn + silos) away from the towns', () => {
    const farmB = B.filter((b) => b.farm >= 0);
    const farms = new Set(farmB.map((b) => b.farm));
    expect(farms.size).toBeGreaterThan(NET.farms.length * 0.7);
    const barns = farmB.filter((b) => b.use === 'barn');
    const silos = farmB.filter((b) => b.use === 'silo');
    expect(barns.length).toBeGreaterThan(farms.size * 0.8);
    expect(silos.length).toBeGreaterThan(farms.size * 0.8);
    for (const b of barns) expect(b.archetype === 'gambrel' || b.archetype === 'gable').toBe(true);
    const red = barns.filter((b) => ((b.wallColor >> 16) & 255) > 2 * ((b.wallColor >> 8) & 255));
    expect(red.length).toBeGreaterThan(barns.length * 0.5);
    for (const b of silos) {
      expect(b.archetype).toBe('silo');
      expect(b.width).toBe(b.depth);
    }
    for (const b of farmB) for (const t of LAYOUT.towns) expect(Math.hypot(b.x - t.x, b.z - t.z)).toBeGreaterThan(t.radius + 200);
  });

  it('has industrial sheds/warehouses and varied roof colours on houses', () => {
    expect(B.filter((b) => b.use === 'industrial' || b.use === 'warehouse').length).toBeGreaterThan(30);
    const houses = B.filter((b) => b.use === 'house');
    const fam = (c: number): string => {
      const r = (c >> 16) & 255;
      const g = (c >> 8) & 255;
      const bl = c & 255;
      if (r > g * 1.6 && r > 120) return 'terracotta';
      if (Math.abs(r - bl) < 25 && r < 110) return 'slate';
      if (r > bl * 1.3 && r <= 120) return 'brown';
      return 'other';
    };
    const fams = new Set(houses.map((h) => fam(h.roofColor)));
    for (const f of ['terracotta', 'slate', 'brown']) expect(fams.has(f)).toBe(true);
    expect(new Set(houses.map((h) => h.archetype))).toEqual(new Set(['gable', 'hip']));
  });

  it('records the plinth (extra wall height on sloping ground) of every building', () => {
    for (const b of B) {
      expect(b.plinth).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(b.plinth).toBeLessThan(b.wallHeight);
    }
  });

  it('gives some downtown towers a setback upper tier, within the footprint', () => {
    const tiered = B.filter((b) => (b.tierHeight ?? 0) > 0);
    expect(tiered.length).toBeGreaterThan(5);
    for (const b of tiered) {
      expect(b.use === 'tower' || b.use === 'office').toBe(true);
      expect(b.archetype).toBe('flat');
      expect(b.tierHeight!).toBeGreaterThan(b.plinth! + 8);
      expect(b.tierHeight!).toBeLessThan(b.wallHeight - 6);
      expect(b.tierInset!).toBeGreaterThan(1.5);
      expect(Math.min(b.width, b.depth) - 2 * b.tierInset!).toBeGreaterThan(8);
    }
  });

  it('builds grain bins (squat, cone roof) as well as tall domed silos on the farms', () => {
    const silos = B.filter((b) => b.use === 'silo');
    const bins = silos.filter((b) => b.ridge < 0.5);
    const domed = silos.filter((b) => b.ridge >= 0.5);
    expect(bins.length).toBeGreaterThan(silos.length * 0.15);
    expect(domed.length).toBeGreaterThan(silos.length * 0.3);
    for (const b of bins) expect(b.width).toBeGreaterThan(b.wallHeight - b.plinth! - 1);
  });

  it('keeps every building clear of roads, water, the airport and each other, on the ground and facing its street', () => {
    checkInvariants(LAYOUT, NET, B, HEIGHT);
  });

  it('fuzz: the invariants hold for random settlements', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 0, max: 2 ** 31 - 1 }), (lseed, bseed) => {
        const L = syntheticLayout(lseed);
        const h = createStandInHeight(L);
        const net = buildRoadNetwork(L, h, { ...CONFIG.world.towns, farmsteadChance: 0 });
        const bs = placeBuildings(L, net, h, { seed: bseed });
        checkInvariants(L, net, bs, h);
        // and determinism
        expect(JSON.stringify(placeBuildings(L, net, h, { seed: bseed }))).toBe(JSON.stringify(bs));
      }),
      { numRuns: 16 },
    );
  }, 60_000);
});

describe('roofTopAt', () => {
  const mk = (over: Partial<Building>): Building => ({
    x: 100,
    z: -50,
    y: 12,
    headingDeg: 30,
    width: 12,
    depth: 8,
    wallHeight: 6,
    roofHeight: 3,
    ridge: 0.4,
    ridgeAxis: 0,
    archetype: 'gable',
    use: 'house',
    wallColor: 0xffffff,
    roofColor: 0xaa5533,
    floorHeight: 2.9,
    style: 0,
    rand: 0.5,
    town: 0,
    farm: -1,
    ...over,
  });
  it('is −Infinity outside the footprint and the ridge height on the ridge', () => {
    const b = mk({});
    expect(roofTopAt(b, b.x + 50, b.z)).toBe(-Infinity);
    expect(roofTopAt(b, b.x, b.z)).toBeCloseTo(b.y + b.wallHeight + b.roofHeight);
    const f = frontVector(b.headingDeg);
    // at the front eave line the gable roof is at the wall top
    expect(roofTopAt(b, b.x + f.x * (b.depth / 2 - 1e-6), b.z + f.z * (b.depth / 2 - 1e-6))).toBeCloseTo(b.y + b.wallHeight, 3);
  });
  it('gable ridge along the depth slopes toward the sides instead', () => {
    const b = mk({ ridgeAxis: 1 });
    const f = frontVector(b.headingDeg);
    expect(roofTopAt(b, b.x + f.x * 3.9, b.z + f.z * 3.9)).toBeCloseTo(b.y + b.wallHeight + b.roofHeight);
  });
  it('flat roofs are flat at wall + parapet, silos are domes, spires are pyramids', () => {
    const flat = mk({ archetype: 'flat', roofHeight: 1 });
    expect(roofTopAt(flat, flat.x + 1, flat.z + 1)).toBeCloseTo(flat.y + 7);
    const silo = mk({ archetype: 'silo', width: 6, depth: 6, roofHeight: 2 });
    expect(roofTopAt(silo, silo.x, silo.z)).toBeCloseTo(silo.y + 8);
    expect(roofTopAt(silo, silo.x + 2.9, silo.z + 2.9)).toBe(-Infinity); // outside the circle, inside the square
    const spire = mk({ archetype: 'hip', ridge: 0, width: 6, depth: 6, wallHeight: 18, roofHeight: 14 });
    expect(roofTopAt(spire, spire.x, spire.z)).toBeCloseTo(spire.y + 32);
  });
  it('grain bins (silo, ridge 0) have a cone roof', () => {
    const bin = mk({ archetype: 'silo', width: 10, depth: 10, roofHeight: 2.5, ridge: 0 });
    expect(roofTopAt(bin, bin.x, bin.z)).toBeCloseTo(bin.y + 8.5);
    const f = frontVector(bin.headingDeg);
    expect(roofTopAt(bin, bin.x + f.x * 2.5, bin.z + f.z * 2.5)).toBeCloseTo(bin.y + 6 + 2.5 * 0.5);
  });
  it('a tiered tower is full height over its inset top and at the tier over the terrace', () => {
    const t = mk({ archetype: 'flat', width: 30, depth: 24, wallHeight: 80, roofHeight: 1.5, tierHeight: 50, tierInset: 4 });
    expect(roofTopAt(t, t.x, t.z)).toBeCloseTo(t.y + 81.5);
    const f = frontVector(t.headingDeg);
    // 2 m in from the front wall: on the terrace
    expect(roofTopAt(t, t.x + f.x * 10, t.z + f.z * 10)).toBeCloseTo(t.y + 51.5);
    expect(roofTopAt(t, t.x + f.x * 7.5, t.z + f.z * 7.5)).toBeCloseTo(t.y + 81.5);
  });
  it('fuzz: inside the footprint the top lies between the wall top and the roof top', () => {
    const arch = fc.constantFrom('gable', 'hip', 'flat', 'gambrel', 'silo') as fc.Arbitrary<Building['archetype']>;
    fc.assert(
      fc.property(
        arch,
        fc.double({ min: 3, max: 40, noNaN: true }),
        fc.double({ min: 3, max: 40, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: -0.999, max: 0.999, noNaN: true }),
        fc.double({ min: -0.999, max: 0.999, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1 }),
        (a, w, d, h, u, v, ridge, axis) => {
          const b = mk({ archetype: a, width: w, depth: a === 'silo' ? w : d, headingDeg: h, ridge, ridgeAxis: axis as 0 | 1 });
          const r: Rect = buildingRect(b);
          const x = r.x + r.ax * r.hw * u + r.fx * r.hd * v;
          const z = r.z + r.az * r.hw * u + r.fz * r.hd * v;
          const top = roofTopAt(b, x, z);
          if (a === 'silo' && u * u + v * v > 1) {
            expect(top).toBe(-Infinity);
            return;
          }
          expect(top).toBeGreaterThanOrEqual(b.y + b.wallHeight - 1e-9);
          expect(top).toBeLessThanOrEqual(b.y + b.wallHeight + b.roofHeight + 1e-9);
        },
      ),
    );
  });
});
