import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import fc from 'fast-check';
import { MeshBuilder, mat } from '../../../src/world/traffic/models/builder';
import { buildVesselPart, buildHull, hullShape, type VesselPart } from '../../../src/world/traffic/models/vessels';
import { buildAircraft, DISCS, LIGHTS } from '../../../src/world/traffic/models/aircraft';
import { buildMarina, buildFerryTerminal } from '../../../src/world/traffic/models/marina';
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
  it('marina and ferry terminals build within budget', () => {
    const m = createMarina(getLayout());
    const g = buildMarina(m, 0).build();
    expect(finite(g)).toBe(true);
    expect(g.index!.count / 3).toBeLessThan(60000);
    const bb = g.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeGreaterThan(700);
    expect(bb.min.y).toBeLessThan(-3); // founded below the water
    const t = buildFerryTerminal(150).build();
    expect(finite(t)).toBe(true);
    expect(t.index!.count / 3).toBeLessThan(12000);
  });
});
