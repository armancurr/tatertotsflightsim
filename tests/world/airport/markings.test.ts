import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { cloneConfig } from '../../../src/config';
import { runwayFrame } from '../../../src/world/runway';
import { getLayout } from '../../../src/world/layout';
import { FT, MARKING, pianoKeyCount, runwayDesignator, runwayMarkings, taxiMarkings, type MarkQuad } from '../../../src/world/airport/markings';
import { createAirportPlan, pavementAt } from '../../../src/world/airport/plan';

const rw = runwayFrame();
const L = rw.length;
const all = runwayMarkings(rw);
const of = (kind: MarkQuad['kind'], end?: string) => all.filter((m) => m.kind === kind && (end === undefined || m.end === end));
const bb = (m: MarkQuad) => ({
  a0: Math.min(...m.p.map((p) => p.a)),
  a1: Math.max(...m.p.map((p) => p.a)),
  c0: Math.min(...m.p.map((p) => p.c)),
  c1: Math.max(...m.p.map((p) => p.c)),
});
const bbAll = (ms: MarkQuad[]) => {
  const b = ms.map(bb);
  return { a0: Math.min(...b.map((x) => x.a0)), a1: Math.max(...b.map((x) => x.a1)), c0: Math.min(...b.map((x) => x.c0)), c1: Math.max(...b.map((x) => x.c1)) };
};
const rwWith = (length: number, width: number, heading = 360) => {
  const cfg = cloneConfig();
  cfg.world.airport.runway = { ...cfg.world.airport.runway, length, width, headingDeg: heading };
  return runwayFrame(cfg);
};

describe('FAA runway designators', () => {
  it('rounds the magnetic heading to tens, 36 for north, no leading zero', () => {
    expect(runwayDesignator(360)).toBe('36');
    expect(runwayDesignator(0)).toBe('36');
    expect(runwayDesignator(180)).toBe('18');
    expect(runwayDesignator(92)).toBe('9');
    expect(runwayDesignator(273)).toBe('27');
  });
  it('fuzz: always 1..36 and the reciprocal differs by 18', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 359.9, noNaN: true }), (h) => {
        const d = Number(runwayDesignator(h));
        const r = Number(runwayDesignator(h + 180));
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(36);
        expect(((d - r + 36) % 36)).toBe(18);
      }),
    );
  });
});

describe('piano-key threshold markings', () => {
  it('uses the FAA stripe count for the runway width (8 for a 100 ft class runway)', () => {
    expect(pianoKeyCount(60 * FT)).toBe(4);
    expect(pianoKeyCount(75 * FT)).toBe(6);
    expect(pianoKeyCount(30)).toBe(8);
    expect(pianoKeyCount(150 * FT)).toBe(12);
    expect(pianoKeyCount(200 * FT)).toBe(16);
  });
  it('paints 8 keys per end, 4 each side of the centreline, 150 ft long starting 20 ft in', () => {
    for (const end of ['36', '18']) {
      const keys = of('threshold', end);
      expect(keys.length).toBe(8);
      expect(keys.filter((k) => bb(k).c1 < 0).length).toBe(4);
      expect(keys.filter((k) => bb(k).c0 > 0).length).toBe(4);
      for (const k of keys) {
        const b = bb(k);
        expect(b.a1 - b.a0).toBeCloseTo(150 * FT, 3);
        expect(b.c1 - b.c0).toBeGreaterThan(1.5);
        expect(b.c1 - b.c0).toBeLessThanOrEqual(5.75 * FT + 1e-6);
        if (end === '36') expect(b.a0).toBeCloseTo(20 * FT, 3);
        else expect(b.a1).toBeCloseTo(L - 20 * FT, 3);
      }
      // symmetric about the centreline, twice the normal gap in the middle
      const cs = keys.map((k) => (bb(k).c0 + bb(k).c1) / 2).sort((x, y) => x - y);
      expect(cs.reduce((s, x) => s + x, 0)).toBeCloseTo(0, 6);
      const w = bb(keys[0]).c1 - bb(keys[0]).c0;
      const inner = keys.map(bb).filter((b) => b.c0 > 0).reduce((m, b) => Math.min(m, b.c0), Infinity);
      expect(inner * 2).toBeCloseTo(2 * w, 3);
      // equal spacing (= key width) between neighbours on one side
      const right = keys.map(bb).filter((b) => b.c0 > 0).sort((x, y) => x.c0 - y.c0);
      for (let i = 1; i < right.length; i++) expect(right[i].c0 - right[i - 1].c1).toBeCloseTo(w, 3);
    }
  });
});

