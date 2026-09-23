import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import missilesModule from '../../src/game/systems/missiles';
import { combatWorld } from '../../src/combat/world';
import { getAircraftDef } from '../../src/fleet';
import { createInitialState, FLAT_ENV } from '../../src/physics';
import type { AircraftState } from '../../src/types';
import type { CombatEvent } from '../../src/combat/types';
import type { SystemContext, SystemFrame, SimSystem } from '../../src/game/systems/types';

/** A-10 at 600 m, 130 m/s due north (−Z), nose 8° down, with a tank 3.5 km ahead. */
function setup(aircraft = 'a10') {
  const scene = new THREE.Scene();
  const def = getAircraftDef(aircraft);
  const ctx = {
    scene,
    env: FLAT_ENV,
    renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1440, 900) },
    actions: { currentAircraft: () => def },
  } as unknown as SystemContext;
  const world = combatWorld(scene);
  const tank = world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -3500 }, headingDeg: 0, group: 'test' });
  const base = createInitialState(FLAT_ENV, def.config);
  const pitch = (-8 * Math.PI) / 180;
  const state: AircraftState = {
    ...base,
    position: { x: 0, y: 600, z: 0 },
    velocity: { x: 0, y: 130 * Math.sin(pitch), z: -130 * Math.cos(pitch) },
    orientation: { x: Math.sin(pitch / 2), y: 0, z: 0, w: Math.cos(pitch / 2) },
    phase: 'airborne',
    onGround: false,
  };
  let time = 0;
  const frame = (dt = 1 / 60): SystemFrame => {
    time += dt;
    return { state, dt, time, paused: false, def, camera: new THREE.PerspectiveCamera() } as unknown as SystemFrame;
  };
  return { scene, def, ctx, world, tank, state, frame };
}

async function create(ctx: SystemContext): Promise<SimSystem> {
  return missilesModule.create(ctx);
}

describe('missiles system (arcade Mavericks)', () => {
  it('loads the aircraft stores into the status; the Cessna carries none', async () => {
    const a = setup('a10');
    const sys = await create(a.ctx);
    sys.update!(a.frame());
    expect(a.world.status.hasMissiles).toBe(true);
    expect(a.world.status.missiles).toBe(4);
    expect(a.world.status.stores).toEqual([true, true, true, true]);
    expect(a.world.status.missileName).toContain('AGM-65');
    const c = setup('c172rg');
    const sysC = await create(c.ctx);
    sysC.update!(c.frame());
    sysC.onAction!('lockTarget');
    sysC.onAction!('fireMissile');
    expect(c.world.status.hasMissiles).toBe(false);
    expect(c.world.status.missilesInFlight).toBe(0);
  });

  it('T selects, LOCK after the lock time, Z launches from the first station, and the tank is destroyed', async () => {
    const a = setup();
    const sys = await create(a.ctx);
    const events: CombatEvent[] = [];
    a.world.on((e) => events.push(e));
    sys.update!(a.frame());
    // Z without a lock does nothing.
    sys.onAction!('fireMissile');
    sys.update!(a.frame());
    expect(a.world.status.missilesInFlight).toBe(0);

    sys.onAction!('lockTarget');
    sys.update!(a.frame());
    expect(a.world.status.lock.state).toBe('tracking');
    expect(a.world.status.lock.targetId).toBe(a.tank.id);
    for (let i = 0; i < 60; i++) sys.update!(a.frame());
    expect(a.world.status.lock.state).toBe('locked');
    expect(a.world.status.lock.inRange).toBe(true);
    expect(a.world.status.lock.rangeM).toBeGreaterThan(3000);

    sys.onAction!('fireMissile');
    sys.update!(a.frame());
    expect(a.world.status.missilesInFlight).toBe(1);
    expect(a.world.status.stores).toEqual([false, true, true, true]);
    expect(a.world.status.missiles).toBe(3);
    expect(a.world.stats.missilesFired).toBe(1);
    const launch = events.find((e) => e.type === 'missileLaunch');
    expect(launch).toMatchObject({ station: 0 });

    for (let i = 0; i < 60 * 20 && a.tank.alive; i++) sys.update!(a.frame());
    expect(a.tank.alive).toBe(false);
    expect(events.some((e) => e.type === 'detonation' && e.weapon === 'missile' && e.targetId === a.tank.id)).toBe(true);
    expect(events.some((e) => e.type === 'destroyed' && e.targetId === a.tank.id)).toBe(true);
    expect(a.world.status.missilesInFlight).toBe(0);
    expect(a.world.status.lock.state).toBe('off');
  });

  it('a reset reloads every station, clears missiles in flight and the lock', async () => {
    const a = setup();
    const sys = await create(a.ctx);
    sys.update!(a.frame());
    sys.onAction!('lockTarget');
    for (let i = 0; i < 60; i++) sys.update!(a.frame());
    sys.onAction!('fireMissile');
    sys.update!(a.frame());
    sys.onReset!('runway');
    sys.update!(a.frame());
    expect(a.world.status.stores).toEqual([true, true, true, true]);
    expect(a.world.status.missilesInFlight).toBe(0);
    expect(a.world.status.lock.state).toBe('off');
  });

  it('never fires more missiles than it carries; switching aircraft reloads for the new one', async () => {
    const a = setup();
    const sys = await create(a.ctx);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (let n = 0; n < 7; n++) {
      a.world.reviveAll();
      sys.onAction!('lockTarget');
      for (let i = 0; i < 60; i++) sys.update!(a.frame());
      sys.onAction!('fireMissile');
      sys.update!(a.frame());
    }
    expect(a.world.stats.missilesFired).toBe(4);
    expect(a.world.status.stores).toEqual([false, false, false, false]);
    sys.onAircraftChange!(getAircraftDef('f16'), {} as never);
    sys.update!({ ...a.frame(), def: getAircraftDef('f16') });
    expect(a.world.status.missiles).toBe(2);
    sys.onAircraftChange!(getAircraftDef('c172rg'), {} as never);
    sys.update!({ ...a.frame(), def: getAircraftDef('c172rg') });
    expect(a.world.status.hasMissiles).toBe(false);
    sys.onAircraftChange!(getAircraftDef('a10'), {} as never);
    sys.update!(a.frame());
    expect(a.world.status.missiles).toBe(4);
    spy.mockRestore();
    sys.dispose!();
  });
});

