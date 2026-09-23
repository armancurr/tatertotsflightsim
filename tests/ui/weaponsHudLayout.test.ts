/**
 * The weapons HUD's text layout (src/ui/weaponsHudLayout.ts + layoutTexts in src/ui/weaponsHud.ts):
 *
 *  - unit: the placer puts a block next to its symbol, steps around hard obstacles, keeps last
 *    frame's spot, drops the least important lines when nothing fits, never leaves the display;
 *  - mirror: the jet HUD, drawn on the geometry canvas, puts every one of its texts (bar the pitch
 *    ladder's numbers) inside `jetHudKeepOut`'s rects — full and compact layouts, glass and screen;
 *  - property: for random lock geometries (targets anywhere in view, ground and air, tracking or
 *    locked, CCIP pipper, gun lead, messages, range cue, gear/speed brake) at 1440×900 and
 *    1024×768, in the chase view, the screen cockpit HUD and on the F-16 / A-10 combiner glass
 *    (full and compact, zoomed), no two texts intersect, none touches the heading tape or the jet
 *    HUD's own text, all stay inside the display, and the drawing puts them exactly there;
 *  - functional: the QA case — an A-10 locked on a Mi-24 ~600 m ahead in the chase view.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG, type Config } from '../../src/config';
import { getAircraftDef } from '../../src/fleet';
import { createCombatWorld, emptyWeaponsStatus } from '../../src/combat/world';
import type { WeaponsStatus } from '../../src/combat/types';
import { computeHudLayout, type HudMode } from '../../src/ui/hud';
import { createJetHudState, drawJetHud, jetHeadingTape, jetHudCompact, jetHudGeometryOnGlass } from '../../src/ui/jetHud';
import { createHudGlass, type HudGlass } from '../../src/ui/hudGlass';
import {
  createWeaponsHudFrame, createWeaponsHudModel, drawWeaponsHud, updateWeaponsHud, TX_AAM, TX_COUNT, TX_GUN, TX_KILLS, TX_LOCK, TX_MSL, TX_RANGE, TX_TYPE,
  type WeaponsHudFrame, type WeaponsHudModel,
} from '../../src/ui/weaponsHud';
import {
  createPlaced, JET_KEEP_OUT_MAX, JET_TAPE_RECTS, jetHudKeepOut, placeOptions, rectsOverlap, TextPlacer, textHeight, textWidth, type LineSpec,
} from '../../src/ui/weaponsHudLayout';
import { makeReadings } from './fixtures';
import { geoCtx } from './geoCtx';
import { fcParams } from '../support/fc';

const A10 = getAircraftDef('a10').config;
const F16 = getAircraftDef('f16').config;

// ─── Placer ──────────────────────────────────────────────────────────────────

describe('text placer', () => {
  const lines: LineSpec[] = [{ chars: 4, px: 13 }, { chars: 5, px: 12 }, { chars: 7, px: 12 }];
  const sym = { x0: 490, y0: 290, x1: 510, y1: 310 };

  it('text sizes grow with the characters and the font', () => {
    expect(textWidth(6, 12)).toBeGreaterThan(textWidth(5, 12));
    expect(textWidth(6, 14)).toBeGreaterThan(textWidth(6, 12));
    expect(textWidth(6, 12)).toBeGreaterThanOrEqual(6 * 0.6 * 12);
    expect(textHeight(12)).toBeGreaterThan(12);
  });

  it('split: the first line above the symbol, the rest below, centred', () => {
    const p = new TextPlacer();
    p.reset(0, 0, 1000, 600);
    const out = p.placeBlock(createPlaced(), lines, 3, 14, sym, placeOptions({ split: true }));
    expect(out.ok).toBe(true);
    expect(out.align).toBe('center');
    expect(out.y[0]).toBeLessThan(sym.y0);
    expect(out.y[1]).toBeGreaterThan(sym.y1);
    expect(out.y[2]).toBeGreaterThan(out.y[1]);
    expect(out.x[0]).toBe(500);
    expect(p.nPlaced).toBe(3);
  });

  it('steps round a hard obstacle under the symbol (to its right), keeps that spot next frame', () => {
    const p = new TextPlacer();
    p.reset(0, 0, 1000, 600);
    p.addHard(300, 312, 700, 400); // a band under the symbol
    const memo = createPlaced();
    const out = p.placeBlock(memo, lines, 3, 14, sym, placeOptions({ prefer: 'below' }));
    expect(out.ok).toBe(true);
    for (let k = 0; k < p.nPlaced; k++) {
      expect(p.placed[4 * k + 3] <= 312 || p.placed[4 * k + 1] >= 400 || p.placed[4 * k] >= 700 || p.placed[4 * k + 2] <= 300).toBe(true);
    }
    const spot = out.spot;
    // Next frame the band is gone: the block stays where it was (no jumping about).
    p.reset(0, 0, 1000, 600);
    p.placeBlock(memo, lines, 3, 14, sym, placeOptions({ prefer: 'below' }));
    expect(memo.spot).toBe(spot);
  });

  it('drops the least important lines when the block fits nowhere, and never leaves the display', () => {
    const p = new TextPlacer();
    p.reset(0, 0, 52, 40); // room for the 5-character line only
    const out = p.placeBlock(createPlaced(), lines, 3, 14, { x0: 25, y0: 34, x1: 35, y1: 40 }, placeOptions({ dropOrder: [0, 2] }));
    expect(out.ok).toBe(true);
    expect(Array.from(out.shown.slice(0, 3))).toEqual([0, 1, 0]);
    for (let k = 0; k < p.nPlaced; k++) {
      expect(p.placed[4 * k]).toBeGreaterThanOrEqual(0);
      expect(p.placed[4 * k + 2]).toBeLessThanOrEqual(52);
      expect(p.placed[4 * k + 1]).toBeGreaterThanOrEqual(0);
      expect(p.placed[4 * k + 3]).toBeLessThanOrEqual(40);
    }
    // nothing fits at all: nothing is placed
    p.reset(0, 0, 10, 10);
    const none = p.placeBlock(createPlaced(), lines, 3, 14, sym, placeOptions({ dropOrder: [0, 1, 2] }));
    expect(none.ok).toBe(false);
    expect(p.nPlaced).toBe(0);
  });

  it('fuzz: placed lines never overlap each other or a hard obstacle, and stay in the display', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ min: 0, max: 900, noNaN: true }), y: fc.double({ min: 0, max: 500, noNaN: true }), w: fc.double({ min: 2, max: 300, noNaN: true }), h: fc.double({ min: 2, max: 120, noNaN: true }) }), { maxLength: 12 }),
        fc.array(fc.record({ x: fc.double({ min: 0, max: 1000, noNaN: true }), y: fc.double({ min: 0, max: 600, noNaN: true }), n: fc.integer({ min: 1, max: 4 }), chars: fc.integer({ min: 1, max: 14 }) }), { minLength: 1, maxLength: 6 }),
        (obst, blocks) => {
          const p = new TextPlacer();
          p.reset(0, 0, 1000, 600);
          for (const o of obst) p.addHard(o.x, o.y, o.x + o.w, o.y + o.h);
          const nObst = p.nHard;
          const hard = p.hard.slice(0, nObst * 4);
          for (const b of blocks) {
            const ls = Array.from({ length: b.n }, (_, i) => ({ chars: b.chars + i, px: 12 }));
            p.placeBlock(createPlaced(), ls, b.n, 14, { x0: b.x - 8, y0: b.y - 8, x1: b.x + 8, y1: b.y + 8 }, placeOptions({ split: b.n > 1, dropOrder: [0, 1, 2] }));
          }
          for (let i = 0; i < p.nPlaced; i++) {
            expect(p.placed[4 * i]).toBeGreaterThanOrEqual(0);
            expect(p.placed[4 * i + 2]).toBeLessThanOrEqual(1000);
            for (let j = 0; j < i; j++) expect(rectsOverlap(p.placed, i, p.placed, j)).toBe(false);
            for (let j = 0; j < nObst; j++) expect(rectsOverlap(p.placed, i, hard, j)).toBe(false);
          }
        },
      ),
      fcParams(200),
    );
  });
});

// ─── The jet HUD's own space ─────────────────────────────────────────────────

type Rd = ReturnType<typeof makeReadings> & { betaDeg: number; flightPathDeg: number; speedBrake: boolean };
const jetReadings = (over: Partial<Rd> = {}): Rd =>
  ({ ...makeReadings({ airspeedKt: 420, altitudeFt: 12000, mach: 0.72, afterburner: 0, gear: 'up', gearLight: 'off', pitchDeg: 0, rollDeg: 0, ...over }), betaDeg: 0, flightPathDeg: 0, speedBrake: false, ...over }) as Rd;

function glassOf(w: number, h: number, boreY: number, ox = 600, oy = 200): HudGlass {
  const g = createHudGlass();
  g.visible = true;
  g.vw = 1440;
  g.vh = 900;
  g.w = w;
  g.h = h;
  g.ppd = h / 20;
  g.boreX = w / 2;
  g.boreY = boreY;
  g.horizonOk = false;
  g.fpmOk = false;
  g.m.set([1, 0, 0, 1, ox, oy]);
  g.inv.set([1, 0, 0, 1, -ox, -oy]);
  g.quad.set([ox, oy, ox + w, oy, ox + w, oy + h, ox, oy + h]);
  g.minX = ox;
  g.minY = oy;
  g.maxX = ox + w;
  g.maxY = oy + h;
  return g;
}

/** Texts the jet HUD draws (device px), with their font size and alignment. */
function drawnJetTexts(w: number, h: number, r: Rd, glass: HudGlass | null, cfg: Config) {
  const g = geoCtx();
  const out: { s: string; x: number; y: number; px: number; align: string }[] = [];
  const inner = g.ctx as unknown as Record<string, unknown> & { fillText: (s: string, x: number, y: number) => void; font: string; textAlign: string };
  const ctx = new Proxy(inner, {
    get(_t, k: string) {
      if (k === 'fillText') {
        return (s: string, x: number, y: number) => {
          const before = g.texts.length;
          inner.fillText(s, x, y);
          const t = g.texts[before];
          const px = Number(/([\d.]+)px/.exec(inner.font)?.[1] ?? NaN);
          if (t) out.push({ s, x: t.p.x, y: t.p.y, px, align: inner.textAlign });
        };
      }
      return inner[k];
    },
    set(_t, k: string, v) {
      inner[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  if (glass) {
    drawJetHud(ctx, glass.w, glass.h, r, createJetHudState(), cfg, { geometry: jetHudGeometryOnGlass(glass, r), minFont: 11 });
  } else drawJetHud(ctx, w, h, r, createJetHudState(), cfg);
  return out;
}

/** Pitch-ladder numbers (roll 0): x at bore ± (0.15 W + 1.2 small). */
function isLadderLabel(t: { x: number; px: number }, w: number): boolean {
  const off = w * 0.15 + t.px * 1.2;
  return Math.abs(t.x - (w / 2 - off)) < 0.5 || Math.abs(t.x - (w / 2 + off)) < 0.5;
}

function checkMirror(w: number, h: number, r: Rd, glass: HudGlass | null, cfg: Config) {
  const ko = new Float64Array(JET_KEEP_OUT_MAX * 4);
  const boreY = glass ? glass.boreY : h * cfg.hud.jet.boresightY;
  const n = jetHudKeepOut(ko, { x: 0, y: 0, w, h, glass: !!glass, boreY, gearUp: r.gear === 'up', font: 12, speedBrake: r.speedBrake, abOrEngine: (r.afterburner ?? 0) > 0.02 || r.engineStatus === 'OFF' || r.engineStatus === 'FAILED' }, cfg);
  expect(n).toBeGreaterThan(3);
  const texts = drawnJetTexts(w, h, r, glass, cfg);
  expect(texts.length).toBeGreaterThan(3);
  for (const t of texts) {
    if (isLadderLabel(t, w)) continue;
    const tw = t.s.length * 0.6 * t.px;
    const x0 = t.align === 'left' ? t.x : t.align === 'right' ? t.x - tw : t.x - tw / 2;
    const cx = x0 + tw / 2;
    // centre and both ends of the text lie in one keep-out rect
    let inside = false;
    for (let k = 0; k < n; k++) {
      const a = ko[4 * k], b = ko[4 * k + 1], c = ko[4 * k + 2], d = ko[4 * k + 3];
      if (x0 >= a - 0.5 && x0 + tw <= c + 0.5 && t.y - t.px * 0.45 >= b - 0.5 && t.y + t.px * 0.45 <= d + 0.5) inside = true;
    }
    expect(inside, `"${t.s}" at ${cx.toFixed(1)},${t.y.toFixed(1)} (${w}×${h}${glass ? ' glass' : ''}) is outside the jet HUD keep-out`).toBe(true);
  }
}

describe('jet HUD keep-out mirrors drawJetHud', () => {
  const boxes = (): { w: number; h: number; mode: HudMode; vw: number; vh: number }[] => {
    const out: { w: number; h: number; mode: HudMode; vw: number; vh: number }[] = [];
    for (const [vw, vh] of [[1440, 900], [1024, 768]]) {
      for (const mode of ['normal', 'cockpitHidden'] as HudMode[]) {
        const b = computeHudLayout(vw, vh, F16, mode, 'jet').jet!;
        out.push({ w: b.w, h: b.h, mode, vw, vh });
      }
    }
    return out;
  };

  it('screen HUD boxes at 1440×900 and 1024×768 (chase and cockpit), gear up and down, cues on', () => {
    for (const b of boxes()) {
      for (const gear of ['up', 'down'] as const) {
        checkMirror(b.w, b.h, jetReadings({ gear, speedBrake: true, afterburner: 0.6, altitudeFt: 12340, altitudeAglFt: 4320, verticalSpeedFpm: -12340 }), null, F16);
        checkMirror(b.w, b.h, jetReadings({ gear, speedBrake: false, afterburner: 0, altitudeFt: 999, altitudeAglFt: 900 }), null, A10);
      }
    }
  });

  it('combiner glass: F-16 (full layout) and A-10 (compact), both sizes and zoomed', () => {
    for (const [w, h] of [[263, 226], [225, 193], [630, 539], [181, 168], [155, 143], [433, 401], [370, 342]]) {
      expect(jetHudCompact(w, h, true)).toBe(h < 190);
      for (const boreY of [h * 0.34, h * 0.5, h * 0.2]) {
        for (const gear of ['up', 'down'] as const) {
          checkMirror(w, h, jetReadings({ gear, speedBrake: gear === 'down', afterburner: gear === 'down' ? 0.5 : 0 }), glassOf(w, h, boreY), F16);
        }
      }
    }
  });

  it('fuzz: any box, readings and cues — every jet HUD text is inside the keep-out', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 140, max: 700 }), fc.integer({ min: 120, max: 700 }), fc.boolean(), fc.double({ min: 0.15, max: 0.7, noNaN: true }),
        fc.record({
          gear: fc.constantFrom('up', 'down', 'transit'), speedBrake: fc.boolean(), afterburner: fc.constantFrom(0, 0.5, 1),
          airspeedKt: fc.double({ min: 0, max: 800, noNaN: true }), altitudeFt: fc.double({ min: -500, max: 49000, noNaN: true }),
          altitudeAglFt: fc.double({ min: 0, max: 6000, noNaN: true }), verticalSpeedFpm: fc.double({ min: -30000, max: 30000, noNaN: true }),
          mach: fc.double({ min: 0, max: 2, noNaN: true }), aoaDeg: fc.double({ min: -20, max: 40, noNaN: true }), gLoad: fc.double({ min: -3, max: 9.9, noNaN: true }),
          engineStatus: fc.constantFrom('RUN', 'OFF', 'FAILED', 'START'),
        }),
        (w, h, onGlass, boreK, over) => {
          const r = jetReadings({ ...over, rollDeg: 0 } as Partial<Rd>);
          checkMirror(w, h, r, onGlass ? glassOf(w, h, h * boreK) : null, F16);
        },
      ),
      fcParams(150),
    );
  });
});

