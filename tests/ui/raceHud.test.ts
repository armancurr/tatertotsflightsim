// @vitest-environment happy-dom
/**
 * The race lap-timer panel (src/ui/raceHud.ts): time and split formatting (fuzzed: always well
 * formed), the relative bearing of the next mark, the layout (top-left, inside the viewport, clear
 * of the compass tape, the chip, the annunciators and the marine helm blocks at common sizes), the
 * view model through a race (idle → racing → a missed mark → a lap), and the DOM render.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { formatLapTime, formatSplit, relativeBearing, raceHudRect, raceHudView, createRaceHud } from '../../src/ui/raceHud';
import { computeHudLayout, type Rect } from '../../src/ui/hud';
import { createRaceTracker, raceCourse, updateRace } from '../../src/world/offshore/raceCourse';
import { CONFIG, V50_AIRCRAFT } from '../../src/config';

const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('formatting', () => {
  it('lap times as m:ss.hh', () => {
    expect(formatLapTime(0)).toBe('0:00.00');
    expect(formatLapTime(83.456)).toBe('1:23.46');
    expect(formatLapTime(59.996)).toBe('1:00.00');
    expect(formatLapTime(9.5, 1)).toBe('0:09.5');
    expect(formatLapTime(NaN)).toBe('—');
    expect(formatLapTime(-1)).toBe('—');
    fc.assert(fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), (s) => {
      expect(formatLapTime(s)).toMatch(/^\d{1,2}:\d{2}\.\d{2}$/);
      expect(formatLapTime(s, 1)).toMatch(/^\d{1,2}:\d{2}\.\d$/);
    }));
  });

  it('splits signed, with a true minus', () => {
    expect(formatSplit(0.4234)).toBe('+0.42');
    expect(formatSplit(-1.2)).toBe('−1.20');
    expect(formatSplit(0.001)).toBe('±0.00');
    expect(formatSplit(NaN)).toBe('');
    fc.assert(fc.property(fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 }), (d) => {
      expect(formatSplit(d)).toMatch(/^(\+|−|±)\d{1,3}\.\d{2}$/);
    }));
  });

  it('relative bearing: ahead 0, starboard +, port −, always in (−180, 180]', () => {
    expect(relativeBearing(0, 0, 0, 0, -100)).toBeCloseTo(0, 9);
    expect(relativeBearing(0, 0, 0, 100, 0)).toBeCloseTo(90, 9);
    expect(relativeBearing(0, 0, 90, 0, -100)).toBeCloseTo(-90, 9);
    expect(relativeBearing(0, 0, 0, 0, 100)).toBeCloseTo(180, 9);
    fc.assert(fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -720, max: 720, noNaN: true }), (tx, tz, h) => {
      const r = relativeBearing(0, 0, h, tx, tz);
      expect(r).toBeGreaterThan(-180.000001);
      expect(r).toBeLessThanOrEqual(180);
    }));
  });
});

describe('layout', () => {
  const V50 = { ...CONFIG, aircraft: V50_AIRCRAFT };
  it.each([[1024, 768], [1280, 800], [1440, 900], [1920, 1080], [800, 600]])('at %i×%i: top-left, inside, clear of the compass, chip, annunciators and the helm blocks', (w, h) => {
    const r = raceHudRect(w, h, V50);
    const L = computeHudLayout(w, h, V50, 'normal', 'marine');
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThan(L.chip.y + L.chip.h);
    expect(r.x + r.w).toBeLessThanOrEqual(w);
    expect(r.y + r.h).toBeLessThan(h / 2);
    expect(r.w).toBeGreaterThan(180);
    expect(overlap(r, L.compass)).toBe(false);
    expect(r.x + r.w).toBeLessThan(L.compass.x);
    if (L.marine?.nav) expect(overlap(r, L.marine.nav)).toBe(false);
    expect(overlap(r, L.strip)).toBe(false);
    expect(overlap(r, { x: L.chip.x, y: L.chip.y, w: L.chip.maxW, h: L.chip.h })).toBe(false);
  });
});

describe('view model through a race', () => {
  const C = raceCourse();
  it('idle → racing → missed mark → lap', () => {
    const t = createRaceTracker(C, 'seadoo');
    let v = raceHudView(t, C.cx, C.cz, 90, 0);
    expect(v.status).toBe('CROSS THE START');
    expect(v.nextLabel).toBe('START');
    expect(v.current).toBe('0:00.0');
    expect(v.dots.every((d) => d === 'todo')).toBe(true);
    expect(v.last).toBe('—');
    const g = C.marks[0];
    updateRace(t, g.x - 5, g.z, g.x + 5, g.z, 10, 0.5);
    v = raceHudView(t, g.x + 5, g.z, 90, 22.3);
    expect(v.status).toBe('RACING');
    expect(v.title).toContain('LAP 1');
    expect(v.current).toMatch(/^0:12\.\d$/);
    expect(v.dots[0]).toBe('next');
    expect(v.nextLabel).toBe('T1');
    expect(v.nextDetail).toContain('starboard');
    expect(v.arrowDeg).toBeGreaterThan(-20);
    expect(v.arrowDeg).toBeLessThan(20);
    // skip T1: cross T2's check line
    const s = C.check[2];
    const m2 = C.marks[2];
    const mx = (s.ax + s.bx) / 2;
    const mz = (s.az + s.bz) / 2;
    updateRace(t, mx - m2.dx * 5, mz - m2.dz * 5, mx + m2.dx * 5, mz + m2.dz * 5, 40, 0.5);
    v = raceHudView(t, mx, mz, 180, 41);
    expect(v.statusTone).toBe('bad');
    expect(v.status).toContain('MISSED 1');
    expect(v.dots[0]).toBe('missed');
    expect(v.dots[1]).toBe('done');
    expect(v.dots[2]).toBe('next');
  });
});

describe('DOM', () => {
  it('renders the view and only touches the DOM when something changed', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const hud = createRaceHud(root);
    const el = root.querySelector('[data-hud="race"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.hidden).toBe(true);
    hud.setVisible(true);
    expect(el.hidden).toBe(false);
    hud.layout(1440, 900);
    expect(el.style.left).toMatch(/px$/);
    const C = raceCourse();
    const t = createRaceTracker(C, 'v50');
    t.best = 101.234;
    const v = raceHudView(t, C.cx, C.cz, 0, 0);
    hud.update(v);
    expect(el.textContent).toContain('CROSS THE START');
    expect(el.textContent).toContain('1:41.23');
    expect(el.querySelectorAll('.frh-dot').length).toBe(C.marks.length - 1);
    const cur = el.querySelector('.frh-cur')!;
    const before = cur.firstChild;
    hud.update(v);
    expect(cur.firstChild).toBe(before);
    hud.update({ ...v, current: '0:05.0', lastInvalid: true, last: '1:50.00', split: '−0.50', splitLabel: 'T3', splitTone: 'ahead' });
    expect(el.textContent).toContain('0:05.0');
    expect(el.textContent).toContain('INVALID');
    expect(el.querySelector('.frh-split')!.className).toContain('ahead');
    hud.dispose();
    expect(root.querySelector('[data-hud="race"]')).toBeNull();
  });
});
