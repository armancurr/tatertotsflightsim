import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { buildInstances, instanceFlags, INST_STRIDE, STYLE_X, type InstanceSets } from '../../../src/world/towns/instances';
import { ARCH_GEOMETRIES, evalVertex, newEvalOut, FLAG, I, NEAR_KINDS, FACE, type NearKind } from '../../../src/world/towns/archetypes';
import { placeBuildings, roofTopAt, buildingRect, type Building } from '../../../src/world/towns/placement';
import { getRoadNetwork } from '../../../src/world/roads/network';
import { pointInRect } from '../../../src/world/towns/geom';
import { LAYOUT, HEIGHT } from './fixtures';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const B = placeBuildings(LAYOUT, getRoadNetwork(LAYOUT, HEIGHT), HEIGHT);
const CS = 400;
const S = buildInstances(B, CS);

const count = (d: Float32Array) => d.length / INST_STRIDE;

function checkPartition(s: InstanceSets): void {
  for (const set of [...NEAR_KINDS.map((k) => s.near[k]), s.mid]) {
    expect(set.start.length).toBe(s.chunkCount + 1);
    expect(set.start[0]).toBe(0);
    expect(set.start[s.chunkCount]).toBe(count(set.data));
    for (let c = 0; c < s.chunkCount; c++) {
      expect(set.start[c + 1]).toBeGreaterThanOrEqual(set.start[c]);
      for (let k = set.start[c]; k < set.start[c + 1]; k++) expect(set.data[k * INST_STRIDE + I.chunk]).toBe(c);
    }
  }
}

/** Every evaluated vertex of every near instance of chunk c lies in the chunk's box. */
function checkChunkBoxes(s: InstanceSets, sample = 1): void {
  const out = newEvalOut();
  for (let c = 0; c < s.chunkCount; c += sample) {
    const bx = s.chunkBox.subarray(c * 6, c * 6 + 6);
    for (const k of [...NEAR_KINDS, 'mid'] as const) {
      const set = k === 'mid' ? s.mid : s.near[k];
      const g = ARCH_GEOMETRIES[k];
      for (let n = set.start[c]; n < set.start[c + 1]; n++) {
        for (let vi = 0; vi < g.count; vi++) {
          evalVertex(g, vi, set.data, n * INST_STRIDE, out);
          if (!out.on) continue;
          expect(out.x).toBeGreaterThanOrEqual(bx[0] - 1e-3);
          expect(out.y).toBeGreaterThanOrEqual(bx[1] - 1e-3);
          expect(out.z).toBeGreaterThanOrEqual(bx[2] - 1e-3);
          expect(out.x).toBeLessThanOrEqual(bx[3] + 1e-3);
          expect(out.y).toBeLessThanOrEqual(bx[4] + 1e-3);
          expect(out.z).toBeLessThanOrEqual(bx[5] + 1e-3);
        }
      }
    }
  }
}

