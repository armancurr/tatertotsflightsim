/**
 * Functional: whole engagements against the enemy aircraft with the real weapons code.
 *  1. An F-16 chases a MiG-29, presses T (the arcade lock), Z (an AIM-9M) — the MiG breaks and pops
 *     flares, the Sidewinder kills it, the wreck falls and comes to rest on the ground.
 *  2. An A-10 600 m behind a Mi-24 holds the gun cross on the lead pipper (src/combat/air/lead.ts)
 *     and fires a GAU-8 burst — real ballistic rounds, dispersion, armour — and the Hind goes down.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import missilesModule from '../../../src/game/systems/missiles';
import { A10_WEAPONS } from '../../../src/config';
import { combatWorld, createCombatWorld } from '../../../src/combat/world';
import { createAirSquadron, type AirEntity } from '../../../src/combat/air/squadron';
import { createGunnery, type GunPose } from '../../../src/combat/gunnery';
import { gunLead, newLead } from '../../../src/combat/air/lead';
import type { PlayerInfo } from '../../../src/combat/air/pilot';
import { getAircraftDef } from '../../../src/fleet';
import { createInitialState, defaultControls, FLAT_ENV } from '../../../src/physics';
import { FxSim } from '../../../src/fx/sim';
import type { AircraftState, Quat, Vec3 } from '../../../src/types';
import type { CombatEvent } from '../../../src/combat/types';
import type { SystemContext, SystemFrame } from '../../../src/game/systems/types';

vi.setConfig({ testTimeout: 60_000 });

const RANGE = { x: -1516, z: -5287 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/** Orientation with the body −Z pointing from `from` to `to`, pitched up `upDeg` (gun depression). */
function pointAt(from: Vec3, to: Vec3, upDeg = 0): Quat {
  _m.lookAt(new THREE.Vector3(from.x, from.y, from.z), new THREE.Vector3(to.x, to.y, to.z), _up);
  _q.setFromRotationMatrix(_m);
  if (upDeg) _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (upDeg * Math.PI) / 180));
  return { x: _q.x, y: _q.y, z: _q.z, w: _q.w };
}

const playerOf = (s: { position: Vec3; velocity: Vec3; orientation: Quat }): PlayerInfo => {
  const q = s.orientation;
  return {
    x: s.position.x, y: s.position.y, z: s.position.z, vx: s.velocity.x, vy: s.velocity.y, vz: s.velocity.z,
    fx: -2 * (q.x * q.z + q.w * q.y), fy: -2 * (q.y * q.z - q.w * q.x), fz: -(1 - 2 * (q.x * q.x + q.y * q.y)),
  };
};

