import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import { buildRiverRibbon, riverPiers, RIVER_STRIDE, type RiverRibbon } from '../../../src/world/water/river';
import { getLayout, type River } from '../../../src/world/layout';
import { CONFIG } from '../../../src/config';

const L = getLayout();
const rv = L.rivers[0];
const W = CONFIG.world.water;
const opts = { seaLevel: L.seaLevel, coastZAt: L.coast.zAt, speed: W.riverSpeed, speedSteep: W.riverSpeedSteep, rapidsSlope: W.rapidsSlope, margin: 3 };
const rib = buildRiverRibbon(rv, opts);

const vx = (r: RiverRibbon, v: number) => r.position[v * 3];
const vy = (r: RiverRibbon, v: number) => r.position[v * 3 + 1];
const vz = (r: RiverRibbon, v: number) => r.position[v * 3 + 2];

describe('river ribbon', () => {
  it('is one continuous strip from the source to past the mouth', () => {
    const n = rib.sections;
    expect(n).toBeGreaterThan(rv.points.length * 0.95);
    expect(rib.position.length).toBe(n * 2 * 3);
    expect(rib.index.length).toBe((n - 1) * 6);
    for (const i of rib.index) expect(i).toBeLessThan(n * 2);
    // consecutive quads share their edge vertices: every section (but the ends) is used by two quads
    const uses = new Uint8Array(n * 2);
    for (const i of rib.index) uses[i]++;
    for (let v = 2; v < n * 2 - 2; v++) expect(uses[v]).toBeGreaterThanOrEqual(2);
    // starts at the source, ends in the sea beyond the coast
    const s0x = (vx(rib, 0) + vx(rib, 1)) / 2;
    const s0z = (vz(rib, 0) + vz(rib, 1)) / 2;
    expect(Math.hypot(s0x - rv.points[0].x, s0z - rv.points[0].z)).toBeLessThan(1e-3);
    const e = n - 1;
    const ez = (vz(rib, e * 2) + vz(rib, e * 2 + 1)) / 2;
    const ex = (vx(rib, e * 2) + vx(rib, e * 2 + 1)) / 2;
    expect(ez).toBeGreaterThan(L.coast.zAt(ex));
  });

  it('is as wide as the water plus the margin, centred on the channel, at the water level', () => {
    for (let i = 0; i < rib.sections; i++) {
      const a = i * 2;
      const b = a + 1;
      const w = Math.hypot(vx(rib, a) - vx(rib, b), vz(rib, a) - vz(rib, b));
      const hw = rib.attrs[a * RIVER_STRIDE];
      expect(hw).toBeCloseTo(rv.halfWidths[i], 4);
      expect(w).toBeCloseTo(2 * (hw + opts.margin), 2); // float32 positions ~10 km from the origin
      expect((vx(rib, a) + vx(rib, b)) / 2).toBeCloseTo(rv.points[i].x, 2);
      expect((vz(rib, a) + vz(rib, b)) / 2).toBeCloseTo(rv.points[i].z, 2);
      expect(vy(rib, a)).toBeCloseTo(rv.levels[i], 3);
      expect(vy(rib, b)).toBe(vy(rib, a));
      // the across vector is a unit vector pointing from the centre to the vertex
      const ax = rib.across[a * 2];
      const az = rib.across[a * 2 + 1];
      expect(Math.hypot(ax, az)).toBeCloseTo(1, 6);
      expect(ax * (vx(rib, a) - rv.points[i].x) + az * (vz(rib, a) - rv.points[i].z)).toBeGreaterThan(0);
    }
  });

  it('faces up everywhere and never folds', () => {
    for (let t = 0; t < rib.index.length; t += 3) {
      const [p, q, r] = [rib.index[t], rib.index[t + 1], rib.index[t + 2]];
      const ux = vx(rib, q) - vx(rib, p);
      const uz = vz(rib, q) - vz(rib, p);
      const wx = vx(rib, r) - vx(rib, p);
      const wz = vz(rib, r) - vz(rib, p);
      // y of (u × w) > 0 ⇔ counter-clockwise seen from above
      expect(uz * wx - ux * wz).toBeGreaterThan(0);
    }
  });

  it('flows downhill: flow coordinate and distance increase, speed and foam follow the slope', () => {
    let prevS = -1;
    let prevF = -1;
    let steepFoam = 0;
    let flatFoam = 0;
    for (let i = 0; i < rib.sections; i++) {
      const o = i * 2 * RIVER_STRIDE;
      const [, , flow, foam, s, fade, speed] = rib.attrs.subarray(o, o + RIVER_STRIDE);
      expect(s).toBeGreaterThan(prevS);
      expect(flow).toBeGreaterThan(prevF);
      prevS = s;
      prevF = flow;
      expect(speed).toBeGreaterThanOrEqual(W.riverSpeed - 1e-5); // float32 attributes
      expect(speed).toBeLessThanOrEqual(W.riverSpeedSteep + 1e-5);
      expect(foam).toBeGreaterThanOrEqual(0);
      expect(foam).toBeLessThanOrEqual(1);
      expect(fade).toBeGreaterThanOrEqual(0);
      expect(fade).toBeLessThanOrEqual(1);
      if (i > 4 && i < rv.points.length - 5) {
        const ds = Math.hypot(rv.points[i + 1].x - rv.points[i - 1].x, rv.points[i + 1].z - rv.points[i - 1].z);
        const slope = (rv.levels[i - 1] - rv.levels[i + 1]) / ds;
        const wide = (rv.levels[i - 4] - rv.levels[i + 4]) / (8 * 40);
        if (slope > 0.05) steepFoam = Math.max(steepFoam, foam);
        if (wide < 0.001) flatFoam = Math.max(flatFoam, foam); // flat all around (foam spreads ±2 sections)
      }
    }
    expect(steepFoam).toBeGreaterThan(0.8);
    expect(flatFoam).toBeLessThan(0.3);
    // fades out into the sea: opaque upstream, gone at the end
    expect(rib.attrs[5]).toBe(1);
    expect(rib.attrs[(rib.sections - 1) * 2 * RIVER_STRIDE + 5]).toBe(0);
  });

  it('carries the bend (inner bank side), turbidity and riffles per section', () => {
    const at = (i: number, k: number) => rib.attrs[i * 2 * RIVER_STRIDE + 8 + k];
    let left = 0;
    let right = 0;
    let agree = 0;
    for (let i = 3; i < rib.sections - 3; i++) {
      const b = at(i, 0);
      expect(b).toBeGreaterThanOrEqual(-1);
      expect(b).toBeLessThanOrEqual(1);
      expect(at(i, 1)).toBeGreaterThanOrEqual(0);
      expect(at(i, 1)).toBeLessThanOrEqual(1);
      expect(at(i, 2)).toBeGreaterThanOrEqual(0);
      expect(at(i, 2)).toBeLessThanOrEqual(1);
      // both vertices of a section agree
      for (let k = 0; k < 4; k++) expect(rib.attrs[(i * 2 + 1) * RIVER_STRIDE + 8 + k]).toBe(at(i, k));
      // the bend's sign: the centreline turns toward +across (n = (−tz, tx)) when b > 0
      const p0 = rv.points[i - 3];
      const p1 = rv.points[i];
      const p2 = rv.points[i + 3];
      const cross = (p1.x - p0.x) * (p2.z - p1.z) - (p1.z - p0.z) * (p2.x - p1.x);
      if (Math.abs(b) > 0.4) {
        if (Math.sign(cross) === Math.sign(b)) agree++; // (the smoothing windows differ at inflections)
        if (b > 0) left++;
        else right++;
      }
    }
    // a meandering river bends both ways, often enough for point bars
    expect(left).toBeGreaterThan(20);
    expect(right).toBeGreaterThan(20);
    expect(agree / (left + right)).toBeGreaterThan(0.95);
    // clear in the mountains, turbid in the plains
    expect(at(40, 1)).toBeLessThan(0.35);
    expect(at(rib.sections - 60, 1)).toBeGreaterThan(0.7);
  });

  it('puts bridge piers in the water', () => {
    expect(L.bridges.length).toBe(2);
    for (const b of L.bridges) {
      // nearest river section
      let best = 0;
      let bd = Infinity;
      rv.points.forEach((p, i) => {
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      const piers = riverPiers(b, rv.halfWidths[best]);
      expect(piers.length).toBe(2);
      for (const p of piers) {
        let dmin = Infinity;
        for (let i = Math.max(0, best - 5); i < Math.min(rv.points.length - 1, best + 5); i++) {
          const a = rv.points[i];
          const c = rv.points[i + 1];
          const ux = c.x - a.x;
          const uz = c.z - a.z;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.z - a.z) * uz) / (ux * ux + uz * uz)));
          dmin = Math.min(dmin, Math.hypot(p.x - a.x - ux * t, p.z - a.z - uz * t));
        }
        expect(dmin).toBeLessThan(rv.halfWidths[best] * 0.8);
      }
    }
  });

  it('fuzz: random meandering rivers give continuous, upward, correctly sized ribbons', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 120 }),
        fc.double({ min: 5, max: 60, noNaN: true }),
        fc.double({ min: 0, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 0.2, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        (n, hw, amp, grad, seed) => {
          const pts = Array.from({ length: n }, (_, i) => ({ x: amp * Math.sin(i * 0.15 + seed), z: -4000 + i * 40 }));
          const levels = pts.map((_, i) => Math.max(0, 200 - i * 40 * grad));
          const r: River = { name: 'fuzz', points: pts, levels, halfWidths: pts.map(() => hw), depths: pts.map(() => 3), valley: pts, valleyLevels: levels, source: pts[0], mouth: pts[n - 1] };
          const rb = buildRiverRibbon(r, { ...opts, coastZAt: () => 1e9 });
          expect(rb.sections).toBe(n);
          for (let t = 0; t < rb.index.length; t += 3) {
            const [p, q, s] = [rb.index[t], rb.index[t + 1], rb.index[t + 2]];
            const ux = vx(rb, q) - vx(rb, p);
            const uz = vz(rb, q) - vz(rb, p);
            const wx = vx(rb, s) - vx(rb, p);
            const wz = vz(rb, s) - vz(rb, p);
            expect(uz * wx - ux * wz).toBeGreaterThan(0);
          }
          for (let i = 0; i < n; i++) {
            const b = rb.attrs[i * 2 * RIVER_STRIDE + 8];
            expect(Math.abs(b)).toBeLessThanOrEqual(1);
            if (amp === 0) expect(b).toBe(0);
            const w = Math.hypot(vx(rb, i * 2) - vx(rb, i * 2 + 1), vz(rb, i * 2) - vz(rb, i * 2 + 1));
            expect(w).toBeCloseTo(2 * (hw + opts.margin), 2);
            for (const v of rb.attrs.subarray(i * 2 * RIVER_STRIDE, (i * 2 + 2) * RIVER_STRIDE)) expect(Number.isFinite(v)).toBe(true);
          }
        },
      ),
      fcParams(80),
    );
  });
});