// ─── The whole weapons HUD: no text overlaps ─────────────────────────────────

interface View { name: string; vw: number; vh: number; exterior: boolean; glass: [number, number] | null; cfg: Config }
const VIEWS: View[] = [];
for (const [vw, vh] of [[1440, 900], [1024, 768]]) {
  for (const cfg of [A10, F16]) {
    VIEWS.push({ name: `chase ${vw}`, vw, vh, exterior: true, glass: null, cfg });
    VIEWS.push({ name: `cockpit screen ${vw}`, vw, vh, exterior: false, glass: null, cfg });
  }
}
// measured combiner glass boxes (window.sim.weaponsHudProbe().glass): F-16 full, A-10 compact, zoomed in (wheel)
for (const [w, h, cfg] of [[263, 226, F16], [225, 193, F16], [630, 539, F16], [181, 168, A10], [155, 143, A10], [433, 401, A10], [370, 342, A10]] as [number, number, Config][]) {
  VIEWS.push({ name: `glass ${w}×${h}`, vw: 1440, vh: 900, exterior: false, glass: [w, h], cfg });
}

interface Scene {
  kind: 'fighter' | 'helo' | 'attack' | 'tank' | 'truck';
  az: number;
  el: number;
  range: number;
  vel: { x: number; y: number; z: number };
  lockState: 'tracking' | 'locked';
  progress: number;
  inRange: boolean;
  ccip: null | { az: number; el: number; range: number };
  message: string;
  rangeCue: boolean;
  gearUp: boolean;
  speedBrake: boolean;
  time: number;
  pitchCam: number;
}

