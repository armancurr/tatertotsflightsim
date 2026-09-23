import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import {
  ARCH_GEOMETRIES,
  evalVertex,
  newEvalOut,
  FACE,
  PART,
  FLAG,
  NEAR_KINDS,
  AWNING,
  TREE_EQ,
  type ArchetypeGeometry,
  type NearKind,
} from '../../../src/world/towns/archetypes';
import { INST_STRIDE, writeInstance, instanceFlags, type InstanceInput } from '../../../src/world/towns/instances';
import { roofTopAt, buildingRect, type Building } from '../../../src/world/towns/placement';
import { pointInRect } from '../../../src/world/towns/geom';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const mk = (over: Partial<Building>): Building => ({
  x: 1234.5,
  z: -876.25,
  y: 40,
  headingDeg: 30,
  width: 12,
  depth: 8,
  wallHeight: 6,
  roofHeight: 3,
  ridge: 1,
  ridgeAxis: 0,
  archetype: 'gable',
  use: 'house',
  wallColor: 0xe9dfc6,
  roofColor: 0xb0553a,
  floorHeight: 2.8,
  style: 0,
  rand: 0.37,
  town: 0,
  farm: -1,
  plinth: 0.5,
  ...over,
});

/** Evaluates every vertex of the geometry for one instance record. */
function evalAll(g: ArchetypeGeometry, inst: Float32Array) {
  const out = newEvalOut();
  const verts: { x: number; y: number; z: number; nx: number; ny: number; nz: number; on: boolean; face: number; part: number }[] = [];
  for (let i = 0; i < g.count; i++) {
    evalVertex(g, i, inst, 0, out);
    verts.push({ ...out, face: g.face[i * 2], part: g.face[i * 2 + 1] });
  }
  return verts;
}

const kindOf = (b: Building): NearKind => b.archetype;

/** Every geometric promise of an archetype, for one building. */
function checkBuilding(b: Building, flagsOverride?: number) {
  const input: InstanceInput = { b, chunk: 0 };
  const inst = new Float32Array(INST_STRIDE);
  writeInstance(inst, 0, input, flagsOverride);
  const g = ARCH_GEOMETRIES[kindOf(b)];
  const vs = evalAll(g, inst);
  const r = buildingRect(b);
  const ridgeTop = b.y + b.wallHeight + b.roofHeight;
  const tree = ((inst[14] | 0) & FLAG.tree) !== 0;
  // 1. every vertex of an enabled part is finite, inside the footprint grown by the overhang (the awning over the pavement), between base and top
  for (const v of vs) {
    if (!v.on) continue;
    expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)).toBe(true);
    expect(pointInRect(r, v.x, v.z, (v.part === PART.awning ? AWNING.out : 0.5) + 1e-3)).toBe(true);
    if (tree) expect(Math.hypot(v.x - b.x, v.z - b.z)).toBeLessThanOrEqual(b.width / 2 + 1e-3);
    expect(v.y).toBeGreaterThanOrEqual(b.y - 1e-3);
    const allowance = v.part === PART.chimney ? 1.0 : v.part === PART.cupola ? 2.6 : 0.25;
    expect(v.y).toBeLessThanOrEqual(ridgeTop + allowance);
    expect(Math.abs(Math.hypot(v.nx, v.ny, v.nz) - 1)).toBeLessThan(1e-4);
  }
  // 2. the roof surface drawn is the roof the physics sees (within the roof thickness)
  for (const v of vs) {
    if (!v.on || v.part !== PART.main) continue;
    const roofFace = v.face === FACE.roofPZ || v.face === FACE.roofNZ || v.face === FACE.roofPX || v.face === FACE.roofNX || v.face === FACE.roofFlat || v.face === FACE.parapetTop || v.face === FACE.siloRoof;
    if (!roofFace) continue;
    if (!pointInRect(r, v.x, v.z, -0.02)) continue; // eave overhang: outside the footprint
    if (v.face === FACE.siloRoof && Math.hypot(v.x - b.x, v.z - b.z) > b.width * 0.49) continue; // the dome's eave ring (on the circle)
    const top = roofTopAt(b, v.x, v.z);
    expect(top).toBeGreaterThan(-Infinity);
    if (tree) {
      // the lumpy crown lies under the physics' cap, above the trunk
      expect(v.y).toBeGreaterThanOrEqual(b.y + b.wallHeight + TREE_EQ * b.roofHeight - 1e-3);
    } else expect(v.y).toBeGreaterThanOrEqual(top - 0.05 - (v.face === FACE.roofFlat ? b.roofHeight : 0));
    expect(v.y).toBeLessThanOrEqual(top + 0.25);
  }
  // 3. triangles are wound counter-clockwise seen from outside (geometric normal agrees with the shading normal)
  const idx = g.index;
  for (let t = 0; t < idx.length; t += 3) {
    const a = vs[idx[t]];
    const bb = vs[idx[t + 1]];
    const c = vs[idx[t + 2]];
    if (!a.on) continue;
    const ux = bb.x - a.x, uy = bb.y - a.y, uz = bb.z - a.z;
    const wx = c.x - a.x, wy = c.y - a.y, wz = c.z - a.z;
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-6) continue; // degenerate (e.g. the ridge of a pyramid)
    const nx = (a.nx + bb.nx + c.nx) / 3, ny = (a.ny + bb.ny + c.ny) / 3, nz = (a.nz + bb.nz + c.nz) / 3;
    expect((cx * nx + cy * ny + cz * nz) / len).toBeGreaterThan(0.2);
  }
  return vs;
}

