import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { markingLines, junctionMarks, paintAt, bandCoverage, dashCoverage, laneWidth, DASH, DASH_PERIOD } from '../../../src/world/roads/markings';
import { markingsGLSL } from '../../../src/world/roads/material';
import type { NetKind } from '../../../src/world/roads/network';

const KINDS: [NetKind, number, boolean][] = [
  ['highway', 11, false],
  ['road', 7, false],
  ['access', 7, false],
  ['lane', 5, false],
  ['street', 6.5, false],
  ['street', 10, true],
  ['drive', 3.6, false],
];

describe('road markings: layout', { timeout: 120_000 }, () => {
  it('keeps every line on the pavement, with no two lines overlapping', () => {
    for (const [kind, w, art] of KINDS) {
      const lines = markingLines(kind, w, art).sort((a, b) => a.offset - b.offset);
      for (const l of lines) {
        expect(Math.abs(l.offset) + l.halfWidth).toBeLessThan(w / 2 - 0.1);
        expect(l.halfWidth).toBeGreaterThanOrEqual(0.05);
        expect(l.halfWidth).toBeLessThanOrEqual(0.1);
      }
      for (let i = 1; i < lines.length; i++) expect(lines[i].offset - lines[i].halfWidth).toBeGreaterThan(lines[i - 1].offset + lines[i - 1].halfWidth);
    }
  });

  it('is symmetric: centre lines yellow (double on highways/arterials), edge lines white', () => {
    for (const [kind, w, art] of KINDS) {
      const lines = markingLines(kind, w, art);
      const offs = lines.map((l) => l.offset).sort((a, b) => a - b);
      for (let i = 0; i < offs.length; i++) expect(offs[i]).toBeCloseTo(-offs[offs.length - 1 - i], 9);
      for (const l of lines) expect(l.color).toBe(l.role === 'centre' ? 'yellow' : 'white');
    }
    expect(markingLines('highway', 11, false).filter((l) => l.role === 'centre')).toHaveLength(2);
    expect(markingLines('street', 10, true).filter((l) => l.role === 'centre')).toHaveLength(2);
    expect(markingLines('lane', 5, false)).toHaveLength(0);
    expect(markingLines('street', 6.5, false)).toHaveLength(0);
    expect(markingLines('drive', 3.6, false)).toHaveLength(0);
  });

  it('gives highways 3.65 m lanes between the centre and the edge lines, roads a US broken centre line', () => {
    expect(laneWidth('highway', 11)).toBe(3.65);
    const hw = markingLines('highway', 11, false);
    const edge = hw.find((l) => l.role === 'edge' && l.offset > 0)!;
    const centre = hw.find((l) => l.role === 'centre' && l.offset > 0)!;
    expect(edge.offset - edge.halfWidth - (centre.offset + centre.halfWidth)).toBeGreaterThan(3.4);
    const road = markingLines('road', 7, false).find((l) => l.role === 'centre')!;
    expect(road.dash).toBe(DASH);
    expect(road.period).toBe(DASH_PERIOD);
    expect(road.dash / road.period).toBeCloseTo(0.25, 9);
  });

  it('paints crosswalk bars and a stop bar on the approach half at town junctions only', () => {
    const jm = junctionMarks(4, 2.5);
    expect(jm.cw0).toBeGreaterThan(4);
    expect(jm.cw1 - jm.cw0).toBeGreaterThanOrEqual(2.4);
    expect(jm.stop0).toBeGreaterThan(jm.cw1);
    // stop bar: right half approaching the end (side +1), left half approaching the start
    const d = (jm.stop0 + jm.stop1) / 2;
    expect(paintAt('street', 7, false, 1.5, 50, { d, h: 4, y: 2.5, side: 1 }).white).toBeCloseTo(1, 6);
    expect(paintAt('street', 7, false, -1.5, 50, { d, h: 4, y: 2.5, side: 1 }).white).toBeCloseTo(0, 6);
    expect(paintAt('street', 7, false, -1.5, 50, { d, h: 4, y: 2.5, side: -1 }).white).toBeCloseTo(1, 6);
    // rural junction (h < 0): no crosswalk, no stop bar
    expect(paintAt('road', 7, false, 1.5, 50, { d, h: -4, y: 0, side: 1 }).white).toBeCloseTo(0, 6);
    // crosswalk: about half of the band is paint (continental bars)
    let paint = 0;
    let n = 0;
    for (let a = -3.2; a <= 3.2; a += 0.01) {
      paint += paintAt('street', 7, false, a, 50, { d: (jm.cw0 + jm.cw1) / 2, h: 4, y: 2.5, side: 1 }).white;
      n++;
    }
    expect(paint / n).toBeGreaterThan(0.35);
    expect(paint / n).toBeLessThan(0.6);
  });

  it('breaks edge lines at every junction and stops centre lines before town crosswalks', () => {
    const w = 7;
    const edge = markingLines('road', w, false).find((l) => l.role === 'edge' && l.offset > 0)!;
    expect(paintAt('road', w, false, edge.offset, 3, null).white).toBeCloseTo(1, 6);
    expect(paintAt('road', w, false, edge.offset, 3, { d: 2, h: -5, y: 0, side: 1 }).white).toBeCloseTo(0, 6);
    expect(paintAt('road', w, false, 0, 1, { d: 3, h: 5, y: 2, side: 1 }).yellow).toBeCloseTo(0, 6);
    expect(paintAt('road', w, false, 0, 1, { d: 60, h: 5, y: 2, side: 1 }).yellow).toBeCloseTo(1, 6);
  });

  it('generates the shader from the same table (every line offset appears in the GLSL)', () => {
    const glsl = markingsGLSL();
    for (const l of markingLines('highway', 11, false)) expect(glsl).toContain((l.offset - l.halfWidth).toFixed(4));
    for (const l of markingLines('street', 10, true)) expect(glsl).toContain((l.offset + l.halfWidth).toFixed(4));
    expect(glsl).toContain(`dashCov( al, ${DASH.toFixed(4)}, ${DASH_PERIOD.toFixed(4)}, fwL )`);
  });
});

