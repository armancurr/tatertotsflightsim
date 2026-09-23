/** The march column: driving, spacing, turning round at the ends, halting and scattering under fire, regrouping, reset. */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createConvoyDriver, hullsOverlap, type ConvoyRoute, type StaticHull } from '../../../src/combat/targets/convoy';
import { makePath, resample } from '../../../src/combat/targets/path';
import { rectsOverlap } from '../../../src/combat/targets/plan';
import { CONFIG } from '../../../src/config';

const C = CONFIG.combat.range.convoy;
const KINDS = C.kinds;
const N = KINDS.length;
const COLUMN = (N - 1) * C.spacing;

/** A gently curving open lane ~1,100 m long with clearance `clear` m both sides. */
function laneRoute(clear = 30, len = 1100): ConvoyRoute {
  const pts = [];
  for (let s = 0; s <= len; s += 10) pts.push({ x: s, z: 40 * Math.sin(s / 260) });
  const path = makePath(resample(pts, 2, false), false);
  const sc = new Array(path.n).fill(clear);
  return { path, scatterL: sc, scatterR: sc.slice(), ends: [20, path.length - 20] };
}
function loopRoute(): ConvoyRoute {
  const pts = [];
  for (let k = 0; k < 360; k++) {
    const a = (k / 360) * Math.PI * 2;
    pts.push({ x: 330 * Math.cos(a), z: 230 * Math.sin(a) });
  }
  const path = makePath(resample(pts, 2, true), true);
  const sc = new Array(path.n).fill(25);
  return { path, scatterL: sc, scatterR: sc.slice(), ends: null };
}
const column = (lead: number) => KINDS.map((kind, k) => ({ kind, slot: k, s: lead - k * C.spacing }));
const run = (d: ReturnType<typeof createConvoyDriver>, seconds: number, dt = 1 / 30, each?: () => void) => {
  for (let t = 0; t < seconds; t += dt) {
    d.update(dt);
    each?.();
  }
};

describe('hull overlap test', () => {
  it('property: agrees with the plan’s separating-axis test', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: -20, max: 20, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true })),
        ([x, z, ha, hb]) => {
          const a = { x: 0, z: 0, h: ha, hl: 3.5, hw: 1.8 };
          const b = { x, z, h: hb, hl: 3.7, hw: 1.3 };
          expect(hullsOverlap(0, 0, (ha * Math.PI) / 180, 3.5, 1.8, x, z, (hb * Math.PI) / 180, 3.7, 1.3, 0.5)).toBe(rectsOverlap(a, b, 0.5));
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the column drives the lane', () => {
  it('moves off, keeps its spacing at cruise speed, and follows the lane exactly', () => {
    const r = laneRoute();
    const d = createConvoyDriver(r, column(20 + COLUMN + 60));
    const s0 = d.units.map((u) => u.s);
    run(d, 25);
    expect(d.phase()).toBe('drive');
    for (let k = 0; k < N; k++) {
      const u = d.units[k];
      expect(u.s - s0[k]).toBeGreaterThan(80);
      expect(u.speed).toBeGreaterThan(C.speed * 0.8);
      expect(Math.abs(u.lat)).toBeLessThan(1e-6);
      if (k > 0) expect(Math.abs(d.units[k - 1].s - u.s - C.spacing)).toBeLessThan(3);
    }
    expect(d.units[0].odo).toBeGreaterThan(80);
  });

  it('stops at the end with every vehicle at its own place, pivots round and comes back tail first; then again at the other end', () => {
    const r = laneRoute();
    const [lo, hi] = r.ends!;
    const d = createConvoyDriver(r, column(hi - 200));
    let sawStop = false;
    run(d, 120, 1 / 30, () => {
      if (d.phase() === 'endStop' && !sawStop) {
        sawStop = true;
        d.units.forEach((u, k) => expect(u.s).toBeCloseTo(hi - k * C.spacing, 0));
      }
    });
    expect(sawStop).toBe(true);
    expect(d.dir()).toBe(-1);
    // everyone faces back down the lane now; the former tail leads
    for (const u of d.units) expect(u.dir).toBe(-1);
    const tail = d.units[N - 1];
    for (const u of d.units) expect(tail.s).toBeLessThanOrEqual(u.s + 1e-6);
    // drive down to the low end and turn again
    let t = 0;
    while (d.dir() === -1 && t < 400) {
      d.update(1 / 30);
      t += 1 / 30;
    }
    expect(d.dir()).toBe(1);
    // it stopped at the low end: the lead (the original tail) at lo, the rest at their spacing behind
    const ss = d.units.map((u) => u.s).sort((a, b) => a - b);
    ss.forEach((s, k) => expect(s).toBeCloseTo(lo + k * C.spacing, 0));
    expect(d.overlapping()).toBe(false);
  });

  it('on a closed loop it goes round and round with no stops', () => {
    const d = createConvoyDriver(loopRoute(), column(400).map((q) => ({ ...q, s: (q.s + 5000) % 5000 })));
    run(d, 400);
    expect(d.phase()).toBe('drive');
    for (const u of d.units) expect(u.odo).toBeGreaterThan(400 * C.speed * 0.8);
    expect(d.overlapping()).toBe(false);
  });
});

