import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import fc from 'fast-check';
import { MeshBuilder, mat } from '../../../src/world/traffic/models/builder';
import { buildVesselPart, buildHull, hullShape, type VesselPart } from '../../../src/world/traffic/models/vessels';
import { buildAircraft, DISCS, LIGHTS } from '../../../src/world/traffic/models/aircraft';
import { buildMarina, buildFerryTerminal, marinaStones, HARBOUR_WORKS } from '../../../src/world/traffic/models/marina';
import { createMarina, VESSEL_DIMS, type VesselKind } from '../../../src/world/traffic/sea';
import { getLayout } from '../../../src/world/layout';
import type { AirKind } from '../../../src/world/traffic/air';

/** Fraction of triangles whose winding agrees with their (averaged) vertex normals. */
function windingAgreement(g: THREE.BufferGeometry): number {
  const p = g.attributes.position.array as Float32Array;
  const n = g.attributes.normal.array as Float32Array;
  const idx = g.index!.array;
  let ok = 0;
  let total = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    const [i0, i1, i2] = [idx[t], idx[t + 1], idx[t + 2]];
    a.fromArray(p, i0 * 3);
    b.fromArray(p, i1 * 3).sub(a);
    c.fromArray(p, i2 * 3).sub(a);
    const gn = b.cross(c);
    if (gn.lengthSq() < 1e-10) continue;
    const vn = new THREE.Vector3(n[i0 * 3] + n[i1 * 3] + n[i2 * 3], n[i0 * 3 + 1] + n[i1 * 3 + 1] + n[i2 * 3 + 1], n[i0 * 3 + 2] + n[i1 * 3 + 2] + n[i2 * 3 + 2]);
    total++;
    if (gn.dot(vn) > 0) ok++;
  }
  return ok / Math.max(1, total);
}

function finite(g: THREE.BufferGeometry): boolean {
  for (const name of ['position', 'normal', 'color', 'aPbr']) for (const v of g.attributes[name].array as Float32Array) if (!Number.isFinite(v)) return false;
  return true;
}

describe('mesh builder', () => {
  it('boxes, prisms, cylinders and lofts face outward', () => {
    const b = new MeshBuilder();
    const m = mat(0xffffff, 0.5);
    b.box(0, 0, 0, 1, 2, 3, m);
    b.prism(5, 0, 0, 2, 3, 3, 2, 2, m, 0.3);
    b.cylinder([10, 0, 0], [10, 3, 1], 1, 0.5, 12, m);
    const g = b.build();
    expect(windingAgreement(g)).toBe(1);
    expect(finite(g)).toBe(true);
  });

  it('fuzz: transformed boxes keep outward winding (including mirrored transforms)', () => {
    fc.assert(
      fc.property(fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: 0.1, max: 20, noNaN: true }), (ry, rx, s) => {
        const b = new MeshBuilder();
        b.with([1, 2, 3], [rx, ry, 0], () => b.box(0, 0, 0, s, s * 0.5, s * 2, mat(0xffffff, 0.5)), [s, s, s]);
        const g = b.build();
        expect(windingAgreement(g)).toBe(1);
      }),
      { numRuns: 60 },
    );
  });
});

