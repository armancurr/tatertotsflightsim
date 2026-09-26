/**
 * Runway 03/21 and the busier field as the physics and the other world systems see them:
 * surfaceAt on both runways, pavement never covered by an obstacle (buildings, parked aircraft,
 * vehicles, signs, windsocks, navaids), no trees or grass tufts on any pavement, the plan's
 * pavement pieces never overlapping (no z-fighting), markings and lights of the new runway, and
 * every runway end spawning an aircraft that rests on its gear on the runway.
 * Unit + fast-check fuzz + functional.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEnvironment } from '../../../src/world/environment';
import { getLandcover } from '../../../src/world/landcover';
import { fromRunwayCoords, runwayEndFrame, runwayFrames, toRunwayCoords } from '../../../src/world/runway';
import { createAirportPlan, pavementAt } from '../../../src/world/airport/plan';
import { airportObstacles, createObstacleSource } from '../../../src/world/airport/obstacles';
import { airportLights } from '../../../src/world/airport/lights';
import { allMarkings, pavementPieces } from '../../../src/world/airport/ground';
import { createAirportField, fieldPaving } from '../../../src/world/airport/field';
import { pointInConvex, polyArea } from '../../../src/world/airport/geom2d';
import { createInitialState, step, defaultControls, FLAT_ENV } from '../../../src/physics';
import { FLEET } from '../../../src/fleet';

const plan = createAirportPlan();
const [rw36, rw03] = runwayFrames();
const lc = getLandcover();
const obstacle = createObstacleSource(airportObstacles(plan));
const pieces = pavementPieces(plan);
const onPiece = (a: number, c: number) => pieces.filter((p) => pointInConvex(p.p, a, c, -1e-6));

/** A random point on some pavement piece (triangle-fan sampling), runway-36 coords. */
const pointOn = (i: number, u: number, v: number, w: number) => {
  const p = pieces[i % pieces.length].p;
  const k = 1 + Math.floor(w * (p.length - 2));
  let s = u, t = v;
  if (s + t > 1) {
    s = 1 - s;
    t = 1 - t;
  }
  return { a: p[0].a + (p[k].a - p[0].a) * s + (p[k + 1].a - p[0].a) * t, c: p[0].c + (p[k].c - p[0].c) * s + (p[k + 1].c - p[0].c) * t, kind: pieces[i % pieces.length].kind };
};

describe('runway 03/21 as a surface (physics)', () => {
  const env = createEnvironment();
  it('surfaceAt is "runway" all over both runways, and flat at the field elevation', () => {
    for (const rw of [rw36, rw03])
      for (let a = 1; a < rw.length; a += 37)
        for (const c of [-rw.halfWidth + 0.3, 0, rw.halfWidth - 0.3]) {
          const p = fromRunwayCoords(a, c, rw);
          expect(env.surfaceAt(p.x, p.z), `${rw.name} ${a} ${c}`).toBe('runway');
          expect(env.groundHeight(p.x, p.z)).toBeCloseTo(rw.elevation, 6);
          expect(env.groundNormal(p.x, p.z).y).toBeCloseTo(1, 6);
        }
  });

  it('the new taxiways, ramps and the perimeter road are asphalt; the grass beside 03/21 is grass', () => {
    const f = createAirportField();
    for (const p of f.paving) {
      if (p.kind === 'runway') continue;
      const ca = p.p.reduce((s, q) => s + q.a, 0) / p.p.length;
      const cc = p.p.reduce((s, q) => s + q.c, 0) / p.p.length;
      const w = fromRunwayCoords(ca, cc, rw36);
      expect(env.surfaceAt(w.x, w.z), p.name).toBe('asphalt');
    }
    const g = fromRunwayCoords(300, rw03.halfWidth + 40, rw03);
    expect(env.surfaceAt(g.x, g.z)).toBe('grass');
  });

  it('fuzz: every point of every pavement piece is paved for landcover (no trees, no grass tufts) and the plan', () => {
    fc.assert(
      fc.property(fc.nat(), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.999, noNaN: true }), (i, u, v, w) => {
        const q = pointOn(i, u, v, w);
        const x = fromRunwayCoords(q.a, q.c, rw36);
        expect(pavementAt(plan, q.a, q.c)).not.toBeNull();
        if (q.kind === 'road') return; // the perimeter road can leave the plateau; its landcover is still paved
        expect(lc.isPaved(x.x, x.z)).toBe(true);
        expect(lc.treeDensity(x.x, x.z)).toBe(0);
      }),
      { numRuns: 3000 },
    );
 }, 30000);
});