describe('under fire', () => {
  it('halts, then pulls off alternately left and right within the clearance, angled off the road', () => {
    const r = laneRoute(26);
    const d = createConvoyDriver(r, column(20 + COLUMN + 100));
    run(d, 20);
    d.alarm();
    run(d, 3);
    // braking: nobody still at cruise
    for (const u of d.units) expect(u.speed).toBeLessThan(C.speed * 0.6);
    run(d, 20);
    expect(d.phase()).toBe('contact');
    const sides = new Set<number>();
    for (const u of d.units) {
      expect(u.mode).toBe('cover');
      expect(Math.abs(u.lat)).toBeGreaterThanOrEqual(C.scatter[0] - 1);
      expect(Math.abs(u.lat)).toBeLessThanOrEqual(26);
      expect(u.speed).toBeLessThan(0.05);
      sides.add(Math.sign(u.lat));
    }
    expect(sides.size).toBe(2);
    expect(d.overlapping()).toBe(false);
  });

  it('a killed vehicle stays put; the rest regroup after regroupS, bypass the wreck and drive on', () => {
    const r = laneRoute();
    const d = createConvoyDriver(r, column(20 + COLUMN + 40));
    run(d, 10);
    d.kill(0);
    d.alarm();
    const wreck = { x: d.units[0].x, z: d.units[0].z };
    run(d, C.regroupS + 40);
    expect(d.units[0].x).toBe(wreck.x);
    expect(d.units[0].z).toBe(wreck.z);
    expect(['drive', 'regroup', 'endStop', 'turn']).toContain(d.phase());
    run(d, 90);
    // the survivors are back on the road and past the wreck
    const past = d.units.slice(1).filter((u) => u.s > d.units[0].s + 10);
    expect(past.length).toBeGreaterThan(0);
    expect(d.overlapping()).toBe(false);
  });

  it('with no room beside the road they stay on it (cover in place)', () => {
    const d = createConvoyDriver(laneRoute(3), column(20 + COLUMN + 100));
    run(d, 10);
    d.alarm();
    run(d, 15);
    for (const u of d.units) expect(Math.abs(u.lat)).toBeLessThan(1.5);
  });

  it('reset puts every vehicle back where it started, alive, in column', () => {
    const r = laneRoute();
    const init = column(20 + COLUMN + 100);
    const d = createConvoyDriver(r, init);
    run(d, 30);
    d.kill(3);
    d.alarm();
    run(d, 20);
    d.reset();
    d.units.forEach((u, k) => {
      expect(u.alive).toBe(true);
      expect(u.mode).toBe('column');
      expect(u.s).toBe(init[k].s);
      expect(u.lat).toBe(0);
      expect(u.speed).toBe(0);
    });
  });
});

describe('property: whatever happens, the column never overlaps and never leaves its ground', () => {
  it('random dt, alarms, kills and resets on lanes and loops', { timeout: 60000 }, () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 4, max: 32 }),
        fc.array(fc.record({ op: fc.constantFrom('step', 'step', 'step', 'alarm', 'kill', 'reset'), i: fc.integer({ min: 0, max: N - 1 }), t: fc.double({ min: 0.5, max: 40, noNaN: true }), dt: fc.double({ min: 0.005, max: 0.25, noNaN: true }) }), { maxLength: 14 }),
        (isLoop, clear, ops) => {
          const r = isLoop ? loopRoute() : laneRoute(clear);
          const init = isLoop ? column(400) : column(20 + COLUMN + 60);
          // a parked vehicle right beside the lane somewhere
          const statics: StaticHull[] = [{ x: 500, z: 40 * Math.sin(500 / 260) + 14, headingDeg: 90, halfL: 3.5, halfW: 1.8 }];
          const d = createConvoyDriver(r, init, isLoop ? [] : statics);
          const maxLat = isLoop ? 25 : clear;
          for (const o of ops) {
            if (o.op === 'alarm') d.alarm();
            else if (o.op === 'kill') d.kill(o.i);
            else if (o.op === 'reset') d.reset();
            else
              for (let t = 0; t < o.t; t += o.dt) {
                d.update(o.dt);
                for (const u of d.units) {
                  expect(Number.isFinite(u.x) && Number.isFinite(u.z) && Number.isFinite(u.headingDeg)).toBe(true);
                  expect(Math.abs(u.lat)).toBeLessThanOrEqual(maxLat + 0.5);
                  expect(u.s).toBeGreaterThanOrEqual(0);
                  expect(u.s).toBeLessThanOrEqual(r.path.length);
                }
              }
            expect(d.overlapping()).toBe(false);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