describe('functional: shooting down the enemy aircraft', () => {
  it('an F-16 locks a MiG-29 and an AIM-9M kills it; it breaks, pops flares, falls and leaves a wreck', async () => {
    const scene = new THREE.Scene();
    const world = combatWorld(scene);
    const fx = new FxSim(3);
    const sq = createAirSquadron({ world, ground: FLAT_ENV.groundHeight, range: RANGE, fx: () => fx });
    const def = getAircraftDef('f16');
    const ctx = { scene, env: FLAT_ENV, renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1440, 900) }, actions: { currentAircraft: () => def } } as unknown as SystemContext;
    const events: CombatEvent[] = [];
    world.on((e) => events.push(e));
    const base = createInitialState(FLAT_ENV, def.config);
    const state: AircraftState = { ...base, phase: 'airborne', onGround: false, position: { x: 0, y: 3000, z: 20000 }, velocity: { x: 0, y: 0, z: 0 } };
    sq.reset(playerOf(state));
    const missiles = await missilesModule.create(ctx);
    const mig = sq.entities.find((e) => e.kind === 'fighter' && e.pilot.leader === null)!;
    const dt = 1 / 60;
    let time = 0;
    const frame = (): SystemFrame => ({ state, dt, time, paused: false, def, camera: new THREE.PerspectiveCamera() }) as unknown as SystemFrame;
    /** The F-16 stays 2.2 km in trail, nose on the MiG. */
    const chase = (e: AirEntity, back = 2200) => {
      const v = e.flight.velocity;
      const n = Math.hypot(v.x, v.y, v.z);
      state.position = { x: e.position.x - (v.x / n) * back, y: e.position.y - (v.y / n) * back + 30, z: e.position.z - (v.z / n) * back };
      state.velocity = { x: v.x * 1.05, y: v.y * 1.05, z: v.z * 1.05 };
      state.orientation = pointAt(state.position, e.position);
    };
    const step = () => {
      time += dt;
      if (mig.phase === 'flying') chase(mig);
      sq.update(dt, playerOf(state));
      missiles.update!(frame());
      fx.step(dt, 0, 0, 0);
    };
    for (let i = 0; i < 30; i++) step();
    missiles.onAction!('lockTarget');
    expect(world.status.lock.targetId).toBe(mig.target.id);
    for (let i = 0; i < 90 && world.status.lock.state !== 'locked'; i++) step();
    expect(world.status.lock.state).toBe('locked');
    // The lock made it break.
    step();
    expect(mig.pilot.breaks).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 20; i++) step();
    expect(world.status.lock.inRange).toBe(true);
    missiles.onAction!('fireMissile');
    expect(events.some((e) => e.type === 'missileLaunch')).toBe(true);
    expect(world.status.airMissiles).toBe(1);
    for (let i = 0; i < 60 * 10 && mig.target.alive; i++) step();
    expect(mig.target.alive).toBe(false);
    const killed = events.find((e) => e.type === 'destroyed' && e.targetId === mig.target.id);
    expect(killed && killed.type === 'destroyed' && killed.weapon).toBe('missile');
    expect(sq.stats().flares as number).toBeGreaterThan(0);
    // It falls and hits the ground.
    for (let i = 0; i < 60 * 90 && mig.phase !== 'wreck'; i++) step();
    expect(mig.phase).toBe('wreck');
    expect(mig.position.y).toBeLessThan(3);
    expect(world.targets.includes(mig.target)).toBe(true);
  });

  it('an A-10 gun burst from 600 m behind a Mi-24 (gun cross on the lead pipper) kills it', () => {
    const world = createCombatWorld();
    const sq = createAirSquadron({ world, ground: FLAT_ENV.groundHeight, range: RANGE });
    const gun = A10_WEAPONS.gun!;
    const gn = createGunnery(world, FLAT_ENV, { seed: 5 });
    gn.setGun(gun, 0);
    const events: CombatEvent[] = [];
    world.on((e) => events.push(e));
    const far: PlayerInfo = { x: 0, y: 30, z: 20000, vx: 0, vy: 0, vz: 0, fx: 0, fy: 0, fz: -1 };
    sq.reset(far);
    const helo = sq.entities.find((e) => e.kind === 'helo')!;
    const dt = 1 / 60;
    let t = 0;
    const pos = { x: 0, y: 0, z: 0 };
    const vel = { x: 0, y: 0, z: 0 };
    const lead = newLead();
    let hold = 0;
    let fired = 0;
    let q: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (let i = 0; i < 60 * 12; i++) {
      t += dt;
      if (helo.phase === 'flying') {
        // 600 m in trail, a little above, closing slowly.
        const v = helo.flight.velocity;
        const n = Math.hypot(v.x, v.z) || 1;
        pos.x = helo.position.x - (v.x / n) * 600;
        pos.z = helo.position.z - (v.z / n) * 600;
        pos.y = helo.position.y + 25;
        vel.x = v.x + (v.x / n) * 3;
        vel.y = v.y;
        vel.z = v.z + (v.z / n) * 3;
        // Put the gun cross (2° below the datum) on the lead pipper.
        const muzzle = { x: pos.x, y: pos.y - 0.55, z: pos.z };
        gunLead(lead, muzzle, vel, helo.position, helo.flight.velocity, gun.muzzleVelocity, gun.dragK);
        expect(lead.ok).toBe(true);
        q = pointAt(pos, { x: lead.x, y: lead.y, z: lead.z }, gun.boresightDownDeg);
      }
      const trigger = t > 1 && hold < 2 + gun.spinUpS && helo.target.alive;
      if (trigger) hold += dt;
      gn.adjustControls({ ...defaultControls(), trigger }, false, dt);
      const pose: GunPose = { position: { ...pos }, orientation: q };
      gn.update(pose, vel, dt, t);
      sq.update(dt, playerOf({ position: pos, velocity: vel, orientation: q }));
      fired = gun.rounds - world.status.rounds;
      if (!helo.target.alive && gn.pool.count === 0) break;
    }
    const hits = events.filter((e) => e.type === 'hit' && e.targetId === helo.target.id).length;
    expect(fired).toBeGreaterThan(20);
    expect(fired).toBeLessThan(160);
    expect(hits).toBeGreaterThanOrEqual(8);
    expect(helo.target.alive).toBe(false);
    const d = events.find((e) => e.type === 'destroyed' && e.targetId === helo.target.id);
    expect(d && d.type === 'destroyed' && d.weapon).toBe('gun');
    // Shot at, it tried to break.
    expect(helo.pilot.breaks).toBeGreaterThanOrEqual(1);
    // It autorotates down and leaves a wreck.
    for (let i = 0; i < 60 * 40 && helo.phase !== 'wreck'; i++) sq.update(dt, null);
    expect(helo.phase).toBe('wreck');
  });
});
