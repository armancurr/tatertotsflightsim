import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildVehicleGeometry, LAMP } from '../../../src/world/cars/vehicles';
import { SPECS, SEMI, MODEL_COUNT, MODEL_TRAILER, TRAILER_WHEELBASE, VT } from '../../../src/world/cars/specs';

const models = Array.from({ length: MODEL_COUNT }, (_, m) => m);
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

describe('vehicle models', () => {
  const near = models.map((m) => buildVehicleGeometry(m, 0));
  const far = models.map((m) => buildVehicleGeometry(m, 1));

  it('share one attribute layout (BatchedMesh) and are indexed', () => {
    for (const g of [...near, ...far]) {
      expect(Object.keys(g.attributes).sort()).toEqual(['aMat', 'aWheel', 'color', 'normal', 'position']);
      expect(g.index).not.toBeNull();
      const pos = g.getAttribute('position').array as Float32Array;
      for (const v of pos) expect(Number.isFinite(v)).toBe(true);
      const n = g.getAttribute('normal');
      for (let i = 0; i < n.count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 3);
    }
  });

  it('are realistic low-poly: 400–1,500 triangles near, ≤ 300 far', () => {
    near.forEach((g, m) => {
      expect(tris(g), `model ${m}`).toBeGreaterThanOrEqual(400);
      expect(tris(g), `model ${m}`).toBeLessThanOrEqual(1500);
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
      const hubZ = new Set<number>();
      let front = 0;
      for (let i = 0; i < w.count; i++) {
        if (w.getW(i) === 0) continue;
        minY = Math.min(minY, p.getY(i));
        hubZ.add(Math.round(w.getZ(i) * 100) / 100);
        if (w.getW(i) < 0) front++;
        // every wheel vertex lies within its tyre radius of the hub
        const d = Math.hypot(p.getY(i) - w.getY(i), p.getZ(i) - w.getZ(i));
        expect(d).toBeLessThanOrEqual(Math.abs(w.getW(i)) + 1e-3);
      }
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
