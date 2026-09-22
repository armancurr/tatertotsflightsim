/**
 * Unit + fuzz tests for the airport renderer's geometry builders and its
 * PAPI / obstacle behaviour (node, no WebGL).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createAirport } from '../../../src/world/airport';
import { buildAircraftGeometry } from '../../../src/world/airport/aircraft';
import { buildCarGeometry } from '../../../src/world/airport/vehicles';
import { fenceRuns } from '../../../src/world/airport/structures';
import { buildSigns } from '../../../src/world/airport/signs';
import { createAirportPlan } from '../../../src/world/airport/plan';
import { getLayout } from '../../../src/world/layout';

const bounds = (g: THREE.BufferGeometry) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};
const tris = (g: THREE.BufferGeometry) => g.index!.count / 3;

describe('parked aircraft geometry', () => {
  it('c172: 2–8k triangles, 11 m span, 8.3 m long, wheels on the ground', () => {
    const g = buildAircraftGeometry('c172');
    const b = bounds(g);
    expect(tris(g)).toBeGreaterThan(2000);
    expect(tris(g)).toBeLessThan(8000);
    expect(b.max.x - b.min.x).toBeGreaterThan(10.6);
    expect(b.max.x - b.min.x).toBeLessThan(11.2);
    expect(b.max.z - b.min.z).toBeGreaterThan(7.8);
    expect(b.max.z - b.min.z).toBeLessThan(8.8);
    expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(b.max.y).toBeLessThan(3.0);
    for (const k of ['color', 'aRM', 'aPart']) expect(g.getAttribute(k), k).toBeDefined();
  });
  it('pa28: low wing, ~9 m span, wheels on the ground', () => {
    const g = buildAircraftGeometry('pa28');
    const b = bounds(g);
    expect(tris(g)).toBeGreaterThan(2000);
    expect(tris(g)).toBeLessThan(8000);
    expect(b.max.x - b.min.x).toBeGreaterThan(8.8);
    expect(b.max.x - b.min.x).toBeLessThan(9.6);
    expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(b.max.y).toBeLessThan(2.6);
  });
});

describe('cars', () => {
  for (const kind of ['sedan', 'suv'] as const)
    it(`${kind}: car-sized, light, on the ground`, () => {
      const g = buildCarGeometry(kind);
      const b = bounds(g);
      expect(tris(g)).toBeLessThan(2500);
      expect(b.max.z - b.min.z).toBeGreaterThan(4.3);
      expect(b.max.z - b.min.z).toBeLessThan(5.0);
      expect(b.max.x - b.min.x).toBeLessThan(2.1);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.01);
      expect(b.max.y).toBeLessThan(1.9);
    });
});

describe('fence and signs', () => {
  const plan = createAirportPlan();
  it('fence runs trace the perimeter minus the gate', () => {
    const f = plan.fence;
    const perimeter = 2 * (f.a1 - f.a0 + f.c1 - f.c0);
    const gates = f.gates.reduce((s, g) => s + (g.to - g.from), 0);
    const len = fenceRuns(plan).reduce((s, r) => s + Math.hypot(r.p1.a - r.p0.a, r.p1.c - r.p0.c), 0);
    expect(len).toBeCloseTo(perimeter - gates, 3);
  });
  it('signs: holding-position signs name the runway, textured faces have UVs (no canvas in node)', () => {
    const s = buildSigns(plan, () => plan.elevation);
    expect(s.texture).toBeNull();
    expect(s.geometry.getAttribute('uv')).toBeDefined();
    expect(s.faces.some((f) => f.text === '36-18' && f.style === 'mandatory')).toBe(true);
    for (const h of plan.holdLines) expect(s.faces.some((f) => f.text === h.name && f.style === 'location')).toBe(true);
  });
});

describe('fuzz: PAPI and obstacles through the renderer', () => {
  const scene = new THREE.Scene();
  const airport = createAirport(scene, null);
  const cam = new THREE.PerspectiveCamera();
  const u0 = airport.papiState('36').units[0];

  it('the white count never decreases as the camera climbs on the approach', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 300, max: 8000, noNaN: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: 0.5, max: 6, noNaN: true }),
        fc.double({ min: 0.01, max: 2, noNaN: true }),
        (d, lateral, a1, da) => {
          const white = (deg: number) => {
            cam.position.set(u0.x + lateral, u0.y + d * Math.tan((deg * Math.PI) / 180), u0.z + d);
            cam.updateMatrixWorld();
            airport.update(cam, 1, 20);
            return airport.papiState('36').white;
          };
          expect(white(a1)).toBeLessThanOrEqual(white(a1 + da));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('obstacle tops are either none or at/above the field; the tower is always solid', () => {
    const layout = getLayout().airport;
    const t = layout.tower;
    fc.assert(
      fc.property(fc.double({ min: -2000, max: 2000, noNaN: true }), fc.double({ min: -2000, max: 2000, noNaN: true }), (x, z) => {
        const top = airport.obstacleTop(x, z);
        expect(top === -Infinity || top >= layout.elevation).toBe(true);
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.double({ min: -0.45, max: 0.45, noNaN: true }), fc.double({ min: -0.45, max: 0.45, noNaN: true }), (u, v) => {
        expect(airport.obstacleTop(t.center.x + u * t.width, t.center.z + v * t.depth)).toBeGreaterThanOrEqual(layout.elevation + t.height);
      }),
      { numRuns: 200 },
    );
  });
});