describe('vessel models', () => {
  const parts: [VesselKind, VesselPart][] = [
    ['sail', 'hull'], ['sail', 'mainP'], ['sail', 'mainS'], ['sail', 'jibP'], ['sail', 'jibS'], ['sail', 'furled'],
    ['motor', 'hull'], ['fish', 'hull'], ['launch', 'hull'], ['ferry', 'hull'], ['container', 'hull'], ['tanker', 'hull'],
  ];

  it('every part/LOD builds finite geometry with outward winding and sensible budgets', () => {
    for (const [kind, part] of parts)
      for (const lod of [0, 1]) {
        const g = buildVesselPart(kind, part, lod).build();
        expect(finite(g), `${kind}/${part}/${lod}`).toBe(true);
        const tris = g.index!.count / 3;
        const budget = kind === 'container' ? (lod ? 12000 : 40000) : kind === 'tanker' || kind === 'ferry' ? (lod ? 3000 : 8000) : lod ? 900 : 3500;
        expect(tris, `${kind}/${part}/${lod} triangles`).toBeLessThan(budget);
        expect(tris).toBeGreaterThan(8);
        // hulls: closed-ish outward surfaces; sails are double-sided by design
        if (part === 'hull') expect(windingAgreement(g), `${kind} winding`).toBeGreaterThan(0.97);
        g.dispose();
      }
  });

  it('hulls have realistic proportions, sit on the waterline and LOD1 is much lighter', () => {
    for (const kind of ['sail', 'motor', 'fish', 'launch', 'ferry', 'container', 'tanker'] as VesselKind[]) {
      const g0 = buildVesselPart(kind, 'hull', 0).build();
      const g1 = buildVesselPart(kind, 'hull', 1).build();
      const bb = g0.boundingBox!;
      const d = VESSEL_DIMS[kind];
      const len = bb.max.z - bb.min.z;
      const beam = bb.max.x - bb.min.x;
      expect(len, kind).toBeGreaterThan(d.length * 0.95);
      expect(len, kind).toBeLessThan(d.length * 1.12);
      expect(beam, kind).toBeGreaterThan(d.beam * 0.85);
      expect(bb.min.y, kind).toBeLessThan(0); // hull below the waterline
      expect(bb.max.y, kind).toBeGreaterThan(d.freeboard);
      if (kind !== 'sail') expect(g1.index!.count, kind).toBeLessThan(g0.index!.count * 0.7);
      g0.dispose();
      g1.dispose();
    }
    // sailing yacht mast ~1.35 × LOA above the water
    const sb = buildVesselPart('sail', 'hull', 0).build().boundingBox!;
    expect(sb.max.y).toBeGreaterThan(15);
    expect(sb.max.y).toBeLessThan(18);
  });

  it('fuzz: the hull shape is well-formed along the whole length', () => {
    const spec = { L: 12, B: 4, F: 1, D: 0.6, sheer: 0.2, transom: 0.8, transomDepth: 0.1, entry: 1.7, n: 2.3, rake: 0.7 } as Parameters<typeof hullShape>[0];
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.boolean(), (u, sym) => {
        const s = hullShape({ ...spec, symmetric: sym }, u);
        expect(s.halfB).toBeGreaterThanOrEqual(0);
        expect(s.halfB).toBeLessThanOrEqual(spec.B / 2 + 1e-9);
        expect(s.deckY).toBeGreaterThan(0);
        expect(s.keel).toBeLessThan(0);
        expect(s.keel).toBeGreaterThanOrEqual(-spec.D - 1e-9);
      }),
      { numRuns: 300 },
    );
    const b = new MeshBuilder();
    buildHull(b, { ...spec, topside: mat(0xffffff, 0.3), boot: mat(0, 0.3), bottom: mat(0x800000, 0.8), deck: mat(0xcccccc, 0.8), rub: mat(0x888888, 0.3), bootTop: 0.1 });
    expect(windingAgreement(b.build())).toBeGreaterThan(0.97);
  });

  it('sail variants belly to leeward and carry flutter weights only on the cloth', () => {
    const p = buildVesselPart('sail', 'mainP', 0).build();
    const s = buildVesselPart('sail', 'mainS', 0).build();
    const meanX = (g: THREE.BufferGeometry) => {
      const a = g.attributes.position.array as Float32Array;
      const w = g.attributes.aPbr.array as Float32Array;
      let sx = 0;
      let n = 0;
      for (let i = 0; i < a.length / 3; i++) if (w[i * 4 + 3] > 0.2) (sx += a[i * 3]), n++;
      return sx / n;
    };
    expect(meanX(p)).toBeLessThan(-0.05); // port tack → belly to port (−x)
    expect(meanX(s)).toBeGreaterThan(0.05);
    // the mast lies at the sail-frame origin
    const bb = p.boundingBox!;
    expect(bb.min.z).toBeGreaterThan(-0.3);
    expect(bb.max.z).toBeLessThan(5.5);
  });
});

