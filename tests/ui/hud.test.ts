// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CONFIG, cloneConfig } from '../../src/config';
import type { AircraftState, CameraMode, InstrumentReadings } from '../../src/types';
import { createHud, type Hud, type HudInfo } from '../../src/ui/hud';
import { drawPanel } from '../../src/ui/gauges';
import { mockCtx, makeReadings, makeState, makeControls, makeTouchdown, type MockCtx } from './fixtures';

const contexts = new Map<HTMLCanvasElement, MockCtx>();

function setViewport(width: number, height: number): void {
  (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
}

function info(over: Partial<HudInfo> = {}): HudInfo {
  return {
    cameraMode: 'chase',
    paused: false,
    fps: 60,
    timeOfDay: 'Morning',
    state: makeState(),
    controls: makeControls(),
    mouseYoke: false,
    ...over,
  };
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const shown = (el: Element | null) => {
  let e: Element | null = el;
  while (e) {
    if ((e as HTMLElement).hidden || (e as HTMLElement).style?.display === 'none') return false;
    e = e.parentElement;
  }
  return !!el;
};
const px = (s: string) => parseFloat(s);

let root: HTMLElement;
let hud: Hud;

beforeEach(() => {
  contexts.clear();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let m = contexts.get(this);
    if (!m) {
      m = mockCtx(this.width, this.height);
      contexts.set(this, m);
    }
    return m.ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  setViewport(1440, 900);
  document.body.innerHTML = '<div id="hud"></div>';
  root = document.getElementById('hud')!;
});

afterEach(() => {
  hud?.dispose();
});

describe('HUD: construction', () => {
  it('builds the gauge clusters, compass tape, systems strip and FPS chip', () => {
    hud = createHud(root);
    const gauges = [...document.querySelectorAll('canvas[data-gauge]')].map((c) => c.getAttribute('data-gauge'));
    expect(gauges).toEqual(['airspeed', 'attitude', 'altimeter', 'heading', 'vsi', 'tach']);
    expect($('.fsh-compass canvas')).not.toBeNull();
    expect($('.fsh-strip canvas')).not.toBeNull();
    expect($('.fsh-chip')).not.toBeNull();
    expect(shown($('.fsh-help'))).toBe(false);
  });

  it('never takes the mouse: the whole overlay is pointer-events: none', () => {
    hud = createHud(root);
    expect(hud.element.style.pointerEvents).toBe('none');
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    expect(css).toMatch(/\.fsh-root \*[^{]*\{[^}]*pointer-events:\s*none/);
  });

  it('hands drawPanel to the aircraft for the cockpit panel texture', () => {
    let got: unknown = null;
    hud = createHud(root, { aircraft: { setPanelDrawer: (fn) => (got = fn) } });
    expect(got).toBe(drawPanel);
  });

  it('dispose removes everything it added', () => {
    hud = createHud(root);
    hud.dispose();
    expect(root.children.length).toBe(0);
    expect(document.getElementById('fsh-style')).toBeNull();
  });
});

describe('HUD: drawing', () => {
  it('draws every gauge on update and skips redraws when nothing changed', () => {
    hud = createHud(root);
    const r = makeReadings();
    hud.update(r, info(), 1 / 60);
    const asi = document.querySelector('canvas[data-gauge="airspeed"]') as HTMLCanvasElement;
    const m = contexts.get(asi)!;
    const n = m.calls.length;
    expect(n).toBeGreaterThan(0);
    hud.update(r, info(), 1 / 60);
    expect(m.calls.length).toBe(n);
    hud.update({ ...r, airspeedKt: r.airspeedKt + 5 }, info(), 1 / 60);
    expect(m.calls.length).toBeGreaterThan(n);
  });

  it('draws crisply at devicePixelRatio (backing store = CSS size × dpr, capped)', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    hud = createHud(root);
    const c = document.querySelector('canvas[data-gauge="attitude"]') as HTMLCanvasElement;
    expect(c.width).toBe(Math.round(px(c.style.width) * 2));
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    hud.resize();
    expect(c.width).toBe(Math.round(px(c.style.width) * CONFIG.hud.maxPixelRatio));
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });
});

describe('HUD: messages', () => {
  it('shows the crash banner with the reason and the reset keys', () => {
    hud = createHud(root);
    const s: AircraftState = { ...makeState({ phase: 'crashed' }), crash: { time: 5, reason: 'Hit terrain', speedKt: 90, verticalSpeedFpm: -2500, position: { x: 0, y: 0, z: 0 } } };
    hud.update(makeReadings({ state: 'crashed' }), info({ state: s }), 1 / 60);
    const banner = $('.fsh-banner');
    expect(shown(banner)).toBe(true);
    expect(banner!.textContent).toContain('CRASHED — Hit terrain');
    expect(banner!.textContent).toContain('R reset · Shift+R approach');
    hud.update(makeReadings(), info({ state: makeState({ time: 0 }) }), 1 / 60);
    expect(shown($('.fsh-banner'))).toBe(false);
  });

  it('flashes the STALL annunciator while the stall warning is on', () => {
    hud = createHud(root);
    hud.update(makeReadings({ stallWarning: true }), info(), 1 / 60);
    const stall = $('[data-ann="stall"]');
    expect(shown(stall)).toBe(true);
    expect(stall!.textContent).toBe('STALL');
    const phases = new Set<boolean>();
    for (let i = 0; i < 30; i++) {
      hud.update(makeReadings({ stallWarning: true }), info(), 1 / 30);
      phases.add(stall!.classList.contains('fsh-dim'));
    }
    expect(phases.size).toBe(2);
    hud.update(makeReadings({ stallWarning: false }), info(), 1 / 60);
    expect(shown(stall)).toBe(false);
  });

  it('shows gear and flap overspeed cautions', () => {
    hud = createHud(root);
    hud.update(makeReadings({ airspeedKt: 150, flapsDeg: 20, gear: 'down', gearLight: 'green' }), info(), 1 / 60);
    expect(shown($('[data-ann="flapOverspeed"]'))).toBe(true);
    expect(shown($('[data-ann="gearOverspeed"]'))).toBe(true);
    expect(shown($('[data-ann="stall"]'))).toBe(false);
  });

  it('pops a landing toast once per touchdown, then it expires', () => {
    hud = createHud(root);
    const td = makeTouchdown({ rating: 'smooth', verticalSpeedFpm: -180, centerlineOffsetM: 3.2 });
    const s = { ...makeState({ onGround: true, phase: 'landed' }), touchdown: td };
    hud.update(makeReadings(), info({ state: s }), 1 / 60);
    hud.update(makeReadings(), info({ state: s }), 1 / 60);
    const toasts = () => [...document.querySelectorAll('.fsh-toast')].map((e) => e.textContent);
    expect(toasts().filter((t) => t === 'SMOOTH · −180 fpm · 3 m right of centreline')).toHaveLength(1);
    for (let i = 0; i < (CONFIG.hud.landingToastSeconds + 1) * 10; i++) hud.update(makeReadings(), info({ state: s }), 0.1);
    expect(toasts().filter((t) => t?.startsWith('SMOOTH'))).toHaveLength(0);
  });

  it('shows PAUSED while paused', () => {
    hud = createHud(root);
    hud.update(makeReadings(), info({ paused: true }), 1 / 60);
    expect(shown($('.fsh-paused'))).toBe(true);
    hud.update(makeReadings(), info({ paused: false }), 1 / 60);
    expect(shown($('.fsh-paused'))).toBe(false);
  });

  it('shows the start hint for the first seconds only', () => {
    hud = createHud(root);
    hud.update(makeReadings(), info(), 1 / 60);
    expect(shown($('.fsh-hint'))).toBe(true);
    for (let i = 0; i < (CONFIG.hud.startHintSeconds + 1) * 10; i++) hud.update(makeReadings(), info(), 0.1);
    expect(shown($('.fsh-hint'))).toBe(false);
  });

  it('flash() shows a toast for the given seconds', () => {
    hud = createHud(root);
    hud.flash('Mouse yoke ON', 'info', 1);
    hud.update(makeReadings(), info(), 0.1);
    expect([...document.querySelectorAll('.fsh-toast')].some((e) => e.textContent === 'Mouse yoke ON')).toBe(true);
    for (let i = 0; i < 15; i++) hud.update(makeReadings(), info(), 0.1);
    expect([...document.querySelectorAll('.fsh-toast')].some((e) => e.textContent === 'Mouse yoke ON')).toBe(false);
  });

  it('flashes the new camera and mouse-yoke state when they change', () => {
    hud = createHud(root);
    hud.update(makeReadings(), info({ cameraMode: 'chase' }), 1 / 60);
    hud.update(makeReadings(), info({ cameraMode: 'orbit', mouseYoke: true }), 1 / 60);
    const t = [...document.querySelectorAll('.fsh-toast')].map((e) => e.textContent).join(' | ');
    expect(t).toMatch(/orbit/i);
    expect(t).toMatch(/mouse yoke/i);
  });

  it('chip shows fps, camera, time of day and mouse yoke', () => {
    hud = createHud(root);
    hud.update(makeReadings(), info({ fps: 59.6, cameraMode: 'external', timeOfDay: 'Golden hour', mouseYoke: true }), 1 / 60);
    const chip = $('.fsh-chip')!.textContent!;
    expect(chip).toContain('60 FPS');
    expect(chip).toContain('EXTERNAL');
    expect(chip).toContain('Golden hour');
    expect(chip).toContain('MOUSE YOKE');
  });
});

describe('HUD: help and visibility', () => {
  it('help toggles and lists every control', () => {
    hud = createHud(root);
    expect(shown($('.fsh-help'))).toBe(false);
    hud.toggleHelp();
    expect(shown($('.fsh-help'))).toBe(true);
    const text = $('.fsh-help')!.textContent!;
    for (const k of ['Shift+R', 'Space', 'PgUp', '[', ']', 'Esc']) expect(text).toContain(k);
    hud.toggleHelp();
    expect(shown($('.fsh-help'))).toBe(false);
  });

  it('toggleVisible hides the instruments but keeps the messages', () => {
    hud = createHud(root);
    hud.toggleVisible();
    hud.update(makeReadings({ stallWarning: true }), info(), 1 / 60);
    expect(shown($('.fsh-left'))).toBe(false);
    expect(shown($('.fsh-compass'))).toBe(false);
    expect(shown($('.fsh-strip'))).toBe(false);
    expect(shown($('[data-ann="stall"]'))).toBe(true);
    hud.toggleVisible();
    hud.update(makeReadings(), info(), 1 / 60);
    expect(shown($('.fsh-left'))).toBe(true);
  });
});

describe('HUD: layout', () => {
  const gaugeWidth = () => px((document.querySelector('canvas[data-gauge="airspeed"]') as HTMLElement).style.width);

  it('gauges are ≈118–132 px at 1440 wide and ≈92–100 px at 1024', () => {
    setViewport(1440, 900);
    hud = createHud(root);
    expect(gaugeWidth()).toBeGreaterThanOrEqual(118);
    expect(gaugeWidth()).toBeLessThanOrEqual(132);
    setViewport(1024, 768);
    hud.resize();
    expect(gaugeWidth()).toBeGreaterThanOrEqual(92);
    expect(gaugeWidth()).toBeLessThanOrEqual(100);
  });

  it('clusters sit in the lower 20 % of the screen at both sizes', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      setViewport(w, h);
      hud = createHud(root);
      for (const sel of ['.fsh-left', '.fsh-right']) {
        const el = $(sel)!;
        expect(px(el.style.top)).toBeGreaterThanOrEqual(h * 0.8 - 1);
        expect(px(el.style.top) + px(el.style.height)).toBeLessThanOrEqual(h);
      }
      hud.dispose();
    }
  });

  it('cockpit view hides the gauge clusters but keeps compass, systems strip and messages', () => {
    hud = createHud(root);
    const cam: CameraMode = 'cockpit';
    hud.update(makeReadings({ stallWarning: true }), info({ cameraMode: cam }), 1 / 60);
    expect(shown($('.fsh-left'))).toBe(false);
    expect(shown($('.fsh-right'))).toBe(false);
    expect(shown($('.fsh-compass'))).toBe(true);
    expect(shown($('.fsh-strip'))).toBe(true);
    expect(shown($('[data-ann="stall"]'))).toBe(true);
    hud.update(makeReadings(), info({ cameraMode: 'chase' }), 1 / 60);
    expect(shown($('.fsh-left'))).toBe(true);
  });

  it("cockpitGauges: 'compact' keeps smaller clusters in cockpit view", () => {
    const cfg = cloneConfig();
    cfg.hud.cockpitGauges = 'compact';
    hud = createHud(root, { config: cfg });
    const normal = gaugeWidth();
    hud.update(makeReadings(), info({ cameraMode: 'cockpit' }), 1 / 60);
    expect(shown($('.fsh-left'))).toBe(true);
    expect(gaugeWidth()).toBeLessThan(normal);
  });

  it('follows window resizes on its own', () => {
    setViewport(1440, 900);
    hud = createHud(root);
    setViewport(1024, 768);
    window.dispatchEvent(new Event('resize'));
    expect(gaugeWidth()).toBeLessThanOrEqual(100);
  });
});

// Keep the readings type in use for editors.
export type _R = InstrumentReadings;
