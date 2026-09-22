import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout } from '../../../src/world/layout';
import { toRunwayCoords } from '../../../src/world/runway';
import { createAirportPlan, pavementAt } from '../../../src/world/airport/plan';
import {
  airportLights,
  beaconFlash,
  BEACON,
  COLORS,
  lightLevel,
  PAPI_ANGLES,
  papiUnitWhiteness,
  papiWhiteCount,
  rabbitIndex,
  RABBIT,
  viewAngleDeg,
  type LightDef,
} from '../../../src/world/airport/lights';

const layout = getLayout().airport;
const rw = layout.runway;
const plan = createAirportPlan(layout);
const lights = airportLights(plan);
const kind = (k: LightDef['kind']) => lights.filter((l) => l.kind === k);
const rc = (l: LightDef) => {
  const r = toRunwayCoords(l.x, l.z, rw);
  return { a: r.along, c: r.across };
};
const same = (x: readonly number[], y: readonly number[]) => x.every((v, i) => Math.abs(v - y[i]) < 1e-9);

describe('runway edge lights', () => {
  const edge = kind('edge');
  it('lines both edges at <= 200 ft spacing, just outside the pavement', () => {
    for (const side of [-1, 1]) {
      const row = edge.filter((l) => Math.sign(rc(l).c) === side).map(rc).sort((p, q) => p.a - q.a);
      expect(row.length).toBe(Math.ceil(rw.length / 61) + 1);
      expect(row[0].a).toBeCloseTo(0, 6);
      expect(row[row.length - 1].a).toBeCloseTo(rw.length, 6);
      for (let i = 1; i < row.length; i++) {
        expect(row[i].a - row[i - 1].a).toBeLessThanOrEqual(61);
        expect(row[i].a - row[i - 1].a).toBeCloseTo(row[1].a - row[0].a, 6);
      }
      for (const p of row) {
        expect(Math.abs(p.c) - rw.halfWidth).toBeGreaterThanOrEqual(0.6);
        expect(Math.abs(p.c) - rw.halfWidth).toBeLessThanOrEqual(3.05);
      }
    }
  });
  it('shows yellow over the last 2000 ft ahead of the pilot, white elsewhere, from both directions', () => {
    for (const l of edge) {
      const { a } = rc(l);
      // front = seen by a pilot rolling on 36 (toward +along), back = seen on 18
      expect(same(l.front, a >= rw.length - 600 - 1e-6 ? COLORS.yellow : COLORS.white)).toBe(true);
      expect(same(l.back, a <= 600 + 1e-6 ? COLORS.yellow : COLORS.white)).toBe(true);
      expect(l.facingDeg).toBeCloseTo((rw.headingDeg + 180) % 360, 6);
    }
  });
});

describe('threshold / runway end lights', () => {
  const th = kind('threshold');
  it('spans each end: green toward the approach, red toward the runway', () => {
    const e36 = th.filter((l) => rc(l).a < rw.length / 2);
    const e18 = th.filter((l) => rc(l).a > rw.length / 2);
    expect(e36.length).toBeGreaterThanOrEqual(8);
    expect(e18.length).toBe(e36.length);
    for (const l of e36) {
      expect(rc(l).a).toBeLessThan(0);
      expect(rc(l).a).toBeGreaterThan(-3.05);
      expect(Math.abs(rc(l).c)).toBeLessThanOrEqual(rw.halfWidth + 1);
      expect(same(l.front, COLORS.green)).toBe(true);
      expect(same(l.back, COLORS.red)).toBe(true);
      expect(l.facingDeg).toBeCloseTo(180, 6); // faces the aircraft approaching 36 from the south
    }
    for (const l of e18) {
      expect(rc(l).a).toBeGreaterThan(rw.length);
      expect(same(l.front, COLORS.green)).toBe(true);
      expect(same(l.back, COLORS.red)).toBe(true);
      expect(l.facingDeg).toBeCloseTo(0, 6);
    }
  });
});

