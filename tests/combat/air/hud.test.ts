/**
 * The air-to-air parts of the weapons HUD: the Sidewinder stores line ("9M ×2"), the gun lead pipper
 * on a locked aircraft, the lock box / markers centred on an aircraft (its position is the box centre),
 * the kill toast naming the AIM-9. Real three.js cameras; the drawing is measured on the geometry ctx.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { A10_WEAPONS, CONFIG, F16_WEAPONS, type Config } from '../../../src/config';
import { getAircraftDef } from '../../../src/fleet';
import { createCombatWorld, emptyWeaponsStatus } from '../../../src/combat/world';
import type { WeaponsStatus } from '../../../src/combat/types';
import { computeHudLayout } from '../../../src/ui/hud';
import { createWeaponsHudFrame, createWeaponsHudModel, drawWeaponsHud, updateWeaponsHud, weaponsHudChanged, WEAPONS_HUD_KEY_LENGTH, type WeaponsHudFrame } from '../../../src/ui/weaponsHud';
import { missileShortName, missileStoresText, projectPoint, createScreenPt } from '../../../src/ui/weaponsHudMath';
import { killToastText } from '../../../src/ui/messages';
import { gunLead, newLead } from '../../../src/combat/air/lead';
import { geoCtx } from '../../ui/geoCtx';

const W = 1440;
const H = 900;
const F16 = getAircraftDef('f16').config;
const A10 = getAircraftDef('a10').config;

/** Jet at (0, 1500, 0) flying north at 200 m/s, level; exterior chase camera (a wide view). */
function setup(cfg: Config = F16, status: Partial<WeaponsStatus> = {}) {
  const cam = new THREE.PerspectiveCamera(60, W / H, 0.1, 90000);
  cam.position.set(0, 1504, 25);
  cam.lookAt(0, 1500, -1000);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const world = createCombatWorld(cfg);
  const f: WeaponsHudFrame = createWeaponsHudFrame();
  f.w = W;
  f.h = H;
  f.view = cam.matrixWorldInverse.elements;
  f.proj = cam.projectionMatrix.elements;
  f.exterior = true;
  f.hudBox = computeHudLayout(W, H, cfg, 'normal', 'jet').jet;
  f.ax = 0;
  f.ay = 1500;
  f.az = 0;
  f.vx = 0;
  f.vy = 0;
  f.vz = -200;
  f.weapons = cfg.weapons;
  f.status = { ...emptyWeaponsStatus(), ...status };
  f.targets = world.targets;
  f.classOf = world.classOf;
  const m = createWeaponsHudModel(cfg);
  const g = geoCtx();
  const run = () => {
    updateWeaponsHud(m, f, cfg);
    g.reset();
    drawWeaponsHud(g.ctx, m, cfg);
    return m;
  };
  return { cam, world, f, m, g, run };
}

const lockOn = (f: WeaponsHudFrame, id: number, rangeM: number) => {
  f.status.lock = { state: 'locked', targetId: id, progress: 1, rangeM, inRange: true };
};

describe('HUD: Sidewinders in the stores block', () => {
  it('"9M ×2" under the gun and Maverick lines; counts down with the status', () => {
    expect(missileShortName('AIM-9M Sidewinder')).toBe('9M');
    expect(missileStoresText(F16_WEAPONS.airMissiles!.name, 2)).toBe('9M ×2');
    const s = setup(F16);
    s.run();
    const texts = s.g.texts.map((t) => t.s);
    expect(texts).toContain('9M ×2');
    expect(texts).toContain('65D ×2');
    s.f.status.hasAirMissiles = true;
    s.f.status.airMissiles = 1;
    s.run();
    expect(s.g.texts.map((t) => t.s)).toContain('9M ×1');
    // stacked: 9M above 65D above KILLS, all left-aligned at the same x
    const y = (str: string) => s.g.texts.find((t) => t.s.startsWith(str))!.p.y;
    expect(y('9M')).toBeLessThan(y('65D'));
    expect(y('65D')).toBeLessThan(y('KILLS'));
    const a = setup(A10);
    a.run();
    expect(a.g.texts.map((t) => t.s)).toContain('9M ×2');
    // the model key notices the count change
    const key = new Float64Array(WEAPONS_HUD_KEY_LENGTH).fill(NaN);
    weaponsHudChanged(s.m, key);
    s.f.status.airMissiles = 0;
    s.run();
    expect(weaponsHudChanged(s.m, key)).toBe(true);
  });

  it('kill toast names the Sidewinder for an aircraft, the Maverick for a vehicle', () => {
    expect(killToastText('fighter', 'missile', F16_WEAPONS)).toBe('MiG-29 destroyed — AIM-9M');
    expect(killToastText('helo', 'gun', A10_WEAPONS)).toBe('Mi-24 destroyed — GAU-8');
    expect(killToastText('tank', 'missile', A10_WEAPONS)).toBe('T-72B destroyed — AGM-65D');
  });
});

