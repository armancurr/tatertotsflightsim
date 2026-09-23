/**
 * Functional: the `combatfx` system plug-in in node (real three.js objects, no WebGL) — combat
 * events emitted into the scene's combat world play on the shared fx pools and the streaks; the gun
 * shakes the camera (cockpit > outside); the scripted demo hook drives a whole gun run over many
 * frames; reset leaves nothing alive; dispose unsubscribes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import mod from '../../../src/game/systems/combatfx';
import { combatWorld } from '../../../src/combat/world';
import { createEffects, fxHub } from '../../../src/fx';
import type { SimSystem, SystemContext, SystemFrame } from '../../../src/game/systems/types';
import type { CameraMode } from '../../../src/types';
import { makeState, makeControls } from '../../ui/fixtures';
import { CONFIG } from '../../../src/config';

const GROUND = 30;
const g = globalThis as unknown as Record<string, unknown>;

async function setup() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.5, 20000);
  camera.position.set(0, GROUND + 3, 60);
  camera.updateMatrixWorld();
  const fx = createEffects(scene, { groundHeight: () => GROUND });
  fxHub(scene).effects = fx;
  const ctx = {
    scene,
    camera,
    env: { groundHeight: () => GROUND, waterLevel: () => null, surfaceAt: () => 'dirt' },
    renderer: { getDrawingBufferSize: (v: THREE.Vector2) => v.set(1440, 900) },
  } as unknown as SystemContext;
  const sys = (await mod.create(ctx)) as SimSystem;
  const state = makeState({ iasKt: 0, onGround: true });
  state.position = { x: 0, y: GROUND + 2, z: 60 };
  const frame = (mode: CameraMode = 'chase', dt = 1 / 60, paused = false) => {
    sys.update!({
      state, controls: makeControls(), controlState: {} as never, camera, dt, time: 0, paused, cameraMode: mode,
      fps: { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 }, readings: null,
    } as unknown as SystemFrame);
    fx.update(camera, paused ? 0 : dt);
  };
  return { scene, camera, fx, sys, frame, world: combatWorld(scene), state };
}

let active: SimSystem | null = null;
afterEach(() => {
  active?.dispose?.();
  active = null;
  delete g.simCombatFx;
});

describe('combatfx system', () => {
  it('impact events emitted into the combat world play on the shared fx pools; hits on armour make streaks', async () => {
    const t = await setup();
    active = t.sys;
    t.frame();
    t.world.emit({ type: 'impact', time: 0, weapon: 'gun', point: { x: 0, y: GROUND, z: 0 }, surface: 'dirt', targetId: null });
    t.world.emit({ type: 'impact', time: 0, weapon: 'gun', point: { x: 3, y: GROUND + 1, z: 0 }, surface: 'target', targetId: 4, ricochet: true });
    t.frame();
    expect(t.fx.sim.smoke.count).toBeGreaterThan(3);
    expect(t.fx.sim.fire.count).toBeGreaterThan(0);
    const st = t.sys.stats!() as Record<string, number>;
    expect(st.impacts).toBe(2);
    t.frame();
    expect((t.sys.stats!() as Record<string, number>).streaksDrawn).toBeGreaterThan(3);
  });

  it('the gun shakes the camera while it fires: hard in the cockpit, lighter outside', async () => {
    const t = await setup();
    active = t.sys;
    t.world.status.gunFiring = true;
    t.world.status.gunSpin = 1;
    t.frame('cockpit');
    const inCockpit = t.sys.cameraShake!(t.state);
    t.frame('chase');
    const outside = t.sys.cameraShake!(t.state);
    expect(inCockpit).toBeCloseTo(CONFIG.fx.combat.shake.gunCockpit, 3);
    expect(outside).toBeLessThan(inCockpit);
    expect(outside).toBeGreaterThan(0);
    t.world.status.gunFiring = false;
    t.frame('cockpit');
    expect(t.sys.cameraShake!(t.state)).toBe(0);
  });

  it('the demo hook plays a whole GAU-8 run (status for the sound, impacts after the time of flight, gun stop), then reset clears it', async () => {
    const t = await setup();
    active = t.sys;
    const seen: string[] = [];
    t.world.on((e) => seen.push(e.type));
    t.frame();
    const api = g.simCombatFx as { demo: (k: string, o?: object) => { ok: boolean } };
    expect(api.demo('gun', { distance: 400 }).ok).toBe(true);
    let firing = 0;
    for (let i = 0; i < 60 * 4; i++) {
      t.frame();
      if (t.world.status.gunFiring) firing++;
    }
    expect(seen[0]).toBe('gunStart');
    expect(seen.filter((s) => s === 'impact').length).toBeGreaterThan(100);
    expect(seen).toContain('gunStop');
    expect(firing / 60).toBeGreaterThan(1.9);
    expect(firing / 60).toBeLessThan(2.1);
    expect(t.world.status.gunSpin).toBe(0);
    expect(t.fx.sim.smoke.count).toBeGreaterThan(100);
    t.sys.onReset!('runway');
    t.fx.reset();
    t.frame();
    expect(t.fx.sim.smoke.count + t.fx.sim.fire.count).toBe(0);
    expect((t.sys.stats!() as Record<string, number>).streaks).toBe(0);
  });

  it('the Maverick demo kills a (virtual) tank: detonation, destroyed, flash', async () => {
    const t = await setup();
    active = t.sys;
    const seen: string[] = [];
    t.world.on((e) => seen.push(e.type));
    t.frame();
    (g.simCombatFx as { demo: (k: string, o?: object) => unknown }).demo('maverick', { distance: 800 });
    let flash = 0;
    for (let i = 0; i < 60 * 9; i++) {
      t.frame();
      flash = Math.max(flash, t.fx.sim.flashLevel);
    }
    expect(seen).toEqual(expect.arrayContaining(['missileLaunch', 'detonation', 'destroyed']));
    expect(flash).toBeGreaterThan(0.8);
    expect((t.sys.stats!() as Record<string, number>).secondaries).toBe(1);
  });

  it('paused: queued effects still wait for time; nothing moves', async () => {
    const t = await setup();
    active = t.sys;
    t.frame();
    t.world.emit({ type: 'impact', time: 0, weapon: 'gun', point: { x: 0, y: GROUND, z: 0 }, surface: 'asphalt', targetId: null });
    t.frame('chase', 1 / 60, true);
    const n = (t.sys.stats!() as Record<string, number>).streaks;
    for (let i = 0; i < 30; i++) t.frame('chase', 1 / 60, true);
    expect((t.sys.stats!() as Record<string, number>).streaks).toBe(n);
  });

  it('dispose unsubscribes from the combat world and removes its objects', async () => {
    const t = await setup();
    t.frame();
    const before = t.scene.getObjectByName('combatfx');
    expect(before).toBeDefined();
    t.sys.dispose!();
    t.world.emit({ type: 'impact', time: 0, weapon: 'gun', point: { x: 0, y: GROUND, z: 0 }, surface: 'dirt', targetId: null });
    t.fx.update(t.camera, 1 / 60);
    expect(t.fx.sim.smoke.count).toBe(0);
    expect(t.scene.getObjectByName('combatfx')).toBeUndefined();
    expect(g.simCombatFx).toBeUndefined();
  });
});
