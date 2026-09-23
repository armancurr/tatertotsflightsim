import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import fc from 'fast-check';
import { buildVehicleGeometry, buildBodyGeometry, carBodyProfile, LAMP } from '../../../src/world/cars/vehicles';
import { SPECS, SEMI, MODEL_COUNT, MODEL_TRAILER, TRAILER_WHEELBASE, VT } from '../../../src/world/cars/specs';

const models = Array.from({ length: MODEL_COUNT }, (_, m) => m);
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('vehicle models', { timeout: 20000 }, () => {
  const near = models.map((m) => buildVehicleGeometry(m, 0));
  const far = models.map((m) => buildVehicleGeometry(m, 1));

  it('share one attribute layout (BatchedMesh) and are indexed', () => {
    for (const g of [...near, ...far]) {
      expect(Object.keys(g.attributes).sort()).toEqual(['aMat', 'aWheel', 'color', 'normal', 'position']);
      expect(g.index).not.toBeNull();
      const pos = g.getAttribute('position').array as Float32Array;
      expect(pos.every((v) => Number.isFinite(v))).toBe(true);
      const n = g.getAttribute('normal');
      let worst = 0;
      for (let i = 0; i < n.count; i++) worst = Math.max(worst, Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1));
      expect(worst).toBeLessThan(1e-3);
    }
  }, 20000);

  it('stay cheap: 400–2,000 triangles near (≤ 2,200 for the big trucks), ≤ 300 far', () => {
    near.forEach((g, m) => {
      expect(tris(g), `model ${m}`).toBeGreaterThanOrEqual(400);
      expect(tris(g), `model ${m}`).toBeLessThanOrEqual(m === VT.semi || m === VT.bus || m === VT.box ? 2200 : 2000);
    });
    far.forEach((g, m) => expect(tris(g), `model ${m}`).toBeLessThanOrEqual(300));
  });

  it('have the real dimensions (length, width, height)', () => {
    near.forEach((g, m) => {
      g.computeBoundingBox();
      const b = g.boundingBox!;
      const s = m === MODEL_TRAILER ? { length: SEMI.trailerRear - SEMI.trailerFront, width: SEMI.trailerWidth, height: SEMI.trailerHeight } : SPECS[m];
      const len = m === VT.semi ? 6.3 : s.length;
      expect(b.max.z - b.min.z, `length ${m}`).toBeGreaterThan(len * 0.95);
      expect(b.max.z - b.min.z, `length ${m}`).toBeLessThan(len * 1.05);
      expect(b.max.x - b.min.x, `width ${m}`).toBeGreaterThan(s.width * 0.93);
      expect(b.max.x - b.min.x, `width ${m}`).toBeLessThan(s.width + 0.35);
      expect(b.max.y, `height ${m}`).toBeGreaterThan(s.height * 0.93);
      expect(b.max.y, `height ${m}`).toBeLessThan(s.height * 1.06);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.02);
    });
  });

  it('stand on their wheels: hubs on the axles, tyres touching the ground', () => {
    near.forEach((g, m) => {
      const w = g.getAttribute('aWheel');
      const p = g.getAttribute('position');
      let minY = Infinity;
      let outside = 0;
      const hubZ = new Set<number>();
      let front = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.getW(i) === 0) continue;
        minY = Math.min(minY, p.getY(i));
        hubZ.add(Math.round(w.getZ(i) * 100) / 100);
        if (w.getW(i) < 0) front++;
        // every wheel vertex lies within its tyre radius of the hub
        const d = Math.hypot(p.getY(i) - w.getY(i), p.getZ(i) - w.getZ(i));
        if (d > Math.abs(w.getW(i)) + 1e-3) outside++;
      }
      expect(outside, `wheel vertices outside the tyre ${m}`).toBe(0);
      expect(minY, `model ${m}`).toBeLessThan(0.03);
      if (m === MODEL_TRAILER) {
        expect([...hubZ].every((z) => z > TRAILER_WHEELBASE / 2 - 1)).toBe(true);
        expect(front).toBe(0);
      } else {
        const wb = SPECS[m].wheelbase;
        expect([...hubZ].some((z) => Math.abs(z + wb / 2) < 0.02), `front axle ${m}`).toBe(true);
        expect(front).toBeGreaterThan(0);
      }
    });
  });

  it('have head lamps at the front, tail lamps (left and right) at the back, dark glass and paint', () => {
    near.forEach((g, m) => {
      const a = g.getAttribute('aMat');
      const p = g.getAttribute('position');
      const c = g.getAttribute('color');
      let head = 0;
      let tailL = 0;
      let tailR = 0;
      let paint = 0;
      let glass = 0;
      for (let i = 0; i < a.count; i++) {
        const lamp = a.getW(i);
        if (lamp === LAMP.head) {
          head++;
          expect(p.getZ(i)).toBeLessThan(0);
        }
        if (lamp === LAMP.tailL) {
          tailL++;
          expect(p.getZ(i)).toBeGreaterThan(0);
          expect(p.getX(i)).toBeLessThan(0);
        }
        if (lamp === LAMP.tailR) {
          tailR++;
          expect(p.getX(i)).toBeGreaterThan(0);
        }
        if (a.getX(i) > 0.5) paint++;
        if (a.getY(i) < 0.1 && a.getX(i) < 0.5 && c.getX(i) < 0.02 && lamp === 0) glass++;
      }
      if (m !== MODEL_TRAILER) expect(head, `head ${m}`).toBeGreaterThan(0);
      if (m !== VT.semi) {
        expect(tailL, `tail ${m}`).toBeGreaterThan(0);
        expect(tailR, `tail ${m}`).toBeGreaterThan(0);
      }
      expect(paint, `paint ${m}`).toBeGreaterThan(12);
      if (m !== MODEL_TRAILER) expect(glass, `glass ${m}`).toBeGreaterThan(8);
    });
  });
});

