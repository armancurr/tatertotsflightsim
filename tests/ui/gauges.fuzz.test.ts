import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { GAUGES, SYSTEM_CELLS, drawSystemsStrip, drawCompassTape, drawPanel, asiNeedleDeg, vsiNeedleDeg, tachNeedleDeg, altimeterHandsDeg, attitudeGeometry, turnCoordinatorBankDeg, ballOffset } from '../../src/ui/gauges';
import { mockCtx, arbReadings } from './fixtures';

const size = fc.double({ min: 4, max: 600, noNaN: true });
const coord = fc.double({ min: -500, max: 2000, noNaN: true });
const any = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));

describe('gauges: property tests', () => {
  it('random readings never throw or emit NaN coordinates, at any size and position', () => {
    fc.assert(
      fc.property(arbReadings, size, coord, coord, (r, s, cx, cy) => {
        for (const draw of Object.values(GAUGES)) {
          const m = mockCtx();
          draw(m.ctx, cx, cy, s, r);
          expect(m.bad()).toEqual([]);
          expect(m.argsOf('save').length).toBe(m.argsOf('restore').length);
        }
        for (const cell of Object.values(SYSTEM_CELLS)) {
          const m = mockCtx();
          cell.draw(m.ctx, cx, cy, s * cell.aspect, s, r);
          expect(m.bad()).toEqual([]);
        }
      }),
      { numRuns: 120 },
    );
  });

  it('strip, compass tape and panel survive random readings and sizes', () => {
    fc.assert(
      fc.property(arbReadings, fc.double({ min: 20, max: 1200, noNaN: true }), fc.double({ min: 10, max: 120, noNaN: true }), (r, w, h) => {
        const a = mockCtx();
        drawSystemsStrip(a.ctx, 0, 0, w, h, r);
        expect(a.bad()).toEqual([]);
        const b = mockCtx();
        drawCompassTape(b.ctx, 0, 0, w, h, r.headingDeg);
        expect(b.bad()).toEqual([]);
        const c = mockCtx();
        drawPanel(c.ctx, w * 2, w, r);
        expect(c.bad()).toEqual([]);
        expect(c.argsOf('save').length).toBe(c.argsOf('restore').length);
      }),
      { numRuns: 60 },
    );
  });

  it('needle angle helpers are finite and within their dial for any input', () => {
    fc.assert(
      fc.property(any, any, any, (a, b, s) => {
        const asi = asiNeedleDeg(a);
        expect(asi).toBeGreaterThanOrEqual(0);
        expect(asi).toBeLessThan(360);
        const vsi = vsiNeedleDeg(a);
        expect(Number.isFinite(vsi)).toBe(true);
        expect(Math.abs(vsi + 90)).toBeLessThanOrEqual(170 + 1e-9);
        const tach = tachNeedleDeg(a);
        expect(Math.abs(tach)).toBeLessThanOrEqual(130);
        const alt = altimeterHandsDeg(a);
        for (const v of [alt.h100, alt.h1000, alt.h10000]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(360);
        }
        const g = attitudeGeometry(a, b, Number.isFinite(s) ? Math.abs(s) % 1000 : s);
        expect(Number.isFinite(g.rotation) && Number.isFinite(g.offsetY) && Number.isFinite(g.pxPerDeg)).toBe(true);
        expect(Math.abs(turnCoordinatorBankDeg(a))).toBeLessThanOrEqual(40);
        expect(Number.isFinite(ballOffset(a, Number.isFinite(s) ? Math.abs(s) % 1000 : s))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('needles move the right way: more airspeed / climb / rpm never turns the needle back', () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 400, noNaN: true }), fc.double({ min: 0, max: 50, noNaN: true }), (v, dv) => {
        expect(asiNeedleDeg(v + dv)).toBeGreaterThanOrEqual(asiNeedleDeg(v));
        expect(vsiNeedleDeg(v * 20 + dv)).toBeGreaterThanOrEqual(vsiNeedleDeg(v * 20));
        expect(tachNeedleDeg(v * 10 + dv)).toBeGreaterThanOrEqual(tachNeedleDeg(v * 10));
      }),
      { numRuns: 300 },
    );
  });
});
