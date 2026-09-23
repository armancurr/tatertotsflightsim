import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createCombatWorld } from '../../../src/combat/world';
import { createRangeRuntime } from '../../../src/combat/targets/runtime';
import { planRange } from '../../../src/combat/targets/plan';
import { planToss, tossPose } from '../../../src/combat/targets/toss';
import { selectLod, createTargetsRenderer } from '../../../src/combat/targets/renderer';
import { buildClassModel, TARGET_KINDS } from '../../../src/combat/targets/models';
import { FxSim } from '../../../src/fx/sim';
import { mulberry32 } from '../../../src/combat/targets/rng';
import { CONFIG } from '../../../src/config';
import { fakeGround } from './support';

const site = { x: -1000, z: -6000, headingDeg: 350 };
const plan = planRange(fakeGround(), site);
const ground = { height: () => 50, normal: () => ({ x: 0, y: 1, z: 0 }) };
const kill = (w: ReturnType<typeof createCombatWorld>, id: number) =>
  w.applyHit(id, { weapon: 'missile', damage: 1e6, point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, time: 0 });

describe('turret toss (T-72 jack-in-the-box)', () => {
  it('flies 5–25 m up and lands within 30 m of the hull, at rest on the ground', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e9 }), fc.double({ min: 5, max: 25, noNaN: true }), (seed, apex) => {
        const rnd = mulberry32(seed);
        const p0 = new THREE.Vector3(10, 51.45, -20);
        const toss = planToss(0, p0, new THREE.Quaternion(), apex, rnd, () => 50);
        const pos = new THREE.Vector3();
        const q = new THREE.Quaternion();
        let top = -Infinity;
        for (let t = 0; t <= toss.flightS + 0.5; t += 0.02) {
          tossPose(toss, t, pos, q);
          top = Math.max(top, pos.y);
          expect(pos.y).toBeGreaterThan(49.9);
        }
        expect(tossPose(toss, toss.flightS + 1, pos, q)).toBe(true);
        expect(top - p0.y).toBeGreaterThan(apex * 0.9);
        expect(top - p0.y).toBeLessThan(apex * 1.05);
        expect(Math.hypot(pos.x - p0.x, pos.z - p0.z)).toBeLessThan(30);
        expect(pos.y).toBeCloseTo(50.45, 6);
      }),
      { numRuns: 200 },
    );
  });
});

