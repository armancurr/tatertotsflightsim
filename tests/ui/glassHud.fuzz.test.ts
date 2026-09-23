/**
 * Glass HUD fuzz: the layout on any viewport from 640×480 to 4K in every camera mode (on screen,
 * below the top bar, no overlaps with the chip or each other, the centre third clear, messages
 * outside it), and the painters with random and hostile readings (NaN, ±Infinity, huge) and
 * sizes — never a non-finite coordinate, never a "NaN" string, readouts inside the canvas.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Config } from '../../src/config';
import { computeHudLayout, type Rect } from '../../src/ui/hud';
import {
  computeGlassHudLayout, createGlassHudState, drawGlassEicas, drawGlassPfd, engineN1, engineN1Command, trackGlassHud, type GlassReadings,
} from '../../src/ui/glassHud';
import { getAircraftDef } from '../../src/fleet';
import { arbReadings, arbDt, mockCtx } from './fixtures';
import { geoCtx } from './geoCtx';

const B747: Config = getAircraftDef('b747').config;
const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number) => a.x >= 0 && a.y >= 0 && a.x + a.w <= w + 1e-9 && a.y + a.h <= h + 1e-9;
const wild = (min: number, max: number) =>
  fc.oneof({ weight: 8, arbitrary: fc.double({ min, max, noNaN: true }) }, { weight: 1, arbitrary: fc.constantFrom(NaN, Infinity, -Infinity, 1e12, -1e12) });
const arbGlass: fc.Arbitrary<GlassReadings> = fc
  .tuple(arbReadings, wild(-90, 90), fc.boolean(), wild(-45, 45), wild(-1, 5))
  .map(([r, fpa, sb, beta, mach]) => ({ ...r, flightPathDeg: fpa, speedBrake: sb, betaDeg: beta, mach }));

describe('glass HUD layout (property)', () => {
  it('any viewport 640×480 → 4K, any mode: on screen, below the top bar, no overlaps, centre third clear', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 640, max: 3840 }),
        fc.integer({ min: 480, max: 2160 }),
        fc.constantFrom('normal', 'cockpitHidden', 'cockpitCompact') as fc.Arbitrary<'normal' | 'cockpitHidden' | 'cockpitCompact'>,
        (w, h, mode) => {
          const L = computeHudLayout(w, h, B747, mode, 'glass');
          const g = L.glass!;
          expect(g).toBeTruthy();
          expect(computeGlassHudLayout(w, h, B747, mode)).toEqual(g);
          const bs: [string, Rect][] = [['systems', g.systems], ['chip', { x: L.chip.x, y: L.chip.y, w: L.chip.maxW, h: L.chip.h }]];
          if (g.pfd) bs.push(['pfd', g.pfd]);
          for (const [name, b] of bs) {
            expect(inside(b, w, h), `${name} ${JSON.stringify(b)} in ${w}x${h}`).toBe(true);
            expect(b.y, `${name} below the top bar`).toBeGreaterThanOrEqual(L.topInset);
            for (const v of [b.x, b.y, b.w, b.h]) expect(Number.isInteger(v)).toBe(true);
          }
          for (let i = 0; i < bs.length; i++)
            for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i][1], bs[j][1]), `${bs[i][0]} × ${bs[j][0]} at ${w}x${h} ${mode}`).toBe(false);
          const centre: Rect = { x: w / 3, y: h / 3, w: w / 3, h: h / 3 };
          for (const [name, b] of bs) expect(overlap(b, centre), `${name} in the centre third at ${w}x${h}`).toBe(false);
          expect(L.bannerY).toBeLessThan(h / 3);
          expect(L.toastBottom).toBeGreaterThan((2 * h) / 3);
          expect(L.toastBottom).toBeLessThanOrEqual(Math.min(g.systems.y, g.pfd?.y ?? Infinity));
          // Readable: the PFD never shrinks below 150 px, the compact strip below 36 px.
          if (g.pfd) expect(g.pfd.h).toBeGreaterThanOrEqual(Math.min(150, Math.floor(h / 3) - 40));
          else expect(g.systems.h).toBeGreaterThanOrEqual(36);
        },
      ),
      { numRuns: 400 },
    );
  }, 60000);
});

describe('glass HUD painters (fuzz)', () => {
  it('PFD: random and hostile readings and sizes → only finite coordinates, texts inside the canvas', () => {
    fc.assert(
      fc.property(arbGlass, fc.integer({ min: 0, max: 900 }), fc.integer({ min: 0, max: 700 }), arbDt, (r, w, h, dt) => {
        const s = createGlassHudState();
        trackGlassHud(s, r, dt);
        trackGlassHud(s, r, dt);
        expect(Number.isFinite(s.trendKt)).toBe(true);
        const m = mockCtx(w, h);
        drawGlassPfd(m.ctx, w, h, r, s, B747);
        expect(m.bad(), JSON.stringify(m.bad().slice(0, 3))).toEqual([]);
        const g = geoCtx();
        drawGlassPfd(g.ctx, w, h, r, s, B747);
        for (const n of g.numbers) expect(Number.isFinite(n)).toBe(true);
        for (const t of g.texts) {
          expect(t.s).not.toMatch(/NaN|Infinity|undefined/);
          expect(t.p.x).toBeGreaterThanOrEqual(-1);
          expect(t.p.x).toBeLessThanOrEqual(w + 1);
          expect(t.p.y).toBeGreaterThanOrEqual(-1);
          expect(t.p.y).toBeLessThanOrEqual(h + 1);
        }
      }),
      { numRuns: 300 },
    );
  }, 60000);

  it('EICAS (full and compact): random and hostile readings → finite, texts inside the canvas', () => {
    fc.assert(
      fc.property(arbGlass, fc.integer({ min: 0, max: 800 }), fc.integer({ min: 0, max: 400 }), fc.boolean(), (r, w, h, compact) => {
        const m = mockCtx(w, h);
        drawGlassEicas(m.ctx, w, h, r, B747, compact);
        expect(m.bad(), JSON.stringify(m.bad().slice(0, 3))).toEqual([]);
        const g = geoCtx();
        drawGlassEicas(g.ctx, w, h, r, B747, compact);
        for (const n of g.numbers) expect(Number.isFinite(n)).toBe(true);
        for (const t of g.texts) {
          expect(t.s).not.toMatch(/NaN|Infinity|undefined/);
          expect(t.p.x).toBeGreaterThanOrEqual(-1);
          expect(t.p.x).toBeLessThanOrEqual(w + 1);
          expect(t.p.y).toBeGreaterThanOrEqual(-1);
          expect(t.p.y).toBeLessThanOrEqual(h + 1);
        }
      }),
      { numRuns: 300 },
    );
  }, 60000);

  it('N1 and the lever N1 are finite and within 0–110 % whatever comes in', () => {
    fc.assert(
      fc.property(wild(-500, 5000), fc.constantFrom('RUNNING', 'STARTING', 'OFF', 'FAILED') as fc.Arbitrary<'RUNNING'>, fc.integer({ min: -3, max: 8 }), wild(-100, 300), (rpm, st, e, thr) => {
        const n = engineN1(rpm, st, e, B747);
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(110);
        const c = engineN1Command(thr, B747);
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(110);
      }),
      { numRuns: 500 },
    );
  }, 60000);
});
