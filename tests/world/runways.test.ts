/**
 * Runway 03/21 and the multi-runway helpers of runway.ts: geometry (heading, length, the crossing
 * with 36/18 on both pavements, inside the airport plateau), runway ends as departure frames,
 * which runway a point is on. Unit + fast-check property tests.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, cloneConfig } from '../../src/config';
import {
  runwayFrame,
  runwayFrames,
  runwayEndFrame,
  runwayEnds,
  runwayAt,
  isOnAnyRunway,
  toRunwayCoords,
  fromRunwayCoords,
  runwayCrossing,
} from '../../src/world/runway';

const [rw36, rw03] = runwayFrames();

describe('runway frames (all configured runways)', () => {
  it('lists 36/18 first (the default) and 03/21 second', () => {
    expect(runwayFrames().length).toBe(2);
    expect(rw36).toEqual(runwayFrame());
    expect(rw36.name).toBe('36/18');
    expect(rw03.name).toBe('03/21');
  });

  it('03/21: true heading ≈ 030°, ~1,200 m × 25 m', () => {
    expect(rw03.headingDeg).toBeGreaterThanOrEqual(25);
    expect(rw03.headingDeg).toBeLessThanOrEqual(35);
    const rel = (((rw03.headingDeg - rw36.headingDeg) % 180) + 180) % 180;
    expect(Math.abs(rel - 30)).toBeLessThan(5); // "crossways at ~30°"
    expect(rw03.length).toBeGreaterThanOrEqual(1100);
    expect(rw03.length).toBeLessThanOrEqual(1300);
    expect(rw03.width).toBe(25);
    expect(Math.hypot(rw03.dir.x, rw03.dir.z)).toBeCloseTo(1, 12);
    expect(rw03.dir.x * rw03.right.x + rw03.dir.z * rw03.right.z).toBeCloseTo(0, 12);
  });

  it('crosses 36/18 in its northern half, on both pavements, both runways usable', () => {
    const x = runwayCrossing(rw36, rw03)!;
    expect(x).not.toBeNull();
    const on36 = toRunwayCoords(x.x, x.z, rw36);
    const on03 = toRunwayCoords(x.x, x.z, rw03);
    expect(on36.along).toBeGreaterThan(rw36.length / 2); // northern half of 36/18
    expect(on36.along).toBeLessThan(rw36.length - 150);
    expect(Math.abs(on36.across)).toBeLessThan(1e-6);
    expect(on03.along).toBeGreaterThan(300); // both runways keep a usable length either side
    expect(rw03.length - on03.along).toBeGreaterThan(300);
    expect(isOnAnyRunway(x.x, x.z)).toBe(true);
  });

  it('keeps every corner of 03/21 inside the flattened airport plateau', () => {
    const R = CONFIG.world.airport.flatRadius;
    for (const along of [0, rw03.length])
      for (const across of [-rw03.halfWidth, rw03.halfWidth]) {
        const p = fromRunwayCoords(along, across, rw03);
        expect(Math.hypot(p.x - rw36.center.x, p.z - rw36.center.z)).toBeLessThan(R - 150);
      }
  });

  it('dedupes `runway` from `runways` by name (edits to `runway` win)', () => {
    const cfg = cloneConfig();
    cfg.world.airport.runway.length = 1500;
    const f = runwayFrames(cfg);
    expect(f.length).toBe(2);
    expect(f[0].length).toBe(1500);
  });
});

describe('runway ends as departure frames', () => {
  it('names the four ends 36, 18, 3, 21', () => {
    expect(runwayEnds().map((e) => e.designator).sort()).toEqual(['18', '21', '3', '36']);
  });

  it('each end frame starts at that threshold and points down the runway', () => {
    for (const d of ['36', '18', '3', '21', '03']) {
      const f = runwayEndFrame(d)!;
      expect(f).not.toBeNull();
      // the whole runway lies ahead: the far threshold is `length` ahead on the centreline
      const far = toRunwayCoords(f.farEnd.x, f.farEnd.z, f);
      expect(far.along).toBeCloseTo(f.length, 6);
      expect(isOnAnyRunway(fromRunwayCoords(10, 0, f).x, fromRunwayCoords(10, 0, f).z)).toBe(true);
    }
    expect(runwayEndFrame('21')!.headingDeg).toBeCloseTo(210, 6);
    expect(runwayEndFrame('18')!.headingDeg).toBeCloseTo(180, 6);
    expect(runwayEndFrame('36')).toEqual(runwayFrame());
    expect(runwayEndFrame('9')).toBeNull();
    expect(runwayEndFrame(null)).toBeNull();
  });
});

describe('which runway a point is on', () => {
  it('fuzz: points on either strip are on a runway; runwayAt returns a frame that contains them', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -0.999, max: 0.999, noNaN: true }), (i, u, v) => {
        const rw = [rw36, rw03][i];
        const p = fromRunwayCoords(u * rw.length, v * rw.halfWidth, rw);
        expect(isOnAnyRunway(p.x, p.z)).toBe(true);
        const f = runwayAt(p.x, p.z)!;
        const q = toRunwayCoords(p.x, p.z, f);
        expect(q.along).toBeGreaterThanOrEqual(-1e-6);
        expect(q.along).toBeLessThanOrEqual(f.length + 1e-6);
        expect(Math.abs(q.across)).toBeLessThanOrEqual(f.halfWidth + 1e-6);
      }),
      { numRuns: 2000 },
    );
  });

  it('points well off both strips are on no runway', () => {
    expect(isOnAnyRunway(60, 0)).toBe(false);
    expect(isOnAnyRunway(-300, -600)).toBe(false);
    expect(runwayAt(60, 0)).toBeNull();
  });
});
