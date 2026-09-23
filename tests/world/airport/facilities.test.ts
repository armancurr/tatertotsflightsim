import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MeshBuilder } from '../../../src/world/airport/builder';
import { MAT } from '../../../src/world/airport/materials';
import {
  FACILITY_SIZE,
  fireStation,
  flightSchool,
  fuelFarm,
  glideslope,
  localizerArray,
  localizerShelterX,
  LOCALIZER_HEIGHT,
  tHangarRow,
  TH_HALF_DEPTH,
  TH_RIDGE,
  vorStation,
} from '../../../src/world/airport/facilities';

interface Bounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

function bounds(b: MeshBuilder, filter?: (i: number) => boolean): Bounds {
  const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (let i = 0; i < b.vertexCount; i++) {
    if (filter && !filter(i)) continue;
    const x = b.pos[i * 3], y = b.pos[i * 3 + 1], z = b.pos[i * 3 + 2];
    r.x0 = Math.min(r.x0, x);
    r.x1 = Math.max(r.x1, x);
    r.y0 = Math.min(r.y0, y);
    r.y1 = Math.max(r.y1, y);
    r.z0 = Math.min(r.z0, z);
    r.z1 = Math.max(r.z1, z);
  }
  return r;
}

/** Sanity every builder must pass: finite, above −0.25 m, unit normals, indices in range. */
function expectSane(b: MeshBuilder, maxTris: number) {
  expect(b.triangleCount).toBeGreaterThan(50);
  expect(b.triangleCount).toBeLessThanOrEqual(maxTris);
  for (const v of b.pos) expect(Number.isFinite(v)).toBe(true);
  for (let i = 0; i < b.vertexCount; i++) {
    expect(b.pos[i * 3 + 1]).toBeGreaterThanOrEqual(-0.25);
    const l = Math.hypot(b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]);
    expect(Math.abs(l - 1)).toBeLessThan(1e-4);
  }
  for (const i of b.idx) expect(i).toBeLessThan(b.vertexCount);
}

const TOL = 0.06;
function expectInside(r: Bounds, s: { halfW: number; halfD: number; height: number }) {
  expect(r.x0).toBeGreaterThanOrEqual(-s.halfW - TOL);
  expect(r.x1).toBeLessThanOrEqual(s.halfW + TOL);
  expect(r.z0).toBeGreaterThanOrEqual(-s.halfD - TOL);
  expect(r.z1).toBeLessThanOrEqual(s.halfD + TOL);
  expect(r.y1).toBeLessThanOrEqual(s.height + TOL);
}

const matIs = (b: MeshBuilder, m: number) => (i: number) => b.mat[i] === m;