describe('aircraft models', () => {
  it('every kind/LOD builds finite, outward geometry at the right size', () => {
    const size: Record<AirKind, { span: [number, number]; len: [number, number] }> = {
      c172: { span: [10.5, 11.6], len: [7.8, 8.8] },
      pa28: { span: [10.2, 11.2], len: [7.3, 8.4] },
      heli: { span: [1.8, 3.2], len: [9.5, 10.8] },
      a320: { span: [33, 37], len: [36.5, 38.5] },
    };
    for (const kind of ['c172', 'pa28', 'heli', 'a320'] as AirKind[])
      for (const lod of [0, 1]) {
        const g = buildAircraft(kind, lod).build();
        expect(finite(g)).toBe(true);
        expect(windingAgreement(g), `${kind}/${lod}`).toBeGreaterThan(0.93);
        const bb = g.boundingBox!;
        const span = bb.max.x - bb.min.x;
        const len = bb.max.z - bb.min.z;
        expect(span, `${kind} span`).toBeGreaterThan(size[kind].span[0]);
        expect(span, `${kind} span`).toBeLessThan(size[kind].span[1]);
        expect(len, `${kind} length`).toBeGreaterThan(size[kind].len[0]);
        expect(len, `${kind} length`).toBeLessThan(size[kind].len[1]);
        expect(g.index!.count / 3).toBeLessThan(lod ? 1500 : 5000);
        g.dispose();
      }
  });

  it('lights and discs sit on the airframe', () => {
    for (const kind of ['c172', 'pa28', 'heli', 'a320'] as AirKind[]) {
      const bb = buildAircraft(kind, 0).build().boundingBox!.expandByScalar(0.6);
      for (const p of Object.values(LIGHTS[kind])) expect(bb.containsPoint(new THREE.Vector3(p[0], p[1], p[2])), kind).toBe(true);
      for (const d of DISCS[kind]) expect(bb.containsPoint(new THREE.Vector3(...d.c)), kind).toBe(true);
    }
  });
});

describe('harbour structures', () => {
  it('breakwaters are rubble mounds: armour stones on both slopes, a parapet on the seaward side (near LOD only)', () => {
    const m = createMarina(getLayout());
    const near = buildMarina(m, 0);
    const far = buildMarina(m, 1);
    const stones = marinaStones(m);
    // ~one stone every 1.6 m of breakwater per row, several rows, both sides
    const len = m.breakwaters.reduce((s, b) => s + b.pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.u - b.pts[i].u, p.w - b.pts[i].w), 0), 0);
    expect(stones.length).toBeGreaterThan(len * 2);
    const inner = stones.filter((st) => !st.seaward).length;
    expect(inner).toBeGreaterThan(stones.length * 0.3);
    expect(inner).toBeLessThan(stones.length * 0.7);
    for (const st of stones) {
      expect(st.size).toBeGreaterThan(0.8);
      expect(st.size).toBeLessThan(3.2);
      expect(st.y).toBeGreaterThan(-2.6);
      expect(st.y).toBeLessThan(m.breakwaters[0].crestY + 0.5);
    }
    expect(near.triangleCount).toBeGreaterThan(far.triangleCount * 4);
    expect(near.triangleCount).toBeLessThan(110000);
    expect(far.triangleCount).toBeLessThan(6000);
  });


  it('marina and ferry terminals build within budget', () => {
    const m = createMarina(getLayout());
    const g = buildMarina(m, 0).build();
    expect(finite(g)).toBe(true);
    expect(g.index!.count / 3).toBeLessThan(110000);
    const bb = g.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeGreaterThan(700);
    expect(bb.min.y).toBeLessThan(-3); // founded below the water
    const t = buildFerryTerminal(150).build();
    expect(finite(t)).toBe(true);
    expect(t.index!.count / 3).toBeLessThan(12000);
  });
});

