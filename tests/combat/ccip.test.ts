/**
 * Gun CCIP (the HUD pipper): where a round fired now lands. Unit + fast-check property: the CCIP
 * solved at the end of a frame equals the landing point of the zero-dispersion round the gun really
 * fires at the start of the next frame (same pose), over random dives, speeds, headings and banks,
 * on flat and hilly ground.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_WEAPONS, F16_WEAPONS, KT_TO_MS, FT_TO_M, type GunConfig } from '../../src/config';
import { computeCcip, newCcip } from '../../src/combat/ccip';
import { createCombatWorld } from '../../src/combat/world';
import { createGunnery, type GunPose } from '../../src/combat/gunnery';
import { surfaceHeight } from '../../src/combat/ground';
import { defaultControls, FLAT_ENV } from '../../src/physics';
import { quatFromEuler, bodyToWorld } from '../../src/physics/frames';
import type { Environment, Vec3 } from '../../src/types';
import type { CombatEvent } from '../../src/combat/types';
import { HILLY_ENV } from '../support/envs';
import { fcParams } from '../support/fc';

const GAU8 = A10_WEAPONS.gun!;

/** CCIP of a gun on an aircraft at `pose` moving at `vel` (what the gunnery computes each frame). */
function ccipFor(env: Environment, pose: GunPose, vel: Vec3, gun: GunConfig = GAU8) {
  const m = bodyToWorld(pose.orientation, gun.muzzle);
  const d = (gun.boresightDownDeg * Math.PI) / 180;
  const dir = bodyToWorld(pose.orientation, { x: 0, y: -Math.sin(d), z: -Math.cos(d) });
  const out = newCcip();
  const ok = computeCcip(env, pose.position.x + m.x, pose.position.y + m.y, pose.position.z + m.z, vel.x + gun.muzzleVelocity * dir.x, vel.y + gun.muzzleVelocity * dir.y, vel.z + gun.muzzleVelocity * dir.z, gun.dragK, out);
  return ok ? out : null;
}

/** Flight-path velocity for a dive of `diveDeg` on `headingDeg` at `kt`. */
function pathVel(headingDeg: number, diveDeg: number, kt: number): Vec3 {
  const h = (headingDeg * Math.PI) / 180, g = (diveDeg * Math.PI) / 180, v = kt * KT_TO_MS;
  return { x: Math.sin(h) * Math.cos(g) * v, y: -Math.sin(g) * v, z: -Math.cos(h) * Math.cos(g) * v };
}