/** Fraction of triangles whose winding agrees with their (averaged) vertex normals. */
function windingAgreement(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  const idx = g.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let ok = 0;
  let total = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t);
    const i1 = idx.getX(t + 1);
    const i2 = idx.getX(t + 2);
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1).sub(a);
    c.fromBufferAttribute(p, i2).sub(a);
    const gn = b.cross(c);
    if (gn.lengthSq() < 1e-12) continue;
    const vx = n.getX(i0) + n.getX(i1) + n.getX(i2);
    const vy = n.getY(i0) + n.getY(i1) + n.getY(i2);
    const vz = n.getZ(i0) + n.getZ(i1) + n.getZ(i2);
    total++;
    if (gn.x * vx + gn.y * vy + gn.z * vz > 0) ok++;
  }
  return ok / Math.max(1, total);
}

describe('sculpted bodies', { timeout: 30000 }, () => {
  it('every near model faces outward (winding agrees with the shading normals)', () => {
    for (const m of models) expect(windingAgreement(buildVehicleGeometry(m, 0)), `model ${m}`).toBeGreaterThan(0.985);
  });

  it('cars have glass above the belt (windows, windscreen), black pillars/seals and a painted roof on top', () => {
    for (const m of [VT.sedan, VT.hatch, VT.suv, VT.pickup, VT.van]) {
      const g = buildVehicleGeometry(m, 0);
      const P = carBodyProfile(m);
      const a = g.getAttribute('aMat');
      const p = g.getAttribute('position');
      const c = g.getAttribute('color');
      let glassHigh = 0;
      let gloss = 0;
      let roofPaint = 0;
      const roofY = Math.max(...P.roof.map((k) => k[1]));
      for (let i = 0; i < a.count; i++) {
        const isGlass = a.getX(i) < 0.5 && a.getY(i) < 0.1 && c.getX(i) < 0.02 && a.getW(i) === 0;
        if (isGlass && p.getY(i) > 0.85) glassHigh++;
        if (a.getX(i) < 0.5 && a.getY(i) > 0.15 && a.getY(i) < 0.3 && c.getX(i) < 0.01) gloss++;
        if (a.getX(i) > 0.5 && p.getY(i) > roofY - 0.02 && Math.abs(p.getX(i)) < 0.3) roofPaint++;
      }
      expect(glassHigh, `glass ${m}`).toBeGreaterThan(40);
      expect(gloss, `black trim ${m}`).toBeGreaterThan(8);
      expect(roofPaint, `roof ${m}`).toBeGreaterThan(4);
    }
  });

  it('the pick-up bed is a recessed tub with a dark liner', () => {
    const g = buildVehicleGeometry(VT.pickup, 0);
    const P = carBodyProfile(VT.pickup);
    const zOff = SPECS[VT.pickup].frontOverhang + SPECS[VT.pickup].wheelbase / 2;
    const a = g.getAttribute('aMat');
    const p = g.getAttribute('position');
    let floor = 0;
    for (let i = 0; i < a.count; i++) {
      const zf = p.getZ(i) + zOff;
      if (zf > P.bed![0] + 0.2 && zf < P.bed![1] - 0.2 && Math.abs(p.getX(i)) < 0.5 && a.getX(i) < 0.5 && Math.abs(p.getY(i) - P.bed![2]) < 0.02) floor++;
    }
    expect(floor).toBeGreaterThan(4);
  });

  it('fuzz: any plausible car profile builds a finite, outward, in-bounds body', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4 }),
        fc.double({ min: 0.85, max: 1.2, noNaN: true }),
        fc.double({ min: 0.9, max: 1.12, noNaN: true }),
        fc.double({ min: 0.9, max: 1.1, noNaN: true }),
        fc.integer({ min: 0, max: 1 }),
        (t, sl, sw, sh, detail) => {
          const P0 = carBodyProfile(t);
          const k = (keys: [number, number][], fy = sh) => keys.map(([z, y]) => [z * sl, y * fy] as [number, number]);
          const P = {
            ...P0,
            L: P0.L * sl,
            W: P0.W * sw,
            wb: P0.wb * sl,
            fo: P0.fo * sl,
            belt: k(P0.belt),
            roof: k(P0.roof),
            gh: [P0.gh[0] * sl, P0.gh[1] * sl] as [number, number],
            windows: P0.windows.map(([a, b]) => [a * sl, b * sl] as [number, number]),
            ws: P0.ws * sl,
            bl: P0.bl * sl,
            bed: P0.bed ? ([P0.bed[0] * sl, P0.bed[1] * sl, P0.bed[2] * sh] as [number, number, number]) : undefined,
            doors: P0.doors?.map((z) => z * sl),
          };
          const { geometry: g } = buildBodyGeometry(P, detail);
          const pos = g.getAttribute('position');
          const nrm = g.getAttribute('normal');
          let bad = 0;
          for (let i = 0; i < pos.count; i++) {
            if (!Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))) bad++;
            if (Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1) > 1e-3) bad++;
          }
          expect(bad).toBe(0);
          g.computeBoundingBox();
          const bb = g.boundingBox!;
          expect(bb.min.y).toBeGreaterThanOrEqual(-0.02);
          expect(bb.max.z - bb.min.z).toBeLessThan(P.L * 1.05);
          expect(bb.max.x - bb.min.x).toBeLessThan(P.W + 0.4);
          expect(windingAgreement(g)).toBeGreaterThan(0.97);
          expect(g.index!.count / 3).toBeLessThan(detail ? 300 : 2100);
        },
      ),
      { numRuns: 40 },
    );
  }, 30000);
});

