import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { planRange, rectsOverlap } from '../../../src/combat/targets/plan';
import { footprintOk, openAt } from '../../../src/combat/targets/ground';
import { makePath, nearestOnPath } from '../../../src/combat/targets/path';
import { CONFIG } from '../../../src/config';
import { fakeGround } from './support';

const R = CONFIG.combat.range;
const T = CONFIG.combat.targets;
const site = { x: -1000, z: -6000, headingDeg: 350 };
const rect = (v: { kind: keyof typeof T; x: number; z: number; headingDeg: number }) => ({ x: v.x, z: v.z, h: v.headingDeg, hl: T[v.kind].length / 2, hw: T[v.kind].width / 2 });

function checkPlan(plan: ReturnType<typeof planRange>, g: ReturnType<typeof fakeGround>) {
  for (const v of plan.vehicles) {
    if (v.group !== 'convoy') {
      expect(footprintOk(g, v.x, v.z, v.headingDeg, T[v.kind].length, T[v.kind].width, 0, R)).toBe(true);
    }
    expect(Number.isFinite(v.x) && Number.isFinite(v.z) && Number.isFinite(v.headingDeg)).toBe(true);
  }
  for (let i = 0; i < plan.vehicles.length; i++)
    for (let j = i + 1; j < plan.vehicles.length; j++) expect(rectsOverlap(rect(plan.vehicles[i]), rect(plan.vehicles[j]), 0.5)).toBe(false);
}

describe('range plan on open ground', () => {
  it('lays out a track loop, a column on it, a platoon behind berms, an AAA site and a logistics park', { timeout: 30000 }, () => {
    const g = fakeGround();
    const plan = planRange(g, site);
    expect(plan.track?.kind).toBe('loop');
    const path = makePath(plan.track!.points, true);
    expect(path.length).toBeGreaterThan(R.track.minLength);
    const by = (grp: string) => plan.vehicles.filter((v) => v.group === grp);
    expect(by('convoy')).toHaveLength(R.convoy.kinds.length);
    expect(by('convoy').map((v) => v.kind)).toEqual(R.convoy.kinds);
    expect(by('platoon')).toHaveLength(R.platoon.count);
    expect(by('platoon').every((v) => v.kind === 'tank')).toBe(true);
    expect(by('aaa')).toHaveLength(R.aaa.count);
    expect(by('logistics').map((v) => v.kind)).toEqual(R.logistics.kinds);
    expect(plan.vehicles.length).toBeGreaterThanOrEqual(20);
    expect(plan.vehicles.length).toBeLessThanOrEqual(26);
    // the column is on the track, heading along it, 30–50 m apart
    for (const v of by('convoy')) expect(nearestOnPath(path, v.x, v.z).d).toBeLessThan(0.5);
    // parked groups keep clear of the track
    for (const v of plan.vehicles.filter((q) => q.group !== 'convoy')) expect(nearestOnPath(path, v.x, v.z).d).toBeGreaterThan(R.convoy.scatter[1]);
    // berms: one per platoon tank, three per ZSU revetment
    expect(plan.berms).toHaveLength(R.platoon.count + 3 * R.aaa.count);
    checkPlan(plan, g);
    // scatter clearances per station, bounded
    expect(plan.track!.scatterL).toHaveLength(plan.track!.points.length);
    expect(Math.max(...plan.track!.scatterL, ...plan.track!.scatterR)).toBeLessThanOrEqual(R.convoy.scatter[1]);
  });

  it('is deterministic', { timeout: 30000 }, () => {
    expect(planRange(fakeGround(), site)).toEqual({ ...planRange(fakeGround(), site), stats: expect.anything() });
  });

  it('property: with random woodlots every vehicle stands on clear open ground and no hulls overlap', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ x: fc.double({ min: -700, max: 700, noNaN: true }), z: fc.double({ min: -700, max: 700, noNaN: true }), r: fc.double({ min: 10, max: 90, noNaN: true }) }), { maxLength: 8 }), (woods) => {
        const inWood = (x: number, z: number) => woods.some((w) => Math.hypot(x - site.x - w.x, z - site.z - w.z) < w.r);
        const g = fakeGround({ surface: (x, z) => (inWood(x, z) ? 'forest' : 'field'), obstacle: (x, z) => (inWood(x, z) ? 80 : -Infinity) });
        const plan = planRange(g, site);
        for (const v of plan.vehicles) expect(openAt(g, v.x, v.z)).toBe(true);
        checkPlan(plan, g);
      }),
      { numRuns: 6 },
    );
  }, 120000);

  it('rectangles: overlap test', () => {
    expect(rectsOverlap({ x: 0, z: 0, h: 0, hl: 3, hw: 1.5 }, { x: 2.9, z: 0, h: 90, hl: 3, hw: 1.5 })).toBe(true);
    expect(rectsOverlap({ x: 0, z: 0, h: 0, hl: 3, hw: 1.5 }, { x: 4.6, z: 0, h: 0, hl: 3, hw: 1.5 })).toBe(false);
    expect(rectsOverlap({ x: 0, z: 0, h: 0, hl: 3, hw: 1.5 }, { x: 4.6, z: 0, h: 0, hl: 3, hw: 1.5 }, 1)).toBe(true);
  });
});
