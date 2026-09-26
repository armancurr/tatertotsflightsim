// @vitest-environment happy-dom
/**
 * The marine helm HUD (vessels, the Princess V50): the helm readings instruments.ts builds from a
 * hand-made VesselState (and that nothing aircraft-specific fires on a boat, nor throws without
 * one), the pure scales (lever gear / detent, tach range, shallow alarm, lever travel), the layout
 * at 1024×768 and 1440×900 in the normal and cockpit views (in the bottom third, no overlaps), the
 * painters on a recording canvas (and fuzzed), the vessel annunciators / hint / crash text, the
 * overlay wired into createHud ("Cast off", "Aground!", no landing toast), the Helm controls page
 * and the picker's Vessels group.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { CONFIG, V50_AIRCRAFT, type Config } from '../../src/config';
import type { AircraftState, InstrumentReadings, PropulsorState, VesselReadings, VesselState } from '../../src/types';
import { createInstrumentModel, leverGear, sounderDepth, updateInstruments } from '../../src/ui/instruments';
import {
  computeMarineHudLayout, drawMarineCompact, drawMarineEngines, drawMarineNav, leverY, shallowAlarm, speedText, steerText, tachAngle, tachRange,
  SHALLOW_ALARM_M,
} from '../../src/ui/marineHud';
import { computeHudLayout, createHud, type Hud, type HudInfo, type Rect } from '../../src/ui/hud';
import { annunciations, crashText, startHint } from '../../src/ui/messages';
import { controlGroups, controlNotes } from '../../src/ui/controls';
import { createAircraftPicker, orderPickerItems } from '../../src/ui/picker';
import { keyLabel } from '../../src/ui/messages';
import { arbState, makeControls, makeReadings, makeState, makeTouchdown, mockCtx, type MockCtx } from './fixtures';

const V50: Config = { ...CONFIG, aircraft: V50_AIRCRAFT };
const KT = 1 / 1.943844;
const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r: Rect, w: number, h: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h;

const prop = (over: Partial<PropulsorState> = {}): PropulsorState => ({ rpm: 2950, n: 27, gear: 'ahead', thrust: 18000, steerDeg: 6, load: 0.78, boost: 1, ...over });

function vesselState(over: Partial<VesselState> = {}): VesselState {
  return {
    seaTime: 12,
    propulsors: [prop(), prop({ rpm: 2980, load: 0.8 })],
    tabs: 0.3,
    mooring: null,
    speedMs: 24.6 * KT,
    leewayDeg: 0.5,
    trimDeg: 3.2,
    planing: 0.85,
    wettedLength: 9,
    wettedArea: 30,
    displacedVolume: 3,
    resistance: 30000,
    depthUnderKeel: 12.4,
    aground: false,
    capsizeTime: 0,
    surfaceY: 0,
    ...over,
  };
}

/** A boat at sea: 25.1 kt over the ground, heeled 4° to port, on heading 270. */
function boat(v: Partial<VesselState> | null = {}, spec: Parameters<typeof makeState>[0] = {}): AircraftState {
  const s = makeState({ iasKt: 24, groundSpeedKt: 25.1, headingDeg: 270, rollDeg: -4, pitchDeg: 3, altFt: 1, aglFt: 1, onGround: false, alphaDeg: 25, rpm: 2950, ...spec });
  const out: AircraftState = { ...s, phase: 'afloat', stalled: false };
  if (v) out.vessel = vesselState(v);
  return out;
}

const read = (state: AircraftState, controls = makeControls({ throttle: 0.85 }), cfg: Config = V50) => updateInstruments(createInstrumentModel(), state, controls, 0.016, cfg);

const helm = (over: Partial<VesselReadings> = {}): VesselReadings => ({
  speedKt: 24.6, sogKt: 25.1, rpm: [2950, 2980], loadPct: [78, 80], leverPct: 85, gear: 'ahead', steerDeg: 6, tabsPct: 30, trimDeg: 3.2, heelDeg: -4,
  depthM: 12.4, planingPct: 85, moored: false, aground: false, ...over,
});
const boatReadings = (v: Partial<VesselReadings> = {}, over: Partial<InstrumentReadings> = {}): InstrumentReadings => ({
  ...makeReadings({ airspeedKt: 24.6, state: 'afloat', gear: 'down', gearLight: 'off', ...over }),
  vessel: helm(v),
});

