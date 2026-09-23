/**
 * Weapons HUD model + drawing (functional, node): real three.js cameras over a small scene of
 * targets; the symbols must land where the world points project (gun cross, CCIP pipper, lock box,
 * markers, range caret), the texts must say the right things, and the drawing is measured on the
 * geometry-tracking canvas. Fuzz: random statuses, cameras and targets never throw, never NaN, and
 * clamped symbols stay inside the display.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { A10_WEAPONS, CONFIG, F16_WEAPONS, type Config } from '../../src/config';
import { getAircraftDef } from '../../src/fleet';
import { createCombatWorld, emptyWeaponsStatus } from '../../src/combat/world';
import type { WeaponsStatus } from '../../src/combat/types';
import { computeHudLayout } from '../../src/ui/hud';
import { jetHeadingTape, jetHudOmitsGunCross } from '../../src/ui/jetHud';
import {
  createSeekerOverlay, createWeaponsHudFrame, createWeaponsHudModel, drawSeekerOverlay, drawWeaponsHud, seekerRect, updateWeaponsHud,
  type WeaponsHudFrame,
} from '../../src/ui/weaponsHud';
import { geoCtx } from './geoCtx';
import { fcParams } from '../support/fc';

const W = 1440;
const H = 900;
const A10 = getAircraftDef('a10').config;
const F16 = getAircraftDef('f16').config;
const DEG = Math.PI / 180;

/** Aircraft at (0, 500, 0) flying north, level; camera at the pilot's eye looking straight ahead (or a chase camera). */
function setup(opts: { exterior?: boolean; cfg?: Config; status?: Partial<WeaponsStatus>; w?: number; h?: number; fov?: number } = {}) {
  const cfg = opts.cfg ?? A10;
  const w = opts.w ?? W;
  const h = opts.h ?? H;
  const cam = new THREE.PerspectiveCamera(opts.fov ?? 68, w / h, 0.1, 90000);
  if (opts.exterior) {
    cam.position.set(0, 506, 30);
    cam.lookAt(0, 500, -40);
  } else {
    cam.position.set(0, 501, -4);
    cam.lookAt(0, 501, -1000);
  }
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const world = createCombatWorld(cfg);
  const f: WeaponsHudFrame = createWeaponsHudFrame();
  f.w = w;
  f.h = h;
  f.view = cam.matrixWorldInverse.elements;
  f.proj = cam.projectionMatrix.elements;
  f.exterior = !!opts.exterior;
  f.hudBox = computeHudLayout(w, h, cfg, opts.exterior ? 'normal' : 'cockpitHidden', 'jet').jet;
  f.gearUp = true;
  f.ax = 0;
  f.ay = 500;
  f.az = 0;
  f.qx = 0;
  f.qy = 0;
  f.qz = 0;
  f.qw = 1;
  f.headingDeg = 0;
  f.weapons = cfg.weapons;
  f.status = { ...emptyWeaponsStatus(), ...opts.status };
  f.targets = world.targets;
  f.classOf = world.classOf;
  f.time = 0;
  const m = createWeaponsHudModel();
  const g = geoCtx();
  const run = (c: Config = cfg) => {
    updateWeaponsHud(m, f, c);
    g.reset();
    drawWeaponsHud(g.ctx, m, c);
    return m;
  };
  return { cam, world, f, m, g, run, cfg };
}

const texts = (g: ReturnType<typeof geoCtx>) => g.texts.map((t) => t.s);

