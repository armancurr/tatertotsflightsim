/**
 * The gun system core (src/combat/gunnery.ts + rounds.ts): gunFiring through adjustControls, round
 * spawning at the muzzle with sub-frame spacing, the live round pool (cap, drop after maxFlightS),
 * hits on targets / ground / water, HEI splash, ricochets off sloped front armour, events, the gun
 * fields of the weapons status, reload. Unit + fast-check fuzz.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_WEAPONS, F16_WEAPONS, CONFIG, type GunConfig } from '../../src/config';
import { createCombatWorld } from '../../src/combat/world';
import { createGunnery, type GunPose } from '../../src/combat/gunnery';
import { RoundPool, ROUND_TRACER, ROUND_HEI } from '../../src/combat/rounds';
import { defaultControls, FLAT_ENV } from '../../src/physics';
import { quatFromEuler, bodyToWorld } from '../../src/physics/frames';
import type { CombatEvent } from '../../src/combat/types';
import type { Environment, Vec3 } from '../../src/types';
import { fcParams } from '../support/fc';
import { newBallistic, flyUntil } from '../../src/combat/ballistics';

const GAU8 = A10_WEAPONS.gun!;
const M61 = F16_WEAPONS.gun!;

function rig(gun: GunConfig | null = GAU8, env: Environment = FLAT_ENV) {
  const world = createCombatWorld();
  const gn = createGunnery(world, env, { seed: 7 });
  gn.setGun(gun, 0);
  const events: CombatEvent[] = [];
  world.on((e) => events.push(e));
  return { world, gn, events };
}

const pose = (x: number, y: number, z: number, heading = 0, pitch = 0, roll = 0): GunPose => ({
  position: { x, y, z },
  orientation: quatFromEuler(heading, pitch, roll),
});

/**
 * CG height for a level, stationary gun (heading north) whose rounds pass `aimY` at `range` m:
 * the gun line's 2° depression, the muzzle offset and the gravity drop.
 */
function levelAim(range: number, aimY: number, gun: GunConfig = GAU8): number {
  const b = newBallistic();
  const d = (gun.boresightDownDeg * Math.PI) / 180;
  b.y = gun.muzzle.y;
  b.z = gun.muzzle.z;
  b.vy = -Math.sin(d) * gun.muzzleVelocity;
  b.vz = -Math.cos(d) * gun.muzzleVelocity;
  flyUntil(b, 1 / 240, gun.dragK, (s) => s.z <= -range, 5);
  return aimY - b.y;
}

/** Run `seconds` of frames with a fixed pose/velocity (the aircraft is moved along its velocity). */
function run(g: ReturnType<typeof rig>, p: GunPose, vel: Vec3, seconds: number, trigger: (t: number) => boolean, dt = 1 / 60, t0 = 0) {
  let t = t0;
  const n = Math.round(seconds / dt);
  let firingFrames = 0;
  for (let i = 0; i < n; i++) {
    const c = g.gn.adjustControls({ ...defaultControls(), trigger: trigger(t) }, false, dt);
    if (c.gunFiring) firingFrames++;
    p.position.x += vel.x * dt;
    p.position.y += vel.y * dt;
    p.position.z += vel.z * dt;
    t += dt;
    g.gn.update(p, vel, dt, t);
  }
  return { t, firingFrames };
}