describe('instance sets (functional: the real world)', () => {
  it('partitions every set by chunk, in chunk order', () => {
    checkPartition(S);
    expect(S.chunkCount).toBeGreaterThan(50);
  });
  it('draws every building: one mid piece at least and near pieces of its own archetype', () => {
    const nearTotal = NEAR_KINDS.reduce((a, k) => a + count(S.near[k].data), 0);
    expect(nearTotal).toBeGreaterThanOrEqual(B.length);
    // pools lie flat on the ground: near only
    expect(count(S.mid.data)).toBeGreaterThanOrEqual(B.filter((b) => b.use !== 'pool').length);
    for (const k of NEAR_KINDS) {
      const want = B.filter((b) => b.archetype === k).length;
      expect(count(S.near[k].data)).toBeGreaterThanOrEqual(want);
    }
  });
  it('chunk boxes hold every vertex drawn (near and mid)', () => {
    checkChunkBoxes(S, 7);
  }, 60_000);
  it('splits setback towers into a base and an inset upper tier whose roofs are the ones the physics sees', () => {
    const tiered = B.filter((b) => (b.tierHeight ?? 0) > 0);
    expect(tiered.length).toBeGreaterThan(0);
    const flat = S.near.flat;
    const out = newEvalOut();
    for (const b of tiered.slice(0, 20)) {
      // find this tower's pieces (same centre, walls not blank)
      const pieces: number[] = [];
      for (let n = 0; n < count(flat.data); n++) {
        const o = n * INST_STRIDE;
        if (Math.abs(flat.data[o + I.x] - b.x) < 0.01 && Math.abs(flat.data[o + I.z] - b.z) < 0.01 && !((flat.data[o + I.flags] | 0) & FLAG.blank)) pieces.push(o);
      }
      expect(pieces.length).toBe(2);
      const r = buildingRect(b);
      for (const o of pieces) {
        for (let vi = 0; vi < ARCH_GEOMETRIES.flat.count; vi++) {
          const f = ARCH_GEOMETRIES.flat.face[vi * 2];
          if (f !== FACE.parapetTop) continue;
          evalVertex(ARCH_GEOMETRIES.flat, vi, flat.data, o, out);
          if (!pointInRect(r, out.x, out.z, -0.05)) continue;
          // (queried 5 cm toward the centre: the upper tier's coping lies exactly on the setback line)
          const dx = b.x - out.x;
          const dz = b.z - out.z;
          const dl = Math.hypot(dx, dz) || 1;
          const top = roofTopAt(b, out.x + (dx / dl) * 0.05, out.z + (dz / dl) * 0.05);
          expect(out.y).toBeLessThanOrEqual(top + 1e-3);
        }
      }
    }
  });
  it('puts rooftop units, tanks and masts on flat roofs, inside the parapet, sitting on the deck', () => {
    const flat = S.near.flat;
    const silo = S.near.silo;
    let clutter = 0;
    let tanks = 0;
    const out = newEvalOut();
    for (const [set, kind] of [
      [flat, 'flat'],
      [silo, 'silo'],
    ] as [typeof flat, NearKind][]) {
      for (let n = 0; n < count(set.data); n++) {
        const o = n * INST_STRIDE;
        const st = set.data[o + I.style];
        if (set.data[o + I.aux1] !== 2) continue; // rooftop pieces only (not a water tower's column)
        if (st !== STYLE_X.hvac && st !== STYLE_X.tank && st !== STYLE_X.mast && st !== STYLE_X.plain) continue;
        clutter++;
        if (st === STYLE_X.tank) tanks++;
        // its parent: aux0 holds the parent's index
        const parent = B[set.data[o + I.aux0]];
        expect(parent).toBeTruthy();
        const r = buildingRect(parent!);
        for (let vi = 0; vi < ARCH_GEOMETRIES[kind].count; vi++) {
          evalVertex(ARCH_GEOMETRIES[kind], vi, set.data, o, out);
          expect(pointInRect(r, out.x, out.z, 0.01)).toBe(true);
        }
        // base on the roof deck of the parent (top wall, below its parapet top)
        const deck = roofTopAt(parent!, set.data[o + I.x], set.data[o + I.z]) - parent!.roofHeight;
        expect(set.data[o + I.y]).toBeCloseTo(deck, 3);
      }
    }
    expect(clutter).toBeGreaterThan(300);
    expect(tanks).toBeGreaterThan(5);
  });
  it('is deterministic', () => {
    const again = buildInstances(B, CS);
    for (const k of NEAR_KINDS) expect(Buffer.from(again.near[k].data.buffer).equals(Buffer.from(S.near[k].data.buffer))).toBe(true);
    expect(Buffer.from(again.mid.data.buffer).equals(Buffer.from(S.mid.data.buffer))).toBe(true);
  });
  it('chooses decoration flags from the building: dormers/chimneys on houses, balconies on flats, glass on glass offices, cones on bins', () => {
    const houses = B.filter((b) => b.use === 'house');
    const withChimney = houses.filter((b) => instanceFlags(b) & FLAG.chimney).length;
    expect(withChimney).toBeGreaterThan(houses.length * 0.3);
    expect(withChimney).toBeLessThan(houses.length * 0.95);
    expect(houses.some((b) => instanceFlags(b) & FLAG.dormers)).toBe(true);
    for (const b of houses) if (instanceFlags(b) & FLAG.dormers) expect(b.archetype).toBe('gable');
    const apts = B.filter((b) => b.use === 'apartment');
    expect(apts.some((b) => instanceFlags(b) & FLAG.balcony)).toBe(true);
    for (const b of B.filter((x) => x.style === 2)) expect(instanceFlags(b) & FLAG.glass).toBeTruthy();
    for (const b of B.filter((x) => x.use === 'steeple')) expect(instanceFlags(b) & FLAG.steeple).toBeTruthy();
    for (const b of B.filter((x) => x.use === 'shop')) expect(instanceFlags(b) & FLAG.shopfront).toBeTruthy();
  });
  it('awnings on most shopfronts (only where the front is the local +z wall), solar panels on some roofs, metal roofs by colour', () => {
    const shops = B.filter((b) => b.use === 'shop');
    const aw = shops.filter((b) => instanceFlags(b) & FLAG.awning);
    expect(aw.length).toBeGreaterThan(shops.length * 0.4);
    expect(aw.length).toBeLessThan(shops.length * 0.8);
    for (const b of B) if (instanceFlags(b) & FLAG.awning) expect(b.archetype === 'flat' || (b.archetype === 'gable' && b.ridgeAxis === 0)).toBe(true);
    const houses = B.filter((b) => b.use === 'house');
    const solar = houses.filter((b) => instanceFlags(b) & FLAG.solar).length;
    expect(solar).toBeGreaterThan(houses.length * 0.04);
    expect(solar).toBeLessThan(houses.length * 0.2);
    expect(houses.some((b) => instanceFlags(b) & FLAG.metalRoof)).toBe(true);
    // trees are trees, pools are blank
    for (const b of B.filter((x) => x.use === 'tree').slice(0, 500)) expect(instanceFlags(b)).toBe(FLAG.tree);
    for (const b of B.filter((x) => x.use === 'pool')) expect(instanceFlags(b) & FLAG.blank).toBeTruthy();
  });
  it('water towers are a column and a raised tank; town halls carry a clock turret on the ridge', () => {
    const idx = new Map(B.map((b, i) => [b, i]));
    const towers = B.filter((b) => b.use === 'watertower');
    expect(towers.length).toBeGreaterThan(0);
    for (const t of towers) {
      const i = idx.get(t)!;
      const flat = S.near.flat;
      const silo = S.near.silo;
      const col = [...Array(count(flat.data)).keys()].filter((n) => flat.data[n * INST_STRIDE + I.aux0] === i);
      const tank = [...Array(count(silo.data)).keys()].filter((n) => silo.data[n * INST_STRIDE + I.aux0] === i);
      expect(col.length).toBe(1);
      expect(tank.length).toBe(1);
      const to = tank[0] * INST_STRIDE;
      // the tank's top is the building's top (what the physics sees)
      expect(silo.data[to + I.y] + silo.data[to + I.Hw]).toBeCloseTo(t.y + t.wallHeight, 2);
      expect(silo.data[to + I.y]).toBeGreaterThan(t.y + 12);
    }
    const halls = B.filter((b) => b.use === 'townhall');
    expect(halls.length).toBeGreaterThan(0);
    for (const h of halls) {
      const i = idx.get(h)!;
      const hip = S.near.hip;
      const turret = [...Array(count(hip.data)).keys()].filter((n) => hip.data[n * INST_STRIDE + I.aux0] === i && hip.data[n * INST_STRIDE + I.aux1] === 1);
      expect(turret.length).toBe(1);
      expect((hip.data[turret[0] * INST_STRIDE + I.flags] | 0) & FLAG.steeple).toBeTruthy();
    }
  });
});

