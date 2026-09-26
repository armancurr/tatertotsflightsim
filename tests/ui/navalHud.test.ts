// @vitest-environment happy-dom
/**
 * The naval fire-control HUD (src/ui/navalHud.ts + the navalHud system): the panel sits at the right
 * edge clear of the marine helm blocks and the compass at 1024×768 and 1440×900 (normal and cockpit
 * views); the display model from a live battery (ON TARGET / STANDBY / NO BEARING / OUT OF RANGE,
 * load bars, ready count, splash countdown); the painters on a recording canvas draw what matters and
 * never emit NaN (fuzzed); the system shows only for a vessel with naval guns.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG, IOWA_WEAPONS, type NavalGunsConfig } from '../../src/config';
import { computeHudLayout, type HudMode, type Rect } from '../../src/ui/hud';
import { computeNavalHudLayout, drawNavalOverlay, drawNavalPanel, navalHudKey, navalHudModel, turretStateText } from '../../src/ui/navalHud';
import { createBattery, requestSalvo, stepBattery, dueShots } from '../../src/combat/navalBattery';
import { newFireSolution } from '../../src/combat/naval';
import { navalHub, type NavalAim } from '../../src/combat/navalHub';
import navalHudModule from '../../src/game/systems/navalHud';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import { mockCtx } from './fixtures';

const GUNS = IOWA_WEAPONS.naval as NavalGunsConfig;
const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const aim = (over: Partial<NavalAim> = {}): NavalAim => ({ valid: true, source: 'pointer', point: { x: 0, y: 0, z: -12000 }, targetId: null, rangeM: 12000, bearingDeg: 271, tofS: 19.4, tooFar: false, tooClose: false, ...over });

describe('naval HUD layout', () => {
  for (const [w, h] of [[1024, 768], [1440, 900], [1920, 1080], [1280, 720]] as const) {
    for (const mode of ['normal', 'cockpitCompact'] as HudMode[]) {
      it(`${w}×${h} ${mode}: right edge, inside the view, clear of the helm blocks, the compass and the top bar`, () => {
        const p = computeNavalHudLayout(w, h, CONFIG, mode);
        const L = computeHudLayout(w, h, CONFIG, mode, 'marine');
        expect(p.w).toBeGreaterThan(200);
        expect(p.h).toBeGreaterThan(180);
        expect(p.x + p.w).toBeLessThanOrEqual(w);
        expect(p.x).toBeGreaterThan(w / 2);
        expect(p.y).toBeGreaterThanOrEqual(L.topInset);
        expect(p.y + p.h).toBeLessThanOrEqual(h);
        expect(overlap(p, L.compass)).toBe(false);
        if (L.marine?.nav) expect(overlap(p, L.marine.nav)).toBe(false);
        if (L.marine) expect(overlap(p, L.marine.engines)).toBe(false);
      });
    }
  }
  it('degenerate viewports never produce NaN or negative sizes', () => {
    fc.assert(fc.property(fc.double({ min: -100, max: 5000 }), fc.double({ min: -100, max: 3000 }), (w, h) => {
      const p = computeNavalHudLayout(w, h);
      for (const v of [p.x, p.y, p.w, p.h]) expect(Number.isFinite(v)).toBe(true);
      expect(p.w).toBeGreaterThanOrEqual(0);
      expect(p.h).toBeGreaterThanOrEqual(0);
    }));
  });
});

describe('naval HUD model', () => {
  it('reports each turret\'s state, the loads and the ready count', () => {
    const b = createBattery(GUNS);
    const sols = GUNS.turrets.map(() => newFireSolution());
    b.turrets[0].orderTrain = -90; b.turrets[0].orderElev = 8; b.turrets[0].onTarget = true; sols[0].ok = true;
    b.turrets[1].orderTrain = -90; b.turrets[1].orderElev = 8; b.turrets[1].armedUntil = 5;
    b.turrets[2].orderTrain = 30; b.turrets[2].orderElev = 8; b.turrets[2].inArc = false;
    let m = navalHudModel(GUNS.name, b, sols, aim());
    expect(m.turrets.map((t) => t.state)).toEqual(['on', 'armed', 'blind']);
    expect(m.turrets.map((t) => turretStateText(t.state))).toEqual(['ON TARGET', 'STANDBY', 'NO BEARING']);
    expect(m.ready).toBe(9);
    expect(m.guns).toBe(9);
    // fire turret I: its three guns start reloading
    b.turrets[1].armedUntil = -1;
    requestSalvo(b);
    const out: never[] = [];
    for (let i = 0; i < 60; i++) {
      stepBattery(b, 1 / 60);
      dueShots(b, out);
    }
    m = navalHudModel(GUNS.name, b, sols, aim(), { shells: 3, splashS: 17.2 });
    expect(m.ready).toBe(6);
    expect(m.turrets[0].load.every((l) => l > 0 && l < 1)).toBe(true);
    expect(m.turrets[0].rounds).toBe(3 * (GUNS.roundsPerGun - 1));
    expect(m.splashS).toBeCloseTo(17.2, 5);
    sols[1].tooFar = true;
    b.turrets[1].onTarget = false;
    expect(navalHudModel(GUNS.name, b, sols, aim({ tooFar: true })).turrets[1].state).toBe('range');
    expect(navalHudModel(GUNS.name, b, sols, aim({ valid: false })).turrets[0].state).toBe('stowed');
  });

  it('the redraw key changes with what is shown and not otherwise', () => {
    const b = createBattery(GUNS);
    const sols = GUNS.turrets.map(() => newFireSolution());
    const k1 = navalHudKey(navalHudModel(GUNS.name, b, sols, aim())).join(',');
    const k2 = navalHudKey(navalHudModel(GUNS.name, b, sols, aim({ rangeM: 12010 }))).join(',');
    const k3 = navalHudKey(navalHudModel(GUNS.name, b, sols, aim({ rangeM: 12500 }))).join(',');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });
});

describe('naval HUD painters', () => {
  it('draws the header, the solution, three turret cards and the ready line', () => {
    const b = createBattery(GUNS);
    const sols = GUNS.turrets.map(() => newFireSolution());
    b.turrets.forEach((t) => ((t.orderTrain = t.cfg.name === 'III' ? 270 : -90), (t.orderElev = 9), (t.onTarget = true)));
    const m = mockCtx(300, 300);
    drawNavalPanel(m.ctx, 300, 300, navalHudModel(GUNS.name, b, sols, aim(), { target: 'Target raft', splashS: 12 }));
    const t = m.texts();
    for (const s of ['MAIN BATTERY', 'TARGET RAFT', 'RANGE', '12.0 km', '271°', '19 s', 'I', 'II', 'III', 'ON TARGET', 'READY 9/9', 'SPLASH 12 s']) expect(t).toContain(s);
    expect(m.bad()).toEqual([]);
  });

  it('out of range shows in red; no aim shows dashes', () => {
    const m = mockCtx(300, 300);
    drawNavalPanel(m.ctx, 300, 300, navalHudModel(GUNS.name, createBattery(GUNS), [], aim({ tooFar: true, rangeM: 45000 })));
    expect(m.texts()).toContain('OUT OF RANGE');
    const n = mockCtx(300, 300);
    drawNavalPanel(n.ctx, 300, 300, navalHudModel(GUNS.name, createBattery(GUNS), [], aim({ valid: false })));
    expect(n.texts()).toContain('NO AIM');
    expect(n.texts()).toContain('— km');
  });

  it('the overlay draws the aim marker, the lock bracket, splash diamonds with one countdown, and fading falls', () => {
    const m = mockCtx(1440, 900);
    drawNavalOverlay(m.ctx, 1440, 900, {
      aim: { x: 700, y: 450, visible: true }, aimOk: true, lock: { x: 700, y: 450, visible: true, r: 20 },
      splashes: [{ x: 690, y: 452, visible: true, s: 7.2 }, { x: 710, y: 449, visible: true, s: 7.6 }],
      falls: [{ x: 600, y: 460, visible: true, age: 0.2, hit: true }, { x: 610, y: 460, visible: false, age: 0.2, hit: false }],
    });
    expect(m.texts()).toEqual(['8']);
    expect(m.argsOf('arc').length).toBeGreaterThanOrEqual(3);
    expect(m.bad()).toEqual([]);
  });

  it('fuzz: garbage models and sizes never throw or emit NaN', () => {
    const b = createBattery(GUNS);
    fc.assert(fc.property(
      fc.double(), fc.double(), fc.double(), fc.double({ min: 1, max: 900 }), fc.double({ min: 1, max: 900 }), fc.boolean(), fc.option(fc.double(), { nil: null }),
      (range, brg, tof, w, h, far, splash) => {
        b.turrets[0].trainDeg = range;
        b.turrets[1].elevDeg = tof;
        const m = mockCtx(w, h);
        drawNavalPanel(m.ctx, w, h, navalHudModel(GUNS.name, b, [], aim({ rangeM: range, bearingDeg: brg, tofS: tof, tooFar: far }), { splashS: splash }));
        drawNavalOverlay(m.ctx, w, h, { aim: { x: range, y: brg, visible: Number.isFinite(range + brg) }, aimOk: far, lock: null, splashes: [], falls: [] });
        expect(m.bad()).toEqual([]);
      },
    ), { numRuns: 120 });
  });
});

describe('navalHud system', () => {
  it('shows only while the vehicle has naval guns, and renders the panel from the hub', async () => {
    const scene = new THREE.Scene();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ctx = { scene, hudRoot: root } as unknown as SystemContext;
    const sys = await navalHudModule.create(ctx);
    const hub = navalHub(scene);
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1e5);
    cam.updateMatrixWorld();
    const frame = (t: number) => ({ time: t, dt: 1 / 60, cameraMode: 'chase', camera: cam, paused: false } as unknown as SystemFrame);
    sys.update!(frame(0));
    const el = root.querySelector('.fsn-root') as HTMLElement;
    expect(el.style.display).toBe('none');
    hub.guns = GUNS;
    hub.battery = createBattery(GUNS);
    hub.solutions = GUNS.turrets.map(() => newFireSolution());
    Object.assign(hub.aim, aim());
    sys.update!(frame(1));
    expect(el.style.display).toBe('block');
    expect(root.querySelector('[data-hud="naval-panel"]')).not.toBeNull();
    const st = sys.stats!() as { shown: boolean; panel: Rect };
    expect(st.shown).toBe(true);
    hub.guns = null;
    sys.update!(frame(2));
    expect(el.style.display).toBe('none');
    sys.dispose!();
    expect(root.querySelector('.fsn-root')).toBeNull();
  });
});
