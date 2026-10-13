import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import mod from '../../../src/game/systems/wildlife';
import { discoverSystemModules, createSystems } from '../../../src/game/systems';
import type { SystemContext, SystemFrame } from '../../../src/game/systems/types';

function ctx(scene: THREE.Scene): SystemContext {
  return {
    renderer: { domElement: { height: 900 } } as unknown as THREE.WebGLRenderer,
    scene,
    camera: new THREE.PerspectiveCamera(),
    env: {} as SystemContext['env'],
    hudRoot: {} as HTMLElement,
    aircraft: {} as SystemContext['aircraft'],
    atmosphere: { sunDirection: new THREE.Vector3(0.3, 0.8, 0.2).normalize(), state: null } as unknown as SystemContext['atmosphere'],
    actions: { currentAircraft: () => null } as unknown as SystemContext['actions'],
  };
}

function frame(camera: THREE.PerspectiveCamera, t: number): SystemFrame {
  return {
    state: { position: { x: -4700, y: 300, z: 9000 }, velocity: { x: 0, y: 0, z: -60 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    camera,
    dt: 1 / 60,
    time: t,
    waveTime: t,
    paused: false,
    def: null,
  } as unknown as SystemFrame;
}

describe('wildlife system', () => {
  it('is discovered as "wildlife" (so ?no=wildlife switches it off) and runs after the traffic', () => {
    const mods = discoverSystemModules();
    const w = mods.find((m) => m.name === 'wildlife');
    expect(w).toBeDefined();
    const ships = mods.find((m) => m.name === 'ships');
    if (ships) expect(w!.order).toBeGreaterThan(ships.order);
  });

  it('?no=wildlife: the system is not created', async () => {
    const scene = new THREE.Scene();
    const s = await createSystems(ctx(scene), [mod], new Set(['wildlife']));
    expect(s.names()).toEqual([]);
    expect(scene.getObjectByName('wildlife')).toBeUndefined();
  });

  it('adds its group, updates from a frame, reports stats and cleans up', async () => {
    const scene = new THREE.Scene();
    const c = ctx(scene);
    const sys = await mod.create(c);
    expect(scene.getObjectByName('wildlife')).toBeDefined();
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(-4700, 30, 8300);
    cam.updateMatrixWorld();
    for (let k = 0; k < 30; k++) sys.update!(frame(cam, k / 60));
    const st = sys.stats!() as { drawCalls: number; gulls: number; whales: unknown[] };
    expect(st.gulls).toBeGreaterThan(100);
    expect(st.drawCalls).toBeLessThanOrEqual(7);
    expect(Array.isArray(st.whales)).toBe(true);
    sys.onReset!('runway');
    sys.onAction!('mute');
    sys.dispose!();
    expect(scene.getObjectByName('wildlife')).toBeUndefined();
  });
});