describe('taxiway edge lights', () => {
  const tx = kind('taxi');
  it('are blue, omnidirectional, many, and never on the pavement', () => {
    expect(tx.length).toBeGreaterThan(60);
    for (const l of tx) {
      expect(same(l.front, COLORS.blue)).toBe(true);
      expect(l.facingDeg).toBeNull();
      const p = rc(l);
      expect(pavementAt(plan, p.a, p.c)).toBeNull();
    }
  });
  it('sit within 2 m of a taxiway edge, and no two closer than 8 m', () => {
    for (let i = 0; i < tx.length; i++) {
      const p = rc(tx[i]);
      let near = false;
      for (const [da, dc] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) if (pavementAt(plan, p.a + da, p.c + dc) !== null) near = true;
      expect(near).toBe(true);
      for (let j = i + 1; j < tx.length; j++) expect(Math.hypot(tx[i].x - tx[j].x, tx[i].z - tx[j].z)).toBeGreaterThan(8);
    }
  });
});

describe('approach lights (MALSR) and the rabbit on runway 36', () => {
  it('has steady white bars every 200 ft out to 1400 ft, with a crossbar at 1000 ft', () => {
    const als = kind('approach').map(rc);
    const bars = new Map<number, number>();
    for (const p of als) bars.set(Math.round(-p.a), (bars.get(Math.round(-p.a)) ?? 0) + 1);
    const stations = [...bars.keys()].sort((x, y) => x - y);
    expect(stations.length).toBe(7);
    stations.forEach((s, i) => expect(s).toBeCloseTo((i + 1) * 200 * 0.3048, -0.5));
    const crossbar = bars.get(Math.round(1000 * 0.3048))!;
    expect(crossbar).toBeGreaterThan(bars.get(stations[0])!);
    for (const l of kind('approach')) {
      expect(same(l.front, COLORS.white)).toBe(true);
      expect(same(l.back, COLORS.off)).toBe(true);
      expect(l.facingDeg).toBeCloseTo(180, 6);
    }
  });
  it('has 5 sequenced flashers beyond, numbered from the outermost inward', () => {
    const fl = kind('rabbit').map((l) => ({ ...rc(l), seq: l.seq }));
    expect(fl.length).toBe(RABBIT.count);
    fl.sort((p, q) => p.a - q.a);
    fl.forEach((p, i) => {
      expect(p.seq).toBe(i);
      expect(Math.abs(p.c)).toBeLessThan(0.01);
    });
    expect(-fl[fl.length - 1].a).toBeGreaterThan(1400 * 0.3048);
  });
  it('rabbit: sweeps the flashers outermost → innermost twice a second', () => {
    const seen: number[] = [];
    for (let t = 0; t < 0.5; t += 0.001) {
      const i = rabbitIndex(t);
      if (i >= 0 && seen[seen.length - 1] !== i) seen.push(i);
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(RABBIT.period).toBeCloseTo(0.5);
  });
  it('fuzz: rabbitIndex is -1 or a flasher index', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e5, noNaN: true }), (t) => {
        const i = rabbitIndex(t);
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(-1);
        expect(i).toBeLessThan(RABBIT.count);
      }),
    );
  });
  it('fuzz: rabbitIndex is periodic (mid-slot of flasher i in any cycle is i)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100000 }), fc.integer({ min: 0, max: RABBIT.count - 1 }), (k, i) => {
        expect(rabbitIndex(k * RABBIT.period + (i + 0.5) * RABBIT.flash)).toBe(i);
      }),
    );
  });
});