describe('HUD: gun lead pipper on a locked aircraft', () => {
  it('a MiG crossing left to right 800 m ahead: the pipper sits ahead of it on the lead solution, IN RNG', () => {
    const s = setup(F16);
    const t = s.world.addTarget({ kind: 'fighter', position: { x: 0, y: 1500, z: -800 }, headingDeg: 90, velocity: { x: 180, y: 0, z: -40 }, orientation: { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, group: 'air' });
    lockOn(s.f, t.id, 800);
    s.run();
    const ld = s.m.lead;
    expect(ld.show).toBe(true);
    expect(ld.clamped).toBe(false);
    expect(ld.inRange).toBe(true);
    const tp = projectPoint(createScreenPt(), 0, 1500, -800, s.f.view, s.f.proj, W, H);
    expect(ld.x).toBeGreaterThan(tp.x + 20); // lead to the right (it flies right)
    // exactly where the lead solution projects
    const gun = F16_WEAPONS.gun!;
    const sol = gunLead(newLead(), { x: gun.muzzle.x, y: 1500 + gun.muzzle.y, z: gun.muzzle.z }, { x: 0, y: 0, z: -200 }, t.position, t.velocity, gun.muzzleVelocity, gun.dragK);
    const sp = projectPoint(createScreenPt(), sol.x, sol.y, sol.z, s.f.view, s.f.proj, W, H);
    expect(ld.x).toBeCloseTo(sp.x, 3);
    expect(ld.y).toBeCloseTo(sp.y, 3);
    expect(s.g.texts.map((x) => x.s)).toContain('IN RNG');
    // the lock box is centred on the aircraft's centre (no half-height lift as for a vehicle)
    expect(s.m.lock.show).toBe(true);
    expect(s.m.lock.y).toBeCloseTo(tp.y, 3);
    expect(s.m.lock.type).toBe('MiG-29');
  });

  it('no lead pipper beyond gun range, for a ground vehicle, or without a gun', () => {
    const s = setup(F16);
    const far = s.world.addTarget({ kind: 'fighter', position: { x: 0, y: 1500, z: -4000 }, headingDeg: 0, velocity: { x: 0, y: 0, z: -190 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' });
    lockOn(s.f, far.id, 4000);
    s.run();
    expect(s.m.lead.show).toBe(false);
    expect(s.m.lock.show).toBe(true);
    const tank = s.world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -900 }, headingDeg: 0, group: 'g' });
    lockOn(s.f, tank.id, 1700);
    s.run();
    expect(s.m.lead.show).toBe(false);
    const noGun = setup({ ...F16, weapons: { ...F16.weapons, gun: null } } as Config);
    const t = noGun.world.addTarget({ kind: 'helo', position: { x: 0, y: 1500, z: -600 }, headingDeg: 0, velocity: { x: 0, y: 0, z: -60 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' });
    lockOn(noGun.f, t.id, 600);
    noGun.run();
    expect(noGun.m.lead.show).toBe(false);
  });

  it('fuzz: any aircraft geometry — never NaN, a clamped pipper stays inside the display', () => {
    fc.assert(
      fc.property(
        fc.record({ x: fc.double({ min: -2500, max: 2500, noNaN: true }), y: fc.double({ min: -1000, max: 1000, noNaN: true }), z: fc.double({ min: -2500, max: 2500, noNaN: true }) }),
        fc.record({ x: fc.double({ min: -300, max: 300, noNaN: true }), y: fc.double({ min: -80, max: 80, noNaN: true }), z: fc.double({ min: -300, max: 300, noNaN: true }) }),
        (p, v) => {
          const s = setup(F16);
          const t = s.world.addTarget({ kind: 'fighter', position: { x: p.x, y: 1500 + p.y, z: p.z }, headingDeg: 0, velocity: v, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' });
          lockOn(s.f, t.id, Math.hypot(p.x, p.y, p.z));
          s.run();
          const ld = s.m.lead;
          if (ld.show) {
            expect(Number.isFinite(ld.x) && Number.isFinite(ld.y)).toBe(true);
            const d = s.m.display;
            expect(ld.x).toBeGreaterThanOrEqual(d.x - 1e-6);
            expect(ld.x).toBeLessThanOrEqual(d.x + d.w + 1e-6);
            expect(ld.y).toBeGreaterThanOrEqual(d.y - 1e-6);
            expect(ld.y).toBeLessThanOrEqual(d.y + d.h + 1e-6);
          }
          for (const a of s.g.arcs) expect(Number.isFinite(a.c.x) && Number.isFinite(a.c.y) && Number.isFinite(a.r)).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('HUD config', () => {
  it('lead ranges are sane', () => {
    const h = CONFIG.combat.air.hud;
    expect(h.leadInRangeM).toBeLessThan(h.leadMaxRangeM);
  });
});