describe('CCIP', () => {
  it('in a 30° dive from 1,500 ft the pipper is ≈ 0.9 km ahead on the ground', () => {
    const pose: GunPose = { position: { x: 0, y: 1500 * FT_TO_M, z: 0 }, orientation: quatFromEuler(0, -28, 0) };
    const c = ccipFor(FLAT_ENV, pose, pathVel(0, 30, 300));
    expect(c).not.toBeNull();
    expect(Math.abs(c!.y)).toBeLessThan(0.5);
    expect(Math.abs(c!.x)).toBeLessThan(0.5);
    expect(-c!.z).toBeGreaterThan(600);
    expect(-c!.z).toBeLessThan(1000);
    expect(c!.range).toBeGreaterThan(800);
    expect(c!.range).toBeLessThan(1200);
    expect(c!.time).toBeGreaterThan(0.6);
    expect(c!.time).toBeLessThan(1.5);
  });

  it('none in level flight at 1,500 ft or in a climb (the round would not land within 4 s / 5 km)', () => {
    const level: GunPose = { position: { x: 0, y: 1500 * FT_TO_M, z: 0 }, orientation: quatFromEuler(0, 3, 0) };
    expect(ccipFor(FLAT_ENV, level, pathVel(0, 0, 250))).toBeNull();
    const climb: GunPose = { position: { x: 0, y: 300, z: 0 }, orientation: quatFromEuler(0, 15, 0) };
    expect(ccipFor(FLAT_ENV, climb, pathVel(0, -12, 250))).toBeNull();
  });

  it('the 20 mm M61 round (more drag) lands short of the 30 mm one fired the same way', () => {
    const f16 = F16_WEAPONS.gun!;
    const pose: GunPose = { position: { x: 0, y: 700, z: 0 }, orientation: quatFromEuler(0, -28, 0) };
    const vel = pathVel(0, 30, 400);
    // Same muzzle and gun line; only the M61's muzzle velocity and drag.
    const a = ccipFor(FLAT_ENV, pose, vel, { ...GAU8, muzzleVelocity: f16.muzzleVelocity, dragK: f16.dragK });
    const b = ccipFor(FLAT_ENV, pose, vel, GAU8);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(-a!.z).toBeLessThan(-b!.z);
    expect(a!.time).toBeGreaterThan(b!.time);
  });

  it('property: the CCIP is where a zero-dispersion round fired now really lands (flat and hilly ground)', () => {
    fc.assert(
      fc.property(
        fc.record({
          heading: fc.double({ min: 0, max: 360, noNaN: true }),
          dive: fc.double({ min: 10, max: 45, noNaN: true }),
          aoa: fc.double({ min: -1, max: 6, noNaN: true }),
          bank: fc.double({ min: -30, max: 30, noNaN: true }),
          agl: fc.double({ min: 150, max: 1500, noNaN: true }),
          kt: fc.double({ min: 180, max: 450, noNaN: true }),
          hilly: fc.boolean(),
          x: fc.double({ min: -3000, max: 3000, noNaN: true }),
          z: fc.double({ min: -3000, max: 3000, noNaN: true }),
        }),
        (a) => {
          const env = a.hilly ? HILLY_ENV : FLAT_ENV;
          const y = surfaceHeight(env, a.x, a.z) + a.agl;
          const pose: GunPose = { position: { x: a.x, y, z: a.z }, orientation: quatFromEuler(a.heading, -a.dive + a.aoa, a.bank) };
          const vel = pathVel(a.heading, a.dive, a.kt);
          const world = createCombatWorld();
          const gun = { ...GAU8, dispersionMrad: 0 };
          const gn = createGunnery(world, env, { seed: 1 });
          gn.setGun(gun, 0);
          const events: CombatEvent[] = [];
          world.on((e) => events.push(e));
          const dt = 1 / 60;
          // Frame 0: no fire — the gunnery solves the CCIP at this pose.
          gn.update(pose, vel, dt, 0);
          const ccip = world.status.ccip ? { ...world.status.ccip } : null;
          fc.pre(ccip !== null);
          const inRange = ccipFor(env, pose, vel, gun);
          expect(inRange).not.toBeNull();
          // Frame 1: barrels already at speed, one round leaves at the start of the frame.
          gn.gunState.spin = 1;
          gn.gunState.rounds = 1;
          gn.adjustControls({ ...defaultControls(), trigger: true }, false, dt);
          const p1: GunPose = { position: { x: pose.position.x + vel.x * dt, y: pose.position.y + vel.y * dt, z: pose.position.z + vel.z * dt }, orientation: pose.orientation };
          gn.update(p1, vel, dt, dt);
          for (let i = 0; i < 400 && gn.pool.count > 0; i++) gn.update(p1, vel, dt, dt * (i + 2));
          const imp = events.find((e) => e.type === 'impact');
          expect(imp).toBeDefined();
          const p = imp!.type === 'impact' ? imp!.point : { x: 0, y: 0, z: 0 };
          const miss = Math.hypot(p.x - ccip!.x, p.y - ccip!.y, p.z - ccip!.z);
          expect(miss).toBeLessThan(2);
          // And it sits on the surface.
          expect(Math.abs(ccip!.y - surfaceHeight(env, ccip!.x, ccip!.z))).toBeLessThan(0.6);
        },
      ),
      fcParams(150),
    );
  });

  it('fuzz: never NaN, and either null or a point within 5 km slant range', () => {
    fc.assert(
      fc.property(
        fc.record({ heading: fc.double({ min: 0, max: 360, noNaN: true }), pitch: fc.double({ min: -89, max: 89, noNaN: true }), roll: fc.double({ min: -180, max: 180, noNaN: true }), agl: fc.double({ min: -5, max: 12000, noNaN: true }), vx: fc.double({ min: -400, max: 400, noNaN: true }), vy: fc.double({ min: -400, max: 400, noNaN: true }), vz: fc.double({ min: -400, max: 400, noNaN: true }) }),
        (a) => {
          const pose: GunPose = { position: { x: 100, y: surfaceHeight(HILLY_ENV, 100, -900) + a.agl, z: -900 }, orientation: quatFromEuler(a.heading, a.pitch, a.roll) };
          const c = ccipFor(HILLY_ENV, pose, { x: a.vx, y: a.vy, z: a.vz });
          if (!c) return;
          expect(Number.isFinite(c.x + c.y + c.z + c.range + c.time)).toBe(true);
          expect(c.range).toBeLessThanOrEqual(5000);
          expect(c.time).toBeLessThanOrEqual(4 + 1e-9);
        },
      ),
      fcParams(300),
    );
  });
});