describe('airport facilities (merged-mesh builders)', () => {
  it('flight school: sane, inside its footprint, glazed front toward −Z, blank fascia at 6.3–7.3 m', () => {
    const b = new MeshBuilder();
    flightSchool(b);
    expectSane(b, 6000);
    expectInside(bounds(b), FACILITY_SIZE.flightSchool);
    const glass = bounds(b, matIs(b, MAT.window));
    expect(glass.z0).toBeLessThan(-7); // curtain wall on the front face
    const fascia = bounds(b, (i) => b.mat[i] === MAT.metal && b.pos[i * 3 + 2] < -7 && b.pos[i * 3 + 1] > 6.2);
    expect(fascia.y0).toBeCloseTo(6.3, 1);
    expect(fascia.y1).toBeCloseTo(7.3, 1);
  });

  it('fire station: sane, inside its footprint, roll-up doors on the front with one bay open and lit', () => {
    const b = new MeshBuilder();
    fireStation(b);
    expectSane(b, 6000);
    expectInside(bounds(b), FACILITY_SIZE.fireStation);
    const doors = bounds(b, (i) => b.mat[i] === MAT.door && b.pos[i * 3 + 2] < 0);
    expect(doors.z0).toBeLessThan(-10.5);
    expect(doors.y1).toBeGreaterThan(5);
    let lit = 0;
    for (let i = 0; i < b.vertexCount; i++) if (b.mat[i] === MAT.interiorLamp) lit++;
    expect(lit).toBeGreaterThan(0);
    // the hose tower is the tallest part (~13 m)
    expect(bounds(b).y1).toBeGreaterThan(12.5);
  });

  it('fuel farm, VOR and glideslope: sane and inside their footprints', () => {
    for (const [fn, s] of [
      [fuelFarm, FACILITY_SIZE.fuelFarm],
      [vorStation, FACILITY_SIZE.vor],
      [glideslope, FACILITY_SIZE.glideslope],
    ] as const) {
      const b = new MeshBuilder();
      fn(b);
      expectSane(b, 6000);
      expectInside(bounds(b), s);
    }
  });

  it('VOR: counterpoise ~7 m radius at ~3.5 m with the radome above it', () => {
    const b = new MeshBuilder();
    vorStation(b);
    const disc = bounds(b, (i) => Math.abs(b.pos[i * 3 + 1] - 3.56) < 0.08 && Math.hypot(b.pos[i * 3], b.pos[i * 3 + 2]) > 6);
    expect(disc.x1).toBeGreaterThan(6.8);
    expect(bounds(b, (i) => Math.hypot(b.pos[i * 3], b.pos[i * 3 + 2]) < 1.2).y1).toBeGreaterThan(5.5);
  });

  it('localizer: 14 antennas across the width, low (≤ LOCALIZER_HEIGHT), shelter at localizerShelterX', () => {
    const b = new MeshBuilder();
    localizerArray(b, 30);
    expectSane(b, 6000);
    const array = bounds(b, (i) => b.pos[i * 3] < 16.1);
    expect(array.x0).toBeLessThan(-14.5);
    expect(array.y1).toBeLessThanOrEqual(LOCALIZER_HEIGHT + TOL);
    expect(array.z0).toBeLessThan(-1.5); // booms point at the runway (−Z)
    const sx = localizerShelterX(30);
    const shelter = bounds(b, (i) => b.pos[i * 3] > 16.2);
    const s = FACILITY_SIZE.localizerShelter;
    expect(shelter.x0).toBeGreaterThanOrEqual(sx - s.halfW - TOL);
    expect(shelter.x1).toBeLessThanOrEqual(sx + s.halfW + TOL);
    expect(shelter.y1).toBeLessThanOrEqual(s.height + TOL);
  });

  it('property: T-hangar rows of any size stay inside their documented box, doors on both faces', () => {
    fc.assert(
      fc.property(fc.double({ min: 40, max: 130, noNaN: true }), fc.double({ min: 12, max: 22, noNaN: true }), fc.integer({ min: 3, max: 12 }), fc.integer({ min: 0, max: 9 }), (len, dep, bays, seed) => {
        const b = new MeshBuilder();
        tHangarRow(b, len, dep, bays, seed);
        expect(b.triangleCount).toBeLessThanOrEqual(8000);
        const r = bounds(b);
        expect(r.y0).toBeGreaterThanOrEqual(-0.25);
        expect(r.x0).toBeGreaterThanOrEqual(-len / 2 - 0.45);
        expect(r.x1).toBeLessThanOrEqual(len / 2 + 0.45);
        expect(r.y1).toBeLessThanOrEqual(TH_RIDGE(dep) + TOL);
        // folded-open doors may stick out ~1.8 m below the eaves; everything else within the obstacle box
        const high = bounds(b, (i) => b.pos[i * 3 + 1] > 3.7);
        expect(high.z0).toBeGreaterThanOrEqual(-TH_HALF_DEPTH(dep) - TOL);
        expect(high.z1).toBeLessThanOrEqual(TH_HALF_DEPTH(dep) + TOL);
        let front = 0, back = 0;
        for (let i = 0; i < b.vertexCount; i++)
          if (b.mat[i] === MAT.door) {
            if (b.pos[i * 3 + 2] < 0) front++;
            else back++;
          }
        expect(front).toBeGreaterThan(0);
        expect(back).toBeGreaterThan(0);
      }),
      { numRuns: 40 },
    );
  });

  it('T-hangar row: 110 m × 18 m with 10 bays within the triangle budget', () => {
    const b = new MeshBuilder();
    tHangarRow(b, 110, 18, 10, 1);
    expectSane(b, 8000);
  });
});