describe('ship and harbour detail', () => {
  const verts = (g: THREE.BufferGeometry) => {
    const p = g.attributes.position.array as Float32Array;
    const a = g.attributes.aPbr.array as Float32Array;
    return Array.from({ length: p.length / 3 }, (_, i) => ({ x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2], rough: a[i * 4], metal: a[i * 4 + 1] }));
  };

  it('the container ship and the tanker have a bulbous bow ahead of the stem, below the waterline', () => {
    for (const kind of ['container', 'tanker'] as VesselKind[]) {
      const d = VESSEL_DIMS[kind];
      for (const lod of [0, 1]) {
        const v = verts(buildVesselPart(kind, 'hull', lod).build());
        const bulb = v.filter((q) => q.z < -d.length / 2 && q.y < -2);
        expect(bulb.length, `${kind}/${lod}`).toBeGreaterThan(5);
        // nothing of the bulb breaks the surface
        expect(Math.max(...bulb.map((q) => q.y))).toBeLessThan(0);
      }
    }
  });

  it('yachts carry guard rails along the deck edges; the tanker has deck pipework and cranes', () => {
    const sail = verts(buildVesselPart('sail', 'hull', 0).build());
    const railTops = sail.filter((q) => q.metal > 0.8 && q.y > 1.5 && q.y < 2.0 && Math.abs(q.x) > 1.2);
    expect(railTops.length).toBeGreaterThan(20);
    const tanker = verts(buildVesselPart('tanker', 'hull', 0).build());
    const F = VESSEL_DIMS.tanker.freeboard;
    // pipes (metal) run most of the deck length, cranes stand above them
    const pipes = tanker.filter((q) => q.metal > 0.4 && q.y > F && q.y < F + 2);
    const zs = pipes.map((q) => q.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(VESSEL_DIMS.tanker.length * 0.6);
    expect(tanker.some((q) => q.y > F + 14 && Math.abs(q.x) < 14 && q.z < 0)).toBe(true);
  });

  it('the harbour works (crane, container yard, boatyard) stand on the free east end of the quay, at both LODs', () => {
    const m = createMarina(getLayout());
    const q = m.quay;
    for (const lod of [0, 1]) {
      const v = verts(buildMarina(m, lod).build());
      // the crane: a tall structure over the works, its boom luffed up and slewed along the quay over the yard
      const high = v.filter((p) => p.y > q.top + 25);
      expect(high.length, `crane ${lod}`).toBeGreaterThan(8);
      for (const p of high) {
        expect(p.x).toBeGreaterThan(HARBOUR_WORKS.u0 - 5);
        expect(p.x).toBeLessThan(HARBOUR_WORKS.u1 + 20);
        expect(p.z).toBeGreaterThan(q.w0 - 5);
        expect(p.z).toBeLessThan(q.w1 + 5);
      }
      expect(Math.max(...high.map((p) => p.y))).toBeGreaterThan(q.top + 45);
      expect(HARBOUR_WORKS.crane.u - Math.min(...high.map((p) => p.x))).toBeGreaterThan(30);
      // everything 7–25 m up on the quay (stacked containers, the hoist, boats in its slings) lies inside the works
      // footprint (lower: quay lamps along the whole quay, the breakwater roots)
      const mid = v.filter((p) => p.y > q.top + 7.2 && p.y < q.top + 25 && p.z < q.w1 && p.z > q.w0);
      expect(mid.length).toBeGreaterThan(50);
      for (const p of mid) {
        expect(p.x).toBeGreaterThan(HARBOUR_WORKS.u0 - 1);
        expect(p.x).toBeLessThan(HARBOUR_WORKS.u1 + 1);
      }
    }
    // clear of the last pontoon's berths (u = 185 + fingers + boats)
    expect(HARBOUR_WORKS.u0).toBeGreaterThan(Math.max(...m.pontoons.map((p) => p.u)) + 30);
    expect(HARBOUR_WORKS.u1).toBeLessThan(q.u1);
  });

  it('fuzz: every vessel kind and variant builds finite, outward geometry within budget', () => {
    const kinds: VesselKind[] = ['sail', 'motor', 'fish', 'launch', 'ferry', 'container', 'tanker'];
    fc.assert(
      fc.property(fc.constantFrom(...kinds), fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 1 }), fc.boolean(), (kind, variant, lod, moored) => {
        const g = buildVesselPart(kind, 'hull', lod, { variant, moored, deployed: moored }).build();
        expect(finite(g)).toBe(true);
        expect(windingAgreement(g)).toBeGreaterThan(0.97);
        const tris = g.index!.count / 3;
        expect(tris).toBeLessThan(kind === 'container' ? (lod ? 12000 : 40000) : kind === 'tanker' || kind === 'ferry' ? (lod ? 3000 : 8000) : lod ? 900 : 3500);
        const bb = g.boundingBox!;
        const d = VESSEL_DIMS[kind];
        expect(bb.max.z - bb.min.z).toBeLessThan(d.length * 1.12);
        // (a trawler's outrigger booms reach far out when fishing)
        expect(bb.max.x - bb.min.x).toBeLessThan(kind === 'fish' ? 22 : d.beam * 1.25 + 2);
        g.dispose();
      }),
      { numRuns: 30 },
    );
  }, 60000);
});
