/**
 * The crash director, functionally (headless, three.js objects in node): whole crashes simulated
 * for 30+ s with a stand-in aircraft model — the parts fly apart, never go through the ground and
 * all come to rest; the effects burn and expire; the camera frames the wreckage; reset puts every
 * part back exactly; switching aircraft mid-crash leaves nothing behind.
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CrashDirector, windowCueSink, type DirectorEnv, type CrashStart, type CrashCue } from '../../src/crash/director';
import { FxSim } from '../../src/fx/sim';
import { ASLEEP, SUNK, EV_DETACH } from '../../src/crash/rigid';
import type { AircraftModelHandle, BreakupPart } from '../../src/fleet/types';
import { CONFIG } from '../../src/config';

vi.setConfig({ testTimeout: 60000 });

const KT = 0.514444;
const DT = 1 / 60;

function box(name: string, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), new THREE.MeshBasicMaterial());
  m.name = name;
  m.position.set(x, y, z);
  return m;
}

/** A 172-sized stand-in: nose toward −Z. With `parts`, it lists its breakup parts (and restores them). */
function model(withParts: boolean): AircraftModelHandle & { snapshot(): Map<THREE.Object3D, { parent: THREE.Object3D | null; m: THREE.Matrix4; visible: boolean }> } {
  const root = new THREE.Group();
  root.name = 'aircraft';
  const ext = new THREE.Group();
  ext.name = 'exterior';
  root.add(ext);
  const fus = box('fuselage', 1.2, 1.4, 7.6, 0, 0, 0.4);
  const glass = box('glass', 1.1, 0.5, 1.2, 0, 0.8, -0.6);
  const wing = box('wing', 11, 0.16, 1.5, 0, 1.2, -0.2);
  wing.geometry = new THREE.BoxGeometry(11, 0.16, 1.5, 10, 1, 1);
  const flapPivot = new THREE.Group();
  flapPivot.position.set(-2, 1.1, 0.7);
  const flap = box('flap.left', 2, 0.05, 0.35, 0, 0, 0);
  flapPivot.add(flap);
  const tail = new THREE.Group();
  tail.name = 'tailplane';
  tail.position.set(0, 0.3, 4.4);
  tail.add(box('stab', 3.4, 0.1, 0.9, 0, 0, 0));
  const fin = box('fin', 0.1, 1.6, 1.2, 0, 1.0, 4.3);
  const prop = box('propHub', 1.9, 0.2, 0.1, 0, 0, -3.4);
  const gear = box('gear', 2.4, 0.6, 0.3, 0, -0.9, 0.3);
  const details = box('details', 0.2, 0.2, 0.2, 0, 1.3, 0.5);
  ext.add(fus, glass, wing, flapPivot, tail, fin, prop, gear, details);
  const glows = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
  glows.name = 'lightGlows';
  ext.add(glows);
  const spot = new THREE.SpotLight();
  root.add(spot, spot.target);
  const lw = box('leftWing', 5.4, 0.16, 1.5, -2.8, 1.2, -0.2);
  const rw = box('rightWing', 5.4, 0.16, 1.5, 2.8, 1.2, -0.2);
  const parts: BreakupPart[] = [
    { name: 'fuselage', object: fus, mass: 520, burning: true },
    { name: 'leftWing', object: lw, mass: 70, burning: true },
    { name: 'rightWing', object: rw, mass: 70, burning: true },
    { name: 'tail', object: tail, mass: 35 },
    { name: 'fin', object: fin, mass: 15 },
    { name: 'prop', object: prop, mass: 25 },
    { name: 'gear', object: gear, mass: 30 },
  ];
  if (withParts) {
    ext.remove(wing);
    ext.add(lw, rw);
  }
  const saved = new Map<THREE.Object3D, { parent: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }>();
  const handle = {
    root,
    setVisualState() {},
    dispose() {},
    snapshot() {
      const out = new Map<THREE.Object3D, { parent: THREE.Object3D | null; m: THREE.Matrix4; visible: boolean }>();
      root.traverse((o) => out.set(o, { parent: o.parent, m: o.matrix.clone().compose(o.position, o.quaternion, o.scale), visible: o.visible }));
      return out;
    },
  } as AircraftModelHandle & { snapshot(): Map<THREE.Object3D, { parent: THREE.Object3D | null; m: THREE.Matrix4; visible: boolean }> };
  if (withParts) {
    handle.getBreakupParts = () => {
      for (const p of parts) if (!saved.has(p.object)) saved.set(p.object, { parent: p.object.parent!, p: p.object.position.clone(), q: p.object.quaternion.clone() });
      return parts;
    };
    handle.restoreBreakupParts = () => {
      for (const [o, s] of saved) {
        s.parent.add(o);
        o.position.copy(s.p);
        o.quaternion.copy(s.q);
      }
    };
  }
  return handle;
}

