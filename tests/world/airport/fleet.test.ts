/**
 * Extra airport vehicles and aircraft (fleet.ts): every kind and paint scheme builds a sane,
 * grounded, forward-facing mesh inside its declared overall box and triangle budget.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MeshBuilder } from '../../../src/world/airport/builder';
import {
  buildExtraVehicle,
  buildExtraVehicleGeometry,
  EXTRA_VEHICLE_KINDS,
  EXTRA_VEHICLE_SIZE,
  EXTRA_VEHICLE_VARIANTS,
  type ExtraVehicle,
} from '../../../src/world/airport/fleet';

const BUDGET: Record<ExtraVehicle, number> = { kingair: 7000, helicopter: 5000, arff: 5000, fueltruck: 4000, tug: 2500, baggage: 2500, pickup: 2500 };

function built(kind: ExtraVehicle, variant: number) {
  const b = new MeshBuilder();
  buildExtraVehicle(b, kind, variant);
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.pos.length; i += 3)
    for (let a = 0; a < 3; a++) {
      mn[a] = Math.min(mn[a], b.pos[i + a]);
      mx[a] = Math.max(mx[a], b.pos[i + a]);
    }
  return { b, mn, mx };
}

const cases = EXTRA_VEHICLE_KINDS.flatMap((k) => Array.from({ length: EXTRA_VEHICLE_VARIANTS[k] }, (_, v) => [k, v] as const));

describe('airport fleet models (unit)', () => {
  it.each(cases)('%s variant %i: finite, on the ground, inside its box, within budget', (kind, variant) => {
    const { b, mn, mx } = built(kind, variant);
    expect(b.pos.every(Number.isFinite)).toBe(true);
    // stands on the ground: nothing below it, something touching y = 0
    expect(mn[1]).toBeGreaterThanOrEqual(-0.05);
    let touching = 0;
    for (let i = 1; i < b.pos.length; i += 3) if (b.pos[i] < 0.05) touching++;
    expect(touching).toBeGreaterThan(0);
    // overall box matches the declared size within 12 % and is centred on the origin in X/Z
    const s = EXTRA_VEHICLE_SIZE[kind];
    expect(mx[2] - mn[2]).toBeGreaterThan(s.length * 0.88);
    expect(mx[2] - mn[2]).toBeLessThan(s.length * 1.12);
    expect(mx[0] - mn[0]).toBeGreaterThan(s.width * 0.88);
    expect(mx[0] - mn[0]).toBeLessThan(s.width * 1.12);
    expect(mx[1]).toBeGreaterThan(s.height * 0.88);
    expect(mx[1]).toBeLessThan(s.height * 1.12);
    expect(Math.abs(mx[2] + mn[2]) / 2).toBeLessThan(s.length * 0.06);
    expect(Math.abs(mx[0] + mn[0]) / 2).toBeLessThan(s.width * 0.06);
    expect(b.triangleCount).toBeLessThanOrEqual(BUDGET[kind]);
    expect(b.triangleCount).toBeGreaterThan(300);
  });

  it.each(EXTRA_VEHICLE_KINDS)('%s: no instance tint (aAccent 0), unit normals, indices in range', (kind) => {
    const g = buildExtraVehicleGeometry(kind, 0);
    const acc = g.getAttribute('aAccent').array;
    expect(Array.from(acc).every((v) => v === 0)).toBe(true);
    const rm = g.getAttribute('aRM').array;
    for (let i = 0; i < rm.length; i++) expect(rm[i] >= 0 && rm[i] <= 1).toBe(true);
    const n = g.getAttribute('normal').array;
    for (let i = 0; i < n.length; i += 3) expect(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1)).toBeLessThan(1e-3);
    const count = g.getAttribute('position').count;
    const idx = g.index!.array;
    for (let i = 0; i < idx.length; i++) expect(idx[i]).toBeLessThan(count);
  });

  it('faces −Z: the heavy front end (cab / nose) is forward of the centre', () => {
    // mean z of the vertices above half height is forward (negative) for the cab-forward trucks,
    // and the King Air's nose tip / the helicopter's cabin lead toward −Z
    for (const kind of ['arff', 'fueltruck', 'pickup'] as const) {
      const { b } = built(kind, 0);
      let front = 0, back = 0;
      for (let i = 0; i < b.pos.length; i += 3) {
        const z = b.pos[i + 2];
        const y = b.pos[i + 1];
        // glass (dark, glossy) sits at the front of the cab
        if (y > 1.4 && b.rm[(i / 3) * 2] < 0.08) (z < 0 ? front++ : back++);
      }
      expect(front).toBeGreaterThan(back);
    }
    const ka = built('kingair', 0);
    // the nose tip is the frontmost point, on the centreline, around 1.5 m up
    let tip = 0;
    for (let i = 0; i < ka.b.pos.length; i += 3) if (ka.b.pos[i + 2] < ka.b.pos[tip * 3 + 2]) tip = i / 3;
    expect(Math.abs(ka.b.pos[tip * 3])).toBeLessThan(0.1);
    expect(ka.b.pos[tip * 3 + 1]).toBeGreaterThan(1.2);
    const heli = built('helicopter', 0);
    let gz = 0, gn = 0;
    for (let i = 0; i < heli.b.pos.length; i += 3) if (heli.b.rm[(i / 3) * 2] < 0.08) (gz += heli.b.pos[i + 2]), gn++;
    expect(gz / gn).toBeLessThan(0); // the glass bubble is at the front
  });

  it('property: any integer variant (even negative or huge) builds a valid model', () => {
    fc.assert(
      fc.property(fc.constantFrom(...EXTRA_VEHICLE_KINDS), fc.integer({ min: -1000, max: 1000 }), (kind, v) => {
        const { b, mn } = built(kind, v);
        expect(b.pos.every(Number.isFinite)).toBe(true);
        expect(mn[1]).toBeGreaterThanOrEqual(-0.05);
      }),
      { numRuns: 60 },
    );
  });

  it('draws in the builder frame: a pushed transform moves the whole model', () => {
    const b = new MeshBuilder();
    b.pushTR(100, 0, -50, Math.PI / 2);
    buildExtraVehicle(b, 'tug', 0);
    b.pop();
    let cx = 0, cz = 0;
    const n = b.pos.length / 3;
    for (let i = 0; i < b.pos.length; i += 3) (cx += b.pos[i] / n), (cz += b.pos[i + 2] / n);
    expect(Math.hypot(cx - 100, cz + 50)).toBeLessThan(2);
  });
});
