import { describe, expect, it } from 'vitest';
import { emitFarWhaleSprite, emitSplash, SPLASH_COUNT, SPLASH_LIFE, SplashKind, type PointSink } from '../../../src/world/wildlife/splash';
import { createSeals } from '../../../src/world/wildlife/seals';
import { exclusionAt, seaDepthAt, swimmable } from '../../../src/world/wildlife/zones';
import { WILDLIFE } from '../../../src/world/wildlife/tuning';
import { toWorld } from '../../../src/world/traffic/sea';
import { marina, water, zoneCtx } from './support';

class Sink implements PointSink {
  pts: { x: number; y: number; z: number; a: number; size: number }[] = [];
  push(x: number, y: number, z: number, _r: number, _g: number, _b: number, a: number, size: number): boolean {
    this.pts.push({ x, y, z, a, size });
    return true;
  }
}
const ctx = { windX: 1, windZ: 0, drift: 2.8 };

describe('wildlife splashes (stateless particles)', () => {
  it('every kind stays within its particle budget and above the water line', () => {
    for (const kind of Object.values(SplashKind)) {
      for (let age = 0; age < SPLASH_LIFE[kind]; age += 0.1) {
        const s = new Sink();
        const n = emitSplash(s, kind, age, 100, 0.3, 200, 1, 42, ctx);
        expect(n).toBeLessThanOrEqual(SPLASH_COUNT[kind]);
        for (const p of s.pts) {
          expect(p.y).toBeGreaterThanOrEqual(0.3 - 1e-9);
          expect(p.a).toBeGreaterThan(0);
          expect(p.a).toBeLessThanOrEqual(1);
          expect(Number.isFinite(p.x + p.y + p.z + p.size)).toBe(true);
        }
      }
      // gone after its life
      expect(emitSplash(new Sink(), kind, SPLASH_LIFE[kind] + 0.01, 0, 0, 0, 1, 1, ctx)).toBe(0);
    }
  });

  it('is deterministic (same event key → same particles) and differs between events', () => {
    const a = new Sink();
    const b = new Sink();
    const c = new Sink();
    emitSplash(a, SplashKind.WhaleBreach, 1.3, 0, 0, 0, 1, 7, ctx);
    emitSplash(b, SplashKind.WhaleBreach, 1.3, 0, 0, 0, 1, 7, ctx);
    emitSplash(c, SplashKind.WhaleBreach, 1.3, 0, 0, 0, 1, 8, ctx);
    expect(b.pts).toEqual(a.pts);
    expect(c.pts).not.toEqual(a.pts);
  });

  it('a humpback blow is a tall column (≈ 4 m) that drifts downwind as it hangs', () => {
    const at = (age: number) => {
      const s = new Sink();
      emitSplash(s, SplashKind.WhaleBlow, age, 0, 0, 0, 1, 3, ctx);
      const n = s.pts.length;
      return { top: Math.max(...s.pts.map((p) => p.y)), meanX: s.pts.reduce((q, p) => q + p.x, 0) / n };
    };
    const early = at(0.9);
    const late = at(4);
    expect(early.top).toBeGreaterThan(0.75 * WILDLIFE.whale.blowHeight);
    expect(early.top).toBeLessThan(1.5 * WILDLIFE.whale.blowHeight);
    expect(late.meanX - early.meanX).toBeGreaterThan(3);
  });

  it('a breach throws water far higher than a dolphin splash', () => {
    const top = (kind: number, age: number) => {
      const s = new Sink();
      emitSplash(s, kind, age, 0, 0, 0, 1, 5, ctx);
      return Math.max(0, ...s.pts.map((p) => p.y));
    };
    expect(top(SplashKind.WhaleBreach, 0.8)).toBeGreaterThan(6);
    expect(top(SplashKind.DolphinSplash, 0.25)).toBeLessThan(1.5);
  });
});

describe('far whale events', () => {
  it('add one soft sprite per blow / breach only when seen from afar', () => {
    for (const kind of [SplashKind.WhaleBlow, SplashKind.WhaleBreach]) {
      const near = new Sink();
      expect(emitFarWhaleSprite(near, kind, 1, 0, 0, 0, 1, 60, ctx)).toBe(false);
      const far = new Sink();
      expect(emitFarWhaleSprite(far, kind, 1, 0, 0, 0, 1, 1500, ctx)).toBe(true);
      expect(far.pts.length).toBe(1);
      expect(far.pts[0].size).toBeGreaterThan(2);
      expect(far.pts[0].y).toBeGreaterThan(0);
    }
    expect(emitFarWhaleSprite(new Sink(), SplashKind.DolphinPuff, 0.2, 0, 0, 0, 1, 1500, ctx)).toBe(false);
  });
});

describe('seals', () => {
  it('haul out on Seal Rock just above the waterline, spaced apart', () => {
    const seals = createSeals((x, z) => water.groundHeight(x, z));
    expect(seals.length).toBe(WILDLIFE.seal.n);
    const R = WILDLIFE.seal.rock;
    for (const s of seals) {
      expect(Math.hypot(s.x - R.x, s.z - R.z)).toBeLessThan(R.r + 45);
      expect(s.y).toBeGreaterThanOrEqual(WILDLIFE.seal.minH);
      expect(s.y).toBeLessThanOrEqual(WILDLIFE.seal.maxH);
      for (const o of seals) if (o !== s) expect(Math.hypot(o.x - s.x, o.z - s.z)).toBeGreaterThan(3);
    }
  });
});

describe('wildlife zones', () => {
  it('names the exclusion zones', () => {
    const Z = WILDLIFE.zones;
    expect(exclusionAt(zoneCtx, 'dolphin', Z.gunnery.x, Z.gunnery.z)).toBe('gunnery');
    expect(exclusionAt(zoneCtx, 'gull', Z.gunnery.x + 1000, Z.gunnery.z)).toBe('gunnery');
    expect(exclusionAt(zoneCtx, 'whale', Z.oilRig.x + 500, Z.oilRig.z)).toBe('oilRig');
    expect(exclusionAt(zoneCtx, 'gull', Z.oilRig.x, Z.oilRig.z)).toBeNull();
    expect(exclusionAt(zoneCtx, 'dolphin', 11000, 10800)).toBe('windFarm');
    expect(exclusionAt(zoneCtx, 'dolphin', -2300, 8000)).toBe('jetSkiCourse');
    expect(exclusionAt(zoneCtx, 'dolphin', -1800, 11777)).toBe('island');
    const bw = toWorld(marina.frame, -350, 100);
    expect(exclusionAt(zoneCtx, 'dolphin', bw.x, bw.z)).toBe('marina');
  });

  it('land and shallow water are not swimmable; the open sea is', () => {
    expect(seaDepthAt(water, 0, 0)).toBe(-Infinity);
    expect(swimmable(zoneCtx, water, 'dolphin', 0, 0, 5)).toBe(false);
    expect(swimmable(zoneCtx, water, 'dolphin', -500, 9500, 5)).toBe(true);
    expect(swimmable(zoneCtx, water, 'whale', -500, 9500, 60)).toBe(false);
  });
});