const flat = (h = 30): DirectorEnv => ({ groundHeight: () => h, waterLevel: () => null, surfaceAt: () => 'field' });
const sea: DirectorEnv = { groundHeight: () => -25, waterLevel: () => 0, surfaceAt: () => 'water' };
const forest: DirectorEnv = { groundHeight: () => 30, waterLevel: () => null, obstacleTop: () => 48, surfaceAt: () => 'forest' };

function crashAt(env: DirectorEnv, speedKt: number, pathDeg: number, reason = 'Hit terrain', withParts = true, y?: number, cues: (c: CrashCue) => void = () => {}) {
  const scene = new THREE.Scene();
  const m = model(withParts);
  const g = env.groundHeight(0, 0);
  const wl = env.waterLevel?.(0, 0);
  const surf = wl !== null && wl !== undefined ? Math.max(g, wl) : g;
  m.root.position.set(0, y ?? surf + 1.2, 0);
  m.root.rotation.set((-pathDeg * Math.PI) / 180, 0, 0);
  scene.add(m.root);
  m.root.updateMatrixWorld(true);
  const before = m.snapshot();
  const worldBefore = new Map<THREE.Object3D, THREE.Matrix4>();
  m.root.traverse((o) => worldBefore.set(o, o.matrixWorld.clone()));
  const baseline = scene.children.length;
  const fx = new FxSim(3);
  const dir = new CrashDirector(scene, env, { seed: 5, cues });
  dir.fx = fx;
  const sp = speedKt * KT;
  const a = (pathDeg * Math.PI) / 180;
  const info: CrashStart = {
    reason, speedKt,
    position: { x: 0, y: m.root.position.y, z: 0 },
    velocity: { x: 0, y: -Math.sin(a) * sp, z: -Math.cos(a) * sp },
    angularVelocity: { x: 0.1, y: 0, z: 0.2 },
    massKg: CONFIG.aircraft.mass,
  };
  dir.begin(m, info);
  const step = (s: number) => {
    for (let t = 0; t < s - 1e-9; t += DT) {
      dir.update(DT);
      fx.step(DT * dir.timeScale(), 0, 0, 0);
    }
  };
  return { scene, m, dir, fx, before, worldBefore, baseline, step, env };
}

const hotFlames = (fx: FxSim) => {
  let n = 0;
  for (let i = 0; i < fx.fire.capacity; i++) if (fx.fire.alive[i] && fx.fire.heat[i] * Math.exp(-fx.fire.age[i] / fx.fire.heatTau[i]) > 0.3) n++;
  return n;
};

function expectRestored(c: ReturnType<typeof crashAt>) {
  const after = c.m.snapshot();
  for (const [o, s] of c.before) {
    const a = after.get(o);
    expect(a, `${o.name || o.type} is back in the aircraft`).toBeDefined();
    expect(a!.parent, `${o.name} parent`).toBe(s.parent);
    expect(a!.visible, `${o.name} visible`).toBe(s.visible);
    const e1 = a!.m.elements, e0 = s.m.elements;
    for (let k = 0; k < 16; k++) expect(e1[k]).toBeCloseTo(e0[k], 6);
  }
  expect(after.size).toBe(c.before.size);
  expect(c.scene.children.filter((o) => o.name !== 'crash-scorch' && o !== c.m.root)).toHaveLength(0);
  expect(c.dir.scorch?.count()).toBe(0);
  expect(c.dir.active).toBe(false);
  expect(c.dir.stats().lastResetOk).toBe(true);
}