describe('visibility', () => {
  it('the Cessna gets nothing: no symbols, no text', () => {
    const s = setup({ cfg: CONFIG });
    s.run();
    expect(s.m.show).toBe(false);
    expect(s.g.segments.length + s.g.texts.length + s.g.arcs.length + s.g.fills.length).toBe(0);
  });

  it('the A-10 shows its gun cross, stores and kills; config counts until a weapons system reports', () => {
    const s = setup();
    s.run();
    expect(s.m.show).toBe(true);
    expect(s.m.gunCross.show).toBe(true);
    const t = texts(s.g);
    expect(t).toContain('GUN 1150 CM');
    expect(t).toContain('65D ×4');
    expect(t).toContain('KILLS 0');
  });

  it('live status wins over the config counts', () => {
    const s = setup({ status: { hasGun: true, rounds: 612, maxRounds: 1150, hasMissiles: true, missiles: 3, maxMissiles: 4 } });
    s.f.kills = 5;
    s.run();
    const t = texts(s.g);
    expect(t).toContain('GUN 612 CM');
    expect(t).toContain('65D ×3');
    expect(t).toContain('KILLS 5');
  });

  it('F-16: gun only (no Maverick text); in the cockpit its jet HUD keeps the fixed cross, outside the conformal one shows', () => {
    const s = setup({ cfg: F16 });
    s.run();
    expect(s.m.show).toBe(true);
    expect(texts(s.g).some((x) => x.includes('65D'))).toBe(false);
    expect(texts(s.g)).toContain('GUN 511 PGU');
    expect(jetHudOmitsGunCross(F16)).toBe(false);
    expect(s.m.gunCross.show).toBe(false);
    const e = setup({ cfg: F16, exterior: true });
    e.run();
    expect(e.m.gunCross.show).toBe(true);
    expect(jetHudOmitsGunCross(A10)).toBe(true);
  });
});

describe('gun cross', () => {
  it('sits on the gun line, 2° below the straight-ahead point in the cockpit', () => {
    const s = setup();
    s.run();
    const focal = (H / 2) / Math.tan(34 * DEG);
    const ahead = new THREE.Vector3(0, 501, -1e5).project(s.cam);
    const aheadY = ((1 - ahead.y) / 2) * H;
    // The gun line is 2° down from 0.55 m below the CG; the eye is 1 m above it.
    const expected = aheadY + focal * Math.tan(2 * DEG);
    expect(s.m.gunCross.x).toBeCloseTo(W / 2, 0);
    expect(Math.abs(s.m.gunCross.y - expected)).toBeLessThan(focal * Math.tan(0.12 * DEG) + 1);
    // A cross is stroked around it.
    const near = s.g.segments.filter((sg) => Math.hypot(sg.a.x - s.m.gunCross.x, sg.a.y - s.m.gunCross.y) < 30);
    expect(near.length).toBeGreaterThanOrEqual(4);
  });
});

describe('CCIP pipper', () => {
  it('drawn at the projected impact point with a range arc; IN RNG inside 4,000 ft', () => {
    // Rising ground 150 m below, 700 m ahead: ~12° below the nose, inside the HUD's field.
    const p = { x: 0, y: 350, z: -700 };
    const s = setup({ status: { hasGun: true, rounds: 1150, maxRounds: 1150, ccip: p, ccipRangeM: Math.hypot(700, 150) } });
    s.run();
    const v = new THREE.Vector3(p.x, p.y, p.z).project(s.cam);
    expect(s.m.pipper.show).toBe(true);
    expect(s.m.pipper.clamped).toBe(false);
    expect(s.m.pipper.x).toBeCloseTo(((v.x + 1) / 2) * W, 3);
    expect(s.m.pipper.y).toBeCloseTo(((1 - v.y) / 2) * H, 3);
    expect(s.m.pipper.arc).toBeCloseTo(Math.hypot(700, 150) / CONFIG.hud.weapons.gunInRangeM, 6);
    expect(s.m.pipper.inRange).toBe(true);
    expect(texts(s.g)).toContain('IN RNG');
    // A circle and a centre dot around the pipper.
    const circles = s.g.arcs.filter((a) => Math.hypot(a.c.x - s.m.pipper.x, a.c.y - s.m.pipper.y) < 1);
    expect(circles.length).toBeGreaterThanOrEqual(1);
  });

  it('out of range: full arc, no IN RNG', () => {
    const s = setup({ status: { hasGun: true, rounds: 1150, maxRounds: 1150, ccip: { x: 0, y: 0, z: -2500 }, ccipRangeM: 2550 } });
    s.run();
    expect(s.m.pipper.arc).toBe(1);
    expect(s.m.pipper.inRange).toBe(false);
    expect(texts(s.g)).not.toContain('IN RNG');
  });

  it('an impact point outside the HUD is clamped to its edge (dimmed), never drawn off the display', () => {
    const s = setup({ status: { hasGun: true, rounds: 1150, maxRounds: 1150, ccip: { x: 0, y: 0, z: -40 }, ccipRangeM: 502 } });
    s.run();
    expect(s.m.pipper.show).toBe(true);
    expect(s.m.pipper.clamped).toBe(true);
    const box = s.f.hudBox!;
    expect(s.m.pipper.y).toBeLessThanOrEqual(box.y + box.h);
    expect(s.m.pipper.y).toBeGreaterThanOrEqual(box.y);
    expect(s.m.pipper.inRange).toBe(false);
    // Behind the aircraft: hidden.
    const b = setup({ status: { hasGun: true, rounds: 1150, maxRounds: 1150, ccip: { x: 0, y: 0, z: 400 }, ccipRangeM: 640 } });
    b.run();
    expect(b.m.pipper.show).toBe(false);
  });

  it('no CCIP solution → no pipper', () => {
    const s = setup({ status: { hasGun: true, rounds: 1150, maxRounds: 1150, ccip: null } });
    s.run();
    expect(s.m.pipper.show).toBe(false);
  });
});