describe('archetype geometries (unit)', () => {
  it('has a geometry per near kind plus the mid-distance prism, with consistent attribute arrays', () => {
    for (const k of [...NEAR_KINDS, 'mid'] as const) {
      const g = ARCH_GEOMETRIES[k];
      expect(g.count).toBeGreaterThan(8);
      expect(g.position.length).toBe(g.count * 3);
      expect(g.coef.length).toBe(g.count * 3);
      expect(g.offset.length).toBe(g.count * 3);
      expect(g.normal.length).toBe(g.count * 4);
      expect(g.face.length).toBe(g.count * 2);
      expect(g.index.length % 3).toBe(0);
      for (const i of g.index) expect(i).toBeLessThan(g.count);
      for (const arr of [g.position, g.coef, g.offset, g.normal, g.face]) for (const x of arr) expect(Number.isFinite(x)).toBe(true);
    }
  });
  it('keeps detail cheap: a house is a few dozen triangles, the mid prism fourteen', () => {
    expect(ARCH_GEOMETRIES.gable.index.length / 3).toBeLessThan(140);
    expect(ARCH_GEOMETRIES.mid.index.length / 3).toBeLessThanOrEqual(14);
  });
});

describe('archetype geometries (functional: real buildings)', () => {
  it('a gable house with chimney and dormers matches its footprint and roof', () => {
    checkBuilding(mk({ roofHeight: 4.2 }), FLAG.chimney | FLAG.dormers);
  });
  it('a gable house turned end-on to the street (ridge front-to-back) matches its footprint and roof', () => {
    checkBuilding(mk({ ridgeAxis: 1, width: 7, depth: 12, headingDeg: 200 }), FLAG.chimney | FLAG.side);
  });
  it('a hip house and a pyramid steeple', () => {
    checkBuilding(mk({ archetype: 'hip', width: 14, depth: 9, ridge: 5 / 14, roofHeight: 2.6 }), FLAG.chimney);
    checkBuilding(mk({ archetype: 'hip', use: 'steeple', width: 6, depth: 6, ridge: 0, wallHeight: 22, roofHeight: 15, style: 5 }));
  });
  it('a flat-roofed block with parapet, and a tiered tower', () => {
    checkBuilding(mk({ archetype: 'flat', use: 'apartment', width: 24, depth: 13, wallHeight: 18.6, roofHeight: 1.1 }));
  });
  it('a gambrel barn end-on with a cupola, and a domed silo and a cone-roofed grain bin', () => {
    checkBuilding(mk({ archetype: 'gambrel', use: 'barn', width: 13, depth: 26, wallHeight: 5, roofHeight: 6, ridgeAxis: 1, style: 4 }), FLAG.cupola);
    checkBuilding(mk({ archetype: 'silo', use: 'silo', width: 6, depth: 6, wallHeight: 16, roofHeight: 2.3, style: 6 }));
    checkBuilding(mk({ archetype: 'silo', use: 'silo', width: 10, depth: 10, wallHeight: 7, roofHeight: 2.4, ridge: 0, style: 6 }));
  });
  it('a shop with an awning over the pavement: in front of the shopfront, under the sign', () => {
    const b = mk({ archetype: 'flat', use: 'shop', width: 11, depth: 15, wallHeight: 10.2, roofHeight: 1.1, floorHeight: 3.2, style: 7, plinth: 0.6 });
    const vs = checkBuilding(b, FLAG.awning | FLAG.shopfront);
    const aw = vs.filter((v) => v.part === PART.awning);
    expect(aw.length).toBeGreaterThan(0);
    const line = b.y + 0.6 + 1.4 * 3.2 + AWNING.attach;
    const f = { x: Math.sin((b.headingDeg * Math.PI) / 180), z: -Math.cos((b.headingDeg * Math.PI) / 180) };
    for (const v of aw) {
      expect(v.on).toBe(true);
      expect(v.y).toBeLessThanOrEqual(line + 1e-3);
      expect(v.y).toBeGreaterThanOrEqual(line - AWNING.drop - AWNING.valance - 1e-3);
      const ahead = (v.x - b.x) * f.x + (v.z - b.z) * f.z; // along the front vector
      expect(ahead).toBeGreaterThanOrEqual(b.depth / 2 - 1e-3);
      expect(ahead).toBeLessThanOrEqual(b.depth / 2 + AWNING.out + 1e-3);
    }
    // without the flag it collapses
    const off = evalAll(ARCH_GEOMETRIES.flat, (() => {
      const inst = new Float32Array(INST_STRIDE);
      writeInstance(inst, 0, { b, chunk: 0 }, 0);
      return inst;
    })());
    for (const v of off) if (v.part === PART.awning) expect(v.on).toBe(false);
  });
  it('a tree: a lumpy crown on a trunk, round in plan, under the physics cap', () => {
    const t = mk({ archetype: 'silo', use: 'tree', width: 8, depth: 8, wallHeight: 2.6, roofHeight: 8, style: 13, rand: 0.61 });
    const vs = checkBuilding(t);
    const trunk = vs.filter((v) => v.part === PART.trunk);
    expect(trunk.length).toBeGreaterThan(0);
    for (const v of trunk) {
      expect(v.on).toBe(true);
      expect(Math.hypot(v.x - t.x, v.z - t.z)).toBeLessThan(0.3);
    }
    const crown = vs.filter((v) => v.part === PART.main);
    const top = Math.max(...crown.map((v) => v.y));
    const low = Math.min(...crown.map((v) => v.y));
    expect(top).toBeCloseTo(t.y + t.wallHeight + t.roofHeight, 3);
    expect(low).toBeCloseTo(t.y + t.wallHeight, 3);
    // lumpy: the widest ring is not a circle
    const ring = crown.filter((v) => Math.abs(v.y - (t.y + t.wallHeight + TREE_EQ * t.roofHeight)) < 1e-3).map((v) => Math.hypot(v.x - t.x, v.z - t.z));
    expect(Math.max(...ring) - Math.min(...ring)).toBeGreaterThan(0.3);
    // a silo (no tree flag) has no trunk
    const s = checkBuilding(mk({ archetype: 'silo', use: 'silo', width: 6, depth: 6, wallHeight: 16, roofHeight: 2.3, style: 6 }));
    for (const v of s) if (v.part === PART.trunk) expect(v.on).toBe(false);
  });
  it('parts switched off collapse to a point (no triangles drawn)', () => {
    const b = mk({ roofHeight: 4.2 });
    const inst = new Float32Array(INST_STRIDE);
    writeInstance(inst, 0, { b, chunk: 0 }, 0);
    const vs = evalAll(ARCH_GEOMETRIES.gable, inst);
    const chim = vs.filter((v) => v.part === PART.chimney);
    expect(chim.length).toBeGreaterThan(0);
    for (const v of chim) expect(v.on).toBe(false);
  });
  it('dormers are only enabled on roofs tall enough to hold them', () => {
    const low = mk({ roofHeight: 2.2, rand: 0.01 });
    const high = mk({ roofHeight: 4.5, rand: 0.01 });
    expect(instanceFlags(low) & FLAG.dormers).toBe(0);
    let any = false;
    for (let i = 0; i < 40; i++) any ||= (instanceFlags({ ...high, rand: i / 40 }) & FLAG.dormers) !== 0;
    expect(any).toBe(true);
  });
});