/** Aircraft at (0, 800, 0) flying north; camera per view; one target at (az, el, range) from the aircraft. */
function runScene(v: View, sc: Scene) {
  const cfg = v.cfg;
  const fov = v.exterior ? 60 : 70;
  const cam = new THREE.PerspectiveCamera(fov, v.vw / v.vh, 0.1, 90000);
  if (v.exterior) {
    cam.position.set(0, 806, 24);
    cam.lookAt(0, 801 + sc.pitchCam * 20, -100);
  } else {
    cam.position.set(0, 801, -4);
    cam.lookAt(0, 801 + sc.pitchCam * 20, -1000);
  }
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const world = createCombatWorld(cfg);
  const f: WeaponsHudFrame = createWeaponsHudFrame();
  f.w = v.vw;
  f.h = v.vh;
  f.view = cam.matrixWorldInverse.elements;
  f.proj = cam.projectionMatrix.elements;
  f.exterior = v.exterior;
  const mode: HudMode = v.exterior ? 'normal' : 'cockpitHidden';
  f.hudBox = computeHudLayout(v.vw, v.vh, cfg, mode, 'jet').jet;
  let glass: HudGlass | null = null;
  if (v.glass) {
    const [w, h] = v.glass;
    const ox = Math.round((v.vw - w) / 2);
    const oy = Math.round(v.vh * 0.4 - h / 2);
    glass = glassOf(w, h, h * 0.345, ox, oy);
    f.glass = glass;
  }
  f.gearUp = sc.gearUp;
  f.speedBrake = sc.speedBrake;
  f.abOrEngine = false;
  f.ax = 0;
  f.ay = 800;
  f.az = 0;
  f.vx = 0;
  f.vy = 0;
  f.vz = -140;
  f.headingDeg = 0;
  f.weapons = cfg.weapons;
  f.time = sc.time;
  const air = sc.kind === 'fighter' || sc.kind === 'helo' || sc.kind === 'attack';
  const dir = (az: number, el: number) => ({ x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) });
  const d = dir(sc.az, sc.el);
  const pos = { x: d.x * sc.range, y: 800 + d.y * sc.range, z: d.z * sc.range };
  const t = air
    ? world.addTarget({ kind: sc.kind, position: pos, headingDeg: 0, velocity: sc.vel, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' })
    : world.addTarget({ kind: sc.kind, position: { ...pos, y: Math.min(pos.y, 780) }, headingDeg: 0, group: 'g' });
  const st: WeaponsStatus = { ...emptyWeaponsStatus(), hasGun: true, rounds: 1150 };
  st.lock = { state: sc.lockState, targetId: t.id, progress: sc.progress, rangeM: sc.range, inRange: sc.inRange };
  if (sc.ccip) {
    const c = dir(sc.ccip.az, sc.ccip.el);
    st.ccip = { x: c.x * sc.ccip.range, y: 800 + c.y * sc.ccip.range, z: c.z * sc.ccip.range };
    st.ccipRangeM = sc.ccip.range;
  }
  f.status = st;
  f.targets = world.targets;
  f.classOf = world.classOf;
  f.range = sc.rangeCue ? { x: 3000, z: -9000, headingDeg: 0 } as never : null;
  f.message = sc.message;
  f.messageUntil = sc.message ? sc.time + 2 : 0;
  f.seekerActive = true;
  const m = createWeaponsHudModel(cfg);
  updateWeaponsHud(m, f, cfg);
  const g = geoCtx();
  drawWeaponsHud(g.ctx, m, cfg);
  return { m, g, f, glass };
}

function assertNoOverlap(m: WeaponsHudModel, label: string) {
  const R = m.rects;
  const shown: number[] = [];
  for (let i = 0; i < TX_COUNT; i++) if (m.texts[i].show) shown.push(i);
  const d = m.display;
  for (const i of shown) {
    const t = m.texts[i];
    expect(R[4 * i] >= d.x - 0.01 && R[4 * i + 2] <= d.x + d.w + 0.01 && R[4 * i + 1] >= d.y - 0.01 && R[4 * i + 3] <= d.y + d.h + 0.01, `${label}: "${t.s}" leaves the display`).toBe(true);
    for (const j of shown) if (j < i) expect(rectsOverlap(R, i, R, j), `${label}: "${t.s}" overlaps "${m.texts[j].s}"`).toBe(false);
    for (let k = 0; k < m.nKeepOut; k++) {
      expect(rectsOverlap(R, i, m.keepOut, k), `${label}: "${t.s}" overlaps the jet HUD ${k >= m.nKeepOut - JET_TAPE_RECTS ? 'heading tape' : `text #${k}`}`).toBe(false);
    }
  }
}

/** Every text drawn is a laid-out one, exactly at its place (through the glass transform). */
function assertDrawnAsLaidOut(m: WeaponsHudModel, g: ReturnType<typeof geoCtx>, label: string) {
  const ox = m.glassOn ? m.xform[4] : 0;
  const oy = m.glassOn ? m.xform[5] : 0;
  const want = m.texts.filter((t) => t.show && (!t.blink || m.flashOn));
  expect(g.texts.length, label).toBe(want.length);
  for (const t of g.texts) {
    const hit = want.find((w) => w.s === t.s && Math.abs(w.x + ox - t.p.x) < 1e-6 && Math.abs(w.y + oy - t.p.y) < 1e-6);
    expect(hit, `${label}: "${t.s}" drawn off its layout`).toBeTruthy();
  }
}

const sceneArb = (): fc.Arbitrary<Scene> =>
  fc.record({
    kind: fc.constantFrom('fighter', 'helo', 'attack', 'tank', 'truck'),
    az: fc.double({ min: -0.7, max: 0.7, noNaN: true }),
    el: fc.double({ min: -0.5, max: 0.3, noNaN: true }),
    range: fc.double({ min: 150, max: 7000, noNaN: true }),
    vel: fc.record({ x: fc.double({ min: -200, max: 200, noNaN: true }), y: fc.double({ min: -30, max: 30, noNaN: true }), z: fc.double({ min: -200, max: 200, noNaN: true }) }),
    lockState: fc.constantFrom('tracking', 'locked'),
    progress: fc.double({ min: 0, max: 1, noNaN: true }),
    inRange: fc.boolean(),
    ccip: fc.option(fc.record({ az: fc.double({ min: -0.3, max: 0.3, noNaN: true }), el: fc.double({ min: -0.6, max: -0.02, noNaN: true }), range: fc.double({ min: 300, max: 3000, noNaN: true }) }), { nil: null }),
    message: fc.constantFrom('', '', 'FOX 2', 'LOCK LOST', 'OUT OF RNG'),
    rangeCue: fc.boolean(),
    gearUp: fc.boolean(),
    speedBrake: fc.boolean(),
    time: fc.double({ min: 0, max: 100, noNaN: true }),
    pitchCam: fc.double({ min: -1, max: 1, noNaN: true }),
  });

describe('weapons HUD: no text overlaps another, the heading tape or the jet HUD', () => {
  it('property: random lock geometries in every view (chase, cockpit, F-16/A-10 glass, zoomed) at 1440×900 and 1024×768', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VIEWS), sceneArb(), (v, sc) => {
        const { m, g } = runScene(v, sc);
        if (!m.show) return;
        const label = `${v.name} ${v.cfg === A10 ? 'A-10' : 'F-16'}`;
        assertNoOverlap(m, label);
        assertDrawnAsLaidOut(m, g, label);
        // the stores block keeps its gun line
        expect(m.texts[7].show, `${label}: gun line dropped`).toBe(true);
      }),
      fcParams(600),
    );
  }, 60_000);

  it('the lock data survives: range always, and the full block in the roomy views', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VIEWS.filter((v) => !v.glass || v.glass[1] >= 300)), sceneArb(), (v, sc) => {
        const { m } = runScene(v, { ...sc, lockState: 'locked', az: sc.az * 0.4, el: Math.max(-0.25, Math.min(0.15, sc.el)) });
        if (!m.lock.show) return;
        expect(m.texts[TX_RANGE].show, v.name).toBe(true);
        if (!m.lock.clamped) expect(m.texts[TX_TYPE].show, v.name).toBe(true);
      }),
      fcParams(200),
    );
  }, 60_000);
});