describe('runway designators', () => {
  it('paints "36" 40 ft past the keys, 60 ft tall, 3 on the pilot\'s left', () => {
    const d = of('designator', '36');
    const b = bbAll(d);
    const start = (20 + 150 + 40) * FT;
    expect(b.a0).toBeCloseTo(start, 3);
    expect(b.a1).toBeCloseTo(start + 60 * FT, 3);
    for (const m of d.filter((q) => q.digit === '3')) expect(bb(m).c1).toBeLessThan(0);
    for (const m of d.filter((q) => q.digit === '6')) expect(bb(m).c0).toBeGreaterThan(0);
  });
  it('paints "18" at the far end facing the other way (1 on the east side)', () => {
    const d = of('designator', '18');
    const b = bbAll(d);
    const start = (20 + 150 + 40) * FT;
    expect(b.a1).toBeCloseTo(L - start, 3);
    expect(b.a0).toBeCloseTo(L - start - 60 * FT, 3);
    for (const m of d.filter((q) => q.digit === '1')) expect(bb(m).c0).toBeGreaterThan(0);
    for (const m of d.filter((q) => q.digit === '8')) expect(bb(m).c1).toBeLessThan(0);
  });
});

describe('centreline, touchdown zone, aiming point, side stripes', () => {
  it('dashes the centreline 120 ft on / ~80 ft off, 36 in wide, symmetric, clear of the designators', () => {
    const cl = of('centerline').map(bb).sort((x, y) => x.a0 - y.a0);
    expect(cl.length).toBeGreaterThan(15);
    for (const b of cl) {
      expect(b.a1 - b.a0).toBeCloseTo(120 * FT, 3);
      expect(b.c1 - b.c0).toBeCloseTo(36 * 0.0254, 3);
      expect((b.c0 + b.c1) / 2).toBeCloseTo(0, 6);
    }
    for (let i = 1; i < cl.length; i++) {
      const gap = cl[i].a0 - cl[i - 1].a1;
      expect(gap).toBeGreaterThan(80 * FT * 0.9);
      expect(gap).toBeLessThan(80 * FT * 1.15);
    }
    expect(cl[0].a0 + cl[cl.length - 1].a1).toBeCloseTo(L, 3);
    const d36 = bbAll(of('designator', '36'));
    expect(cl[0].a0 - d36.a1).toBeGreaterThanOrEqual(40 * FT - 1e-6);
  });
  it('puts TDZ bars at 500/1500/2000 ft (3/2/2 per side) and the aiming point at 1000 ft', () => {
    const tdz = of('tdz', '36').map(bb);
    const at = (ft: number) => tdz.filter((b) => Math.abs(b.a0 - ft * FT) < 0.01);
    expect(at(500).length).toBe(6);
    expect(at(1500).length).toBe(4);
    expect(at(2000).length).toBe(4);
    expect(tdz.length).toBe(14); // the 2500/3000 ft groups don't fit a 5250 ft runway
    for (const b of tdz) expect(b.a1 - b.a0).toBeCloseTo(75 * FT, 3);
    const ap = of('aiming', '36').map(bb);
    expect(ap.length).toBe(2);
    for (const b of ap) {
      expect(b.a0).toBeCloseTo(1000 * FT, 3);
      expect(b.a1 - b.a0).toBeCloseTo(150 * FT, 3);
      expect(b.c1 - b.c0).toBeGreaterThan(4);
    }
    expect(ap[0].c0 + ap[1].c1).toBeCloseTo(0, 6);
    // mirrored at the 18 end
    const tdz18 = of('tdz', '18').map(bb);
    expect(tdz18.length).toBe(14);
    expect(Math.max(...tdz18.map((b) => b.a1))).toBeCloseTo(L - 500 * FT, 3);
  });
  it('runs a side stripe along each edge, full length', () => {
    const e = of('edge').map(bb);
    expect(e.length).toBe(2);
    for (const b of e) {
      expect(b.a0).toBeCloseTo(0, 6);
      expect(b.a1).toBeCloseTo(L, 6);
      expect(Math.max(Math.abs(b.c0), Math.abs(b.c1))).toBeCloseTo(rw.halfWidth, 6);
      expect(b.c1 - b.c0).toBeCloseTo(MARKING.sideStripeWidth(rw.width), 6);
    }
  });
  it('keeps every runway marking white and inside the runway', () => {
    for (const m of all) {
      expect(m.color).toBe('white');
      const b = bb(m);
      expect(b.a0).toBeGreaterThanOrEqual(-1e-6);
      expect(b.a1).toBeLessThanOrEqual(L + 1e-6);
      expect(b.c0).toBeGreaterThanOrEqual(-rw.halfWidth - 1e-6);
      expect(b.c1).toBeLessThanOrEqual(rw.halfWidth + 1e-6);
    }
  });
  it('never overlaps two different runway markings (except strokes within one numeral)', () => {
    const rects = all.filter((m) => m.kind !== 'designator' && m.kind !== 'edge').map(bb);
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const x = rects[i], y = rects[j];
        const overlap = x.a0 < y.a1 - 1e-6 && y.a0 < x.a1 - 1e-6 && x.c0 < y.c1 - 1e-6 && y.c0 < x.c1 - 1e-6;
        expect(overlap).toBe(false);
      }
  });
  it('fuzz: for any runway 900-4000 m long and 18-60 m wide the markings fit and stay separated', () => {
    fc.assert(
      fc.property(fc.double({ min: 900, max: 4000, noNaN: true }), fc.double({ min: 18, max: 60, noNaN: true }), (len, wid) => {
        const r = rwWith(len, wid);
        const ms = runwayMarkings(r);
        const keys = ms.filter((m) => m.kind === 'threshold' && m.end === '36');
        expect(keys.length % 2).toBe(0);
        expect(keys.length).toBeGreaterThanOrEqual(4);
        for (const m of ms) {
          const b = bb(m);
          expect(b.a0).toBeGreaterThanOrEqual(-1e-6);
          expect(b.a1).toBeLessThanOrEqual(len + 1e-6);
          expect(Math.max(Math.abs(b.c0), Math.abs(b.c1))).toBeLessThanOrEqual(r.halfWidth + 1e-6);
        }
        // the two ends' touchdown-zone systems keep >= 900 ft between them
        const tz = ms.filter((m) => m.kind === 'tdz' || m.kind === 'aiming');
        const t36 = tz.filter((m) => m.end === '36').map(bb);
        const t18 = tz.filter((m) => m.end === '18').map(bb);
        if (t36.length && t18.length) expect(Math.min(...t18.map((b) => b.a0)) - Math.max(...t36.map((b) => b.a1))).toBeGreaterThanOrEqual(900 * FT - 1e-6);
        // centreline dashes never touch the designators or keys
        const cl = ms.filter((m) => m.kind === 'centerline').map(bb);
        const others = ms.filter((m) => m.kind === 'designator' || m.kind === 'threshold').map(bb);
        for (const a of cl) for (const b of others) expect(a.a0 < b.a1 && b.a0 < a.a1 && a.c0 < b.c1 && b.c0 < a.c1).toBe(false);
      }),
      { numRuns: 60 },
    );
  }, 30000); // ~0.6 s alone; generous under a loaded CPU
});