describe('gunnery: controls, status, events', () => {
  it('adjustControls sets gunFiring only with the trigger held, barrels at speed, ammo left, not crashed', () => {
    const g = rig();
    const base = { ...defaultControls(), trigger: true };
    // Spin-up: not yet.
    expect(g.gn.adjustControls(base, false, 0.1).gunFiring).toBeFalsy();
    for (let i = 0; i < 10; i++) g.gn.adjustControls(base, false, 0.1);
    const c = g.gn.adjustControls(base, false, 1 / 60);
    expect(c.gunFiring).toBe(true);
    expect(c).not.toBe(base);
    expect(c.throttle).toBe(base.throttle);
    expect(g.gn.adjustControls(base, true, 1 / 60).gunFiring).toBeFalsy(); // crashed
    expect(g.gn.adjustControls({ ...base, trigger: false }, false, 1 / 60).gunFiring).toBeFalsy();
    g.gn.gunState.rounds = 0;
    expect(g.gn.adjustControls(base, false, 1 / 60).gunFiring).toBeFalsy(); // click
  });

  it('the Cessna (no gun) never fires and reports hasGun false', () => {
    const g = rig(null);
    for (let i = 0; i < 100; i++) expect(g.gn.adjustControls({ ...defaultControls(), trigger: true }, false, 1 / 60).gunFiring).toBeFalsy();
    g.gn.update(pose(0, 500, 0), { x: 0, y: 0, z: -60 }, 1 / 60, 1);
    expect(g.world.status.hasGun).toBe(false);
    expect(g.world.status.rounds).toBe(0);
    expect(g.world.status.ccip).toBeNull();
    expect(g.gn.pool.count).toBe(0);
  });

  it('writes only the gun fields of the status', () => {
    const g = rig();
    g.world.status.lock = { state: 'locked', targetId: 42, progress: 1, rangeM: 3000, inRange: true };
    g.world.status.missiles = 3;
    g.world.status.missilesInFlight = 1;
    run(g, pose(0, 800, 0), { x: 0, y: 0, z: -120 }, 1.5, () => true);
    const s = g.world.status;
    expect(s.hasGun).toBe(true);
    expect(s.gunName).toBe(GAU8.name);
    expect(s.maxRounds).toBe(GAU8.rounds);
    expect(s.rounds).toBeLessThan(GAU8.rounds);
    expect(s.gunSpin).toBe(1);
    expect(s.gunFiring).toBe(true);
    expect(s.lock).toEqual({ state: 'locked', targetId: 42, progress: 1, rangeM: 3000, inRange: true });
    expect(s.missiles).toBe(3);
    expect(s.missilesInFlight).toBe(1);
  });

  it('emits gunStart once per burst and gunStop with the rounds fired; counts stats.roundsFired', () => {
    const g = rig();
    run(g, pose(0, 800, 0), { x: 0, y: 0, z: -120 }, 2, (t) => t < 1.5);
    const starts = g.events.filter((e) => e.type === 'gunStart');
    const stops = g.events.filter((e) => e.type === 'gunStop');
    expect(starts).toHaveLength(1);
    expect(stops).toHaveLength(1);
    const fired = GAU8.rounds - g.world.status.rounds;
    expect(stops[0].type === 'gunStop' && stops[0].roundsFired).toBe(fired);
    expect(g.world.stats.roundsFired).toBe(fired);
    // ≈ (1.5 − 0.55) s × 65 rds/s
    expect(fired).toBeGreaterThan(58);
    expect(fired).toBeLessThan(66);
  });
});