describe('Maverick lock box', () => {
  const withTarget = (state: 'tracking' | 'locked', progress: number, inRange = true) => {
    const s = setup({ status: { hasMissiles: true, missiles: 4, maxMissiles: 4, stores: [true, true, true, true] } });
    const t = s.world.addTarget({ kind: 'tank', position: { x: 30, y: 0, z: -3000 }, headingDeg: 180, group: 'test' });
    s.f.status.lock = { state, targetId: t.id, progress, rangeM: Math.hypot(30, 500, 3000), inRange };
    s.f.seekerActive = true;
    s.run();
    return { s, t };
  };

  it('tracking: a box on the target that fills with the progress, the seeker circle up', () => {
    const { s } = withTarget('tracking', 0.5);
    const v = new THREE.Vector3(30, 2.23 / 2, -3000).project(s.cam);
    expect(s.m.lock.show).toBe(true);
    expect(s.m.lock.solid).toBe(false);
    expect(s.m.lock.fill).toBeCloseTo(0.5, 9);
    expect(s.m.lock.x).toBeCloseTo(((v.x + 1) / 2) * W, 2);
    expect(s.m.lock.y).toBeCloseTo(((1 - v.y) / 2) * H, 2);
    expect(s.m.seekerCircle.show).toBe(true);
    expect(s.m.seekerCircle.r).toBeGreaterThan(40);
    expect(texts(s.g)).not.toContain('LOCK');
  });

  it('locked: solid box, LOCK (flashing), the type and the slant range, IN RNG', () => {
    const { s } = withTarget('locked', 1);
    expect(s.m.lock.solid).toBe(true);
    expect(s.m.lock.type).toBe('T-72B');
    expect(s.m.lock.range).toBe(`${(Math.hypot(30, 500, 3000) / 1852).toFixed(1)} NM`);
    s.f.time = 0.01;
    s.run();
    const on = texts(s.g);
    expect(on).toContain('LOCK');
    expect(on).toContain('T-72B');
    expect(on).toContain('IN RNG');
    s.f.time = 1 / (CONFIG.hud.weapons.flashHz * 2) + 0.01;
    s.run();
    expect(texts(s.g)).not.toContain('LOCK');
    expect(texts(s.g)).toContain('T-72B');
  });

  it('out of range: no IN RNG under the lock', () => {
    const { s } = withTarget('locked', 1, false);
    expect(texts(s.g)).not.toContain('IN RNG');
  });

  it('a lock on an unknown target id shows no box', () => {
    const s = setup({ status: { hasMissiles: true, missiles: 4, maxMissiles: 4 } });
    s.f.status.lock = { state: 'locked', targetId: 999, progress: 1, rangeM: 3000, inRange: true };
    s.run();
    expect(s.m.lock.show).toBe(false);
  });
});

