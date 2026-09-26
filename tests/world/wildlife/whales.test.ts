import { describe, expect, it } from 'vitest';
import { createWhalePlan, newWhalePose, sequenceAt, whaleEvents, whalePose } from '../../../src/world/wildlife/whales';
import { exclusionAt, seaDepthAt } from '../../../src/world/wildlife/zones';
import { WILDLIFE } from '../../../src/world/wildlife/tuning';
import { water, zoneCtx } from './support';

const plan = createWhalePlan(zoneCtx, water);
const Z = WILDLIFE.zones;
const DAY = 86400;
const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('whales: placement', () => {
  it('builds every configured humpback (and the calf) offshore', () => {
    expect(plan.rejected).toEqual([]);
    const adults = plan.whales.filter((w) => w.calfOf < 0);
    expect(adults.length).toBe(WILDLIFE.whale.whales.length);
    expect(plan.whales.some((w) => w.calfOf >= 0)).toBe(true);
  });

  it('routes stay offshore (z > 11,500), deep, ≥ 4 km from the gunnery range and ≥ 1.5 km from the oil platform', () => {
    for (const w of plan.whales) {
      const r = w.route;
      for (let i = 0; i < r.n; i += 2) {
        const x = r.x[i];
        const z = r.z[i];
        expect(z, w.id).toBeGreaterThan(WILDLIFE.whale.minZ);
        expect(Math.hypot(x - Z.gunnery.x, z - Z.gunnery.z), w.id).toBeGreaterThanOrEqual(4000);
        expect(Math.hypot(x - Z.oilRig.x, z - Z.oilRig.z), w.id).toBeGreaterThanOrEqual(1500);
        expect(seaDepthAt(water, x, z), w.id).toBeGreaterThanOrEqual(WILDLIFE.whale.minDepth);
        expect(exclusionAt(zoneCtx, 'whale', x, z), w.id).toBeNull();
      }
    }
  });
});

describe('whales: motion', () => {
  it('is continuous: position, height, pitch, roll and arch (whole schedule cycle, 0.1 s steps)', () => {
    const a = newWhalePose();
    const b = newWhalePose();
    for (let i = 0; i < plan.whales.length; i++) {
      const w = plan.whales[i];
      whalePose(plan, i, 0, a);
      const span = Math.min(w.cycle, 7000);
      for (let t = 0.1; t < span; t += 0.1) {
        whalePose(plan, i, t, b);
        const ctx = `${w.id} t=${t.toFixed(1)} ${a.phase}→${b.phase}`;
        expect(Math.hypot(b.x - a.x, b.z - a.z), ctx).toBeLessThan(0.5);
        expect(Math.abs(b.dy - a.dy), ctx).toBeLessThan(1.6);
        expect(angle(b.pitch, a.pitch), ctx).toBeLessThan(6);
        expect(angle(b.roll, a.roll), ctx).toBeLessThan(10);
        expect(Math.abs(b.flex - a.flex), ctx).toBeLessThan(0.2);
        Object.assign(a, b);
      }
    }
  }, 30_000);

  it('spends most of its time under water; the body never flies higher than a breach', () => {
    const p = newWhalePose();
    for (let i = 0; i < plan.whales.length; i++) {
      let near = 0;
      let n = 0;
      for (let t = 0; t < 6000; t += 0.5) {
        whalePose(plan, i, t, p);
        expect(p.dy).toBeLessThan(0.4 * p.length);
        expect(p.dy).toBeGreaterThan(-30);
        if (p.dy > -1.5) near++;
        n++;
      }
      expect(near / n).toBeLessThan(0.3);
      expect(near).toBeGreaterThan(0);
    }
  });

  it('blows at every surfacing, lifts its flukes clear when it sounds, and breaches now and then', () => {
    const p = newWhalePose();
    const adult = plan.whales.findIndex((w) => w.calfOf < 0);
    const w = plan.whales[adult];
    let blows = 0;
    let breaches = 0;
    let flukes = 0;
    let fluke = false;
    let surfacings = 0;
    for (let t = 0; t < DAY / 4; t += 0.5) {
      // events in the last 0.5 s (each counted once)
      whaleEvents(plan, adult, t, 0.5, (kind) => {
        if (kind === 0) blows++;
        if (kind === 1) breaches++;
      });
      whalePose(plan, adult, t, p);
      // the tail tip (half a length aft, pitched) above the surface while sounding
      const tail = p.dy - Math.sin((p.pitch * Math.PI) / 180) * 0.5 * p.length;
      if (p.phase === 'sounding' && tail > 1) {
        if (!fluke) flukes++;
        fluke = true;
      } else fluke = false;
    }
    for (let t = 0; t < DAY / 4; ) {
      const s = sequenceAt(w, t);
      surfacings += s.seq.blows - (s.seq.breach ? 1 : 0);
      t += s.seq.duration - s.tau + 1e-3;
    }
    expect(Math.abs(blows - surfacings)).toBeLessThanOrEqual(6);
    expect(breaches).toBeGreaterThan(3);
    expect(flukes).toBeGreaterThan(20);
  });

  it('breaches clear most of the body', () => {
    const p = newWhalePose();
    const adult = plan.whales.findIndex((w) => w.calfOf < 0);
    let best = -99;
    for (let t = 0; t < DAY / 4; t += 0.2) {
      whalePose(plan, adult, t, p);
      if (p.phase === 'breach') best = Math.max(best, p.dy + Math.sin((p.pitch * Math.PI) / 180) * 0.5 * p.length);
    }
    // the rostrum ≥ half a body length out of the water
    expect(best).toBeGreaterThan(0.5 * plan.whales[adult].length);
  });

  it('the calf keeps to her side and never breaches', () => {
    const ci = plan.whales.findIndex((w) => w.calfOf >= 0);
    const mi = plan.whales[ci].calfOf;
    const c = newWhalePose();
    const m = newWhalePose();
    for (let t = 0; t < 20000; t += 3) {
      whalePose(plan, ci, t, c);
      whalePose(plan, mi, t, m);
      expect(c.phase).not.toBe('breach');
      expect(Math.hypot(c.x - m.x, c.z - m.z)).toBeLessThan(12);
      expect(Math.hypot(c.x - m.x, c.z - m.z)).toBeGreaterThan(4);
    }
  });

  it('is deterministic', () => {
    const plan2 = createWhalePlan(zoneCtx, water);
    const a = newWhalePose();
    const b = newWhalePose();
    for (let i = 0; i < plan.whales.length; i++) {
      for (const t of [0, 55.5, 1234.5, 99999]) {
        expect(whalePose(plan2, i, t, b)).toEqual(whalePose(plan, i, t, a));
      }
    }
  });
});