// ─── Readings ────────────────────────────────────────────────────────────────

describe('marine HUD: helm readings (instruments.ts)', () => {
  it('reads the helm from the vessel state: STW, SOG, both tachs and loads, lever, gear, drives, tabs, trim, heel, depth, planing', () => {
    const r = read(boat());
    const v = r.vessel!;
    expect(v.speedKt).toBeCloseTo(24.6, 3);
    expect(v.sogKt).toBeCloseTo(25.1, 3);
    expect(v.rpm).toEqual([2950, 2980]);
    expect(v.loadPct[0]).toBeCloseTo(78, 6);
    expect(v.loadPct[1]).toBeCloseTo(80, 6);
    expect(v.leverPct).toBeCloseTo(85, 6);
    expect(v.gear).toBe('ahead');
    expect(v.steerDeg).toBe(6);
    expect(v.tabsPct).toBeCloseTo(30, 6);
    expect(v.trimDeg).toBe(3.2);
    expect(v.heelDeg).toBeCloseTo(-4, 6);
    expect(v.depthM).toBe(12.4);
    expect(v.planingPct).toBeCloseTo(85, 6);
    expect(v.moored).toBe(false);
    expect(v.aground).toBe(false);
  });

  it('nothing aircraft-specific fires: no stall (whatever α), no overspeed, gear down with no light and no horn, airspeed = |STW|', () => {
    const r = read(boat({ speedMs: -3 * KT }, { alphaDeg: 40 }), makeControls({ throttle: -0.5, gearDown: false, flapsNotch: 3 }));
    expect(r.stallWarning).toBe(false);
    expect(r.overspeed).toBe(false);
    expect(r.gear).toBe('down');
    expect(r.gearLight).toBe('off');
    expect(r.gearHorn || r.gearUnsafe || r.gearSquat || r.gearOverspeed).toBe(false);
    expect(r.flapsDeg).toBe(0);
    expect(r.vessel!.speedKt).toBeCloseTo(-3, 3);
    expect(r.airspeedKt).toBeCloseTo(3, 3);
    expect(r.throttlePct).toBeCloseTo(50, 6);
    expect(r.vessel!.leverPct).toBeCloseTo(-50, 6);
    expect(annunciations(r, V50).map((a) => a.id)).toEqual([]);
  });

  it('the sounder: deep water (Infinity, NaN, beyond 200 m) reads null; shallow reads the metres; negatives clamp to 0', () => {
    expect(read(boat({ depthUnderKeel: Infinity })).vessel!.depthM).toBeNull();
    expect(read(boat({ depthUnderKeel: NaN })).vessel!.depthM).toBeNull();
    expect(read(boat({ depthUnderKeel: 250 })).vessel!.depthM).toBeNull();
    expect(read(boat({ depthUnderKeel: 1.3 })).vessel!.depthM).toBe(1.3);
    expect(sounderDepth(-0.4)).toBe(0);
    expect(sounderDepth(undefined)).toBeNull();
  });

  it('moored (mooring set) and aground flags; the gear the first drive is in (not the lever)', () => {
    const r = read(boat({ mooring: { x: 1, z: 2, headingDeg: 90 }, propulsors: [prop({ gear: 'neutral', rpm: 700, load: 0.04 }), prop({ gear: 'neutral', rpm: 700 })] }), makeControls({ throttle: 0.5 }));
    expect(r.vessel!.moored).toBe(true);
    expect(r.vessel!.gear).toBe('neutral');
    expect(read(boat({ aground: true })).vessel!.aground).toBe(true);
  });

  it('never throws without a vessel state: the lever picks the gear, the engine block stands in for the tachs', () => {
    const r = read(boat(null), makeControls({ throttle: -0.6 }));
    expect(r.vessel).toBeDefined();
    expect(r.vessel!.gear).toBe('astern');
    expect(r.vessel!.rpm.length).toBe(2);
    expect(r.vessel!.depthM).toBeNull();
    expect(r.vessel!.moored).toBe(false);
    expect(read(boat(null), makeControls({ throttle: 0.03 })).vessel!.gear).toBe('neutral');
  });

  it('an aircraft gets no vessel block (and a vessel state on an aircraft config is ignored)', () => {
    expect(read(makeState(), makeControls(), CONFIG).vessel).toBeUndefined();
    expect(read(boat(), makeControls(), CONFIG).vessel).toBeUndefined();
  });

  it('fuzz: random states with random (garbage) vessel states give finite, in-range helm readings', () => {
    const w = (lo: number, hi: number) => fc.oneof(fc.double({ min: lo, max: hi, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 1e12));
    fc.assert(
      fc.property(
        arbState,
        fc.record({ rpm: w(-100, 5000), load: w(-1, 3), steer: w(-90, 90), tabs: w(-1, 2), spd: w(-20, 40), depth: w(-5, 500), plan: w(-1, 3), trim: w(-50, 50), n: fc.integer({ min: 0, max: 3 }) }),
        w(-2, 2),
        (s, g, lever) => {
          const props = Array.from({ length: g.n }, () => prop({ rpm: g.rpm, load: g.load, steerDeg: g.steer }));
          const st: AircraftState = { ...s, vessel: vesselState({ propulsors: props, tabs: g.tabs, speedMs: g.spd, depthUnderKeel: g.depth, planing: g.plan, trimDeg: g.trim }) };
          const v = read(st, makeControls({ throttle: lever })).vessel!;
          for (const x of [v.speedKt, v.sogKt, v.leverPct, v.steerDeg, v.tabsPct, v.trimDeg, v.heelDeg, v.planingPct, ...v.rpm, ...v.loadPct]) expect(Number.isFinite(x)).toBe(true);
          expect(Math.abs(v.leverPct)).toBeLessThanOrEqual(100);
          expect(v.tabsPct).toBeGreaterThanOrEqual(0);
          expect(v.tabsPct).toBeLessThanOrEqual(100);
          expect(v.depthM === null || (v.depthM >= 0 && v.depthM <= 200)).toBe(true);
          expect(['ahead', 'neutral', 'astern']).toContain(v.gear);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('marine HUD: lever, tach, depth alarm', () => {
  it('lever gear: inside the detent neutral, else ahead / astern; garbage reads neutral', () => {
    const d = V50.aircraft.watercraft!.neutralDetent;
    expect(leverGear(0, d)).toBe('neutral');
    expect(leverGear(d * 0.9, d)).toBe('neutral');
    expect(leverGear(-d * 0.9, d)).toBe('neutral');
    expect(leverGear(d * 1.1, d)).toBe('ahead');
    expect(leverGear(-d * 1.1, d)).toBe('astern');
    expect(leverGear(1, d)).toBe('ahead');
    expect(leverGear(-1, d)).toBe('astern');
    expect(leverGear(NaN, d)).toBe('neutral');
  });

  it('the lever travels the full track: +100 at the top (F), 0 in the middle (N), −100 at the bottom (R), clamped', () => {
    expect(leverY(100, 10, 110)).toBe(10);
    expect(leverY(0, 10, 110)).toBe(60);
    expect(leverY(-100, 10, 110)).toBe(110);
    expect(leverY(500, 10, 110)).toBe(10);
    expect(leverY(NaN, 10, 110)).toBe(60);
  });

  it('tach: 0–4,000 rpm with the redline at the V50 rated 3,500; 270° sweep, monotonic', () => {
    expect(tachRange(V50.aircraft.watercraft!.engine.maxRpm)).toEqual({ max: 4000, redline: 3500 });
    expect(tachAngle(0, 4000)).toBeCloseTo((135 * Math.PI) / 180, 9);
    expect(tachAngle(4000, 4000)).toBeCloseTo((405 * Math.PI) / 180, 9);
    let last = -Infinity;
    for (let r = 0; r <= 4000; r += 100) {
      const a = tachAngle(r, 4000);
      expect(a).toBeGreaterThan(last);
      last = a;
    }
    expect(Number.isFinite(tachAngle(NaN, NaN))).toBe(true);
  });

  it(`shallow-water alarm under ${SHALLOW_ALARM_M} m under the keel — not in deep water, not moored at the berth`, () => {
    expect(shallowAlarm(helm({ depthM: 1.9 }))).toBe(true);
    expect(shallowAlarm(helm({ depthM: 2.1 }))).toBe(false);
    expect(shallowAlarm(helm({ depthM: null }))).toBe(false);
    expect(shallowAlarm(helm({ depthM: 0.5, moored: true }))).toBe(false);
    expect(shallowAlarm(undefined)).toBe(false);
  });

  it('texts: steering side (+ starboard), astern speeds with a minus', () => {
    expect(steerText(12.4)).toBe('12° S');
    expect(steerText(-8)).toBe('8° P');
    expect(steerText(0.2)).toBe('0°');
    expect(speedText(24.64)).toBe('24.6');
    expect(speedText(-3.1)).toBe('−3.1');
    expect(speedText(NaN)).toBe('0.0');
  });
});

// ─── Layout ──────────────────────────────────────────────────────────────────

describe('marine HUD: layout', () => {
  const VIEWS = [[1440, 900], [1024, 768]] as const;

  it('normal view: nav bottom-left, engines bottom-right, both readable, in the bottom third, apart, clear of the compass and chip', () => {
    for (const [w, h] of VIEWS) {
      const m = computeMarineHudLayout(w, h, V50, 'normal');
      const nav = m.nav!;
      expect(m.compact).toBe(false);
      expect(inside(nav, w, h)).toBe(true);
      expect(inside(m.engines, w, h)).toBe(true);
      expect(nav.h).toBeGreaterThanOrEqual(150);
      expect(m.engines.w).toBeGreaterThan(nav.w);
      expect(nav.x).toBeLessThan(w * 0.05);
      expect(m.engines.x + m.engines.w).toBeGreaterThan(w * 0.95);
      expect(nav.y).toBeGreaterThan((2 * h) / 3);
      expect(m.engines.y).toBeGreaterThan((2 * h) / 3);
      expect(m.engines.x - (nav.x + nav.w)).toBeGreaterThanOrEqual(20);
      const L = computeHudLayout(w, h, V50, 'normal', 'marine');
      expect(L.marine).toEqual(m);
      expect(L.clustersVisible).toBe(false);
      expect(L.compassVisible).toBe(true);
      expect(L.jet).toBeNull();
      expect(L.glass).toBeNull();
      expect(L.strip).toEqual(m.engines);
      const chip: Rect = { x: L.chip.x, y: L.chip.y, w: L.chip.maxW, h: L.chip.h };
      for (const r of [nav, m.engines]) {
        expect(overlap(r, L.compass)).toBe(false);
        expect(overlap(r, chip)).toBe(false);
      }
      expect(L.toastBottom).toBeLessThan(Math.min(nav.y, m.engines.y));
      expect(L.annunciatorY).toBeGreaterThan(L.compass.y + L.compass.h);
    }
  });

  it('cockpit view (hidden or compact gauges): no nav block, a compact strip docked bottom-left in the left 36 %', () => {
    for (const [w, h] of VIEWS) {
      for (const mode of ['cockpitHidden', 'cockpitCompact'] as const) {
        const m = computeMarineHudLayout(w, h, V50, mode);
        expect(m.nav).toBeNull();
        expect(m.compact).toBe(true);
        expect(inside(m.engines, w, h)).toBe(true);
        expect(m.engines.x + m.engines.w).toBeLessThanOrEqual(w * 0.36);
        expect(m.engines.h).toBeGreaterThanOrEqual(44);
        expect(m.engines.h).toBeLessThanOrEqual(60);
        expect(m.engines.w).toBeGreaterThanOrEqual(m.engines.h * 5);
        const L = computeHudLayout(w, h, V50, mode, 'marine');
        expect(overlap(m.engines, L.compass)).toBe(false);
        expect(L.toastBottom).toBeLessThan(m.engines.y);
      }
    }
  });

  it('property: any viewport keeps the blocks inside it and apart', () => {
    fc.assert(
      fc.property(fc.integer({ min: 320, max: 3840 }), fc.integer({ min: 240, max: 2160 }), (w, h) => {
        const m = computeMarineHudLayout(w, h, V50, 'normal');
        expect(inside(m.nav!, w, h)).toBe(true);
        expect(inside(m.engines, w, h)).toBe(true);
        expect(overlap(m.nav!, m.engines)).toBe(false);
      }),
      { numRuns: 150 },
    );
  });
});

// ─── Painters ────────────────────────────────────────────────────────────────

describe('marine HUD: painters', () => {
  it('nav: the speed, SOG and heading, the depth with its unit, trim / heel / planing', () => {
    const m = mockCtx(330, 200);
    drawMarineNav(m.ctx, 330, 200, boatReadings());
    const t = m.texts();
    expect(t).toContain('24.6');
    expect(t).toContain('25.1 kt');
    expect(t).toContain('270°');
    expect(t).toContain('12');
    expect(t).toContain('m');
    expect(t).toContain('+3.2°');
    expect(t).toContain('4° P');
    expect(t).toContain('85%');
    expect(t).not.toContain('SHALLOW');
    expect(m.bad()).toEqual([]);
  });

  it('nav: DEEP beyond the sounder, SHALLOW (red box, flashing) under 2 m, astern speed with a minus', () => {
    const deep = mockCtx(330, 200);
    drawMarineNav(deep.ctx, 330, 200, boatReadings({ depthM: null }));
    expect(deep.texts()).toContain('DEEP');
    const on = mockCtx(330, 200);
    drawMarineNav(on.ctx, 330, 200, boatReadings({ depthM: 1.4, speedKt: -2.5 }), false);
    expect(on.texts()).toContain('SHALLOW');
    expect(on.texts()).toContain('1.4');
    expect(on.texts()).toContain('−2.5');
    const reds = (mc: MockCtx) => mc.argsOf('set:fillStyle').filter((a) => String(a[0]).startsWith('rgba(255,60,60')).length;
    expect(reds(on)).toBeGreaterThan(0);
    const off = mockCtx(330, 200);
    drawMarineNav(off.ctx, 330, 200, boatReadings({ depthM: 1.4 }), true);
    expect(reds(off)).toBe(0);
  });

  it('engines: PORT / STBD tachs with their rpm and load, the lever F / N / R with its %, drives and tabs', () => {
    const m = mockCtx(560, 200);
    drawMarineEngines(m.ctx, 560, 200, boatReadings(), 3500, 0.08);
    const t = m.texts();
    for (const s of ['PORT', 'STBD', '2950', '2980', '78%', '80%', 'F', 'N', 'R', '+85%', 'LEVER', 'DRIVES', '6° S', 'TABS', '30%']) expect(t, s).toContain(s);
    expect(m.bad()).toEqual([]);
    const off = mockCtx(560, 200);
    drawMarineEngines(off.ctx, 560, 200, boatReadings({ rpm: [0, 0] }, { engineStatus: 'OFF' }));
    expect(off.texts().filter((s) => s === 'OFF').length).toBe(2);
    const astern = mockCtx(560, 200);
    drawMarineEngines(astern.ctx, 560, 200, boatReadings({ leverPct: -40, gear: 'astern' }));
    expect(astern.texts()).toContain('−40%');
  });

  it('compact strip: speed, both rpm, the gear letter and lever, depth', () => {
    const m = mockCtx(340, 56);
    drawMarineCompact(m.ctx, 340, 56, boatReadings({ gear: 'astern', leverPct: -40, depthM: 1.2 }));
    const t = m.texts();
    for (const s of ['24.6', '2950', '2980', 'R', '−40%', 'SHALLOW', '1.2']) expect(t, s).toContain(s);
    expect(m.bad()).toEqual([]);
  });

  it('fuzz: hostile helm readings and sizes → only finite coordinates, no NaN text, never throws', () => {
    const w = (lo: number, hi: number) => fc.oneof(fc.double({ min: lo, max: hi, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 1e9));
    fc.assert(
      fc.property(
        fc.record({
          speedKt: w(-50, 80), sogKt: w(0, 80), rpm: fc.array(w(-100, 9000), { maxLength: 5 }), loadPct: fc.array(w(-10, 300), { maxLength: 5 }), leverPct: w(-300, 300),
          gear: fc.constantFrom('ahead', 'neutral', 'astern'), steerDeg: w(-180, 180), tabsPct: w(-50, 200), trimDeg: w(-90, 90), heelDeg: w(-360, 360),
          depthM: fc.oneof(fc.constant(null), w(-10, 400)), planingPct: w(-50, 300), moored: fc.boolean(), aground: fc.boolean(),
        }) as fc.Arbitrary<VesselReadings>,
        fc.integer({ min: 0, max: 900 }),
        fc.integer({ min: 0, max: 400 }),
        fc.boolean(),
        (v, W, H, blink) => {
          const r = { ...makeReadings({ headingDeg: NaN }), vessel: v };
          for (const draw of [
            (c: CanvasRenderingContext2D) => drawMarineNav(c, W, H, r, blink),
            (c: CanvasRenderingContext2D) => drawMarineEngines(c, W, H, r),
            (c: CanvasRenderingContext2D) => drawMarineCompact(c, W, H, r, 3500, blink),
          ]) {
            const m = mockCtx(W, H);
            expect(() => draw(m.ctx)).not.toThrow();
            expect(m.bad()).toEqual([]);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('aircraft readings (no vessel block) still draw without throwing', () => {
    const m = mockCtx(560, 200);
    expect(() => drawMarineEngines(m.ctx, 560, 200, makeReadings())).not.toThrow();
    expect(() => drawMarineNav(m.ctx, 330, 200, makeReadings())).not.toThrow();
    expect(m.bad()).toEqual([]);
  });
});

// ─── Messages ────────────────────────────────────────────────────────────────

describe('marine HUD: annunciators, hint, crash text', () => {
  it('MOORED (with how to cast off), AGROUND, SHALLOW WATER, ENGINES OFF — and never STALL or GEAR on a boat', () => {
    const ids = (r: InstrumentReadings) => annunciations(r, V50).map((a) => a.id);
    expect(ids(boatReadings({ moored: true, depthM: 1 }))).toEqual(['moored']);
    expect(annunciations(boatReadings({ moored: true }), V50)[0].text).toMatch(/lever ahead or astern to cast off/i);
    expect(ids(boatReadings({ aground: true, depthM: 0 }))).toEqual(['aground']);
    expect(ids(boatReadings({ depthM: 1.5 }))).toEqual(['shallow']);
    const off = annunciations(boatReadings({}, { engineStatus: 'OFF' }), V50);
    expect(off.map((a) => a.id)).toEqual(['engineOff']);
    expect(off[0].text).toMatch(/^ENGINES OFF · E to start/);
    expect(ids(boatReadings({}, { stallWarning: true, overspeed: true, gear: 'up', gearLight: 'red' }))).toEqual([]);
    expect(ids(boatReadings({ aground: true }, { state: 'crashed' }))).toEqual([]);
  });

  it('start hint and crash banner speak boat', () => {
    const hint = startHint(V50);
    expect(hint).toMatch(/lever ahead \/ astern/);
    expect(hint).toMatch(/trim tabs/);
    expect(hint).not.toMatch(/pull up|gear|flaps/i);
    const t = crashText({ time: 1, reason: 'Capsized', speedKt: 0, verticalSpeedFpm: 0, position: { x: 0, y: 0, z: 0 } }, V50);
    expect(t.title).toContain('Capsized');
    expect(t.hint).toMatch(/berth/);
    expect(t.hint).toMatch(/open sea/);
    expect(crashText({ time: 1, reason: 'Hit terrain', speedKt: 0, verticalSpeedFpm: 0, position: { x: 0, y: 0, z: 0 } }).hint).toMatch(/approach/);
  });
});

// ─── Overlay ─────────────────────────────────────────────────────────────────

const contexts = new Map<HTMLCanvasElement, MockCtx>();
const setViewport = (width: number, height: number) =>
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
const info = (over: Partial<HudInfo> = {}): HudInfo => ({
  cameraMode: 'chase', paused: false, fps: 60, timeOfDay: 'Morning', state: boat(), controls: makeControls(), mouseYoke: false, veil: false, ...over,
});
const shown = (el: Element | null) => {
  let e: Element | null = el;
  while (e) {
    if ((e as HTMLElement).hidden) return false;
    e = e.parentElement;
  }
  return !!el;
};

describe('marine HUD: in the overlay', () => {
  let hud: Hud;
  let root: HTMLElement;
  beforeEach(() => {
    contexts.clear();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      let m = contexts.get(this);
      if (!m) contexts.set(this, (m = mockCtx(this.width, this.height)));
      return m.ctx;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
    setViewport(1440, 900);
    document.body.innerHTML = '<div id="hud"></div>';
    root = document.getElementById('hud')!;
  });
  afterEach(() => hud?.dispose());

  const toasts = () => [...document.querySelectorAll('.fsh-toast')].map((t) => t.textContent);

  it('shows the helm blocks and the compass, hides the six-pack and strip; the cockpit view keeps the compact strip; I and dispose', () => {
    hud = createHud(root, { style: 'marine', config: V50 });
    hud.update(boatReadings(), info(), 1 / 60);
    expect(hud.style).toBe('marine');
    for (const sel of ['.fsh-left', '.fsh-right', '.fsh-strip']) expect(shown(document.querySelector(sel)), sel).toBe(false);
    expect(shown(document.querySelector('.fsh-compass'))).toBe(true);
    const nav = document.querySelector('canvas[data-hud="marine-nav"]') as HTMLCanvasElement;
    const eng = document.querySelector('canvas[data-hud="marine-engines"]') as HTMLCanvasElement;
    expect(shown(nav)).toBe(true);
    expect(shown(eng)).toBe(true);
    expect(contexts.get(nav)!.texts()).toContain('24.6');
    expect(contexts.get(eng)!.texts()).toContain('PORT');
    // No redraw when nothing shown changed; a change redraws.
    const m = contexts.get(eng)!;
    m.reset();
    hud.update(boatReadings(), info(), 1 / 60);
    expect(m.calls.length).toBe(0);
    hud.update(boatReadings({ leverPct: 50 }), info(), 1 / 60);
    expect(m.calls.length).toBeGreaterThan(0);
    hud.update(boatReadings(), info({ cameraMode: 'cockpit' }), 1 / 60);
    expect(shown(nav)).toBe(false);
    expect(shown(eng)).toBe(true);
    const box = eng.parentElement as HTMLElement;
    expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThanOrEqual(1440 * 0.36);
    hud.toggleVisible();
    expect(shown(eng)).toBe(false);
    hud.toggleVisible();
    expect(shown(eng)).toBe(true);
    hud.dispose();
    expect(document.querySelector('canvas[data-hud="marine-nav"]')).toBeNull();
  });

  it('"Cast off" when the lines let go, "Aground!" when she touches — once each; a restart says nothing', () => {
    hud = createHud(root, { style: 'marine', config: V50 });
    hud.update(boatReadings({ moored: true }), info(), 1 / 60);
    hud.update(boatReadings({ moored: true }), info(), 1 / 60);
    expect(toasts()).toEqual([]);
    hud.update(boatReadings({ moored: false }), info(), 1 / 60);
    expect(toasts()).toEqual(['Cast off']);
    hud.update(boatReadings({ aground: true }), info(), 1 / 60);
    hud.update(boatReadings({ aground: true }), info(), 1 / 60);
    expect(toasts()).toEqual(['Cast off', 'Aground!']);
    // Back to the berth, then Shift+R to the open sea: no "Cast off" from the jump.
    hud.onReset();
    hud.update(boatReadings({ moored: true }), info(), 1 / 60);
    hud.onReset();
    hud.update(boatReadings({ moored: false }), info(), 1 / 60);
    expect(toasts()).toEqual(['Cast off', 'Aground!']);
    expect([...document.querySelectorAll('.fsh-ann')].filter((a) => shown(a)).map((a) => a.getAttribute('data-ann'))).toEqual([]);
  });

  it('no landing toast on a boat, the MOORED advisory shows, and the crash banner speaks boat', () => {
    hud = createHud(root, { style: 'marine', config: V50 });
    hud.update(boatReadings({ moored: true }), info({ state: { ...boat(), touchdown: makeTouchdown() } }), 1 / 60);
    expect(document.querySelector('.fsh-landing')).toBeNull();
    const moored = document.querySelector('.fsh-ann[data-ann="moored"]')!;
    expect(shown(moored)).toBe(true);
    expect(moored.className).toContain('fsh-advisory');
    const crashed = { ...boat(), phase: 'crashed' as const, crash: { time: 2, reason: 'Capsized', speedKt: 3, verticalSpeedFpm: 0, position: { x: 0, y: 0, z: 0 } } };
    hud.update(boatReadings({}, { state: 'crashed' }), info({ state: crashed }), 1 / 60);
    expect(document.querySelector('.fsh-banner .fsh-title')!.textContent).toContain('Capsized');
    expect(document.querySelector('.fsh-banner .fsh-sub')!.textContent).toMatch(/berth/);
  });
});

// ─── Controls page and picker ────────────────────────────────────────────────

describe('marine HUD: controls page and picker', () => {
  it('a vessel gets Helm · Cameras · Sim: the lever through neutral into astern, steering, tabs, engines, berth / open sea', () => {
    const groups = controlGroups(V50);
    expect(groups.map((g) => g.id)).toEqual(['vessel', 'cameras', 'sim']);
    const rows = groups.flatMap((g) => g.rows);
    const row = (id: string) => rows.find((r) => r.ids.includes(id as never))!;
    expect(row('throttleUp').action).toMatch(/lever/i);
    expect(row('throttleUp').keys).toEqual(expect.arrayContaining(['W', 'S']));
    expect(row('throttleUp').note).toMatch(/neutral.*astern/i);
    expect(row('yawLeft').keys).toEqual(expect.arrayContaining(['A', 'D', keyLabel('ArrowLeft'), keyLabel('ArrowRight')]));
    expect(row('trimNoseDown').action).toMatch(/trim tabs/i);
    expect(row('engine').action).toMatch(/engines/i);
    expect(row('reset').action).toMatch(/berth.*open sea/i);
    expect(row('reset').keys).toContain('Shift+R');
    // Nothing that only flies: no gear, flaps, weapons, brakes.
    const ids = new Set(rows.flatMap((r) => r.ids));
    for (const id of ['gear', 'flapsDown', 'fireGun', 'speedBrake', 'pitchUp', 'brake']) expect(ids.has(id as never), id).toBe(false);
    expect(controlNotes(V50)[0]).toMatch(/Princess V50/);
    // The aircraft sheet is unchanged (and mentions the boat in its notes).
    expect(controlGroups(CONFIG).map((g) => g.id)).toEqual(['flight', 'engine', 'weapons', 'cameras', 'sim']);
    expect(controlNotes(CONFIG).join(' ')).toMatch(/Princess V50/);
  });

  it('the picker lists vessels after the aircraft under a "Vessels" heading (keyboard skips the heading)', () => {
    const items = [
      { id: 'v50', name: 'Princess V50', shortName: 'V50', description: 'Yacht.', kind: 'vessel' as const },
      { id: 'c172rg', name: 'Cessna', shortName: 'Cessna', description: 'Trainer.' },
      { id: 'f16', name: 'F-16', shortName: 'F-16', description: 'Fighter.', kind: 'aircraft' as const },
    ];
    expect(orderPickerItems(items).map((i) => i.id)).toEqual(['c172rg', 'f16', 'v50']);
    const p = createAircraftPicker(document, { items, current: 'c172rg', onSelect: () => undefined });
    document.body.appendChild(p.element);
    const list = p.element.querySelector('[role="listbox"]')!;
    const lis = [...list.children].map((li) => (li.getAttribute('role') === 'option' ? (li as HTMLElement).dataset.id : `# ${li.textContent}`));
    expect(lis).toEqual(['c172rg', 'f16', '# Vessels', 'v50']);
    expect(list.querySelectorAll('[role="option"]').length).toBe(3);
    p.dispose();
    // Without vessels: no heading.
    const q = createAircraftPicker(document, { items: items.slice(1), current: 'f16', onSelect: () => undefined });
    expect(q.element.querySelector('.tfs-picker-group')).toBeNull();
    q.dispose();
  });
});