describe('target markers', () => {
  it('hollow diamonds over live vehicles within range, not over wrecks, far ones or the locked one', () => {
    const s = setup({ exterior: true });
    const a = s.world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -2500 }, headingDeg: 0, group: 'g' });
    s.world.addTarget({ kind: 'ifv', position: { x: 80, y: 0, z: -2600 }, headingDeg: 0, group: 'g' });
    const dead = s.world.addTarget({ kind: 'truck', position: { x: -80, y: 0, z: -2600 }, headingDeg: 0, group: 'g' });
    dead.alive = false;
    s.world.addTarget({ kind: 'apc', position: { x: 0, y: 0, z: -9000 }, headingDeg: 0, group: 'g' });
    s.run();
    expect(s.m.markerCount).toBe(2);
    s.f.status.lock = { state: 'locked', targetId: a.id, progress: 1, rangeM: 2550, inRange: true };
    s.f.status.hasMissiles = true;
    s.run();
    expect(s.m.markerCount).toBe(1);
    const off = setup({ exterior: true });
    off.world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -2500 }, headingDeg: 0, group: 'g' });
    off.run({ ...A10, hud: { ...A10.hud, weapons: { ...A10.hud.weapons, targetMarkers: false } } });
    expect(off.m.markerCount).toBe(0);
  });
});

describe('range cue', () => {
  it('"RANGE 7.0 km" with a caret at the tape centre when the range is dead ahead', () => {
    const s = setup();
    s.f.range = { x: 0, z: -7000, headingDeg: 0 };
    s.run();
    expect(s.m.rangeCue.show).toBe(true);
    expect(s.m.rangeCue.text).toBe('RANGE 7.0 km');
    expect(texts(s.g)).toContain('RANGE 7.0 km');
    const box = s.f.hudBox!;
    const tape = jetHeadingTape(box.w, box.h, true);
    expect(s.m.rangeCue.tapeX).toBeCloseTo(box.x + box.w / 2, 6);
    expect(s.m.rangeCue.tapeY).toBeCloseTo(box.y + tape.y, 6);
    expect(s.m.rangeCue.tapeDir).toBe(0);
    expect(s.m.rangeCue.steerShow).toBe(true);
  });

  it('off the tape: the caret sits at the end on the side to turn to; within 3 km it is gone', () => {
    const s = setup();
    s.f.range = { x: 7000, z: 0, headingDeg: 90 };
    s.run();
    const box = s.f.hudBox!;
    const tape = jetHeadingTape(box.w, box.h, true);
    expect(s.m.rangeCue.tapeDir).toBe(1);
    expect(s.m.rangeCue.tapeX).toBeCloseTo(box.x + box.w / 2 + tape.halfWidth, 6);
    s.f.range = { x: -7000, z: 0, headingDeg: 270 };
    s.run();
    expect(s.m.rangeCue.tapeDir).toBe(-1);
    s.f.range = { x: 0, z: -2000, headingDeg: 0 };
    s.run();
    expect(s.m.rangeCue.show).toBe(false);
  });

  it('tape at the top of the HUD with the gear down', () => {
    const s = setup();
    s.f.range = { x: 0, z: -7000, headingDeg: 0 };
    s.f.gearUp = false;
    s.run();
    const box = s.f.hudBox!;
    expect(s.m.rangeCue.tapeY).toBeCloseTo(box.y + jetHeadingTape(box.w, box.h, false).y, 6);
  });
});

describe('stores and messages', () => {
  it('"GUN 0" flashes when the gun is empty', () => {
    const s = setup({ status: { hasGun: true, rounds: 0, maxRounds: 1150 } });
    s.f.time = 0.01;
    s.run();
    expect(texts(s.g)).toContain('GUN 0 CM');
    s.f.time = 1 / (CONFIG.hud.weapons.flashHz * 2) + 0.01;
    s.run();
    expect(texts(s.g)).not.toContain('GUN 0 CM');
  });

  it('a message (NO LOCK) shows until it expires', () => {
    const s = setup();
    s.f.message = 'NO LOCK';
    s.f.messageUntil = 1.5;
    s.f.time = 0.1;
    s.run();
    expect(texts(s.g)).toContain('NO LOCK');
    s.f.time = 1.6;
    s.run();
    expect(texts(s.g)).not.toContain('NO LOCK');
  });

  it('readable at 1024 × 768 too: fonts ≥ 11 px, stores inside the viewport', () => {
    const s = setup({ w: 1024, h: 768 });
    s.run();
    expect(s.m.font).toBeGreaterThanOrEqual(11);
    for (const t of s.g.texts) {
      expect(t.p.x).toBeGreaterThanOrEqual(0);
      expect(t.p.x).toBeLessThanOrEqual(1024);
      expect(t.p.y).toBeGreaterThanOrEqual(0);
      expect(t.p.y).toBeLessThanOrEqual(768);
    }
  });
});