describe('archetype geometries (fuzz)', () => {
  it('any tree: inside its circle, crown under the physics cap, trunk inside the crown, outward-wound', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 3, max: 13, noNaN: true }),
        fc.double({ min: 0.5, max: 4, noNaN: true }),
        fc.double({ min: 2, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        (w, trunk, crown, h, rand) => {
          checkBuilding(mk({ archetype: 'silo', use: 'tree', width: w, depth: w, wallHeight: trunk, roofHeight: crown, headingDeg: h, rand, style: 13 }));
        },
      ),
      { numRuns: 150 },
    );
  });
  it('any shop with an awning: the canvas stays over the pavement in front, below the wall top', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Building['archetype']>('flat', 'gable'),
        fc.double({ min: 4, max: 30, noNaN: true }),
        fc.double({ min: 6, max: 30, noNaN: true }),
        fc.double({ min: 2.8, max: 4, noNaN: true }),
        fc.integer({ min: 2, max: 4 }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 0.3, max: 3, noNaN: true }),
        (a, w, d, fh, floors, h, plinth) => {
          const roof = a === 'flat' ? 1 : Math.min(0.8 * d, (d / 2) * Math.tan((35 * Math.PI) / 180));
          checkBuilding(mk({ archetype: a, use: 'shop', width: w, depth: d, floorHeight: fh, wallHeight: floors * fh + 0.6 + plinth, roofHeight: roof, headingDeg: h, plinth, style: 7 }), FLAG.awning | FLAG.shopfront);
        },
      ),
      { numRuns: 120 },
    );
  });
  it('any pitched/flat/silo building: inside its footprint, roof = roofTopAt, outward-wound', () => {
    const arch = fc.constantFrom<Building['archetype']>('gable', 'hip', 'flat', 'gambrel', 'silo');
    fc.assert(
      fc.property(
        arch,
        fc.double({ min: 4, max: 40, noNaN: true }),
        fc.double({ min: 4, max: 40, noNaN: true }),
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: 2.5, max: 90, noNaN: true }),
        fc.double({ min: 0.3, max: 12, noNaN: true }),
        fc.integer({ min: 0, max: 1 }),
        fc.double({ min: 0, max: 0.999, noNaN: true }),
        fc.integer({ min: 0, max: 0xffff }),
        (a, w, d, h, wall, roof, axis, rand, flags) => {
          let width = w;
          let depth = a === 'silo' ? w : d;
          // pitched roofs as the placement makes them: hips run along the longer side with equal pitch
          let ridge = 1;
          let ridgeAxis = axis as 0 | 1;
          if (a === 'hip') {
            ridgeAxis = w >= d ? 0 : 1;
            const along = Math.max(w, d);
            ridge = Math.max(0, (along - Math.min(w, d)) / along);
          }
          if (a === 'silo') ridge = axis;
          // realistic pitches (≤ ~58°), as the placement builds them
          const span = a === 'silo' || a === 'flat' ? Infinity : ridgeAxis === 1 ? width : depth;
          roof = Math.min(roof, 0.8 * span);
          if (a === 'flat') roof = Math.min(roof, 2.5);
          const b = mk({ archetype: a, width, depth, headingDeg: h, wallHeight: wall, roofHeight: roof, ridge, ridgeAxis, rand, plinth: 0.3 });
          // only the flags the instance builder would allow for this building's geometry
          checkBuilding(b, flags & instanceFlags(b, true));
        },
      ),
      { numRuns: 300 },
    );
  });
});
