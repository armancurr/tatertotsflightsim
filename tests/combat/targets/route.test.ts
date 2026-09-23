/** The column drives the real farm lane: route finding in the plan (fake grounds with a lane). */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planRange } from '../../../src/combat/targets/plan';
import { makePath, nearestOnPath, sampleAt, newPathSample } from '../../../src/combat/targets/path';
import { CONFIG } from '../../../src/config';
import { fakeGround } from './support';

const R = CONFIG.combat.range;
const site = { x: -1000, z: -6000, headingDeg: 350 };
const N = R.convoy.kinds.length;
const COLUMN = (N - 1) * R.convoy.spacing;

/** A straight lane through the site (bearing `brg`), `half` m each way. */
function lane(brg: number, half = 900, off = 0) {
  const h = (brg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const cx = site.x + fz * off;
  const cz = site.z - fx * off;
  const points = [];
  for (let s = -half; s <= half; s += 25) points.push({ x: cx + fx * s, z: cz + fz * s });
  return { kind: 'drive', width: 3.6, points };
}

describe('the farm lane route', () => {
  it('drives the lane: the column sits on it, front first, spaced, heading along it, with turning places at both ends', { timeout: 30000 }, () => {
    const g = { ...fakeGround(), roads: [lane(60)] };
    const plan = planRange(g, site);
    expect(plan.track?.kind).toBe('lane');
    const path = makePath(plan.track!.points, false);
    const [lo, hi] = plan.track!.ends!;
    expect(lo).toBeGreaterThanOrEqual(R.route.endMargin - 1e-6);
    expect(hi).toBeLessThanOrEqual(path.length - R.route.endMargin + 1e-6);
    expect(hi - lo - COLUMN).toBeGreaterThanOrEqual(150);
    const convoy = plan.vehicles.filter((v) => v.group === 'convoy').sort((a, b) => a.slot - b.slot);
    expect(convoy).toHaveLength(N);
    for (const v of convoy) {
      expect(nearestOnPath(path, v.x, v.z).d).toBeLessThan(0.5);
      expect(Math.abs(((v.headingDeg - 60 + 540) % 360) - 180)).toBeLessThan(1);
      expect(v.s).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(v.s).toBeLessThanOrEqual(hi + 1e-6);
    }
    for (let k = 1; k < N; k++) expect(convoy[k - 1].s - convoy[k].s).toBeCloseTo(R.convoy.spacing, 6);
    // parked groups keep well off the lane
    for (const v of plan.vehicles.filter((q) => q.group !== 'convoy')) expect(nearestOnPath(path, v.x, v.z).d).toBeGreaterThan(R.convoy.scatter[1]);
  });

  it('avoids farm yards and trees: the lane is cut where it enters a yard, and no turning place has a tree within reach', { timeout: 30000 }, () => {
    const yard = { x: site.x + Math.sin((60 * Math.PI) / 180) * 700, z: site.z - Math.cos((60 * Math.PI) / 180) * 700 };
    const tree = { x: site.x - Math.sin((60 * Math.PI) / 180) * 690 + 3, z: site.z + Math.cos((60 * Math.PI) / 180) * 690 };
    const g = {
      ...fakeGround({
        keepOut: (x, z) => (Math.hypot(x - yard.x, z - yard.z) < 75 ? 2 : 0),
        obstacle: (x, z) => (Math.hypot(x - tree.x, z - tree.z) < 3 ? 70 : -Infinity),
      }),
      roads: [lane(60)],
    };
    const plan = planRange(g, site);
    expect(plan.track?.kind).toBe('lane');
    for (const p of plan.track!.points) expect(Math.hypot(p.x - yard.x, p.z - yard.z)).toBeGreaterThanOrEqual(75 - 2);
    const path = makePath(plan.track!.points, false);
    const [lo, hi] = plan.track!.ends!;
    const smp = newPathSample();
    for (let k = 0; k < N; k++) {
      for (const s of [hi - k * R.convoy.spacing, lo + k * R.convoy.spacing]) {
        sampleAt(path, s, smp);
        expect(Math.hypot(smp.x - tree.x, smp.z - tree.z)).toBeGreaterThan(R.route.turnClear);
      }
    }
  });

  it('with no lane nearby (or one too short) it falls back to a trail loop', { timeout: 30000 }, () => {
    const far = planRange({ ...fakeGround(), roads: [lane(60, 900, 2500)] }, site);
    expect(far.track?.kind).toBe('loop');
    const short = planRange({ ...fakeGround(), roads: [lane(60, 200)] }, site);
    expect(short.track?.kind).toBe('loop');
  });

  it('property: any lane bearing/offset gives a lane route whose column never overlaps and stays on the lane', { timeout: 60000 }, () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 359 }), fc.integer({ min: -250, max: 250 }), (brg, off) => {
        const plan = planRange({ ...fakeGround(), roads: [lane(brg, 900, off)] }, site);
        expect(plan.track?.kind).toBe('lane');
        const path = makePath(plan.track!.points, false);
        for (const v of plan.vehicles.filter((q) => q.group === 'convoy')) expect(nearestOnPath(path, v.x, v.z).d).toBeLessThan(0.5);
      }),
      { numRuns: 8 },
    );
  });
});