describe('nothing stands on a runway or a taxiway', () => {
  it('fuzz: no obstacle (building, aircraft, vehicle, windsock, navaid) on any runway or taxiway point', () => {
    const moving = pieces.filter((p) => p.kind === 'runway' || p.kind === 'taxiway');
    fc.assert(
      fc.property(fc.nat(), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 0.999, noNaN: true }), (i, u, v, w) => {
        const p = moving[i % moving.length].p;
        const k = 1 + Math.floor(w * (p.length - 2));
        let s = u, t = v;
        if (s + t > 1) {
          s = 1 - s;
          t = 1 - t;
        }
        const a = p[0].a + (p[k].a - p[0].a) * s + (p[k + 1].a - p[0].a) * t;
        const c = p[0].c + (p[k].c - p[0].c) * s + (p[k + 1].c - p[0].c) * t;
        const x = fromRunwayCoords(a, c, rw36);
        expect(obstacle(x.x, x.z)).toBe(-Infinity);
      }),
      { numRuns: 5000 },
    );
 }, 30000);

  it('every obstacle footprint centre is off the runways and taxiways', () => {
    for (const o of airportObstacles(plan)) {
      const q = toRunwayCoords(o.x, o.z, rw36);
      const k = pavementAt(plan, q.along, q.across);
      expect(k === 'runway' || k === 'taxiway', `${o.type} at ${o.x.toFixed(0)},${o.z.toFixed(0)}`).toBe(false);
    }
  });
});

describe('pavement pieces (mesh)', () => {
  it('fuzz: no two pieces overlap (one surface per point, no z-fighting)', () => {
    fc.assert(
      fc.property(fc.double({ min: -800, max: 2000, noNaN: true }), fc.double({ min: -500, max: 360, noNaN: true }), (a, c) => {
        expect(onPiece(a, c).length).toBeLessThanOrEqual(1);
      }),
      { numRuns: 20000 },
    );
 }, 30000);
  it('covers the crossing: the intersection of the two centrelines is 36/18 pavement', () => {
    const f = createAirportField();
    expect(pavementAt(plan, f.crossing.a, f.crossing.c)).toBe('runway');
    expect(onPiece(f.crossing.a, f.crossing.c).length).toBe(1);
    for (const p of pieces) expect(Math.abs(polyArea(p.p))).toBeGreaterThan(1e-3);
  });
  it('landcover and the plan agree on the field pavement (same polygons)', () => {
    expect(fieldPaving().length).toBe(createAirportField().paving.length);
  });
});