describe('CrashDirector: the break-up', () => {
  it('detaches every part into the scene keeping its world transform', () => {
    const c = crashAt(flat(), 100, 40);
    for (const p of c.dir.parts()) {
      expect(p.object.parent).toBe(c.scene);
      const w0 = c.worldBefore.get(p.object)!;
      p.object.updateMatrixWorld(true);
      for (let k = 0; k < 16; k++) expect(p.object.matrixWorld.elements[k]).toBeCloseTo(w0.elements[k], 5);
    }
    expect(c.dir.parts().length).toBe(7);
    expect(c.dir.kind).toBe('noseIn');
  });
  it('nose-in at 100 kt: fluid motion, parts scatter, all come to rest within 30 s above the ground; fire burns then expires', () => {
    const c = crashAt(flat(), 100, 45);
    const W = c.dir.world;
    const core = c.dir.parts()[0].body;
    const z0 = W.pz[core];
    c.step(0.5);
    // the wreck keeps moving the frame after the impact (no freeze)
    expect(Math.hypot(W.vx[core], W.vy[core], W.vz[core])).toBeGreaterThan(1);
    expect(hotFlames(c.fx)).toBeGreaterThan(20);
    expect(c.fx.flashLevel + c.fx.fireLevel).toBeGreaterThan(0.2);
    c.step(2);
    expect(W.pz[core]).toBeLessThan(z0 - 2);
    let maxD = 0;
    for (const a of c.dir.parts()) for (const b of c.dir.parts()) maxD = Math.max(maxD, Math.hypot(W.px[a.body] - W.px[b.body], W.pz[a.body] - W.pz[b.body]));
    expect(maxD).toBeGreaterThan(8);
    c.step(28);
    expect(W.allAtRest()).toBe(true);
    for (const p of c.dir.parts()) expect(W.minClearance(p.body, c.env)).toBeGreaterThan(-0.02);
    // burning parts still burn at 15 s…
    expect(c.fx.activeEmitters()).toBeGreaterThan(0);
    c.step(60);
    // …and every effect is gone by 90 s
    expect(c.fx.smoke.count + c.fx.fire.count).toBe(0);
    expect(c.fx.activeEmitters()).toBe(0);
    expect(c.fx.fireLevel).toBe(0);
  });
  it('shallow skid across a field: a long slide shedding parts, dust, a furrow', () => {
    const c = crashAt(flat(), 85, 4);
    expect(c.dir.kind).toBe('skid');
    const W = c.dir.world;
    const core = c.dir.parts()[0].body;
    let detaches = 0;
    let dust = 0;
    for (let t = 0; t < 12; t += DT) {
      c.dir.update(DT);
      for (let e = 0; e < W.events.count; e++) if (W.events.type[e] === EV_DETACH) detaches++;
      c.fx.step(DT * c.dir.timeScale(), 0, 0, 0);
      dust = Math.max(dust, c.fx.smoke.count);
    }
    expect(-W.pz[core]).toBeGreaterThan(40);
    expect(detaches).toBeGreaterThanOrEqual(2);
    expect(dust).toBeGreaterThan(50);
    expect(c.dir.scorch!.count()).toBeGreaterThanOrEqual(2); // crater + furrow
  });
  it('into the forest: the canopy catches the wreckage, which falls to the ground', () => {
    const c = crashAt(forest, 95, 8, 'Hit an obstacle', true, 46);
    expect(c.dir.kind).toBe('obstacle');
    const W = c.dir.world;
    c.step(30);
    expect(W.allAtRest()).toBe(true);
    let far = 0;
    for (const p of c.dir.parts()) far = Math.max(far, Math.hypot(W.px[p.body], W.pz[p.body]));
    expect(far).toBeLessThan(160);
    for (const p of c.dir.parts()) expect(W.py[p.body]).toBeLessThan(40);
  });
  it('ditching: splashes, no fire, the airframe floats, then sinks out of sight', () => {
    const c = crashAt(sea, 70, 6, 'Ditched in water');
    expect(c.dir.kind).toBe('ditch');
    c.step(1.5);
    expect(hotFlames(c.fx)).toBe(0);
    const W = c.dir.world;
    const core = c.dir.parts()[0].body;
    c.step(6);
    expect(W.py[core]).toBeGreaterThan(-2); // still afloat
    c.step(60);
    expect(W.state[core]).toBe(SUNK);
    expect(c.dir.parts()[0].object.visible).toBe(false);
  });
  it('slow motion for about a second, then real time', () => {
    const c = crashAt(flat(), 100, 40);
    c.dir.update(0.1);
    expect(c.dir.timeScale()).toBeCloseTo(CONFIG.crash.slowMo.scale, 2);
    c.step(3);
    expect(c.dir.timeScale()).toBe(1);
  });
});