describe('QA case: A-10 locked on a Mi-24 ~600 m ahead', () => {
  const base: Scene = {
    kind: 'helo', az: 0, el: -0.004, range: 600, vel: { x: 20, y: 0, z: -50 }, lockState: 'locked', progress: 1, inRange: true,
    ccip: null, message: '', rangeCue: false, gearUp: true, speedBrake: false, time: 0.1, pitchCam: 0,
  };
  for (const v of VIEWS.filter((x) => x.cfg === A10 || x.glass)) {
    it(`${v.name}: LOCK / Mi-24 / range / IN RNG all shown, off the heading tape, next to the box`, () => {
      const { m, g } = runScene(v, base);
      expect(m.lock.show).toBe(true);
      assertNoOverlap(m, v.name);
      assertDrawnAsLaidOut(m, g, v.name);
      expect(m.texts[TX_RANGE].show).toBe(true);
      expect(m.texts[TX_RANGE].s).toMatch(/FT$/);
      if (!v.glass || v.glass[1] >= 190) {
        expect(m.texts[TX_LOCK].show).toBe(true);
        expect(m.texts[TX_TYPE].s).toBe('Mi-24');
      }
      // the whole stores block is there (on a small combiner some of it moves bottom-right)
      for (const i of [TX_GUN, TX_AAM, TX_MSL, TX_KILLS]) expect(m.texts[i].show, `${v.name}: ${m.texts[i].s}`).toBe(true);
      // the data sits by the box (within a few lines of it)
      const t = m.texts[TX_RANGE];
      expect(Math.hypot(t.x - m.lock.x, t.y - m.lock.y)).toBeLessThan(m.lock.half + m.font * 12);
    });
  }

  it('the stores block stays by the HUD box (never jumps to the viewport bottom), with the range caret on the tape', () => {
    for (const v of VIEWS.filter((x) => !x.glass)) {
      for (const rangeCue of [false, true]) {
        const { m } = runScene(v, { ...base, rangeCue });
        const hb = computeHudLayout(v.vw, v.vh, v.cfg, v.exterior ? 'normal' : 'cockpitHidden', 'jet').jet!;
        for (const i of [TX_GUN, TX_KILLS]) {
          expect(m.texts[i].show).toBe(true);
          expect(m.texts[i].y, `${v.name} ${m.texts[i].s}`).toBeLessThan(hb.y + hb.h);
          expect(m.texts[i].y).toBeGreaterThan(hb.y + hb.h * 0.5);
        }
      }
    }
  });

  it('the heading tape band really is where the tape draws (chase view, gear up)', () => {
    const v = VIEWS[0];
    const { m } = runScene(v, base);
    const hb = computeHudLayout(v.vw, v.vh, A10, 'normal', 'jet').jet!;
    const tape = jetHeadingTape(hb.w, hb.h, true, false);
    const k = m.nKeepOut - JET_TAPE_RECTS;
    expect(m.keepOut[4 * k + 1]).toBeLessThan(hb.y + tape.y);
    expect(m.keepOut[4 * k + 3]).toBeGreaterThan(hb.y + tape.y);
    expect(m.keepOut[4 * k]).toBeLessThan(hb.x + hb.w / 2 - tape.halfWidth);
    expect(m.keepOut[4 * k + 2]).toBeGreaterThan(hb.x + hb.w / 2 + tape.halfWidth);
  });
});

void CONFIG;
