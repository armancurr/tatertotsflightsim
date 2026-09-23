import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout, type OrientedRect } from '../../../src/world/layout';
import { toRunwayCoords } from '../../../src/world/runway';
import { createAirportPlan, pavementAt, pointInFillet, rectOfLayout, type PaveRect } from '../../../src/world/airport/plan';

const layout = getLayout().airport;
const plan = createAirportPlan(layout);
const inRect = (r: { a0: number; a1: number; c0: number; c1: number }, a: number, c: number) => a > r.a0 && a < r.a1 && c > r.c0 && c < r.c1;

describe('airport plan (derived from layout.ts)', () => {
  it('converts layout rectangles into runway coordinates', () => {
    const r = rectOfLayout(layout.apron, layout.runway);
    const c = toRunwayCoords(layout.apron.center.x, layout.apron.center.z, layout.runway);
    expect((r.a0 + r.a1) / 2).toBeCloseTo(c.along, 6);
    expect((r.c0 + r.c1) / 2).toBeCloseTo(c.across, 6);
    expect(r.a1 - r.a0).toBeCloseTo(layout.apron.halfLength * 2, 6);
  });

  it('has one runway piece exactly the runway', () => {
    const rws = plan.pavement.filter((p) => p.kind === 'runway');
    expect(rws.length).toBe(1);
    expect(rws[0]).toMatchObject({ a0: 0, a1: layout.runway.length, c0: -layout.runway.halfWidth, c1: layout.runway.halfWidth });
  });

  it('fuzz: pavement rectangles never overlap (one surface per point, no z-fighting)', () => {
    const rects = plan.pavement;
    fc.assert(
      fc.property(fc.double({ min: -100, max: 1700, noNaN: true }), fc.double({ min: -50, max: 320, noNaN: true }), (a, c) => {
        const hits = rects.filter((r) => inRect(r, a, c));
        expect(hits.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 4000 },
    );
  });

  it('fuzz: every point of every layout paved area is paved in the plan', () => {
    const areas: OrientedRect[] = layout.pavedAreas;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: areas.length - 1 }), fc.double({ min: -0.999, max: 0.999, noNaN: true }), fc.double({ min: -0.999, max: 0.999, noNaN: true }), (i, u, v) => {
        const r = rectOfLayout(areas[i], layout.runway);
        const a = r.a0 + ((u + 1) / 2) * (r.a1 - r.a0);
        const c = r.c0 + ((v + 1) / 2) * (r.c1 - r.c0);
        expect(pavementAt(plan, a, c)).not.toBeNull();
      }),
      { numRuns: 3000 },
    );
  });

  it('adds curved fillets at taxiway junctions, outside every rectangle', () => {
    expect(plan.fillets.length).toBeGreaterThanOrEqual(8);
    for (const f of plan.fillets) {
      // centroid of the first fan triangle is inside the fillet and on no rectangle
      const p0 = f.corner, p1 = f.arc[Math.floor(f.arc.length / 2)], p2 = f.arc[Math.floor(f.arc.length / 2) + 1];
      const a = (p0.a + p1.a + p2.a) / 3, c = (p0.c + p1.c + p2.c) / 3;
      expect(pointInFillet(f, a, c)).toBe(true);
      expect(plan.pavement.some((r: PaveRect) => inRect(r, a, c))).toBe(false);
    }
  });

  it('puts a hold-short line on every connector, well clear of the runway', () => {
    const cons = plan.connectors;
    // the layout's connectors + B (across 36/18 to the 03 threshold), which holds on both sides
    expect(cons.length).toBe(layout.taxiways.filter((t) => t.kind === 'connector').length + 1);
    expect(plan.holdLines.length).toBe(cons.length + 1);
    for (const h of plan.holdLines) {
      expect(Math.abs(h.c)).toBeGreaterThanOrEqual(45);
      const con = cons.find((k) => k.name === h.name)!;
      expect(Math.abs(h.c)).toBeLessThan(Math.max(Math.abs(con.c0), Math.abs(con.c1)) - 10);
      expect(h.a).toBeCloseTo(con.a, 6);
    }
  });

  it('parks Cessnas and Pipers with several liveries on tie-down spots (the apron and the south ramp)', () => {
    expect(plan.parked.length).toBeGreaterThanOrEqual(16);
    expect(plan.parked.length).toBeLessThanOrEqual(40);
    expect(new Set(plan.parked.map((p) => p.livery)).size).toBeGreaterThanOrEqual(3);
    const spots = [...layout.parkingSpots, ...plan.field.parking];
    for (const p of plan.parked) expect(spots.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1e-6)).toBe(true);
    for (let i = 0; i < plan.parked.length; i++)
      for (let j = i + 1; j < plan.parked.length; j++) expect(Math.hypot(plan.parked[i].x - plan.parked[j].x, plan.parked[i].z - plan.parked[j].z)).toBeGreaterThan(20);
  });

  it('puts the cars inside the car parks without overlaps', () => {
    expect(plan.cars.length).toBeGreaterThanOrEqual(4);
    for (const car of plan.cars) {
      const rc = toRunwayCoords(car.x, car.z, layout.runway);
      expect([plan.carpark, ...plan.carparks].some((cp) => inRect(cp, rc.along, rc.across))).toBe(true);
    }
    for (let i = 0; i < plan.cars.length; i++)
      for (let j = i + 1; j < plan.cars.length; j++) expect(Math.hypot(plan.cars[i].x - plan.cars[j].x, plan.cars[i].z - plan.cars[j].z)).toBeGreaterThan(2.3);
  });

  it('keeps the car park clear of the buildings and on the access road', () => {
    const rc = toRunwayCoords(layout.accessRoadStart.x, layout.accessRoadStart.z, layout.runway);
    expect(inRect(plan.carpark, rc.along, rc.across)).toBe(true);
    for (const b of [layout.tower, layout.terminal, ...layout.hangars]) {
      const bc = toRunwayCoords(b.center.x, b.center.z, layout.runway);
      expect(inRect(plan.carpark, bc.along, bc.across)).toBe(false);
    }
  });

  it('gives the hangars a mix of arched and gabled roofs', () => {
    expect(plan.hangars.length).toBe(layout.hangars.length + 1); // + the maintenance hangar on the south ramp
    expect(plan.hangars.some((h) => h.doorOpen > 0.8)).toBe(true);
    const roofs = new Set(plan.hangars.map((h) => h.roof));
    expect(roofs.has('arched')).toBe(true);
    expect(roofs.has('gabled')).toBe(true);
  });

  it('fences the whole field (runway, approach lights, buildings) with a gate for the access road', () => {
    const f = plan.fence;
    const inside = (a: number, c: number) => a > f.a0 && a < f.a1 && c > f.c0 && c < f.c1;
    expect(inside(0, 0)).toBe(true);
    expect(inside(layout.runway.length, 0)).toBe(true);
    expect(inside(-740, 0)).toBe(true); // outermost sequenced flasher
    for (const b of [layout.tower, layout.terminal, ...layout.hangars]) {
      const bc = toRunwayCoords(b.center.x, b.center.z, layout.runway);
      expect(inside(bc.along, bc.across)).toBe(true);
    }
    expect(f.gates.length).toBeGreaterThanOrEqual(1);
    const g = f.gates[0];
    expect(g.side).toBe('east');
    expect(g.to - g.from).toBeGreaterThanOrEqual(8);
  });
});