describe('CrashDirector: sound cues for the audio system', () => {
  it('a fireball and its secondary explosions (size 0..1), and rate-limited hard impacts (speed m/s)', () => {
    const cues: CrashCue[] = [];
    const c = crashAt(flat(), 110, 40, 'Hit terrain', true, undefined, (q) => cues.push(q));
    const explosions = () => cues.filter((q) => q.type === 'sim:explosion');
    const impacts = () => cues.filter((q) => q.type === 'sim:impact');
    expect(explosions()).toHaveLength(1);
    expect(impacts()).toHaveLength(1);
    const first = explosions()[0].detail as { size: number; position: { x: number; y: number; z: number } };
    expect(first.size).toBeGreaterThan(0.8);
    expect(first.size).toBeLessThanOrEqual(1);
    expect(Number.isFinite(first.position.x + first.position.y + first.position.z)).toBe(true);
    expect((impacts()[0].detail as { speed: number }).speed).toBeGreaterThan(50);
    c.step(5);
    expect(explosions().length).toBeGreaterThanOrEqual(3); // + the wing tanks
    for (const e of explosions()) expect((e.detail as { size: number }).size).toBeLessThanOrEqual(1);
    const times = impacts().length;
    expect(times).toBeGreaterThan(1);
    expect(times).toBeLessThan(5 / 0.06 + 2);
  });
  it('a ditching makes no explosion; a thrown listener does not stop the crash', () => {
    const cues: CrashCue[] = [];
    const c = crashAt(sea, 70, 6, 'Ditched in water', true, undefined, (q) => {
      cues.push(q);
      throw new Error('listener');
    });
    expect(() => c.step(3)).not.toThrow();
    expect(cues.filter((q) => q.type === 'sim:explosion')).toHaveLength(0);
    expect(cues.filter((q) => q.type === 'sim:impact').length).toBeGreaterThan(0);
  });
  it('the default sink dispatches window CustomEvents', () => {
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    const target = new EventTarget();
    g.window = target;
    const got: CustomEvent[] = [];
    target.addEventListener('sim:explosion', (e) => got.push(e as CustomEvent));
    try {
      windowCueSink({ type: 'sim:explosion', detail: { position: { x: 1, y: 2, z: 3 }, size: 0.5 } });
    } finally {
      if (had) g.window = prev;
      else delete g.window;
    }
    expect(got).toHaveLength(1);
    expect(got[0].detail).toEqual({ position: { x: 1, y: 2, z: 3 }, size: 0.5 });
  });
});

describe('CrashDirector: the crash camera', () => {
  it('chase: heavy shake at first, then frames the wreckage from a sensible distance, above the ground', () => {
    const c = crashAt(flat(), 100, 40);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 50000);
    const root = c.m.root.position.clone();
    const rigPose = () => {
      cam.position.set(root.x, root.y + 3.6, root.z + 15);
      cam.lookAt(root);
    };
    rigPose();
    c.dir.update(DT);
    c.dir.applyCamera(cam, 'chase', DT, root);
    expect(c.dir.shake()).toBeGreaterThan(0.8);
    for (let t = 0; t < 6; t += DT) {
      c.dir.update(DT);
      rigPose();
      c.dir.applyCamera(cam, 'chase', DT, root);
      expect(cam.position.y).toBeGreaterThan(c.env.groundHeight(cam.position.x, cam.position.z) + 1);
    }
    const toFocus = c.dir.focus.clone().sub(cam.position);
    const d = toFocus.length();
    expect(d).toBeGreaterThanOrEqual(CONFIG.crash.camera.minDistance * 0.9);
    expect(d).toBeLessThanOrEqual(CONFIG.crash.camera.maxDistance * 1.1);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    expect(fwd.angleTo(toFocus.normalize())).toBeLessThan(0.15);
    expect(c.dir.shake()).toBeLessThan(0.05);
  });
  it('orbit: keeps the player’s view direction, re-centred on the wreckage; paused = frozen', () => {
    const c = crashAt(flat(), 100, 40);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 50000);
    const root = c.m.root.position.clone();
    const rig = () => {
      cam.position.set(root.x + 20, root.y + 6, root.z + 5);
      cam.lookAt(root);
    };
    c.step(5);
    rig();
    const q0 = cam.quaternion.clone();
    c.dir.applyCamera(cam, 'orbit', DT, root);
    const d = cam.position.clone().sub(c.dir.focus);
    const dir0 = new THREE.Vector3(20, 6, 5).normalize();
    expect(d.normalize().dot(dir0)).toBeGreaterThan(0.98);
    const p1 = cam.position.clone();
    // paused: the director does not advance, the pose is stable
    rig();
    c.dir.update(0);
    c.dir.applyCamera(cam, 'orbit', 0, root);
    expect(cam.position.distanceTo(p1)).toBeLessThan(1e-6);
    expect(Math.abs(cam.quaternion.angleTo(q0))).toBeLessThan(0.05);
  });
});