describe('road markings: filtering (alias-free at any distance)', { timeout: 120_000 }, () => {
  it('fuzz: band and dash coverage stay in [0, 1]', () => {
    fc.assert(
      fc.property(fc.double({ min: -50, max: 50, noNaN: true }), fc.double({ min: 1e-4, max: 100, noNaN: true }), (x, fw) => {
        const b = bandCoverage(x, -0.1, 0.1, fw);
        const d = dashCoverage(x + 1000, 3, 12, fw);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThanOrEqual(1 + 1e-9);
        expect(d).toBeGreaterThanOrEqual(-1e-9);
        expect(d).toBeLessThanOrEqual(1 + 1e-9);
      }),
      { numRuns: 500 },
    );
  });

  it('fuzz: a wide footprint averages to the duty cycle / line fraction (no moiré)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 5000, noNaN: true }), fc.double({ min: 48, max: 480, noNaN: true }), (t, fw) => {
        expect(dashCoverage(t, 3, 12, fw)).toBeCloseTo(0.25, 1);
        expect(bandCoverage(0, -0.075, 0.075, fw)).toBeCloseTo(0.15 / fw, 6);
      }),
      { numRuns: 300 },
    );
  });

  it('is crisp when the footprint is small', () => {
    expect(dashCoverage(1, 3, 12, 0.01)).toBeCloseTo(1, 6);
    expect(dashCoverage(5, 3, 12, 0.01)).toBeCloseTo(0, 6);
    expect(bandCoverage(0, -0.075, 0.075, 0.01)).toBeCloseTo(1, 6);
    expect(bandCoverage(0.2, -0.075, 0.075, 0.01)).toBeCloseTo(0, 6);
  });
});
