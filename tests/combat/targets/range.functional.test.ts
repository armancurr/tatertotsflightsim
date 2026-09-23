/** Functional: the whole range on the real world (heightfield, landcover, trees, farms, roads). */
import { describe, it, expect } from 'vitest';
import { createEnvironment } from '../../../src/world/environment';
import { findRangeSite } from '../../../src/combat/targets/site';
import { groundFromEnv, slopeDeg } from '../../../src/combat/targets/ground';
import { createRangeGround } from '../../../src/combat/targets/groundQuery';
import { planRange, rectsOverlap } from '../../../src/combat/targets/plan';
import { createCombatWorld } from '../../../src/combat/world';
import { createRangeRuntime } from '../../../src/combat/targets/runtime';
import { CONFIG } from '../../../src/config';

const R = CONFIG.combat.range;
const T = CONFIG.combat.targets;

describe('target range on the real world', () => {
  const env = createEnvironment();
  const site = findRangeSite(groundFromEnv(env));
  const g = createRangeGround(site);
  const plan = planRange(g, site);

  it('the site is open farmland in the distance band, near the preferred bearing', () => {
    expect(site.distance).toBeGreaterThanOrEqual(R.minDistance - 1);
    expect(site.distance).toBeLessThanOrEqual(R.maxDistance + 1);
    expect(Math.abs(((site.bearingDeg - R.bearingDeg + 540) % 360) - 180)).toBeLessThanOrEqual(R.search.bearingSpanDeg);
    expect(site.open).toBeGreaterThan(0.7);
  });

  it('places 20–26 vehicles, all on valid ground (not water/urban/forest, gentle slope, clear of trees), none overlapping, within the range radius', () => {
    expect(plan.vehicles.length).toBeGreaterThanOrEqual(20);
    expect(plan.vehicles.length).toBeLessThanOrEqual(26);
    for (const v of plan.vehicles) {
      const s = env.surfaceAt(v.x, v.z);
      expect(['water', 'urban', 'forest', 'runway', 'asphalt']).not.toContain(s);
      expect(env.waterLevel(v.x, v.z)).toBeNull();
      expect(slopeDeg(env.groundNormal(v.x, v.z))).toBeLessThanOrEqual(R.ground.maxSlopeDeg);
      expect(g.obstacle(v.x, v.z)).toBeLessThan(env.groundHeight(v.x, v.z) + 0.5);
      expect(Math.hypot(v.x - site.x, v.z - site.z)).toBeLessThan(R.radius + 200);
    }
    for (let i = 0; i < plan.vehicles.length; i++)
      for (let j = i + 1; j < plan.vehicles.length; j++) {
        const a = plan.vehicles[i];
        const b = plan.vehicles[j];
        expect(rectsOverlap({ x: a.x, z: a.z, h: a.headingDeg, hl: T[a.kind].length / 2, hw: T[a.kind].width / 2 }, { x: b.x, z: b.z, h: b.headingDeg, hl: T[b.kind].length / 2, hw: T[b.kind].width / 2 }, 1)).toBe(false);
      }
    const kinds = new Set(plan.vehicles.map((v) => v.kind));
    for (const k of ['tank', 'ifv', 'apc', 'truck', 'aaa']) expect(kinds.has(k as never)).toBe(true);
  });

  it('is the same every load', () => {
    const again = planRange(createRangeGround(site), site);
    expect(again.vehicles).toEqual(plan.vehicles);
    expect(again.track?.points.length ?? 0).toBe(plan.track?.points.length ?? 0);
  });

  it('registers every vehicle with the combat world at ground level, and a wreck + reset round trip restores it', () => {
    const world = createCombatWorld();
    const rt = createRangeRuntime(world, { height: env.groundHeight, normal: env.groundNormal }, () => null);
    rt.install(plan);
    expect(world.targets).toHaveLength(plan.vehicles.length);
    for (const t of world.targets) expect(t.position.y).toBeCloseTo(env.groundHeight(t.position.x, t.position.z), 6);
    for (let k = 0; k < 600; k++) rt.update(0.1); // 60 s
    const id = world.targets[3].id;
    world.applyHit(id, { weapon: 'missile', damage: 1e6, point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, time: 1 });
    rt.update(0.1);
    expect(rt.vehicles[3].wreck).not.toBeNull();
    rt.reset();
    expect(world.targets.every((t) => t.alive)).toBe(true);
    expect(rt.vehicles.every((v) => v.wreck === null)).toBe(true);
    rt.vehicles.forEach((v) => {
      expect(v.target.position.x).toBe(v.plan.x);
      expect(v.target.position.z).toBe(v.plan.z);
    });
  });
}, 120000);
