/**
 * Functional: the audio system hears the combat world — impacts, detonations, kills and launches
 * emitted into the scene's combat world play at their distance from the camera, the gun follows the
 * weapons status, and the A-10 plays the TF34 'turbofan' voice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import mod from '../../src/game/systems/audio';
import { combatWorld } from '../../src/combat/world';
import type { SimSystem, SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { AircraftDef } from '../../src/fleet/types';
import { FLEET } from '../../src/fleet';
import { makeState, makeControls } from '../ui/fixtures';
import { MockAudioContext, violations } from './mockAudio';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const KEYS = ['AudioContext', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'runAudioSelfTest', 'simAudio'];
const saved: G = {};
const a10 = FLEET.find((d) => d.id === 'a10') as AircraftDef;

let sys: SimSystem | null = null;
beforeEach(() => {
  violations.length = 0;
  for (const k of KEYS) saved[k] = g[k];
  const target = new EventTarget();
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
  g.AudioContext = MockAudioContext;
});
afterEach(() => {
  sys?.dispose?.();
  sys = null;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete g[k];
    else g[k] = saved[k];
  }
  expect(violations).toEqual([]);
});

describe('audio system × combat world', () => {
  it('plays the combat events and the gun; the A-10 sounds like a turbofan', async () => {
    const scene = new THREE.Scene();
    const ctx = { scene, env: { surfaceAt: () => 'dirt', groundHeight: () => 0 }, actions: { currentAircraft: () => a10 } } as unknown as SystemContext;
    sys = (await mod.create(ctx)) as SimSystem;
    (g.dispatchEvent as (e: Event) => boolean)(new Event('keydown'));
    await new Promise((r) => setTimeout(r, 0));
    const world = combatWorld(scene);
    const camera = { position: { x: 0, y: 100, z: 30 } };
    const state = makeState({ iasKt: 250 });
    state.position = { x: 0, y: 100, z: 0 };
    const frame = () =>
      sys!.update!({ state, controls: makeControls(), controlState: {}, camera, dt: 1 / 60, time: 1, paused: false, cameraMode: 'chase', fps: {}, readings: null, def: a10, aircraft: {} } as unknown as SystemFrame);
    frame();
    world.status.hasGun = true;
    world.status.gunFiring = true;
    world.status.gunSpin = 1;
    frame();
    world.emit({ type: 'impact', time: 0, weapon: 'gun', point: { x: 0, y: 0, z: -1200 }, surface: 'dirt', targetId: null });
    world.emit({ type: 'missileLaunch', time: 0, missileId: 1, station: 0, position: { x: 0, y: 99, z: 0 }, velocity: { x: 0, y: 0, z: -120 } });
    world.emit({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: 1, z: -3000 }, targetId: 3, blastRadiusM: 18, surface: 'dirt' });
    world.emit({ type: 'destroyed', time: 0, weapon: 'missile', targetId: 3, kind: 'tank', position: { x: 0, y: 0, z: -3000 } });
    frame();
    const L = sys!.stats!() as Record<string, number>;
    expect(L.turbofan).toBe(1);
    expect(L.gun).toBe(1);
    expect(L.gunHz).toBe(65);
    expect(L.impactsPlayed).toBe(1);
    expect(L.launches).toBe(1);
    expect(L.booms).toBeGreaterThanOrEqual(2);
    expect(L.errors).toBe(0);
  });
});
