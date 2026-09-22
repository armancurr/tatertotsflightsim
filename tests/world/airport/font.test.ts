import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DIGIT_BOX, digitStrokes, strokeQuads, textQuads, type P2, type Quad2 } from '../../../src/world/airport/font';

const area = (q: Quad2): number => {
  let s = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
};
const bbox = (pts: P2[]) => ({
  x0: Math.min(...pts.map((p) => p.x)),
  x1: Math.max(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  y1: Math.max(...pts.map((p) => p.y)),
});

describe('runway numeral stroke font', () => {
  it('defines every digit 0-9', () => {
    for (const d of '0123456789') expect(digitStrokes(d).length).toBeGreaterThan(0);
    expect(() => digitStrokes('x')).toThrow();
  });

  it('keeps every digit inside its 1 × 3 box (FAA 20 ft × 60 ft proportions)', () => {
    expect(DIGIT_BOX.height / DIGIT_BOX.width).toBeCloseTo(3);
    for (const d of '0123456789') {
      const quads = digitStrokes(d).flatMap((s) => strokeQuads(s, DIGIT_BOX.stroke));
      const b = bbox(quads.flat());
      expect(b.x0).toBeGreaterThanOrEqual(-1e-6);
      expect(b.x1).toBeLessThanOrEqual(DIGIT_BOX.width + 1e-6);
      expect(b.y0).toBeGreaterThanOrEqual(-1e-6);
      expect(b.y1).toBeLessThanOrEqual(DIGIT_BOX.height + 1e-6);
      // every digit spans the full height
      expect(b.y1 - b.y0).toBeCloseTo(DIGIT_BOX.height, 5);
    }
  });

  it('draws "1" as a narrow bar and the others full width', () => {
    const w = (d: string) => {
      const b = bbox(digitStrokes(d).flatMap((s) => strokeQuads(s, DIGIT_BOX.stroke)).flat());
      return b.x1 - b.x0;
    };
    expect(w('1')).toBeCloseTo(DIGIT_BOX.stroke, 5);
    for (const d of '0234568') expect(w(d)).toBeCloseTo(DIGIT_BOX.width, 5);
  });

  it('turns a stroke into consistently wound, non-degenerate quads of the stroke width', () => {
    const q = strokeQuads({ pts: [{ x: 0, y: 0 }, { x: 0, y: 2 }], closed: false }, 0.5);
    expect(q.length).toBe(1);
    const b = bbox(q[0]);
    expect(b.x1 - b.x0).toBeCloseTo(0.5);
    expect(b.y1 - b.y0).toBeCloseTo(2);
  });

  it('fuzz: every quad of every digit is convex, CCW and non-degenerate', () => {
    fc.assert(
      fc.property(fc.constantFrom(...'0123456789'.split('')), fc.double({ min: 0.05, max: 0.3, noNaN: true }), (d, sw) => {
        for (const s of digitStrokes(d))
          for (const q of strokeQuads(s, sw)) {
            expect(area(q)).toBeGreaterThan(1e-6);
            // convex: every turn has the same sign
            for (let i = 0; i < 4; i++) {
              const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
              const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
              expect(cr).toBeGreaterThan(-1e-9);
            }
          }
      }),
    );
  });

  it('fuzz: textQuads lays the digits out in cells centred on x = 0, reading left to right', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9]{1,3}$/), fc.double({ min: 2, max: 8, noNaN: true }), fc.double({ min: 0.5, max: 4, noNaN: true }), (text, cell, gap) => {
        const out = textQuads(text, { cellWidth: cell, height: cell * 3, gap, strokeWidth: cell * 0.25 });
        expect(out.cells.length).toBe(text.length);
        const first = out.cells[0];
        const last = out.cells[out.cells.length - 1];
        expect(first.x0 + last.x1).toBeCloseTo(0, 6);
        for (let i = 1; i < out.cells.length; i++) expect(out.cells[i].x0).toBeGreaterThan(out.cells[i - 1].x1);
        for (const q of out.quads) {
          const cellOf = out.cells[q.index];
          expect(q.digit).toBe(text[q.index]);
          for (const p of q.p) {
            expect(p.x).toBeGreaterThanOrEqual(cellOf.x0 - 1e-6);
            expect(p.x).toBeLessThanOrEqual(cellOf.x1 + 1e-6);
            expect(p.y).toBeGreaterThanOrEqual(-1e-6);
            expect(p.y).toBeLessThanOrEqual(cell * 3 + 1e-6);
          }
        }
      }),
    );
  });
});
