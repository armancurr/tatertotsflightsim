/**
 * Tater the mascot: a self-contained SVG (nothing fetched, unique gradient ids so several copies
 * can share a page) and the same figure on a canvas (finite geometry, garbage-proof).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mascotSvg, drawMascot, MASCOT_COLORS } from '../../src/ui/mascot';
import { geoCtx } from './geoCtx';

describe('mascot SVG', () => {
  it('is a self-contained SVG: no external references, only local url(#…) paints', () => {
    const svg = mascotSvg();
    expect(svg).toMatch(/^<svg[\s\S]*<\/svg>$/);
    expect(svg).not.toMatch(/href=|url\((?!#)|@import|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(svg).toContain('role="img"');
  });

  it('wears the brand colours: potato, red cape, goggle lenses', () => {
    const svg = mascotSvg();
    for (const c of [MASCOT_COLORS.potato, MASCOT_COLORS.cape, MASCOT_COLORS.lensDark, MASCOT_COLORS.strap]) expect(svg).toContain(c);
  });

  it('every copy gets its own gradient ids', () => {
    const ids = (s: string) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const a = ids(mascotSvg());
    const b = ids(mascotSvg());
    expect(a.length).toBeGreaterThan(0);
    for (const id of a) expect(b).not.toContain(id);
  });

  it('escapes nothing it should not: the title is used as the accessible label', () => {
    expect(mascotSvg({ title: 'Logo' })).toContain('aria-label="Logo"');
  });
});

describe('mascot on canvas', () => {
  it('draws the cape, the potato, two goggle lenses and the smile inside its box', () => {
    const g = geoCtx();
    drawMascot(g.ctx, 100, 100, 64);
    expect(g.arcs.length).toBeGreaterThanOrEqual(2);
    expect(g.numbers.every(Number.isFinite)).toBe(true);
    for (const a of g.arcs) {
      expect(Math.abs(a.c.x - 100)).toBeLessThan(40);
      expect(Math.abs(a.c.y - 100)).toBeLessThan(40);
    }
  });

  it('property: any position/size draws finite geometry or nothing', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), fc.double(), (x, y, s) => {
        const g = geoCtx();
        drawMascot(g.ctx, x, y, s);
        expect(g.numbers.every(Number.isFinite)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
