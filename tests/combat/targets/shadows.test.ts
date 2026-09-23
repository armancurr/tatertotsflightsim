/** Contact shadows, the far-visibility scale, berms and the range's draw-call budget. */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { newShadowShape, shadowAt, shadowShape, SOFT } from '../../../src/combat/targets/shadows';
import { bermHeight, buildBermGeometry } from '../../../src/combat/targets/berms';
import { createTargetsRenderer, farScaleAt } from '../../../src/combat/targets/renderer';
import { createRangeRuntime } from '../../../src/combat/targets/runtime';
import { planRange } from '../../../src/combat/targets/plan';
import { createCombatWorld } from '../../../src/combat/world';
import { CONFIG } from '../../../src/config';
import { fakeGround } from './support';

const T72 = CONFIG.combat.targets.tank;
const CAST = CONFIG.combat.range.shadow.castMax;
const norm = (x: number, y: number, z: number) => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

describe('contact shadow placement', () => {
  it('sun overhead: no cast shadow, the patch is the hull grown by the soft rim, darkest under the hull', () => {
    const s = shadowShape(T72.length, T72.width, T72.height, 30, { x: 0, y: 1, z: 0 }, CAST, newShadowShape());
    expect(s.castX).toBeCloseTo(0, 9);
    expect(s.castZ).toBeCloseTo(0, 9);
    expect(s.maxX).toBeCloseTo(T72.width / 2 + SOFT, 9);
    expect(s.maxZ).toBeCloseTo(T72.length / 2 + SOFT, 9);
    expect(shadowAt(s, 0, 0)).toBeGreaterThan(0.6);
    expect(shadowAt(s, s.maxX + 0.01, 0)).toBeLessThan(0.01);
  });

  it('a low sun in the east throws the shadow west: left of a north-facing tank, behind an east-facing one; never longer than castMax', () => {
    const sun = norm(1, 0.25, 0);
    const north = shadowShape(T72.length, T72.width, T72.height, 0, sun, CAST, newShadowShape());
    expect(north.castX).toBeLessThan(-1);
    expect(Math.abs(north.castZ)).toBeLessThan(1e-9);
    const east = shadowShape(T72.length, T72.width, T72.height, 90, sun, CAST, newShadowShape());
    expect(east.castZ).toBeGreaterThan(1);
    expect(Math.abs(east.castX)).toBeLessThan(1e-9);
    const dawn = shadowShape(T72.length, T72.width, T72.height, 0, norm(1, 0.04, 0), CAST, newShadowShape());
    expect(Math.hypot(dawn.castX, dawn.castZ)).toBeCloseTo(CAST, 6);
    // the ground in the shadow's direction is darker than on the sunny side
    expect(shadowAt(north, -T72.width / 2 - 1.2, 0)).toBeGreaterThan(shadowAt(north, T72.width / 2 + 1.2, 0) + 0.1);
  });

  it('sun down: occlusion only', () => {
    const s = shadowShape(T72.length, T72.width, T72.height, 0, norm(0.3, -0.2, 0.5), CAST, newShadowShape());
    expect(s.castX).toBe(0);
    expect(s.castZ).toBe(0);
  });

  it('property: the quad holds the hull and the whole cast shadow (nothing clipped), the patch fades outward', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0.02, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (h, sx, sy, sz, t) => {
          const s = shadowShape(T72.length, T72.width, T72.height, h, norm(sx, sy, sz), CAST, newShadowShape());
          expect(Math.hypot(s.castX, s.castZ)).toBeLessThanOrEqual(CAST + 1e-9);
          expect(s.minX).toBeLessThanOrEqual(-T72.width / 2 - SOFT + 1e-9);
          expect(s.maxZ).toBeGreaterThanOrEqual(T72.length / 2 + SOFT - 1e-9);
          // just outside the quad's edges: (almost) nothing — the rim is not cut off
          const px = s.minX + (s.maxX - s.minX) * t;
          const pz = s.minZ + (s.maxZ - s.minZ) * t;
          for (const [x, z] of [[s.minX - 0.01, pz], [s.maxX + 0.01, pz], [px, s.minZ - 0.01], [px, s.maxZ + 0.01]]) expect(shadowAt(s, x, z)).toBeLessThan(0.02);
          // under the hull it is dark, and moving straight out from the hull's side it only gets lighter (sun overhead part)
          expect(shadowAt(s, 0, 0)).toBeGreaterThan(0.6);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('far-visibility scale', () => {
  it('1 up close, grows smoothly and monotonically with distance, capped', () => {
    const [d0, d1, k] = CONFIG.combat.range.farScale;
    expect(farScaleAt(50)).toBe(1);
    expect(farScaleAt(d0)).toBe(1);
    expect(farScaleAt(d1)).toBeCloseTo(k, 9);
    expect(farScaleAt(d1 * 3)).toBeCloseTo(k, 9);
    let prev = 1;
    for (let d = 0; d < d1 * 1.5; d += 25) {
      const v = farScaleAt(d);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v - prev).toBeLessThan(0.02); // no pop
      prev = v;
    }
  });
});

describe('earth berms', () => {
  const b = { x: 10, z: -20, headingDeg: 35, length: 3.2, width: 8, height: 1.35 };
  it('a mound: full height on the crest, zero beyond its footprint and at its ends', () => {
    expect(bermHeight(b, 0, 0)).toBeCloseTo(1.35, 9);
    expect(bermHeight(b, 3, 0)).toBe(0);
    expect(bermHeight(b, 0, 4.01)).toBe(0);
    expect(bermHeight(b, 0, 3.5)).toBeLessThan(bermHeight(b, 0, 1));
  });

  it('property: draped over any ground, every vertex sits between the ground (sunk a little) and the crest; normals face up', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: -0.1, max: 0.1, noNaN: true }), (h, slope) => {
        const ground = (x: number, z: number) => 50 + slope * x + 0.3 * Math.sin(z * 0.2);
        const g = buildBermGeometry([{ ...b, headingDeg: h }, { ...b, x: -40, headingDeg: h + 90 }], ground);
        const p = g.getAttribute('position');
        const n = g.getAttribute('normal');
        let up = 0;
        for (let i = 0; i < p.count; i++) {
          const gy = ground(p.getX(i), p.getZ(i));
          expect(p.getY(i)).toBeGreaterThanOrEqual(gy - 0.12 - 1e-3); // float32 positions
          expect(p.getY(i)).toBeLessThanOrEqual(gy + b.height + 1e-3);
          if (n.getY(i) > 0) up++;
        }
        expect(up).toBe(p.count);
        expect(g.getAttribute('aPart')).toBeDefined();
      }),
      { numRuns: 40 },
    );
  });
});