describe('seeker picture', () => {
  it('corner rect: bottom right, 4:3, within the viewport, clear of the systems strip at 1024 and 1440', () => {
    for (const [w, h] of [[1440, 900], [1024, 768], [1280, 720]] as const) {
      const strip = computeHudLayout(w, h, A10, 'normal', 'jet').strip;
      const r = seekerRect(w, h, CONFIG, strip);
      expect(r.w / r.h).toBeCloseTo(4 / 3, 1);
      expect(r.x + r.w).toBeLessThanOrEqual(w);
      expect(r.y + r.h).toBeLessThanOrEqual(h);
      expect(r.x).toBeGreaterThan(w / 2);
      const overlapX = r.x < strip.x + strip.w && strip.x < r.x + r.w;
      const overlapY = r.y < strip.y + strip.h && strip.y < r.y + r.h;
      expect(overlapX && overlapY).toBe(false);
    }
  });

  it('overlay: crosshair, track gates and LOCK', () => {
    const g = geoCtx();
    const s = createSeekerOverlay();
    s.state = 'locked';
    s.tx = 160;
    s.ty = 120;
    s.half = 14;
    s.fovLabel = 'EXP';
    s.missiles = 3;
    s.range = '2.4 NM';
    s.inRange = true;
    s.flashOn = true;
    drawSeekerOverlay(g.ctx, 320, 240, s);
    const t = g.texts.map((x) => x.s);
    expect(t).toContain('LOCK');
    expect(t).toContain('MAV ×3');
    expect(t).toContain('2.4 NM');
    expect(t).toContain('IN RNG');
    // Long crosshair lines across the picture.
    expect(g.segments.some((sg) => Math.abs(sg.a.y - sg.b.y) < 0.01 && Math.abs(sg.a.x - sg.b.x) > 60)).toBe(true);
    expect(g.segments.some((sg) => Math.abs(sg.a.x - sg.b.x) < 0.01 && Math.abs(sg.a.y - sg.b.y) > 40)).toBe(true);
  });
});