describe('gunnery: rounds', () => {
  it('leave the muzzle along the (2° depressed) gun line, evenly spaced (no per-frame clumping)', () => {
    const g = rig({ ...GAU8, dispersionMrad: 0 });
    g.gn.gunState.spin = 1;
    const p = pose(0, 3000, 0);
    run(g, p, { x: 0, y: 0, z: 0 }, 0.5, () => true);
    const pool = g.gn.pool;
    expect(pool.count).toBeGreaterThan(25);
    const muzzle = bodyToWorld(p.orientation, GAU8.muzzle);
    const pts: { d: number; x: number; y: number; z: number }[] = [];
    for (let k = 0; k < pool.count; k++) {
      const i = pool.idx[k];
      const dx = pool.x[i] - (p.position.x + muzzle.x), dy = pool.y[i] - (p.position.y + muzzle.y), dz = pool.z[i] - (p.position.z + muzzle.z);
      pts.push({ d: Math.hypot(dx, dy, dz), x: dx, y: dy, z: dz });
      // On the gun line: 2° below the nose (plus a little gravity drop).
      const depress = Math.atan2(-dy, -dz) * (180 / Math.PI);
      expect(depress).toBeGreaterThan(GAU8.boresightDownDeg - 0.05);
      expect(depress).toBeLessThan(GAU8.boresightDownDeg + 0.3);
      expect(Math.abs(dx)).toBeLessThan(1e-6);
    }
    pts.sort((a, b) => a.d - b.d);
    const gaps = pts.slice(1).map((q, i) => q.d - pts[i].d);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    for (const gap of gaps.slice(0, 10)) expect(Math.abs(gap - mean) / mean).toBeLessThan(0.25);
    // ≈ 1,000 m/s ÷ 65 rds/s ≈ 15 m apart near the muzzle.
    expect(gaps[0]).toBeGreaterThan(13);
    expect(gaps[0]).toBeLessThan(16.5);
  });

  it('flags every tracerEvery-th round as a tracer and every 5th as HEI (combat mix)', () => {
    const g = rig();
    g.gn.gunState.spin = 1;
    run(g, pose(0, 3000, 0), { x: 0, y: 0, z: -100 }, 0.6, () => true);
    const pool = g.gn.pool;
    let tr = 0, hei = 0;
    for (let k = 0; k < pool.count; k++) {
      const f = pool.flags[pool.idx[k]];
      if (f & ROUND_TRACER) tr++;
      if (f & ROUND_HEI) hei++;
    }
    expect(tr / pool.count).toBeCloseTo(1 / GAU8.tracerEvery, 1);
    expect(hei / pool.count).toBeCloseTo(1 / 5, 1);
  });

  it('hit the ground (impact events with the surface type) and the water', () => {
    const g = rig();
    g.gn.gunState.spin = 1;
    run(g, pose(0, 300, 0, 0, -20), { x: 0, y: -40, z: -110 }, 2.5, (t) => t < 0.3);
    const imp = g.events.filter((e) => e.type === 'impact');
    expect(imp.length).toBeGreaterThan(10);
    for (const e of imp) if (e.type === 'impact') {
      expect(e.surface).toBe('runway');
      expect(e.targetId).toBeNull();
      expect(Math.abs(e.point.y)).toBeLessThan(0.6);
    }
    expect(g.gn.pool.count).toBe(0);
    const lake: Environment = { groundHeight: () => -5, surfaceAt: () => 'grass', waterLevel: () => 0 };
    const w = rig(GAU8, lake);
    w.gn.gunState.spin = 1;
    run(w, pose(0, 300, 0, 0, -20), { x: 0, y: -40, z: -110 }, 2.5, (t) => t < 0.1);
    const wi = w.events.filter((e) => e.type === 'impact');
    expect(wi.length).toBeGreaterThan(0);
    for (const e of wi) if (e.type === 'impact') expect(e.surface).toBe('water');
  });

  it('are dropped after maxFlightS', () => {
    const g = rig();
    g.gn.gunState.spin = 1;
    // Straight up from high above the ground: nothing to hit.
    run(g, pose(0, 20000, 0, 0, 89), { x: 0, y: 0, z: 0 }, 0.2, () => true);
    expect(g.gn.pool.count).toBeGreaterThan(0);
    run(g, pose(0, 20000, 0, 0, 89), { x: 0, y: 0, z: 0 }, GAU8.maxFlightS + 0.2, () => false, 1 / 60, 0.2);
    expect(g.gn.pool.count).toBe(0);
  });

  it('strike a truck: hit + impact events on the target, health drops, roundsHit counted', () => {
    const g = rig({ ...GAU8, dispersionMrad: 0 });
    const truck = g.world.addTarget({ kind: 'truck', position: { x: 0, y: 0, z: -600 }, headingDeg: 90, group: 't' });
    g.gn.gunState.spin = 1;
    // Aim at the middle of the truck's side, 600 m ahead.
    const y = levelAim(600 - 1.3, 1.4);
    run(g, pose(0, y, 0), { x: 0, y: 0, z: 0 }, 1.5, (t) => t < 0.2);
    const hits = g.events.filter((e) => e.type === 'hit');
    expect(hits.length).toBeGreaterThan(0);
    expect(truck.health).toBeLessThan(truck.maxHealth);
    const imp = g.events.filter((e) => e.type === 'impact' && e.surface === 'target');
    expect(imp.length).toBeGreaterThan(0);
    expect(imp.every((e) => e.type === 'impact' && e.targetId === truck.id)).toBe(true);
    expect(g.world.stats.roundsHit).toBeGreaterThan(0);
  });

  it('HEI rounds bursting on the ground next to a truck damage it (API rounds do not)', () => {
    const g = rig({ ...GAU8, dispersionMrad: 0 });
    const aim = { x: 0, z: -800 };
    // Truck 1.3 m beside the impact point (hull side at 1.3 m).
    const truck = g.world.addTarget({ kind: 'truck', position: { x: 1.3 + 2.55 / 2, y: 0, z: aim.z }, headingDeg: 0, group: 't' });
    g.gn.gunState.spin = 1;
    // Dive 45° straight at the aim point from ~500 m.
    const dist = 500;
    const p = pose(0, dist * Math.sin(Math.PI / 4), aim.z + dist * Math.cos(Math.PI / 4), 0, -45 + GAU8.boresightDownDeg);
    run(g, p, { x: 0, y: 0, z: 0 }, 1.5, (t) => t < 0.4);
    const hits = g.events.filter((e) => e.type === 'hit' && e.targetId === truck.id);
    const impacts = g.events.filter((e) => e.type === 'impact' && e.surface !== 'target');
    expect(impacts.length).toBeGreaterThan(8);
    expect(hits.length).toBeGreaterThan(0);
    // Only the HEI rounds (one in five) reach it.
    expect(hits.length).toBeLessThanOrEqual(Math.ceil(impacts.length / 5) + 1);
    expect(truck.health).toBeLessThan(truck.maxHealth);
  });

  it('API rounds glance off a tank’s sloped front armour at shallow angles (ricochet, no damage)', () => {
    const g = rig({ ...GAU8, dispersionMrad: 0 });
    // T-72 facing the shooter (north of it, facing south = 180°), level shot at its front at 1.1 m.
    const tank = g.world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -500 }, headingDeg: 180, group: 't' });
    g.gn.gunState.spin = 1;
    const y = levelAim(500 - 3.5, 1.1);
    run(g, pose(0, y, 0), { x: 0, y: 0, z: 0 }, 1.2, (t) => t < 0.3);
    const imp = g.events.filter((e) => e.type === 'impact' && e.targetId === tank.id);
    expect(imp.length).toBeGreaterThan(5);
    const ric = imp.filter((e) => e.type === 'impact' && e.ricochet);
    expect(ric.length).toBeGreaterThan(imp.length * 0.6);
    // Only the HEI ones (which burst instead of glancing) do anything, and that is little.
    expect(tank.health).toBeGreaterThan(tank.maxHealth * 0.9);
  });

  it('reload on reset: full drum, rounds in flight cleared, barrels stopped, reload event', () => {
    const g = rig();
    run(g, pose(0, 3000, 0), { x: 0, y: 0, z: -100 }, 1.5, () => true);
    expect(g.gn.pool.count).toBeGreaterThan(0);
    g.gn.reload(5);
    expect(g.world.status.rounds).toBe(GAU8.rounds);
    expect(g.gn.pool.count).toBe(0);
    expect(g.world.status.gunSpin).toBe(0);
    expect(g.world.status.gunFiring).toBe(false);
    expect(g.events.some((e) => e.type === 'reload')).toBe(true);
    // A burst in progress is closed with a gunStop first (so the audio stops).
    expect(g.events.filter((e) => e.type === 'gunStop')).toHaveLength(1);
  });

  it('aircraft change: loads that aircraft’s gun (F-16 M61A1: 511 rounds; Cessna: none)', () => {
    const g = rig();
    g.gn.setGun(M61, 1);
    g.gn.update(pose(0, 500, 0), { x: 0, y: 0, z: -100 }, 1 / 60, 1);
    expect(g.world.status.gunName).toBe(M61.name);
    expect(g.world.status.rounds).toBe(511);
    g.gn.setGun(null, 2);
    g.gn.update(pose(0, 500, 0), { x: 0, y: 0, z: -100 }, 1 / 60, 2);
    expect(g.world.status.hasGun).toBe(false);
  });
});