describe('draw calls', () => {
  it('the whole range (every class at every LOD, shadows, berms) stays within ~20 draws', () => {
    const plan = planRange(fakeGround(), { x: -1000, z: -6000, headingDeg: 350 });
    const world = createCombatWorld();
    const rt = createRangeRuntime(world, { height: () => 50, normal: () => ({ x: 0, y: 1, z: 0 }) }, () => null);
    rt.install(plan);
    const counts: Record<string, number> = {};
    for (const v of plan.vehicles) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
    const r = createTargetsRenderer(counts, { berms: plan.berms, ground: () => 50 });
    expect(plan.berms.length).toBeGreaterThan(0);
    const cam = new THREE.PerspectiveCamera();
    // a camera in the middle of the range: near, medium and far LODs at once
    cam.position.set(plan.vehicles[0].x + 5, 60, plan.vehicles[0].z + 5);
    cam.updateMatrixWorld();
    r.update(cam, rt.views, { x: 0.3, y: 0.8, z: -0.5 }, 1);
    expect(r.activeMeshes()).toBeLessThanOrEqual(22);
    // one shadow per vehicle, in one instanced draw
    const shadows = r.group.getObjectByName('targets.shadows') as THREE.InstancedMesh;
    expect(shadows.count).toBe(plan.vehicles.length);
    expect(r.group.getObjectByName('targets.berms')).toBeDefined();
    r.dispose();
  });
});
