// @vitest-environment happy-dom
/**
 * The HUD overlay in jet style (F-16): six-pack and compass tape hidden, the head-up display in the
 * centre, systems strip kept; redraws only on change; max g resets; the PAUSED pill makes way for
 * the pause menu.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { InstrumentReadings } from '../../src/types';
import { createHud, type Hud, type HudInfo } from '../../src/ui/hud';
import { topBarHeight } from '../../src/ui/topBar';
import { mockCtx, makeReadings, makeState, makeControls, type MockCtx } from './fixtures';

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
const jetReadings = (over: Partial<InstrumentReadings> & Record<string, unknown> = {}) =>
  ({ ...makeReadings({ airspeedKt: 380, altitudeFt: 9000, mach: 0.6, afterburner: 0, gear: 'up', gearLight: 'off' }), betaDeg: 0, flightPathDeg: 0, speedBrake: false, ...over }) as InstrumentReadings;

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

describe('HUD: jet style', () => {
  it('hides the six-pack and the compass tape, keeps the systems strip, shows the head-up display in the centre', () => {
    hud = createHud(root, { style: 'jet' });
    hud.update(jetReadings(), info(), 1 / 60);
    expect(hud.style).toBe('jet');
    expect(shown(document.querySelector('.fsh-left'))).toBe(false);
    expect(shown(document.querySelector('.fsh-right'))).toBe(false);
    expect(shown(document.querySelector('.fsh-compass'))).toBe(false);
    expect(shown(document.querySelector('.fsh-strip'))).toBe(true);
    const jet = document.querySelector('canvas[data-hud="jet"]') as HTMLCanvasElement;
    expect(shown(jet)).toBe(true);
    const box = jet.parentElement as HTMLElement;
    const x = parseFloat(box.style.left);
    const w = parseFloat(box.style.width);
    expect(Math.abs(x + w / 2 - 720)).toBeLessThanOrEqual(1);
  });

  it('steam style keeps the six-pack and has no head-up display', () => {
    hud = createHud(root);
    hud.update(makeReadings(), info(), 1 / 60);
    expect(shown(document.querySelector('.fsh-left'))).toBe(true);
    expect(shown(document.querySelector('canvas[data-hud="jet"]'))).toBe(false);
  });

  it('draws the jet HUD, skips unchanged frames, redraws on a change', () => {
    hud = createHud(root, { style: 'jet' });
    const r = jetReadings();
    hud.update(r, info(), 1 / 60);
    const m = contexts.get(document.querySelector('canvas[data-hud="jet"]') as HTMLCanvasElement)!;
    const n = m.calls.length;
    expect(n).toBeGreaterThan(50);
    hud.update(r, info(), 1 / 60);
    expect(m.calls.length).toBe(n);
    hud.update({ ...r, rollDeg: r.rollDeg + 5 }, info(), 1 / 60);
    expect(m.calls.length).toBeGreaterThan(n);
  });

  it('max g is remembered until a restart', () => {
    hud = createHud(root, { style: 'jet' });
    hud.update(jetReadings({ gLoad: 7.5 }), info(), 1 / 60);
    const m = contexts.get(document.querySelector('canvas[data-hud="jet"]') as HTMLCanvasElement)!;
    m.reset();
    hud.update(jetReadings({ gLoad: 1.2 }), info(), 1 / 60);
    expect(m.texts()).toContain('MAX 7.5');
    hud.onReset();
    m.reset();
    hud.update(jetReadings({ gLoad: 1.1 }), info(), 1 / 60);
    expect(m.texts()).toContain('MAX 1.1');
  });

  it('sits below the top bar', () => {
    hud = createHud(root, { style: 'jet' });
    const chip = document.querySelector('.fsh-chip') as HTMLElement;
    expect(parseFloat(chip.style.top)).toBeGreaterThanOrEqual(topBarHeight(1440));
  });
});

describe('HUD: pause menu interplay', () => {
  it('the PAUSED pill hides while the pause menu is open and returns when it closes (still paused)', () => {
    hud = createHud(root);
    const pill = document.querySelector('.fsh-paused') as HTMLElement;
    hud.update(makeReadings(), info({ paused: true }), 0);
    expect(pill.hidden).toBe(false);
    hud.setMenuOpen(true);
    hud.update(makeReadings(), info({ paused: true }), 0);
    expect(pill.hidden).toBe(true);
    hud.setMenuOpen(false);
    hud.update(makeReadings(), info({ paused: true }), 0);
    expect(pill.hidden).toBe(false);
  });

  it('isVisible follows toggleVisible', () => {
    hud = createHud(root);
    expect(hud.isVisible()).toBe(true);
    hud.toggleVisible();
    expect(hud.isVisible()).toBe(false);
  });
});