describe('missiles system: Sidewinders at aircraft, Mavericks at ground vehicles', () => {
  it('an F-16 locked on a MiG-29 fires an AIM-9 from its wingtip (Mavericks stay), and it kills the MiG', async () => {
    const a = setup('f16');
    // Put a MiG 3 km dead ahead at the shooter's altitude-ish (inside the nose cone), and drop the tank far away.
    a.tank.position.z = -60000;
    const mig = a.world.addTarget({ kind: 'fighter', position: { x: 0, y: 180, z: -3000 }, headingDeg: 0, group: 'air', orientation: { x: 0, y: 0, z: 0, w: 1 } });
    const sys = await create(a.ctx);
    const events: CombatEvent[] = [];
    a.world.on((e) => events.push(e));
    sys.update!(a.frame());
    expect(a.world.status.hasAirMissiles).toBe(true);
    expect(a.world.status.airMissiles).toBe(2);
    sys.onAction!('lockTarget');
    for (let i = 0; i < 90; i++) sys.update!(a.frame());
    expect(a.world.status.lock.targetId).toBe(mig.id);
    expect(a.world.status.lock.state).toBe('locked');
    sys.onAction!('fireMissile');
    sys.update!(a.frame());
    expect(a.world.status.airStores).toEqual([false, true]);
    expect(a.world.status.stores).toEqual([true, true]);
    for (let i = 0; i < 60 * 10 && mig.alive; i++) sys.update!(a.frame());
    expect(mig.alive).toBe(false);
    expect(events.some((e) => e.type === 'destroyed' && e.targetId === mig.id && e.weapon === 'missile')).toBe(true);
  });

  it('an A-10 locked on a tank still fires a Maverick; the Cessna has neither', async () => {
    const a = setup('a10');
    const sys = await create(a.ctx);
    sys.update!(a.frame());
    expect(a.world.status.airMissiles).toBe(2);
    sys.onAction!('lockTarget');
    for (let i = 0; i < 60; i++) sys.update!(a.frame());
    sys.onAction!('fireMissile');
    sys.update!(a.frame());
    expect(a.world.status.stores).toEqual([false, true, true, true]);
    expect(a.world.status.airStores).toEqual([true, true]);
    const c = setup('c172rg');
    const sc = await create(c.ctx);
    sc.update!(c.frame());
    expect(c.world.status.hasAirMissiles).toBe(false);
  });
});
