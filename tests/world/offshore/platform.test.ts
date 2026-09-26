/**
 * "Tater Alpha" (src/world/offshore/platform.ts): where it stands (water depth, the traffic routes,
 * the islands), its obstacles (the topside wall down to the sea bed, the derrick, the flare boom),
 * the helideck as a landable deck cut out of the obstacles, and the environment's deck sources
 * (ground height, surface and normal on the deck; nothing changes elsewhere).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PLATFORM, createPlatformPhysics, helideckCircumradius, inOctagon, platformBoxes, platformFrame, platformLights, flareTipLocal } from '../../../src/world/offshore/platform';
import { PLATFORM_SITE, localToWorld, worldToLocal, siteFrame } from '../../../src/world/offshore/sites';
import { getHeightfield, terrainHeight } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import { createSeaPlan } from '../../../src/world/traffic/sea';
import { createEnvironment } from '../../../src/world/environment';
import { routePoints, minDistance } from './helpers';

const hf = getHeightfield();
const phys = createPlatformPhysics();
const F = platformFrame();
const W = (lx: number, lz: number) => localToWorld(F, lx, lz, { x: 0, z: 0 });

describe('site frames', () => {
  it('local ↔ world round-trips and bearing 90 is the identity', () => {
    fc.assert(fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }), (x, z, h) => {
      const f = siteFrame(100, -50, h);
      const w = localToWorld(f, x, z, { x: 0, z: 0 });
      const l = worldToLocal(f, w.x, w.z, { x: 0, z: 0 });
      expect(l.x).toBeCloseTo(x, 6);
      expect(l.z).toBeCloseTo(z, 6);
    }));
    const id = siteFrame(0, 0, 90);
    const p = localToWorld(id, 3, 4, { x: 0, z: 0 });
    expect(p.x).toBeCloseTo(3, 9);
    expect(p.z).toBeCloseTo(4, 9);
    // bearing 35: local +X points north-east (−z is north)
    const w = localToWorld(F, 10, 0, { x: 0, z: 0 });
    expect(w.x - F.x).toBeGreaterThan(0);
    expect(w.z - F.z).toBeLessThan(0);
  });
});

describe('platform placement', () => {
  it('stands in ≥ 40 m of water, and ≥ 38 m under every jacket leg at the sea bed', () => {
    expect(-terrainHeight(PLATFORM_SITE.x, PLATFORM_SITE.z)).toBeGreaterThanOrEqual(40);
    const L = PLATFORM.legs;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const d = (L.topY + 41) * L.batter;
      const w = W(sx * (L.x + d), sz * (L.z + d));
      expect(-terrainHeight(w.x, w.z)).toBeGreaterThanOrEqual(38);
      expect(hf.waterLevel(w.x, w.z)).toBe(0);
    }
  });

  it('keeps ≥ 1.35 km from every traffic route (the tanker lane and the fishing circle are 1.4 km off) and 2 km from the islands', () => {
    const plan = createSeaPlan(getLayout(), createEnvironment());
    expect(plan.rejected).toEqual([]);
    const pts = routePoints(plan);
    const t = PLATFORM.topside;
    let min = Infinity;
    for (const [lx, lz] of [[t.x0, t.z0], [t.x1, t.z0], [t.x1, t.z1], [t.x0, t.z1], [flareTipLocal().x, flareTipLocal().z]]) {
      const w = W(lx, lz);
      min = Math.min(min, minDistance(pts, w.x, w.z));
    }
    expect(min).toBeGreaterThanOrEqual(1350);
    for (const isl of getLayout().islands) expect(Math.hypot(isl.x - F.x, isl.z - F.z) - isl.radius).toBeGreaterThan(2000);
  });
});

describe('platform obstacles and the helideck', () => {
  it('the topside is solid (to above the weather deck) over its whole footprint, and nothing is solid 10 m outside it', () => {
    const t = PLATFORM.topside;
    for (let lx = t.x0 + 1; lx < t.x1; lx += 5)
      for (let lz = t.z0 + 1; lz < t.z1; lz += 5) {
        const w = W(lx, lz);
        if (inOctagon(lx - PLATFORM.helideck.cx, lz - PLATFORM.helideck.cz, PLATFORM.helideck.flats)) continue;
        expect(phys.obstacleTop(w.x, w.z)).toBeGreaterThanOrEqual(PLATFORM.weatherY);
      }
    for (const [lx, lz] of [[t.x0 - 10, 0], [t.x1 + 10, -5], [0, t.z0 - 10], [0, t.z1 + 10]]) {
      const w = W(lx, lz);
      expect(phys.obstacleTop(w.x, w.z)).toBe(-Infinity);
    }
  });

  it('the derrick crown, the cranes and the flare boom stand as tall as they are drawn', () => {
    const d = PLATFORM.derrick;
    const w = W(d.cx, d.cz);
    expect(phys.obstacleTop(w.x, w.z)).toBeGreaterThanOrEqual(d.floorY + d.height);
    const tip = flareTipLocal();
    const wt = W(tip.x, tip.z);
    expect(phys.obstacleTop(wt.x, wt.z)).toBeGreaterThanOrEqual(tip.y);
    expect(phys.flareTip.y).toBeCloseTo(tip.y, 6);
    // the flare burns ≥ 90 m from the helideck and downwind of it (local +X)
    expect(Math.hypot(tip.x - PLATFORM.helideck.cx, tip.z - PLATFORM.helideck.cz)).toBeGreaterThan(90);
    for (const c of PLATFORM.cranes) {
      const wc = W(c.cx, c.cz);
      expect(phys.obstacleTop(wc.x, wc.z)).toBeGreaterThanOrEqual(c.pedestalTop);
    }
  });

  it('the helideck: a deck at +51.5 m over its octagon, no obstacle there, nothing above deck level within 5 m of its edge', () => {
    const hd = PLATFORM.helideck;
    const c = W(hd.cx, hd.cz);
    expect(phys.helideckTop(c.x, c.z)).toBe(hd.y);
    expect(phys.obstacleTop(c.x, c.z)).toBe(-Infinity);
    expect(phys.helideck).toEqual({ x: c.x, y: hd.y, z: c.z });
    const R = helideckCircumradius();
    for (let a = 0; a < 360; a += 5) {
      for (const r of [0, 3, hd.flats / 2 - 0.2]) {
        const w = W(hd.cx + Math.cos((a * Math.PI) / 180) * r, hd.cz + Math.sin((a * Math.PI) / 180) * r);
        expect(phys.helideckTop(w.x, w.z)).toBe(hd.y);
        expect(phys.obstacleTop(w.x, w.z)).toBe(-Infinity);
      }
      // the obstacle-free zone round the deck: everything below the deck surface
      for (const r of [R + 0.5, R + 2.5, R + 5]) {
        const w = W(hd.cx + Math.cos((a * Math.PI) / 180) * r, hd.cz + Math.sin((a * Math.PI) / 180) * r);
        expect(phys.obstacleTop(w.x, w.z)).toBeLessThan(hd.y);
        expect(phys.helideckTop(w.x, w.z)).toBe(-Infinity);
      }
    }
  });

  it('the deck lies ≥ 8 m inside the solid footprint (a hull meets the wall long before it could sample the deck)', () => {
    const hd = PLATFORM.helideck;
    const R = helideckCircumradius();
    for (let a = 0; a < 360; a += 3) {
      for (let r = R; r <= R + 8; r += 0.5) {
        const w = W(hd.cx + Math.cos((a * Math.PI) / 180) * r, hd.cz + Math.sin((a * Math.PI) / 180) * r);
        if (phys.helideckTop(w.x, w.z) > -Infinity) continue;
        expect(phys.obstacleTop(w.x, w.z)).toBeGreaterThan(PLATFORM.weatherY);
      }
    }
  });

  it('the octagon test is a regular octagon with flats on the axes', () => {
    expect(inOctagon(10.9, 0, 22)).toBe(true);
    expect(inOctagon(11.1, 0, 22)).toBe(false);
    expect(inOctagon(0, -10.9, 22)).toBe(true);
    const d = (11 / Math.cos(Math.PI / 8)) * Math.SQRT1_2;
    expect(inOctagon(d * 0.98, d * 0.98, 22)).toBe(false);
    expect(inOctagon(7.7, 7.7, 22)).toBe(true);
  });

  it('every box is finite and the lights are on the structure (red obstruction on the derrick crown, green round the deck)', () => {
    for (const b of platformBoxes()) for (const v of [b.x0, b.x1, b.z0, b.z1, b.top]) expect(Number.isFinite(v)).toBe(true);
    const L = platformLights();
    expect(L.filter((l) => l.kind === 'perimeter').length).toBe(24);
    const crown = L.find((l) => l.kind === 'obstruction')!;
    expect(crown.y).toBeGreaterThan(PLATFORM.derrick.floorY + PLATFORM.derrick.height);
    for (const l of L.filter((q) => q.kind === 'perimeter')) expect(Math.abs(l.y - PLATFORM.helideck.y)).toBeLessThan(0.5);
  });
});

describe('environment deck and soft-obstacle sources', () => {
  it('a deck is a landable top only over the deck (the ground stays the terrain) and sets the surface', () => {
    const env = createEnvironment();
    env.registerDeckSource((x, z) => phys.helideckTop(x, z));
    const c = phys.helideck;
    expect(env.deckTop(c.x, c.z)).toBe(PLATFORM.helideck.y);
    expect(env.surfaceAt(c.x, c.z)).toBe('asphalt');
    expect(env.groundHeight(c.x, c.z)).toBe(terrainHeight(c.x, c.z));
    for (const [x, z] of [[c.x + 40, c.z], [0, 0], [-2400, 8000], [5000, -15000]]) {
      expect(env.deckTop(x, z)).toBe(-Infinity);
      expect(env.groundHeight(x, z)).toBe(terrainHeight(x, z));
    }
    expect(env.waterLevel(c.x, c.z)).toBe(0);
  });

  it('soft obstacles are their own list (obstacleTop ignores them)', () => {
    const env = createEnvironment();
    expect(env.softObstacleTop(1, 1)).toBe(-Infinity);
    env.registerSoftObstacleSource((x) => (x > 0 ? 3 : -Infinity));
    expect(env.softObstacleTop(1, 1)).toBe(3);
    expect(env.softObstacleTop(-1, 1)).toBe(-Infinity);
    expect(env.obstacleTop(1, 1)).toBe(-Infinity);
  });
});