describe('taxiway, apron and car-park markings', () => {
  const layout = getLayout().airport;
  const plan = createAirportPlan(layout);
  const tx = taxiMarkings(plan);
  const center = (m: MarkQuad) => ({ a: m.p.reduce((s, p) => s + p.a, 0) / 4, c: m.p.reduce((s, p) => s + p.c, 0) / 4 });

  it('paints yellow taxiway centrelines on taxiway/apron pavement only, never on the runway', () => {
    const cl = tx.filter((m) => m.kind === 'taxi-centerline');
    expect(cl.length).toBeGreaterThan(20);
    for (const m of cl) {
      expect(m.color).toBe('yellow');
      const c = center(m);
      const k = pavementAt(plan, c.a, c.c);
      expect(k).not.toBeNull();
      expect(k).not.toBe('runway');
    }
  });
  it('paints hold-short markings across every connector: 2 solid lines on the taxiway side, 2 dashed on the runway side', () => {
    for (const h of plan.holdLines) {
      const ms = tx.filter((m) => m.kind === 'hold-short' && m.name === h.name && Math.sign(center(m).c) === Math.sign(h.c));
      const solid = ms.filter((m) => m.style === 'solid');
      const dashed = ms.filter((m) => m.style === 'dashed');
      expect(solid.length).toBe(2);
      expect(dashed.length).toBeGreaterThanOrEqual(8);
      const con = plan.connectors.find((k) => k.name === h.name)!;
      for (const m of solid) {
        const b = bb(m);
        expect(b.a0).toBeCloseTo(con.a - con.halfWidth, 1);
        expect(b.a1).toBeCloseTo(con.a + con.halfWidth, 1);
      }
      const sc = solid.map((m) => center(m).c);
      const dc = dashed.map((m) => center(m).c);
      // taxiway side = farther from the runway centreline
      expect(Math.min(...sc.map(Math.abs))).toBeGreaterThan(Math.max(...dc.map(Math.abs)));
      for (const m of ms) expect(m.color).toBe('yellow');
    }
  });
  it('paints a tie-down T at every parking spot, all on the apron', () => {
    const td = tx.filter((m) => m.kind === 'tiedown');
    expect(td.length).toBe(layout.parkingSpots.length * 2);
    for (const m of td) expect(pavementAt(plan, center(m).a, center(m).c)).toBe('apron');
  });
  it('paints white stall lines in the car park', () => {
    const cp = tx.filter((m) => m.kind === 'carpark');
    expect(cp.length).toBeGreaterThan(6);
    for (const m of cp) {
      expect(m.color).toBe('white');
      expect(pavementAt(plan, center(m).a, center(m).c)).toBe('carpark');
    }
  });
});