describe('range runtime: wrecks', () => {
  it('a killed tank chars, settles and (70 %) tosses its turret; fire and smoke go on the fx sim', () => {
    const world = createCombatWorld();
    const sim = new FxSim(1);
    const rt = createRangeRuntime(world, ground, () => sim);
    rt.install(plan);
    const tanks = rt.vehicles.filter((v) => v.target.kind === 'tank');
    for (const v of tanks) kill(world, v.target.id);
    for (let k = 0; k < 100; k++) rt.update(0.05);
    for (const v of tanks) {
      expect(v.wreck).not.toBeNull();
      expect(v.view.char).toBeCloseTo(1, 6);
      expect(v.view.y).toBeLessThan(v.target.position.y);
      if (v.wreck!.toss) {
        expect(v.view.turretFree).toBe(true);
        expect(Math.hypot(v.view.turretPos.x - v.target.position.x, v.view.turretPos.z - v.target.position.z)).toBeLessThan(30);
      }
    }
    const tossed = tanks.filter((v) => v.wreck!.toss).length;
    expect(tossed).toBeGreaterThan(0);
    expect(sim.activeEmitters()).toBeGreaterThan(0);
    expect(rt.stats().fires).toBeLessThanOrEqual(CONFIG.combat.range.wreck.maxFires);
    expect(rt.stats().columns).toBeLessThanOrEqual(CONFIG.combat.range.wreck.maxColumns);
  });

  it('property: random hits, kills and resets keep dead ⇔ wreck, and a reset restores everything', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.record({ op: fc.constant('kill'), i: fc.nat(40) }), fc.record({ op: fc.constant('hit'), i: fc.nat(40), d: fc.double({ min: 0, max: 80, noNaN: true }) }), fc.record({ op: fc.constant('reset') }), fc.record({ op: fc.constant('step'), dt: fc.double({ min: 0, max: 2, noNaN: true }) })), { maxLength: 40 }), (ops) => {
        const world = createCombatWorld();
        const sim = new FxSim(3);
        const rt = createRangeRuntime(world, ground, () => sim);
        rt.install(plan);
        const n = rt.vehicles.length;
        for (const o of ops) {
          if (o.op === 'kill') kill(world, rt.vehicles[o.i % n].target.id);
          else if (o.op === 'hit') world.applyHit(rt.vehicles[o.i % n].target.id, { weapon: 'gun', damage: o.d, point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 }, time: 0, face: 'top' });
          else if (o.op === 'reset') rt.reset();
          else rt.update(o.dt);
          rt.update(0.016);
          for (const v of rt.vehicles) {
            expect(v.target.alive).toBe(v.wreck === null);
            expect(v.view.char > 0).toBe(!v.target.alive);
            expect(Number.isFinite(v.view.y)).toBe(true);
          }
        }
        rt.reset();
        rt.update(0.016);
        for (const v of rt.vehicles) {
          expect(v.target.alive && v.target.health === v.target.maxHealth).toBe(true);
          expect(v.wreck).toBeNull();
          expect(v.view.turretFree).toBe(false);
          expect(v.target.position.x).toBe(v.plan.x);
        }
      }),
      { numRuns: 60 },
    );
  });
});

describe('models, levels of detail and instancing', () => {
  it('LOD by distance with hysteresis', () => {
    const [a, b] = CONFIG.combat.range.lod;
    expect(selectLod(a * 0.5, 2)).toBe(0);
    expect(selectLod(a * 1.5, 0)).toBe(1);
    expect(selectLod(b * 1.5, 1)).toBe(2);
    expect(selectLod(a * 1.03, 0)).toBe(0); // inside the band: stays
    expect(selectLod(a * 0.97, 1)).toBe(1);
    expect(selectLod(b * 0.97, 2)).toBe(2);
  });

  it('every class builds at every LOD, far LODs are much cheaper, sizes match the hull boxes', () => {
    for (const k of TARGET_KINDS) {
      const tri = [0, 1, 2].map((l) => {
        const m = buildClassModel(k, l as 0 | 1 | 2);
        const bb = m.hull.boundingBox!;
        const cls = CONFIG.combat.targets[k];
        expect(bb.max.z - bb.min.z).toBeGreaterThan(cls.length * 0.85);
        expect(bb.max.x - bb.min.x).toBeLessThan(cls.width * 1.12);
        expect(bb.min.y).toBeGreaterThanOrEqual(-0.05);
        return (m.hull.getAttribute('position').count + (m.turret?.getAttribute('position').count ?? 0)) / 3;
      });
      expect(tri[2]).toBeLessThan(tri[0] * 0.35);
      expect(tri[0]).toBeLessThan(12000);
    }
  });

  it('instances: one per vehicle per part at its LOD, ≤ 30 meshes', () => {
    const world = createCombatWorld();
    const rt = createRangeRuntime(world, ground, () => null);
    rt.install(plan);
    const counts: Record<string, number> = {};
    for (const v of plan.vehicles) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
    const r = createTargetsRenderer(counts);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(site.x, 3000, site.z);
    cam.updateMatrixWorld();
    r.update(cam, rt.views);
    const c = r.counts();
    const hulls = Object.entries(c).filter(([k]) => k.includes('.hull.')).reduce((s, [, n]) => s + n, 0);
    expect(hulls).toBe(plan.vehicles.length);
    expect(Object.keys(c).every((k) => k.endsWith('.2'))).toBe(true);
    expect(r.activeMeshes()).toBeLessThanOrEqual(30);
    r.dispose();
  });
});