describe('PAPI', () => {
  const papi = kind('papi');
  it('has 4 units left of each touchdown zone: 15 m from the edge, 9 m apart, inner unit highest', () => {
    expect(papi.length).toBe(8);
    const p36 = papi.filter((l) => l.end === '36').map((l) => ({ ...rc(l), unit: l.unit }));
    const p18 = papi.filter((l) => l.end === '18').map((l) => ({ ...rc(l), unit: l.unit }));
    for (const p of p36) expect(p.c).toBeLessThan(-rw.halfWidth); // left of a northbound pilot = west
    for (const p of p18) expect(p.c).toBeGreaterThan(rw.halfWidth); // left of a southbound pilot = east
    for (const set of [p36, p18]) {
      const s = set.sort((x, y) => Math.abs(x.c) - Math.abs(y.c));
      expect(Math.abs(s[0].c) - rw.halfWidth).toBeCloseTo(15, 1);
      for (let i = 1; i < 4; i++) expect(Math.abs(s[i].c) - Math.abs(s[i - 1].c)).toBeCloseTo(9, 1);
      expect(s.map((x) => x.unit)).toEqual([0, 1, 2, 3]);
    }
    expect([...PAPI_ANGLES]).toEqual([3.5, 3.17, 2.83, 2.5]);
    // the 3° path from the PAPI crosses the threshold 12-18 m up
    const a36 = p36[0].a;
    const tch = a36 * Math.tan((3 * Math.PI) / 180);
    expect(tch).toBeGreaterThan(12);
    expect(tch).toBeLessThan(18);
  });

  it('switches each unit from red to white at its transition angle', () => {
    for (const u of PAPI_ANGLES) {
      expect(papiUnitWhiteness(u - 0.2, u)).toBe(0);
      expect(papiUnitWhiteness(u + 0.2, u)).toBe(1);
      expect(papiUnitWhiteness(u, u)).toBeCloseTo(0.5, 6);
    }
  });
  it('reads 2 white / 2 red on the 3° glide path, all red low, all white high', () => {
    expect(papiWhiteCount(3.0)).toBe(2);
    expect(papiWhiteCount(2.0)).toBe(0);
    expect(papiWhiteCount(2.7)).toBe(1);
    expect(papiWhiteCount(3.3)).toBe(3);
    expect(papiWhiteCount(4.0)).toBe(4);
  });
  it('fuzz: monotonic — the higher you are, the more white (per unit and in total)', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 30, noNaN: true }), fc.double({ min: -10, max: 30, noNaN: true }), (x, y) => {
        const lo = Math.min(x, y), hi = Math.max(x, y);
        let tl = 0, th = 0;
        for (const u of PAPI_ANGLES) {
          const wl = papiUnitWhiteness(lo, u), wh = papiUnitWhiteness(hi, u);
          expect(wl).toBeGreaterThanOrEqual(0);
          expect(wh).toBeLessThanOrEqual(1);
          expect(wh).toBeGreaterThanOrEqual(wl);
          tl += wl;
          th += wh;
        }
        expect(th).toBeGreaterThanOrEqual(tl);
        expect(papiWhiteCount(hi)).toBeGreaterThanOrEqual(papiWhiteCount(lo));
      }),
      { numRuns: 2000 },
    );
  });
  it('fuzz: inner units are never whiter than outer units (the classic PAPI order)', () => {
    fc.assert(
      fc.property(fc.double({ min: -5, max: 15, noNaN: true }), (a) => {
        for (let i = 1; i < PAPI_ANGLES.length; i++) expect(papiUnitWhiteness(a, PAPI_ANGLES[i - 1])).toBeLessThanOrEqual(papiUnitWhiteness(a, PAPI_ANGLES[i]));
      }),
    );
  });
  it('measures the viewing angle above the horizontal at the unit', () => {
    expect(viewAngleDeg(0, 100, -1000, 0, 0, 0)).toBeCloseTo((Math.atan2(100, 1000) * 180) / Math.PI, 9);
    expect(viewAngleDeg(0, -5, 100, 0, 0, 0)).toBeLessThan(0);
  });
});

describe('light level with the sun and the beacon', () => {
  it('is full at night, bright at dawn/golden hour, dim at midday', () => {
    expect(lightLevel(-12)).toBe(1);
    expect(lightLevel(4)).toBeGreaterThanOrEqual(0.7);
    expect(lightLevel(9)).toBeGreaterThanOrEqual(0.5);
    expect(lightLevel(62)).toBeLessThanOrEqual(0.3);
    expect(lightLevel(62)).toBeGreaterThan(0);
  });
  it('fuzz: stays in (0,1] and never increases as the sun rises', () => {
    fc.assert(
      fc.property(fc.double({ min: -90, max: 90, noNaN: true }), fc.double({ min: -90, max: 90, noNaN: true }), (x, y) => {
        const lo = Math.min(x, y), hi = Math.max(x, y);
        expect(lightLevel(lo)).toBeLessThanOrEqual(1);
        expect(lightLevel(hi)).toBeGreaterThan(0);
        expect(lightLevel(hi)).toBeLessThanOrEqual(lightLevel(lo) + 1e-12);
      }),
    );
  });
  it('beacon: a fixed observer sees one white and one green flash per rotation', () => {
    const period = 60 / BEACON.rpm;
    const dt = period / 4000;
    let whites = 0, greens = 0, prevW = 0, prevG = 0;
    for (let t = 0; t < period; t += dt) {
      const f = beaconFlash(t, 37);
      if (f.white > 0.5 && prevW <= 0.5) whites++;
      if (f.green > 0.5 && prevG <= 0.5) greens++;
      prevW = f.white;
      prevG = f.green;
      expect(f.white * f.green).toBe(0);
    }
    expect(whites).toBe(1);
    expect(greens).toBe(1);
  });
});
