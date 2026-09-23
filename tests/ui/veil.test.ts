// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../src/config';
import {
  createVeilModel, veilMark, veilFrame, veilGesture, veilTick, createLoadingVeil, veilActive, VEIL_STAGES,
  type VeilModel,
} from '../../src/ui/veil';

const V = CONFIG.hud.veil;

/** Drive a model through boot → systems → streaming → frames of `frameMs`. */
function boot(m: VeilModel, frameMs = 16.7, frames = 200): VeilModel {
  veilTick(m, 0.4);
  veilMark(m, 1);
  veilTick(m, 0.3);
  veilMark(m, 2);
  veilTick(m, 0.5);
  for (let i = 0; i < frames; i++) veilFrame(m, frameMs / 1000);
  return m;
}

describe('veil model (pure)', () => {
  it('starts loading with a little progress and a status line', () => {
    const m = createVeilModel();
    expect(m.phase).toBe('loading');
    expect(m.target).toBeGreaterThan(0);
    expect(m.status.length).toBeGreaterThan(3);
  });

  it('each stage raises the target and changes the status', () => {
    const m = createVeilModel();
    const seen = [m.target];
    const texts = new Set([m.status]);
    for (let s = 1; s < VEIL_STAGES.length; s++) {
      veilMark(m, s);
      seen.push(m.target);
      texts.add(m.status);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(texts.size).toBe(VEIL_STAGES.length);
  });

  it('becomes ready after smooth frames, then fades out by itself autoDismissS later', () => {
    const m = boot(createVeilModel());
    expect(m.phase === 'ready' || m.phase === 'fading' || m.phase === 'gone').toBe(true);
    expect(m.progress).toBeGreaterThan(0.97);
    let t = 0;
    while (m.phase !== 'gone' && t < 10) {
      veilFrame(m, 1 / 60);
      t += 1 / 60;
    }
    expect(m.phase).toBe('gone');
    expect(t).toBeLessThan(V.autoDismissS + V.fadeS + 0.5);
  });

  it('a long hitch keeps it loading; stutter never blocks it past maxWarmupS after the first frame', () => {
    const m = boot(createVeilModel(), 120, 10);
    expect(m.phase).toBe('loading');
    let t = 10 * 0.12;
    while (m.phase === 'loading' && t < 30) {
      veilFrame(m, 0.12);
      t += 0.12;
    }
    expect(m.phase).not.toBe('loading');
    expect(t).toBeLessThanOrEqual(V.maxWarmupS + 0.2);
  });

  it('a key/click before the first frame dismisses as soon as the sim renders; after it, at once', () => {
    const m = createVeilModel();
    veilGesture(m);
    veilTick(m, 1);
    expect(m.phase).toBe('loading');
    veilMark(m, 1);
    veilMark(m, 2);
    veilFrame(m, 1 / 60);
    expect(m.phase === 'fading' || m.phase === 'gone').toBe(true);
  });

  it('lifts after maxTotalS even if the simulator never renders a frame', () => {
    const m = createVeilModel();
    for (let t = 0; t < V.maxTotalS + V.fadeS + 1; t += 0.1) veilTick(m, 0.1);
    expect(m.phase).toBe('gone');
  });

  it('never goes back to loading once it is fading', () => {
    const m = boot(createVeilModel());
    veilGesture(m);
    veilFrame(m, 1 / 60);
    veilMark(m, 1);
    expect(['fading', 'gone']).toContain(m.phase);
  });

  it('fuzz: progress is monotone, in [0,1], finite; phases only move forward; gone within a bound of the first frame', () => {
    const order = ['loading', 'ready', 'fading', 'gone'];
    const ev = fc.oneof(
      fc.record({ k: fc.constant('mark' as const), s: fc.integer({ min: -2, max: 9 }) }),
      fc.record({ k: fc.constant('frame' as const), dt: fc.oneof(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.constantFrom(Number.NaN, -1, Infinity)) }),
      fc.record({ k: fc.constant('tick' as const), dt: fc.oneof(fc.double({ min: 0, max: 2, noNaN: true }), fc.constantFrom(Number.NaN, -1, Infinity)) }),
      fc.record({ k: fc.constant('gesture' as const) }),
    );
    fc.assert(
      fc.property(fc.array(ev, { maxLength: 200 }), (events) => {
        const m = createVeilModel();
        let lastP = m.progress;
        let lastPhase = 0;
        for (const e of events) {
          if (e.k === 'mark') veilMark(m, e.s);
          else if (e.k === 'frame') veilFrame(m, e.dt);
          else if (e.k === 'tick') veilTick(m, e.dt);
          else veilGesture(m);
          expect(Number.isFinite(m.progress)).toBe(true);
          expect(m.progress).toBeGreaterThanOrEqual(lastP - 1e-12);
          expect(m.progress).toBeLessThanOrEqual(1);
          const ph = order.indexOf(m.phase);
          expect(ph).toBeGreaterThanOrEqual(lastPhase);
          expect(Number.isFinite(m.opacity) && m.opacity >= 0 && m.opacity <= 1).toBe(true);
          lastP = m.progress;
          lastPhase = ph;
        }
        // After the first frame, enough frame time always gets rid of it.
        veilFrame(m, 1 / 60);
        for (let i = 0; i < (V.maxWarmupS + V.autoDismissS + V.fadeS + 1) * 60; i++) veilFrame(m, 1 / 60);
        expect(m.phase).toBe('gone');
      }),
      { numRuns: 150 },
    );
  });
});

describe('loading veil DOM', () => {
  let veil: ReturnType<typeof createLoadingVeil> | null = null;
  afterEach(() => {
    veil?.dispose();
    veil = null;
  });

  it('covers the page with the branding (mascot, name, full name), the aircraft, a progress bar and a status line', () => {
    veil = createLoadingVeil(document, CONFIG, { aircraftName: 'F-16C Fighting Falcon' });
    const el = document.querySelector('.fsv-veil') as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.querySelector('.fsv-title')!.textContent).toBe("Tater's Flight Sim");
    expect(el.textContent).toContain('Tater Tots Flight Simulator');
    expect(el.textContent).toContain('F-16C Fighting Falcon');
    expect(el.querySelector('.fsv-mascot svg')).not.toBeNull();
    expect(el.querySelector('svg')).not.toBeNull();
    expect(el.querySelector('.fsv-bar')).not.toBeNull();
    expect(el.querySelector('.fsv-status')!.textContent!.length).toBeGreaterThan(3);
    expect(el.querySelector('canvas')).toBeNull(); // the e2e tests find the 3D canvas as the largest canvas
    expect(veilActive()).toBe(true);
  });

  it('shows "Click or press any key to start" when ready and is removed after the fade', () => {
    veil = createLoadingVeil(document);
    veil.mark(1);
    veil.mark(2);
    for (let i = 0; i < 120; i++) veil.frame(1 / 60);
    const el = document.querySelector('.fsv-veil') as HTMLElement | null;
    const start = document.querySelector('.fsv-start') as HTMLElement;
    expect(start.textContent).toBe('Click or press any key to start');
    expect(el?.classList.contains('fsv-ready')).toBe(true);
    for (let i = 0; i < (V.autoDismissS + V.fadeS + 1) * 60; i++) veil.frame(1 / 60);
    expect(document.querySelector('.fsv-veil')).toBeNull();
    expect(veilActive()).toBe(false);
  });

  it('a key press dismisses it (and is not swallowed: it still reaches window listeners)', () => {
    veil = createLoadingVeil(document);
    let seen = 0;
    const count = () => seen++;
    window.addEventListener('keydown', count);
    veil.mark(1);
    veil.mark(2);
    veil.frame(1 / 60);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w' }));
    expect(seen).toBe(1);
    for (let i = 0; i < (V.fadeS + 0.5) * 60; i++) veil.frame(1 / 60);
    expect(document.querySelector('.fsv-veil')).toBeNull();
    window.removeEventListener('keydown', count);
  });

  it('a click dismisses it; while it is up it takes the pointer, once gone it never blocks the canvas', () => {
    veil = createLoadingVeil(document);
    const el = document.querySelector('.fsv-veil') as HTMLElement;
    veil.mark(2);
    veil.frame(1 / 60);
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    veil.frame(1 / 60);
    expect(el.style.pointerEvents).toBe('none');
    for (let i = 0; i < (V.fadeS + 0.5) * 60; i++) veil.frame(1 / 60);
    expect(document.querySelector('.fsv-veil')).toBeNull();
  });

  it('dispose removes everything, listeners included', () => {
    veil = createLoadingVeil(document);
    veil.dispose();
    veil = null;
    expect(document.querySelector('.fsv-veil')).toBeNull();
    expect(document.getElementById('fsv-style')).toBeNull();
    expect(veilActive()).toBe(false);
  });

  it('defaults to the config aircraft', () => {
    veil = createLoadingVeil(document);
    expect(document.querySelector('.fsv-sub')!.textContent).toContain(CONFIG.aircraft.name);
  });
});