describe('fuzz', () => {
  const vec = fc.record({ x: fc.double({ min: -2e4, max: 2e4, noNaN: true }), y: fc.double({ min: -100, max: 3000, noNaN: true }), z: fc.double({ min: -2e4, max: 2e4, noNaN: true }) });
  const odd = fc.constantFrom(NaN, Infinity, -Infinity, 0, -1, 1e12);
  it('random statuses, cameras, targets: never throws, never NaN, clamped symbols inside the display', () => {
    fc.assert(
      fc.property(
        fc.record({
          cam: vec, look: vec, fov: fc.double({ min: 5, max: 100, noNaN: true }),
          ccip: fc.option(vec, { nil: null }), ccipRange: fc.oneof(fc.double({ min: 0, max: 5000, noNaN: true }), odd),
          rounds: fc.oneof(fc.integer({ min: 0, max: 1150 }), odd), missiles: fc.oneof(fc.integer({ min: 0, max: 4 }), odd),
          lockState: fc.constantFrom('off', 'tracking', 'locked'), progress: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), odd),
          lockRange: fc.oneof(fc.double({ min: 0, max: 20000, noNaN: true }), odd),
          targets: fc.array(fc.record({ p: vec, kind: fc.constantFrom('tank', 'ifv', 'apc', 'truck', 'aaa'), alive: fc.boolean(), hdg: fc.double({ min: -720, max: 720, noNaN: true }) }), { maxLength: 8 }),
          range: fc.option(vec, { nil: null }),
          exterior: fc.boolean(), gearUp: fc.boolean(), seeker: fc.boolean(),
          q: fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })),
          time: fc.double({ min: 0, max: 1e5, noNaN: true }),
          size: fc.constantFrom([1440, 900], [1024, 768], [300, 200], [0, 0], [NaN, 500]),
          aircraft: fc.constantFrom('a10', 'f16', 'c172rg'),
        }),
        (r) => {
          const cfg = getAircraftDef(r.aircraft).config;
          const s = setup({ cfg, exterior: r.exterior, w: r.size[0], h: r.size[1] });
          const cam = new THREE.PerspectiveCamera(r.fov, 1.6, 0.1, 90000);
          cam.position.set(r.cam.x, r.cam.y, r.cam.z);
          if (Math.hypot(r.look.x - r.cam.x, r.look.y - r.cam.y, r.look.z - r.cam.z) > 1) cam.lookAt(r.look.x, r.look.y, r.look.z);
          cam.updateMatrixWorld();
          cam.updateProjectionMatrix();
          s.f.view = cam.matrixWorldInverse.elements;
          s.f.proj = cam.projectionMatrix.elements;
          const qn = Math.hypot(...r.q) || 1;
          [s.f.qx, s.f.qy, s.f.qz, s.f.qw] = r.q.map((v) => v / qn);
          s.f.gearUp = r.gearUp;
          s.f.seekerActive = r.seeker;
          s.f.time = r.time;
          s.f.range = r.range ? { x: r.range.x, z: r.range.z, headingDeg: 0 } : null;
          const ids = r.targets.map((t) => {
            const g = s.world.addTarget({ kind: t.kind, position: t.p, headingDeg: t.hdg, group: 'f' });
            g.alive = t.alive;
            return g.id;
          });
          s.f.status = {
            ...emptyWeaponsStatus(), hasGun: true, rounds: r.rounds as number, maxRounds: 1150, hasMissiles: true, missiles: r.missiles as number, maxMissiles: 4,
            ccip: r.ccip, ccipRangeM: r.ccipRange as number,
            lock: { state: r.lockState, targetId: ids.length ? ids[0] : null, progress: r.progress as number, rangeM: r.lockRange as number, inRange: true },
          };
          const m = s.run();
          for (const n of s.g.numbers) expect(Number.isFinite(n)).toBe(true);
          if (m.pipper.show && m.pipper.clamped) {
            const d = m.display;
            expect(m.pipper.x).toBeGreaterThanOrEqual(d.x - 1e-6);
            expect(m.pipper.x).toBeLessThanOrEqual(d.x + d.w + 1e-6);
            expect(m.pipper.y).toBeGreaterThanOrEqual(d.y - 1e-6);
            expect(m.pipper.y).toBeLessThanOrEqual(d.y + d.h + 1e-6);
          }
          if (m.lock.show) {
            expect(Number.isFinite(m.lock.x) && Number.isFinite(m.lock.y)).toBe(true);
            expect(m.lock.x).toBeGreaterThanOrEqual(m.display.x - 1e-6);
            expect(m.lock.x).toBeLessThanOrEqual(m.display.x + m.display.w + 1e-6);
          }
          for (let i = 0; i < m.markerCount; i++) {
            expect(m.markers[2 * i]).toBeGreaterThanOrEqual(0);
            expect(m.markers[2 * i]).toBeLessThanOrEqual(m.w);
          }
        },
      ),
      fcParams(250),
    );
  });

  it('seeker overlay: any state draws finite numbers', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('off', 'tracking', 'locked'), fc.double(), fc.double(), fc.double(), fc.double({ min: 0, max: 1 }), fc.integer({ min: -2, max: 9 }),
        fc.constantFrom([320, 240], [0, 0], [NaN, 3], [240, 180]),
        (state, tx, ty, half, progress, missiles, [w, h]) => {
          const g = geoCtx();
          const s = createSeekerOverlay();
          Object.assign(s, { state, tx, ty, half, progress, missiles, flashOn: true, range: '1.0 NM' });
          drawSeekerOverlay(g.ctx, w, h, s);
          for (const n of g.numbers) expect(Number.isFinite(n)).toBe(true);
        },
      ),
      fcParams(200),
    );
  });
});

describe('F-16 / A-10 weapons config sanity used by the HUD', () => {
  it('A-10 gun line 2° down, F-16 on the datum', () => {
    expect(A10_WEAPONS.gun!.boresightDownDeg).toBe(2);
    expect(F16_WEAPONS.gun!.boresightDownDeg).toBe(0);
  });
});
