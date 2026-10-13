/**
 * The naval gunnery range (src/combat/navalRange.ts): its site in the real world (deep water, every
 * target / buoy / the tow ≥ 1.5 km from the sea-traffic routes, off Long Key), the targets as combat
 * targets any weapon can hit (the F-16's / A-10's guns and Mavericks included), anchored and bobbing,
 * the towed sled on its racetrack, sinking and respawning, the `?spawn=gunnery` start, and the
 * target models (sizes match their hit boxes).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG } from '../../src/config';
import { createCombatWorld } from '../../src/combat/world';
import { createGunneryRange, DRAFT, gunneryStart, GUNNERY_GROUP, planGunneryRange, racetrackAt, racetrackLength, rangeFootprint } from '../../src/combat/navalRange';
import { NAVAL_RANGE_BUILDERS } from '../../src/combat/render/navalRangeRender';
import { getLayout } from '../../src/world/layout';
import { createEnvironment } from '../../src/world/environment';
import { createMarina, defineRoutes } from '../../src/world/traffic/sea';
import type { SeaKind } from '../../src/combat/types';

const plan = planGunneryRange();
const G = CONFIG.combat.gunnery;

describe('gunnery range site', () => {
  const env = createEnvironment();
  const layout = getLayout();
  it('every target, buoy and the tow lie in open water at least 12 m deep (the hulks draw 5 m)', () => {
    for (const p of rangeFootprint(plan)) {
      expect(env.waterLevel(p.x, p.z)).not.toBeNull();
      expect(-env.groundHeight(p.x, p.z)).toBeGreaterThan(12);
    }
  });
  it('clear of the sea-traffic routes by ≥ 1.5 km and of Long Key by ≥ 1 km', () => {
    const routes = defineRoutes(layout, createMarina(layout));
    const pts: { x: number; z: number }[] = [];
    for (const r of routes) for (let i = 0; i < r.path.n; i++) pts.push({ x: r.path.x[i], z: r.path.z[i] });
    for (const p of rangeFootprint(plan)) {
      let d = Infinity;
      for (const q of pts) d = Math.min(d, Math.hypot(q.x - p.x, q.z - p.z));
      expect(d).toBeGreaterThanOrEqual(1500);
      for (const isl of layout.islands) expect(Math.hypot(isl.x - p.x, isl.z - p.z)).toBeGreaterThan(isl.radius + 1000);
    }
  });
  it('a ship starts 9 km off it in deep water, the range on its port beam; an aircraft 6 km south at 1,500 ft', () => {
    const s = gunneryStart(true);
    expect(Math.hypot(s.x - G.center.x, s.z - G.center.z)).toBeCloseTo(G.shipStandoffM, 0);
    expect(-env.groundHeight(s.x, s.z)).toBeGreaterThan(30);
    expect(s.headingDeg).toBe(90);
    const a = gunneryStart(false);
    expect(a.aglFt).toBe(1500);
    expect(a.headingDeg).toBe(0);
  });
});

describe('gunnery range runtime', () => {
  it('registers rafts, hulks and the sled with the combat world, keel below the waterline', () => {
    const world = createCombatWorld();
    const r = createGunneryRange(world);
    r.install();
    r.install();
    const kinds = world.targets.map((t) => t.kind).sort();
    expect(kinds).toEqual(['hulk', 'hulk', 'raft', 'raft', 'raft', 'raft', 'sled']);
    for (const t of world.targets) {
      expect(t.group).toBe(GUNNERY_GROUP);
      expect(t.position.y).toBeCloseTo(-DRAFT[t.kind as SeaKind], 6);
      expect(world.isAir(t)).toBe(false);
    }
  });

  it('shootable by everything: a 30 mm burst chews a raft, a Maverick sinks it, the hulk shrugs off a few rounds', () => {
    const world = createCombatWorld();
    const r = createGunneryRange(world);
    r.install();
    const raft = world.targets.find((t) => t.kind === 'raft')!;
    const hulk = world.targets.find((t) => t.kind === 'hulk')!;
    // a strafing A-10 round from above hits the raft's box
    const c = world.centreOf(raft);
    const hit = world.raycast({ x: c.x, y: c.y + 400, z: c.z + 300 }, { x: c.x, y: c.y - 5, z: c.z - 10 });
    expect(hit?.target.id).toBe(raft.id);
    world.applyHit(raft.id, { weapon: 'gun', damage: 10, point: c, direction: { x: 0, y: -0.8, z: -0.6 }, time: 0 });
    expect(raft.health).toBe(raft.maxHealth - 10);
    world.applyHit(hulk.id, { weapon: 'gun', damage: 10, point: world.centreOf(hulk), direction: { x: 1, y: 0, z: 0 }, time: 0 });
    expect(hulk.maxHealth - hulk.health).toBeCloseTo(5, 6); // ship steel halves the 30 mm
    expect(world.applyHit(raft.id, { weapon: 'missile', damage: 400, point: c, direction: { x: 0, y: -1, z: 0 }, time: 1 }).destroyed).toBe(true);
    // one direct 16-inch hit sinks a raft; the hulk needs a few
    expect(CONFIG.combat.targets.raft.health).toBeLessThanOrEqual(2000);
    expect(CONFIG.combat.targets.hulk.health).toBeGreaterThan(2 * 2000);
    expect(CONFIG.combat.targets.hulk.health).toBeLessThanOrEqual(3 * 2000);
  });

  it('the wreck sinks (and leaves play), a fresh target is in place after respawnS', () => {
    const world = createCombatWorld();
    const r = createGunneryRange(world);
    r.install();
    const rt = r.targets.find((t) => t.plan.kind === 'raft')!;
    expect(r.kill(rt.target.id, 0)).toBe(true);
    r.update(0.1, 0.1);
    expect(rt.phase).toBe('sinking');
    let t = 0.1;
    let lowest = 0;
    for (; t < G.sinkS.raft + 1; t += 0.25) {
      r.update(0.25, t);
      lowest = Math.max(lowest, rt.sink);
    }
    expect(rt.phase).toBe('sunk');
    expect(lowest).toBeGreaterThan(CONFIG.combat.targets.raft.height);
    expect(rt.target.position.y).toBeLessThan(-1000);
    // nothing to hit any more
    expect(world.raycast({ x: rt.x, y: 50, z: rt.z }, { x: rt.x, y: -10, z: rt.z })).toBeNull();
    for (; t < G.sinkS.raft + G.respawnS + 1; t += 0.5) r.update(0.5, t);
    expect(rt.phase).toBe('afloat');
    expect(rt.target.alive).toBe(true);
    expect(rt.target.health).toBe(rt.target.maxHealth);
    expect(rt.target.position.y).toBeCloseTo(-DRAFT.raft, 6);
  });

  it('a reset (or world.reviveAll) brings every target back afloat', () => {
    const world = createCombatWorld();
    const r = createGunneryRange(world);
    r.install();
    for (const t of r.targets) r.kill(t.target.id);
    r.update(5, 5);
    world.reviveAll();
    r.update(0.1, 5.1);
    expect(r.targets.every((t) => t.phase === 'afloat')).toBe(true);
    for (const t of r.targets) r.kill(t.target.id);
    r.update(1, 6);
    r.reset();
    expect(r.targets.every((t) => t.phase === 'afloat' && t.target.alive)).toBe(true);
  });

  it('bobs with the sea sampler; the anchored targets swing a little; the sled is towed at speed behind the tug', () => {
    const world = createCombatWorld();
    const r = createGunneryRange(world);
    r.install();
    const waves = { motion: (_x: number, _z: number, _h: number, _L: number, _B: number, o: { heave: number; pitch: number; roll: number }) => ((o.heave = 0.8), (o.pitch = 1.5), (o.roll = -2), undefined) };
    r.update(1 / 30, 100, waves);
    const raft = r.targets.find((t) => t.plan.kind === 'raft')!;
    expect(raft.y).toBeCloseTo(0.8, 6);
    expect(raft.target.position.y).toBeCloseTo(0.8 - DRAFT.raft, 6);
    expect(raft.rollDeg).toBeCloseTo(-2, 6);
    expect(Math.abs(raft.headingDeg - raft.plan.headingDeg)).toBeLessThanOrEqual(6);
    const sled = r.targets.find((t) => t.plan.kind === 'sled')!;
    const p0 = { x: sled.x, z: sled.z };
    for (let i = 0; i < 300; i++) r.update(1 / 30, 100 + i / 30);
    expect(Math.hypot(sled.x - p0.x, sled.z - p0.z)).toBeGreaterThan(G.tow.speed * 10 * 0.8);
    expect(Math.hypot(sled.target.velocity.x, sled.target.velocity.z)).toBeCloseTo(G.tow.speed, 5);
    expect(Math.hypot(r.tug.x - sled.x, r.tug.z - sled.z)).toBeLessThanOrEqual(G.tow.line + 1);
  });

  it('racetrack: continuous, closed, headings tangent to the path (fuzz)', () => {
    const L = racetrackLength(plan.tow);
    fc.assert(fc.property(fc.double({ min: -1e5, max: 1e5, noNaN: true }), (s) => {
      const a = racetrackAt(plan.tow, s);
      const b = racetrackAt(plan.tow, s + 1);
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1.01);
      const h = (a.headingDeg * Math.PI) / 180;
      const dir = { x: Math.sin(h), z: -Math.cos(h) };
      expect((b.x - a.x) * dir.x + (b.z - a.z) * dir.z).toBeGreaterThan(0.95);
      const c = racetrackAt(plan.tow, s + L);
      expect(Math.hypot(c.x - a.x, c.z - a.z)).toBeLessThan(1e-3 * Math.max(1, Math.abs(s) / 1000));
    }));
  });
});

describe('gunnery range models', () => {
  for (const kind of ['raft', 'hulk', 'sled'] as SeaKind[]) {
    it(`${kind}: fits its hit box (length × width, waterline to top) and stays under the triangle budget`, () => {
      const g = NAVAL_RANGE_BUILDERS[kind]();
      g.computeBoundingBox();
      const b = g.boundingBox as THREE.Box3;
      const cls = CONFIG.combat.targets[kind];
      expect(b.max.z - b.min.z).toBeGreaterThan(cls.length * 0.8);
      expect(b.max.z - b.min.z).toBeLessThan(cls.length * 1.1);
      expect(b.max.x - b.min.x).toBeLessThan(cls.width * 1.15);
      // the hulk's funnel cap and masts may stand a little above its box
      expect(b.max.y).toBeLessThan(cls.height - DRAFT[kind] + 2.5);
      expect(b.min.y).toBeGreaterThanOrEqual(-DRAFT[kind] - 0.5);
      const tris = (g.getAttribute('position').count / 3) | 0;
      expect(tris).toBeLessThan(6000);
      expect(g.getAttribute('color')).toBeTruthy();
      g.dispose();
    });
  }
  it('the tug and the buoys build', () => {
    for (const k of ['tug', 'buoy'] as const) {
      const g = NAVAL_RANGE_BUILDERS[k]();
      expect(g.getAttribute('position').count).toBeGreaterThan(30);
      g.dispose();
    }
  });
});