describe('CrashDirector: reset and aircraft switching', () => {
  it('reset puts every part back exactly (model parts), clears effects handles and scorch', () => {
    const c = crashAt(flat(), 100, 30);
    c.step(8);
    c.m.restoreBreakupParts?.(); // the app does this first…
    c.dir.reset(); // …then the systems
    expectRestored(c);
    // a second reset is harmless
    c.dir.reset();
    expectRestored(c);
  });
  it('reset restores a model without getBreakupParts (fallback split incl. the cut wing) exactly', () => {
    const c = crashAt(flat(), 110, 35, 'Hit terrain', false);
    const names = c.dir.parts().map((p) => p.name);
    expect(names).toContain('fuselage');
    expect(names).toContain('leftWing');
    expect(names).toContain('rightWing');
    // the lights/points stayed with the aircraft root
    expect(c.m.root.getObjectByName('lightGlows')).toBeDefined();
    c.step(10);
    c.dir.reset();
    expectRestored(c);
  });
  it('reset mid-flight (0.2 s, slow motion) and immediately re-crash works', () => {
    const c = crashAt(flat(), 100, 30);
    c.step(0.2);
    c.m.restoreBreakupParts?.();
    c.dir.reset();
    expectRestored(c);
    c.dir.begin(c.m, { reason: 'Hit terrain', speedKt: 90, position: { x: 0, y: 31.2, z: 0 }, velocity: { x: 0, y: -20, z: -40 }, angularVelocity: { x: 0, y: 0, z: 0 }, massKg: 1100 });
    expect(c.dir.active).toBe(true);
    c.step(1);
    c.m.restoreBreakupParts?.();
    c.dir.reset();
    expectRestored(c);
  });
  it('switching aircraft mid-crash removes the old parts from the scene', () => {
    const c = crashAt(flat(), 100, 30, 'Hit terrain', false);
    c.step(2);
    c.scene.remove(c.m.root); // the app removes and disposes the old model
    c.dir.dropModel();
    expect(c.scene.children.filter((o) => o.name !== 'crash-scorch')).toHaveLength(0);
    expect(c.dir.active).toBe(false);
    expect(() => c.dir.update(DT)).not.toThrow();
  });
});

describe('CrashDirector: fuzz', () => {
  it('any impact (speed, angle, terrain height, water, reason): finite, nothing below ground, all at rest by 45 s, reset exact', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 250, noNaN: true }),
        fc.double({ min: -10, max: 89, noNaN: true }),
        fc.double({ min: -50, max: 800, noNaN: true }),
        fc.boolean(),
        fc.constantFrom('Hit terrain', 'Hit an obstacle', 'Gear-up landing', 'Prop strike', 'Ditched in water', 'Structural failure — over-G'),
        fc.boolean(),
        (kt, deg, h, water, reason, withParts) => {
          const env: DirectorEnv = water ? { groundHeight: () => h - 20, waterLevel: () => h } : { groundHeight: (x, z) => h + 0.08 * x + 0.05 * Math.sin(z * 0.1) * 10, waterLevel: () => null };
          const c = crashAt(env, kt, deg, reason, withParts);
          const W = c.dir.world;
          for (let t = 0; t < 45; t += 0.1) {
            c.dir.update(0.1);
            for (let i = 0; i < W.count; i++) {
              if (!Number.isFinite(W.px[i] + W.py[i] + W.pz[i] + W.qx[i] + W.qw[i])) throw new Error('NaN body');
              if (W.state[i] !== SUNK && W.minClearance(i, env) < -0.02) throw new Error(`body ${i} below ground`);
            }
          }
          expect(W.allAtRest()).toBe(true);
          for (const p of c.dir.parts()) {
            p.object.updateMatrixWorld(true);
            for (const e of p.object.matrixWorld.elements) expect(Number.isFinite(e)).toBe(true);
          }
          c.m.restoreBreakupParts?.();
          c.dir.reset();
          expectRestored(c);
          const settled = [...Array(W.count)].every((_, i) => W.state[i] === ASLEEP || W.state[i] === SUNK);
          expect(settled || W.count === 0).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });
});
