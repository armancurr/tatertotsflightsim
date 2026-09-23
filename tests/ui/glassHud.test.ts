// @vitest-environment happy-dom
/**
 * The airliner "glass" HUD style (747): the pure layout (a mini PFD bottom-left, a mini EICAS
 * bottom-right; a compact engines/flaps/gear strip in the cockpit view), the V-speeds and N1 from
 * the config, the PFD and EICAS painters on a geometry-recording canvas (horizon tilt, tape bugs,
 * readouts, gear/flaps/speedbrake), and the overlay wired into createHud (what shows, redraw only
 * on change, dispose).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG, cloneConfig, B747_AIRCRAFT, type Config } from '../../src/config';
import type { InstrumentReadings } from '../../src/types';
import { computeHudLayout, createHud, type Hud, type HudInfo, type Rect } from '../../src/ui/hud';
import {
  computeGlassHudLayout, createGlassHudState, drawGlassEicas, drawGlassPfd, engineN1, engineN1Command, glassVSpeeds, pfdGeometry, speedToY,
  trackGlassHud, type GlassReadings,
} from '../../src/ui/glassHud';
import { getAircraftDef } from '../../src/fleet';
import { geoCtx, screenTiltDeg, len } from './geoCtx';
import { mockCtx, makeReadings, makeState, makeControls, type MockCtx } from './fixtures';

const B747: Config = getAircraftDef('b747').config;
const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const idle = B747.aircraft.engine.idleRpm;
const maxRpm = B747.aircraft.engine.maxRpm;

const glassReadings = (over: Partial<GlassReadings> = {}): GlassReadings => ({
  ...makeReadings({ airspeedKt: 250, altitudeFt: 8000, altitudeAglFt: 7900, headingDeg: 270, verticalSpeedFpm: 0, pitchDeg: 2, rollDeg: 0, rpm: 90, throttlePct: 70, flapsDeg: 0, flapsTargetDeg: 0, gear: 'up', gearLight: 'off' }),
  flightPathDeg: 0,
  speedBrake: false,
  betaDeg: 0,
  mach: 0.42,
  ...over,
});

describe('glass HUD: fleet and config', () => {
  it('the 747 flies the glass style; the others keep theirs', () => {
    expect(getAircraftDef('b747').hud).toBe('glass');
    expect(getAircraftDef('c172rg').hud).toBe('steam');
    expect(getAircraftDef('f16').hud).toBe('jet');
  });

  it('V-speeds come from the aircraft config: Vr = limits.vrKt, Vref = round(vrefFactor × Vso), V1 a few kt below Vr', () => {
    const v = glassVSpeeds(B747);
    expect(v.vr).toBe(B747_AIRCRAFT.limits.vrKt);
    expect(v.vref).toBe(Math.round(CONFIG.hud.glass.vrefFactor * B747_AIRCRAFT.limits.vsoKt));
    expect(v.v1).toBeLessThan(v.vr);
    expect(v.v1).toBeGreaterThan(v.vr - 20);
    const c = cloneConfig();
    c.aircraft = { ...B747_AIRCRAFT };
    c.hud.glass.vrKt = 142;
    c.hud.glass.vrefKt = 131;
    expect(glassVSpeeds(c)).toMatchObject({ vr: 142, vref: 131 });
  });

  it('N1: 0 with the engine stopped, ≈ 22 % at idle core speed, ≈ 100 % at full, monotonic, four engines a hair apart', () => {
    expect(engineN1(0, 'OFF', 0, B747)).toBe(0);
    const i0 = engineN1(idle, 'RUNNING', 0, B747);
    expect(i0).toBeGreaterThan(19);
    expect(i0).toBeLessThan(25);
    const f0 = engineN1(maxRpm, 'RUNNING', 0, B747);
    expect(f0).toBeGreaterThan(96);
    expect(f0).toBeLessThan(102);
    let prev = -1;
    for (let rpm = 0; rpm <= maxRpm; rpm += 2) {
      const n = engineN1(rpm, 'RUNNING', 1, B747);
      expect(n).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = n;
    }
    const four = [0, 1, 2, 3].map((e) => engineN1(90, 'RUNNING', e, B747));
    expect(new Set(four.map((n) => n.toFixed(1))).size).toBeGreaterThan(1);
    expect(Math.max(...four) - Math.min(...four)).toBeLessThan(1);
    // The lever's N1: idle at 0 %, ≈ full at 100 %.
    expect(engineN1Command(0, B747)).toBeLessThan(25);
    expect(engineN1Command(100, B747)).toBeGreaterThan(96);
  });
});

describe('glass HUD: layout', () => {
  it('1440×900 and 1024×768: a readable PFD bottom-left and the EICAS bottom-right, both in the bottom third, apart', () => {
    for (const [w, h, minH] of [[1440, 900, 220], [1024, 768, 190]] as const) {
      const g = computeGlassHudLayout(w, h, B747, 'normal');
      const pfd = g.pfd!;
      expect(pfd.h).toBeGreaterThanOrEqual(minH);
      expect(pfd.w).toBeGreaterThanOrEqual(pfd.h);
      expect(pfd.x).toBeLessThan(w * 0.05);
      expect(g.systems.x + g.systems.w).toBeGreaterThan(w * 0.95);
      expect(pfd.y).toBeGreaterThan((2 * h) / 3);
      expect(g.systems.y).toBeGreaterThan((2 * h) / 3);
      expect(overlap(pfd, g.systems)).toBe(false);
      expect(g.systems.h).toBeGreaterThanOrEqual(pfd.h * 0.5);
    }
  });

  it('cockpit view: no PFD (the flight deck shows its own), a compact strip docked bottom-left', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]] as const) {
      for (const mode of ['cockpitHidden', 'cockpitCompact'] as const) {
        const g = computeGlassHudLayout(w, h, B747, mode);
        expect(g.pfd).toBeNull();
        expect(g.compact).toBe(true);
        expect(g.systems.x).toBeGreaterThanOrEqual(0);
        expect(g.systems.x + g.systems.w).toBeLessThanOrEqual(w * 0.36);
        expect(g.systems.y + g.systems.h).toBeLessThanOrEqual(h);
        expect(g.systems.h).toBeGreaterThanOrEqual(36);
        expect(g.systems.h).toBeLessThanOrEqual(64);
      }
    }
  });

  it('computeHudLayout(glass): no six-pack, no compass tape; the strip is the glass systems block; toasts above the blocks', () => {
    const L = computeHudLayout(1440, 900, B747, 'normal', 'glass');
    expect(L.clustersVisible).toBe(false);
    expect(L.compassVisible).toBe(false);
    expect(L.jet).toBeNull();
    expect(L.glass).not.toBeNull();
    expect(L.strip).toEqual(L.glass!.systems);
    expect(L.toastBottom).toBeLessThan(Math.min(L.glass!.pfd!.y, L.glass!.systems.y));
    expect(computeHudLayout(1440, 900, CONFIG, 'normal', 'steam').glass).toBeNull();
  });
});

describe('glass HUD: PFD painter', () => {
  const W = 300;
  const H = 260;

  it('the horizon tilts with the bank like the real one (right bank → its right end rises) and sits on the pitch', () => {
    const geo = pfdGeometry(W, H);
    for (const roll of [-30, 0, 20]) {
      const g = geoCtx();
      drawGlassPfd(g.ctx, W, H, glassReadings({ rollDeg: roll, pitchDeg: 0 }), createGlassHudState(), B747);
      const horizon = g.segments.filter((s) => s.style === '#ffffff' && len(s) > geo.adi.w * 0.9).sort((a, b) => len(b) - len(a))[0];
      expect(horizon, `roll ${roll}`).toBeDefined();
      expect(screenTiltDeg(horizon)).toBeCloseTo(roll, 0);
    }
    // Nose up 5°: the horizon drops below the aircraft symbol by 5 × px/deg.
    const g = geoCtx();
    drawGlassPfd(g.ctx, W, H, glassReadings({ rollDeg: 0, pitchDeg: 5 }), createGlassHudState(), B747);
    const horizon = g.segments.filter((s) => s.style === '#ffffff' && len(s) > geo.adi.w * 0.9).sort((a, b) => len(b) - len(a))[0];
    const y = (horizon.a.y + horizon.b.y) / 2;
    expect(y - geo.centre.y).toBeCloseTo(5 * geo.ppd, 0);
  });

  it('speed and altitude readouts, the heading box; on the ground the V1 / VR bugs where the tape puts them', () => {
    const geo = pfdGeometry(W, H);
    const v = glassVSpeeds(B747);
    const g = geoCtx();
    const r = glassReadings({ airspeedKt: v.vr - 8, altitudeFt: 1250, headingDeg: 93, flapsDeg: 20, gear: 'down', state: 'ground' });
    drawGlassPfd(g.ctx, W, H, r, createGlassHudState(), B747);
    const texts = g.texts.map((t) => t.s);
    expect(texts).toContain(String(v.vr - 8));
    expect(texts.some((s) => s.replace(/\s/g, '') === '1250' || s === '250')).toBe(true);
    expect(texts).toContain('093');
    const vr = g.texts.find((t) => t.s === 'VR');
    expect(vr, 'VR bug').toBeDefined();
    expect(Math.abs(vr!.p.y - speedToY(v.vr, r.airspeedKt, geo))).toBeLessThan(6);
    expect(vr!.p.y).toBeLessThan(geo.centre.y);
    expect(texts).toContain('V1');
    expect(texts).not.toContain('REF');
  });

  it('airborne: the REF bug instead, and the magenta target speed Vref + 5 above the tape with the gear down', () => {
    const geo = pfdGeometry(W, H);
    const v = glassVSpeeds(B747);
    const g = geoCtx();
    const r = glassReadings({ airspeedKt: v.vref + 6, flapsDeg: 25, flapsTargetDeg: 25, gear: 'down', state: 'airborne' });
    drawGlassPfd(g.ctx, W, H, r, createGlassHudState(), B747);
    const ref = g.texts.find((t) => t.s === 'REF');
    expect(ref, 'REF bug').toBeDefined();
    expect(Math.abs(ref!.p.y - speedToY(v.vref, r.airspeedKt, geo))).toBeLessThan(6);
    expect(ref!.p.y).toBeGreaterThan(geo.centre.y);
    expect(g.texts.map((t) => t.s)).not.toContain('VR');
    const target = g.texts.find((t) => t.s === String(v.vref + 5) && t.p.y < geo.speed.y);
    expect(target, 'magenta target speed above the tape').toBeDefined();
    expect(target!.style.toLowerCase()).toBe(CONFIG.hud.glass.colors.magenta.toLowerCase());
  });

  it('the VSI digits show above 400 fpm and the radio altitude below 2,500 ft AGL', () => {
    const g = geoCtx();
    // The readings' AGL is the CG's; the radio altimeter reads from the wheels (0 on the ground).
    const wheelsFt = -B747.aircraft.geometry.leftMainWheel.y * 3.28084;
    drawGlassPfd(g.ctx, W, H, glassReadings({ verticalSpeedFpm: -1200, altitudeAglFt: 730 + wheelsFt }), createGlassHudState(), B747);
    const texts = g.texts.map((t) => t.s);
    expect(texts).toContain('1200');
    expect(texts).toContain('730');
    const z = geoCtx();
    drawGlassPfd(z.ctx, W, H, glassReadings({ altitudeAglFt: wheelsFt, state: 'ground', airspeedKt: 0 }), createGlassHudState(), B747);
    expect(z.texts.map((t) => t.s)).toContain('0');
    const q = geoCtx();
    drawGlassPfd(q.ctx, W, H, glassReadings({ verticalSpeedFpm: 150, altitudeAglFt: 9000 }), createGlassHudState(), B747);
    expect(q.texts.map((t) => t.s)).not.toContain('150');
  });

  it('the speed trend follows the acceleration (smoothed), and a reset/hostile dt leaves it finite', () => {
    const s = createGlassHudState();
    for (let i = 0; i <= 60; i++) trackGlassHud(s, glassReadings({ airspeedKt: 150 + i * 0.05 }), 1 / 60);
    expect(s.trendKt).toBeGreaterThan(20);
    expect(s.trendKt).toBeLessThan(40);
    trackGlassHud(s, glassReadings({ airspeedKt: NaN }), NaN);
    expect(Number.isFinite(s.trendKt)).toBe(true);
  });
});

describe('glass HUD: EICAS painter', () => {
  it('four N1 readouts, gear DOWN / UP, the flap lever position, SPEEDBRAKE EXT and PARK BRAKE memos', () => {
    const g = geoCtx();
    drawGlassEicas(g.ctx, 300, 150, glassReadings({ rpm: idle, gear: 'down', gearLight: 'green', flapsDeg: 10, flapsTargetDeg: 20, speedBrake: true, parkingBrake: true }), B747, false);
    const texts = g.texts.map((t) => t.s);
    const n1 = texts.filter((s) => /^\d{1,3}\.\d$/.test(s));
    expect(n1.length).toBeGreaterThanOrEqual(4);
    for (const s of n1.slice(0, 4)) expect(Number(s)).toBeLessThan(26);
    expect(texts).toContain('DOWN');
    expect(texts).toContain('20');
    expect(texts.some((s) => s.includes('SPEEDBRAKE'))).toBe(true);
    expect(texts.some((s) => s.includes('PARK'))).toBe(true);
    const u = geoCtx();
    drawGlassEicas(u.ctx, 300, 150, glassReadings({ gear: 'up', gearLight: 'off' }), B747, false);
    expect(u.texts.map((t) => t.s)).toContain('UP');
    expect(u.texts.map((t) => t.s)).not.toContain('DOWN');
  });

  it('compact strip: N1 × 4, flaps and gear in one row', () => {
    const g = geoCtx();
    drawGlassEicas(g.ctx, 280, 50, glassReadings({ rpm: maxRpm, gear: 'down', flapsDeg: 20, flapsTargetDeg: 20 }), B747, true);
    const texts = g.texts.map((t) => t.s);
    expect(texts.filter((s) => /^\d{1,3}\.\d$/.test(s)).length).toBeGreaterThanOrEqual(4);
    expect(texts.some((s) => s.includes('DOWN') || s === 'DN')).toBe(true);
    for (const t of g.texts) {
      expect(t.p.y).toBeGreaterThanOrEqual(0);
      expect(t.p.y).toBeLessThanOrEqual(50);
    }
  });
});

// ─── The overlay in createHud ─────────────────────────────────────────────────

const contexts = new Map<HTMLCanvasElement, MockCtx>();
const setViewport = (width: number, height: number) =>
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
const info = (over: Partial<HudInfo> = {}): HudInfo => ({
  cameraMode: 'chase', paused: false, fps: 60, timeOfDay: 'Morning', state: makeState(), controls: makeControls(), mouseYoke: false, ...over,
});
const shown = (el: Element | null) => {
  let e: Element | null = el;
  while (e) {
    if ((e as HTMLElement).hidden) return false;
    e = e.parentElement;
  }
  return !!el;
};

describe('glass HUD: in the overlay', () => {
  let root: HTMLElement;
  let hud: Hud;
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

  it('shows the PFD and EICAS, hides the six-pack, compass and steam strip; cockpit view keeps only the compact strip', () => {
    hud = createHud(root, { style: 'glass', config: B747 });
    hud.update(glassReadings() as InstrumentReadings, info(), 1 / 60);
    expect(hud.style).toBe('glass');
    for (const sel of ['.fsh-left', '.fsh-right', '.fsh-compass', '.fsh-strip']) expect(shown(document.querySelector(sel)), sel).toBe(false);
    const pfd = document.querySelector('canvas[data-hud="glass-pfd"]') as HTMLCanvasElement;
    const eicas = document.querySelector('canvas[data-hud="glass-eicas"]') as HTMLCanvasElement;
    expect(shown(pfd)).toBe(true);
    expect(shown(eicas)).toBe(true);
    expect(contexts.get(pfd)!.texts().length).toBeGreaterThan(10);
    hud.update(glassReadings() as InstrumentReadings, info({ cameraMode: 'cockpit' }), 1 / 60);
    expect(shown(pfd)).toBe(false);
    expect(shown(eicas)).toBe(true);
    const box = eicas.parentElement as HTMLElement;
    expect(parseFloat(box.style.left) + parseFloat(box.style.width)).toBeLessThan(1440 * 0.36);
  });

  it('redraws only when something it shows changes; I hides it all; dispose removes it', () => {
    hud = createHud(root, { style: 'glass', config: B747 });
    const r = glassReadings() as InstrumentReadings;
    hud.update(r, info(), 1 / 60);
    const pfd = document.querySelector('canvas[data-hud="glass-pfd"]') as HTMLCanvasElement;
    const m = contexts.get(pfd)!;
    m.reset();
    hud.update({ ...r }, info(), 1 / 60);
    hud.update({ ...r }, info(), 1 / 60);
    expect(m.calls.length).toBe(0);
    hud.update({ ...r, pitchDeg: 4 }, info(), 1 / 60);
    expect(m.calls.length).toBeGreaterThan(0);
    hud.toggleVisible();
    expect(shown(pfd)).toBe(false);
    hud.toggleVisible();
    expect(shown(pfd)).toBe(true);
    hud.dispose();
    expect(document.querySelector('canvas[data-hud="glass-pfd"]')).toBeNull();
  });
});