describe('far level of detail (one instanced parametric car)', () => {
  it('has each model\'s real length, width and height', async () => {
    const { FAR_SHAPES } = await import('../../../src/world/cars/farcar');
    FAR_SHAPES.forEach((f, m) => {
      if (m === MODEL_TRAILER) {
        expect(f.L).toBeCloseTo(SEMI.trailerRear - SEMI.trailerFront, 3);
        expect(f.belt).toBeCloseTo(SEMI.trailerHeight, 3);
        return;
      }
      const s = SPECS[m];
      expect(f.L).toBeCloseTo(m === VT.semi ? 6.3 : s.length, 3);
      expect(f.W).toBeCloseTo(s.width, 3);
      expect(Math.max(f.roof, f.bTop, f.belt)).toBeGreaterThan(s.height * 0.95);
      expect(Math.max(f.roof, f.bTop, f.belt)).toBeLessThan(s.height * 1.05);
      expect(f.a0).toBeLessThanOrEqual(f.a1);
      expect(f.b0).toBeLessThanOrEqual(f.b1);
    });
  });
  it('is one small template (≤ 60 triangles) with the attributes its shader reads', async () => {
    const { farTemplate } = await import('../../../src/world/cars/farcar');
    const g = farTemplate();
    expect(g.index!.count / 3).toBeLessThanOrEqual(60);
    for (const a of ['aT', 'aK', 'normal', 'position']) expect(g.getAttribute(a)).toBeDefined();
    expect(g.getAttribute('aT').count).toBe(g.getAttribute('position').count);
  });
});