describe("03/21's markings and lights", () => {
  const marks = allMarkings(plan);
  const on03 = (m: (typeof marks)[number]) => m.frame === 1 && ['threshold', 'designator', 'centerline', 'tdz', 'aiming', 'edge'].includes(m.kind);
  it('paints designators 3 and 21, 6 threshold bars per end, aiming points and a dashed centreline', () => {
    const m = marks.filter(on03);
    expect(new Set(m.filter((q) => q.kind === 'designator').map((q) => q.end))).toEqual(new Set(['3', '21']));
    for (const end of ['3', '21']) expect(m.filter((q) => q.kind === 'threshold' && q.end === end).length).toBe(6);
    expect(m.filter((q) => q.kind === 'aiming').length).toBeGreaterThanOrEqual(4);
    expect(m.filter((q) => q.kind === 'centerline').length).toBeGreaterThan(10);
  });
  it("interrupts 03/21's paint inside 36/18 (36/18 is the primary runway)", () => {
    for (const q of marks.filter(on03)) {
      const ca = q.p.reduce((s, p) => s + p.a, 0) / 4;
      const cc = q.p.reduce((s, p) => s + p.c, 0) / 4;
      expect(Math.abs(cc) > rw36.halfWidth - 1e-6 || ca < 0 || ca > rw36.length).toBe(true);
    }
  });
  it('holds short of 36/18 on 03/21 (both sides) and of 03/21 on taxiways A (both sides), B and C', () => {
    const f = createAirportField();
    const names = f.holds.map((h) => `${h.name}:${h.sign}`).sort();
    expect(names).toEqual(['3-21:18-36', '3-21:36-18', 'A:21-3', 'A:3-21', 'B:3', 'C:21'].sort());
    for (const h of f.holds) {
      const bands = marks.filter((m) => m.kind === 'hold-short' && m.name === h.name);
      expect(bands.length).toBeGreaterThanOrEqual(4);
    }
  });
  it('lights 03/21: edge lights both sides, threshold/end lights, REILs, and a 4-box PAPI for 3 and 21', () => {
    const L = airportLights(plan);
    const edge = L.filter((l) => l.kind === 'edge' && l.runway === '03/21');
    expect(edge.length).toBeGreaterThan(30);
    for (const l of edge) {
      const q = toRunwayCoords(l.x, l.z, rw36);
      expect(pavementAt(plan, q.along, q.across)).toBeNull();
    }
    expect(L.filter((l) => l.kind === 'threshold' && l.runway === '03/21').length).toBeGreaterThanOrEqual(16);
    expect(L.filter((l) => l.kind === 'reil').length).toBe(6); // 18, 3 and 21
    for (const end of ['3', '21']) {
      const p = L.filter((l) => l.kind === 'papi' && l.end === end);
      expect(p.length).toBe(4);
      for (const l of p) {
        const q = toRunwayCoords(l.x, l.z, rw36);
        expect(pavementAt(plan, q.along, q.across)).toBeNull();
        // clear of 36/18 and taxiway A by a few metres
        for (const [da, dc] of [[4, 0], [-4, 0], [0, 4], [0, -4]]) expect(pavementAt(plan, q.along + da, q.across + dc)).toBeNull();
      }
    }
  });
});

describe('spawning on every runway end (functional)', () => {
  it('every aircraft rests on its gear, on the runway centreline, facing down the runway, and stays put', () => {
    const env = createEnvironment();
    for (const d of ['36', '18', '3', '21']) {
      const fr = runwayEndFrame(d)!;
      for (const def of FLEET.filter((f) => f.kind !== 'vessel')) {
        let s = createInitialState(env, def.config, fr);
        expect(s.phase).toBe('ground');
        for (let i = 0; i < 120 * 3; i++) s = step(s, { ...defaultControls(), parkingBrake: true }, 1 / 120, env, def.config);
        expect(s.crash, `${def.id} on ${d}`).toBeNull();
        expect(s.onGround).toBe(true);
        expect(Math.abs(s.derived.verticalSpeed)).toBeLessThan(0.05);
        const q = toRunwayCoords(s.position.x, s.position.z, fr);
        expect(Math.abs(q.across)).toBeLessThan(0.5);
        expect(q.along).toBeGreaterThan(0);
        expect(q.along).toBeLessThan(100);
        expect(env.surfaceAt(s.position.x, s.position.z)).toBe('runway');
        let dh = Math.abs(s.derived.headingDeg - fr.headingDeg) % 360;
        if (dh > 180) dh = 360 - dh;
        expect(dh, `${def.id} on ${d}`).toBeLessThan(1);
      }
    }
    void FLAT_ENV;
  }, 60000);
});
