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

  it('the column drives the farm lane through the range: on the ground, never overlapping, halts and scatters when hit, reset restores', { timeout: 120000 }, () => {
    expect(plan.track?.kind).toBe('lane');
    const world = createCombatWorld();
    const rt = createRangeRuntime(world, { height: env.groundHeight, normal: env.groundNormal }, () => null);
    rt.install(plan);
    const d = rt.convoy!;
    expect(d).not.toBeNull();
    const col = rt.vehicles.filter((v) => v.unit >= 0);
    const start = col.map((v) => ({ x: v.target.position.x, z: v.target.position.z }));
    const check = () => {
      for (const v of col) {
        const p = v.target.position;
        expect(p.y).toBeCloseTo(env.groundHeight(p.x, p.z), 6);
        expect(env.waterLevel(p.x, p.z)).toBeNull();
        expect(['water', 'urban']).not.toContain(env.surfaceAt(p.x, p.z));
      }
      expect(d.overlapping()).toBe(false);
    };
    const phases = new Set<string>();
    for (let k = 0; k < 3000; k++) {
      rt.update(0.1); // 5 minutes: up the lane, turn round, back down
      phases.add(d.phase());
      if (k % 10 === 0) check();
    }
    expect([...phases]).toEqual(expect.arrayContaining(['drive', 'endStop', 'turn']));
    const moved = col.map((v, i) => Math.hypot(v.target.position.x - start[i].x, v.target.position.z - start[i].z));
    expect(Math.max(...col.map((v) => v.view.odo))).toBeGreaterThan(900);
    expect(moved.some((m) => m > 20)).toBe(true);
    // a kill: the column halts and scatters off the road; nobody leaves valid ground
    world.applyHit(col[2].target.id, { weapon: 'missile', damage: 1e6, point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, time: 1 });
    for (let k = 0; k < 300; k++) {
      rt.update(0.1);
      if (k % 5 === 0) check();
    }
    expect(d.phase()).toBe('contact');
    expect(col.filter((v) => v.target.alive).every((v) => Math.hypot(v.target.velocity.x, v.target.velocity.z) < 0.1)).toBe(true);
    rt.reset();
    col.forEach((v, i) => {
      expect(v.target.alive).toBe(true);
      expect(Math.hypot(v.target.position.x - start[i].x, v.target.position.z - start[i].z)).toBeLessThan(0.01);
    });
  });
}, 120000);
