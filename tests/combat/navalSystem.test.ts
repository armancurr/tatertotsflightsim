/**
 * The navalGuns system (src/game/systems/navalGuns.ts) headless: inert for aircraft (no
 * status.turrets), active for any vehicle whose config has weapons.naval (here the V50 with
 * IOWA_WEAPONS — the harness the Iowa's fleet entry will replace); it writes status.turrets every
 * frame, aims where the view ray meets the sea, T cycles the locked target among the range barges,
 * Q (the trigger's press) fires a salvo once the turrets are on target, the shells fly and burst,
 * and switching to an aircraft makes it inert again.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { IOWA_WEAPONS } from '../../src/config';
import { getAircraftDef } from '../../src/fleet';
import type { AircraftDef, AircraftModelHandle } from '../../src/fleet/types';
import { combatWorld } from '../../src/combat/world';
import { createGunneryRange } from '../../src/combat/navalRange';
import navalGunsModule from '../../src/game/systems/navalGuns';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { CombatEvent } from '../../src/combat/types';
import type { Environment, SurfaceType } from '../../src/types';

const SEA: Environment = {
  groundHeight: () => -50,
  surfaceAt: (): SurfaceType => 'water',
  waterLevel: () => 0,
  obstacleTop: () => -Infinity,
};

const v50 = getAircraftDef('v50');
const IOWA_HARNESS: AircraftDef = { ...v50, id: 'iowa-test', config: { ...v50.config, weapons: IOWA_WEAPONS } };

function setup(def: AircraftDef) {
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  const model = { root } as unknown as AircraftModelHandle;
  let current = def;
  const ctx = { scene, env: SEA, aircraft: model, actions: { currentAircraft: () => current } } as unknown as SystemContext;
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 1e5);
  // the ship at the gunnery start: 9 km south of the range, heading east (the range on the port beam)
  const g = createGunneryRange(combatWorld(scene));
  const c = g.plan.center;
  root.position.set(c.x, 0, c.z + 9000);
  root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
  root.updateMatrixWorld();
  const state = { velocity: { x: 4, y: 0, z: 0 }, phase: 'afloat', position: { x: c.x, y: 0, z: c.z + 9000 } };
  let time = 0;
  const frame = (trigger = false, dt = 1 / 30): SystemFrame => {
    time += dt;
    return { state, controls: { trigger }, dt, time, waveTime: time, paused: false, camera, cameraMode: 'chase', def: current, aircraft: model } as unknown as SystemFrame;
  };
  return { scene, ctx, camera, g, c, frame, setDef: (d: AircraftDef) => (current = d), root };
}

describe('navalGuns system', () => {
  it('is inert for an aircraft', async () => {
    const s = setup(getAircraftDef('f16'));
    const sys = await navalGunsModule.create(s.ctx);
    sys.update!(s.frame());
    expect(combatWorld(s.scene).status.turrets).toBeUndefined();
    expect(sys.cameraShake!({} as never)).toBe(0);
  });

  it('aims at the sea under the view ray, trains, fires on Q once on target, and the shells land near the aim', async () => {
    const s = setup(IOWA_HARNESS);
    const world = combatWorld(s.scene);
    const events: CombatEvent[] = [];
    world.on((e) => events.push(e));
    const sys = await navalGunsModule.create(s.ctx);
    // the camera looks north-ish down at the sea 8 km away from 400 m up
    s.camera.position.set(s.c.x, 400, s.c.z + 9000);
    s.camera.lookAt(s.c.x + 200, 0, s.c.z + 1000);
    s.camera.updateMatrixWorld();
    sys.update!(s.frame());
    const st = world.status.turrets!;
    expect(st).toHaveLength(3);
    expect(st[2].trainDeg).toBeCloseTo(180, 0);
    for (let i = 0; i < 30 * 30; i++) sys.update!(s.frame());
    // turrets trained to port (bow = east, so north is −90 relative)
    expect(world.status.turrets![0].trainDeg).toBeLessThan(-70);
    expect(world.status.turrets![2].trainDeg).toBeGreaterThan(250);
    sys.update!(s.frame(true));
    let n = 0;
    for (let i = 0; i < 30 * 40; i++, n++) sys.update!(s.frame(i < 2));
    const fired = events.filter((e) => e.type === 'navalFire');
    expect(fired.length).toBe(9);
    const det = events.filter((e): e is Extract<CombatEvent, { type: 'detonation' }> => e.type === 'detonation' && e.weapon === 'shell');
    expect(det.length).toBe(9);
    const mean = det.reduce((a, e) => ({ x: a.x + e.position.x / 9, z: a.z + e.position.z / 9 }), { x: 0, z: 0 });
    // the view ray (screen centre: no pointer) meets the sea at the point the camera looks at
    expect(Math.hypot(mean.x - (s.c.x + 200), mean.z - (s.c.z + 1000))).toBeLessThan(250);
    expect(world.stats.roundsFired).toBe(9);
    void n;
  }, 30000);

  it('T locks the range targets in turn (nearest the view first) and past the last goes back to free aim', async () => {
    const s = setup(IOWA_HARNESS);
    s.g.install();
    const sys = await navalGunsModule.create(s.ctx);
    s.camera.position.set(s.c.x, 300, s.c.z + 9000);
    s.camera.lookAt(s.c.x, 0, s.c.z);
    s.camera.updateMatrixWorld();
    sys.update!(s.frame());
    // the hub knows the lock
    const { navalHub } = await import('../../src/combat/navalHub');
    const hub = navalHub(s.scene);
    const ids: (number | null)[] = [];
    for (let k = 0; k < 8; k++) {
      sys.onAction!('lockTarget');
      sys.update!(s.frame());
      ids.push(hub.aim.targetId);
    }
    const locked = ids.filter((x) => x !== null);
    expect(new Set(locked).size).toBe(7);
    expect(ids).toContain(null);
    expect(hub.aim.source === 'target' || hub.aim.source === 'view').toBe(true);
  });

  it('Z toggles the rangefinder zoom: the view narrows ×5 (the rig restores its FOV each frame)', async () => {
    const s = setup(IOWA_HARNESS);
    const sys = await navalGunsModule.create(s.ctx);
    sys.onAction!('fireMissile');
    for (let i = 0; i < 60; i++) {
      s.camera.fov = 60; // what the camera rig applies each frame
      sys.update!(s.frame());
    }
    expect(s.camera.fov).toBeCloseTo(12, 1);
    sys.onAction!('fireMissile');
    for (let i = 0; i < 60; i++) {
      s.camera.fov = 60;
      sys.update!(s.frame());
    }
    expect(s.camera.fov).toBeCloseTo(60, 1);
    // an aircraft: Z is the missile key, the naval guns leave it alone
    const f = setup(getAircraftDef('a10'));
    const fsys = await navalGunsModule.create(f.ctx);
    fsys.onAction!('fireMissile');
    f.camera.fov = 60;
    fsys.update!(f.frame());
    expect(f.camera.fov).toBe(60);
  });

  it('switching to an aircraft makes it inert (no status.turrets)', async () => {
    const s = setup(IOWA_HARNESS);
    const sys = await navalGunsModule.create(s.ctx);
    sys.update!(s.frame());
    expect(combatWorld(s.scene).status.turrets).toBeDefined();
    const f16 = getAircraftDef('f16');
    s.setDef(f16);
    sys.onAircraftChange!(f16, s.ctx.aircraft);
    sys.update!(s.frame());
    expect(combatWorld(s.scene).status.turrets).toBeUndefined();
    sys.dispose!();
  });
});