describe('instance sets (fuzz)', () => {
  const arb = fc.record({
    x: fc.double({ min: -30000, max: 30000, noNaN: true }),
    z: fc.double({ min: -30000, max: 30000, noNaN: true }),
    y: fc.double({ min: -5, max: 800, noNaN: true }),
    headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
    width: fc.double({ min: 4, max: 60, noNaN: true }),
    depth: fc.double({ min: 4, max: 60, noNaN: true }),
    wallHeight: fc.double({ min: 3, max: 130, noNaN: true }),
    roofHeight: fc.double({ min: 0.3, max: 3, noNaN: true }),
    archetype: fc.constantFrom<Building['archetype']>('gable', 'flat', 'gambrel'),
    use: fc.constantFrom<Building['use']>('house', 'apartment', 'office', 'tower', 'warehouse', 'shop', 'barn'),
    rand: fc.double({ min: 0, max: 0.999, noNaN: true }),
    tier: fc.boolean(),
  });
  it('any list of buildings: partitioned by chunk, boxes hold every vertex, clutter inside its parent', () => {
    fc.assert(
      fc.property(fc.array(arb, { minLength: 0, maxLength: 25 }), (list) => {
        const bs: Building[] = list.map((p) => {
          const tiered = p.tier && p.archetype === 'flat' && p.wallHeight > 30 && Math.min(p.width, p.depth) > 16;
          return {
            ...p,
            ridge: 1,
            ridgeAxis: 0,
            wallColor: 0xcccccc,
            roofColor: 0x777777,
            floorHeight: 3,
            style: p.use === 'office' ? 2 : 1,
            town: 0,
            farm: -1,
            plinth: 0.3,
            ...(tiered ? { tierHeight: p.wallHeight * 0.6, tierInset: 3 } : {}),
          };
        });
        const s = buildInstances(bs, 300);
        checkPartition(s);
        checkChunkBoxes(s);
        expect(count(s.mid.data)).toBeGreaterThanOrEqual(bs.length);
      }),
      { numRuns: 60 },
    );
  });
});