describe('round pool', () => {
  it('caps at its capacity (spawn returns −1 when full) and frees slots', () => {
    const p = new RoundPool(4);
    const a = [p.spawn(), p.spawn(), p.spawn(), p.spawn()];
    expect(new Set(a).size).toBe(4);
    expect(p.spawn()).toBe(-1);
    expect(p.count).toBe(4);
    p.removeAt(0);
    expect(p.count).toBe(3);
    expect(p.spawn()).toBeGreaterThanOrEqual(0);
    p.clear();
    expect(p.count).toBe(0);
  });

  it('the gunnery pool is CONFIG.combat.maxRounds and never exceeds it', () => {
    const g = rig({ ...GAU8, rateRps: 3000, maxFlightS: 60, rounds: 100000 });
    g.gn.gunState.spin = 1;
    run(g, pose(0, 30000, 0, 0, 80), { x: 0, y: 0, z: 0 }, 1, () => true);
    expect(g.gn.pool.capacity).toBe(CONFIG.combat.maxRounds);
    expect(g.gn.pool.count).toBeLessThanOrEqual(CONFIG.combat.maxRounds);
    expect(g.gn.pool.count).toBeGreaterThan(CONFIG.combat.maxRounds * 0.9);
  });

  it('fuzz: random attitudes, speeds, frame times and trigger patterns never produce NaN or break the cap', () => {
    fc.assert(
      fc.property(
        fc.record({
          heading: fc.double({ min: 0, max: 360, noNaN: true }),
          pitch: fc.double({ min: -85, max: 85, noNaN: true }),
          roll: fc.double({ min: -180, max: 180, noNaN: true }),
          agl: fc.double({ min: 2, max: 5000, noNaN: true }),
          speed: fc.double({ min: 0, max: 300, noNaN: true }),
        }),
        fc.array(fc.record({ dt: fc.double({ min: 0, max: 0.25, noNaN: true }), trigger: fc.boolean() }), { minLength: 1, maxLength: 80 }),
        (a, frames) => {
          const g = rig();
          const world = g.world;
          world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -300 }, headingDeg: a.heading, group: 't' });
          const p = pose(0, a.agl, 0, a.heading, a.pitch, a.roll);
          const fwd = bodyToWorld(p.orientation, { x: 0, y: 0, z: -1 });
          const vel = { x: fwd.x * a.speed, y: fwd.y * a.speed, z: fwd.z * a.speed };
          let t = 0;
          for (const f of frames) {
            g.gn.adjustControls({ ...defaultControls(), trigger: f.trigger }, false, f.dt);
            t += f.dt;
            g.gn.update(p, vel, f.dt, t);
            const pool = g.gn.pool;
            expect(pool.count).toBeLessThanOrEqual(pool.capacity);
            for (let k = 0; k < pool.count; k++) {
              const i = pool.idx[k];
              expect(Number.isFinite(pool.x[i] + pool.y[i] + pool.z[i] + pool.vx[i] + pool.vy[i] + pool.vz[i])).toBe(true);
            }
            const s = world.status;
            expect(s.rounds).toBeGreaterThanOrEqual(0);
            if (s.ccip) expect(Number.isFinite(s.ccip.x + s.ccip.y + s.ccip.z + (s.ccipRangeM ?? 0))).toBe(true);
          }
        },
      ),
      fcParams(120),
    );
  });
});
