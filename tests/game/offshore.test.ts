// @vitest-environment happy-dom
/**
 * The offshore systems with a fake context: `offshore` registers the platform and the turbines as
 * obstacles and the helideck as a deck (the environment's ground there), aims the turbines into the
 * sea wind, lights up at night (obstruction lights flash in sync); `raceCourse` registers the buoys
 * as soft obstacles, shows its lap panel only for a vessel near the course, times laps driven along
 * the racing line and saves the best lap per vessel.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import offshore, { obstructionOn } from '../../src/game/systems/offshore';
import raceSystem, { SHOW_MARGIN_M } from '../../src/game/systems/raceCourse';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import { createEnvironment } from '../../src/world/environment';
import { PLATFORM, createPlatformPhysics } from '../../src/world/offshore/platform';
import { TURBINE, windFarmLayout } from '../../src/world/offshore/windFarm';
import { raceCourse, bestKey } from '../../src/world/offshore/raceCourse';
import { getAircraftDef } from '../../src/fleet';
import { terrainHeight } from '../../src/world/heightfield';

function fakeCtx(sunY: number) {
  const env = createEnvironment();
  const hudRoot = document.createElement('div');
  document.body.appendChild(hudRoot);
  const ctx = {
    scene: new THREE.Scene(),
    env,
    hudRoot,
    renderer: { domElement: { height: 900 } },
    atmosphere: { sunDirection: new THREE.Vector3(0, sunY, Math.sqrt(1 - sunY * sunY)), state: null },
  } as unknown as SystemContext;
  return { ctx, env, hudRoot };
}

const camera = new THREE.PerspectiveCamera();

function frame(over: Partial<SystemFrame>): SystemFrame {
  return { dt: 1 / 60, time: 0, waveTime: 0, paused: false, camera, readings: null, ...over } as SystemFrame;
}

describe('offshore system', () => {
  it('registers the platform, its helideck deck and the turbines with the environment', async () => {
    const { ctx, env } = fakeCtx(0.8);
    const sys = await offshore.create(ctx);
    const p = createPlatformPhysics();
    expect(env.deckTop(p.helideck.x, p.helideck.z)).toBe(PLATFORM.helideck.y);
    expect(env.obstacleTop(p.helideck.x, p.helideck.z)).toBe(-Infinity);
    expect(env.surfaceAt(p.helideck.x, p.helideck.z)).toBe('asphalt');
    expect(env.obstacleTop(p.flareTip.x, p.flareTip.z)).toBeGreaterThan(p.flareTip.y);
    const t = windFarmLayout().turbines[7];
    expect(env.obstacleTop(t.x, t.z)).toBeGreaterThan(TURBINE.hubHeight);
    expect(env.groundHeight(t.x, t.z)).toBe(terrainHeight(t.x, t.z));
    expect(ctx.scene.getObjectByName('offshore')).toBeTruthy();
    const st = sys.stats!();
    expect(st.windFromDeg).toBe(215);
    expect(st.yawDeg).toBe(215);
    expect(Number(st.rotorRpm)).toBeGreaterThan(5);
    sys.dispose?.();
    expect(ctx.scene.getObjectByName('offshore')).toBeUndefined();
  });

  it('dark by day (only the flare’s halo), lit at night; the turbine flashers blink together', async () => {
    const day = fakeCtx(0.8);
    const sd = await offshore.create(day.ctx);
    sd.update!(frame({ time: 0.5 }));
    expect(sd.stats!().lights).toBe(1);
    const night = fakeCtx(-0.2);
    const sn = await offshore.create(night.ctx);
    sn.update!(frame({ time: 0.5 }));
    const on = Number(sn.stats!().lights);
    sn.update!(frame({ time: 1.5 }));
    const off = Number(sn.stats!().lights);
    expect(on).toBeGreaterThan(off + windFarmLayout().turbines.length * 2 - 1);
    expect(off).toBeGreaterThan(100);
    expect(obstructionOn(0.2)).toBe(true);
    expect(obstructionOn(1.2)).toBe(false);
    expect(obstructionOn(2.2)).toBe(true);
    sd.dispose?.();
    sn.dispose?.();
  });
});

describe('raceCourse system', () => {
  beforeEach(() => localStorage.clear());
  const course = raceCourse();
  const v50 = getAircraftDef('v50');
  const cessna = getAircraftDef('c172rg');
  const at = (x: number, z: number) => ({ position: { x, y: 0, z }, orientation: { x: 0, y: 0, z: 0, w: 1 }, crash: null });

  it('buoys are soft obstacles (not hard ones)', async () => {
    const { ctx, env } = fakeCtx(0.8);
    const sys = await raceSystem.create(ctx);
    const m = course.marks[3];
    expect(env.softObstacleTop(m.x, m.z)).toBeGreaterThan(1);
    expect(env.obstacleTop(m.x, m.z)).toBe(-Infinity);
    sys.dispose?.();
  });

  it('the panel shows for a vessel near the course only — not far away, not for an aircraft', async () => {
    const { ctx, hudRoot } = fakeCtx(0.8);
    const sys = await raceSystem.create(ctx);
    const panel = () => hudRoot.querySelector('[data-hud="race"]') as HTMLElement;
    expect(panel()).toBeTruthy();
    sys.update!(frame({ def: v50, state: at(course.cx, course.cz) as never }));
    expect(panel().hidden).toBe(false);
    sys.update!(frame({ def: v50, state: at(course.cx, course.cz + course.radius + SHOW_MARGIN_M + 50) as never }));
    expect(panel().hidden).toBe(true);
    sys.update!(frame({ def: cessna, state: at(course.cx, course.cz) as never }));
    expect(panel().hidden).toBe(true);
    sys.dispose?.();
    expect(hudRoot.querySelector('[data-hud="race"]')).toBeNull();
  });

  it('times two laps along the racing line and saves the best lap for that vessel', async () => {
    const { ctx, hudRoot } = fakeCtx(0.8);
    const sys = await raceSystem.create(ctx);
    const g = course.marks[0];
    const L = course.line;
    const pts: { x: number; z: number }[] = [{ x: g.x - g.dx * 40, z: g.z - g.dz * 40 }];
    for (let lap = 0; lap < 2; lap++)
      for (let i = 0; i < L.length; i++) {
        const a = L[i];
        const b = L[(i + 1) % L.length];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5);
        for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
      }
    pts.push({ x: g.x + g.dx * 10, z: g.z + g.dz * 10 });
    let t = 0;
    for (const p of pts) {
      t += 5 / 18;
      sys.update!(frame({ def: v50, state: at(p.x, p.z) as never, time: t, dt: 5 / 18 }));
    }
    const st = sys.stats!();
    expect(st.validLaps).toBe(2);
    expect(Number(st.best)).toBeGreaterThan(course.length / 18 - 5);
    expect(Number(st.best)).toBeLessThan(course.length / 18 + 5);
    const saved = JSON.parse(localStorage.getItem(bestKey(course.id, 'v50'))!);
    expect(saved.lap).toBeCloseTo(Number(st.best), 2);
    expect(hudRoot.textContent).toContain('BEST');
    // another session with the same vessel loads it
    sys.dispose?.();
    const again = await raceSystem.create(fakeCtx(0.8).ctx);
    again.update!(frame({ def: v50, state: at(course.cx, course.cz) as never }));
    expect(Number(again.stats!().best)).toBeCloseTo(saved.lap, 2);
    again.dispose?.();
  });
});
