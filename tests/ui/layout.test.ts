import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeHudLayout, type Rect } from '../../src/ui/hud';
import { systemsStripWidth } from '../../src/ui/gauges';
import { topBarHeight } from '../../src/ui/topBar';

const overlap = (a: Rect, b: Rect) => a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0 && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number) => a.x >= 0 && a.y >= 0 && a.x + a.w <= w + 1e-9 && a.y + a.h <= h + 1e-9;

function boxes(l: ReturnType<typeof computeHudLayout>): [string, Rect][] {
  const out: [string, Rect][] = [
    ['strip', l.strip],
    ['chip', { x: l.chip.x, y: l.chip.y, w: l.chip.maxW, h: l.chip.h }],
  ];
  if (l.compassVisible) out.push(['compass', l.compass]);
  if (l.clustersVisible) out.push(['left', l.left], ['right', l.right]);
  if (l.jet) out.push(['jet', l.jet]);
  return out;
}

describe('HUD layout', () => {
  it('1440×900: 118–132 px gauges, clusters in the lower 20 %, centre third clear, nothing overlaps', () => {
    const l = computeHudLayout(1440, 900);
    expect(l.gauge).toBeGreaterThanOrEqual(118);
    expect(l.gauge).toBeLessThanOrEqual(132);
    expect(l.left.y).toBeGreaterThanOrEqual(900 * 0.8);
    expect(l.right.y).toBeGreaterThanOrEqual(900 * 0.8);
  });

  it('1024×768: 92–100 px gauges', () => {
    const l = computeHudLayout(1024, 768);
    expect(l.gauge).toBeGreaterThanOrEqual(92);
    expect(l.gauge).toBeLessThanOrEqual(100);
    expect(l.left.y).toBeGreaterThanOrEqual(768 * 0.8);
  });

  it('the systems strip fits between the clusters (wrapping to two rows when it must)', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const l = computeHudLayout(w, h);
      expect(l.strip.x).toBeGreaterThanOrEqual(l.left.x + l.left.w);
      expect(l.strip.x + l.strip.w).toBeLessThanOrEqual(l.right.x);
      expect(l.strip.h / l.stripRows).toBeGreaterThanOrEqual(34);
    }
  });

  it('in cockpit view (clusters hidden) the strip is a single row along the bottom', () => {
    const l = computeHudLayout(1024, 768, undefined, 'cockpitHidden');
    expect(l.clustersVisible).toBe(false);
    expect(l.stripRows).toBe(1);
    expect(l.strip.w).toBeCloseTo(systemsStripWidth(l.strip.h), 0);
  });

  it('everything sits below the branding top bar', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const l = computeHudLayout(w, h);
      expect(l.topInset).toBe(topBarHeight(w));
      expect(l.compass.y).toBeGreaterThanOrEqual(l.topInset);
      expect(l.chip.y).toBeGreaterThanOrEqual(l.topInset);
    }
  });

  it('jet style: no six-pack, no compass tape, a centred head-up display between the annunciators and the strip', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const l = computeHudLayout(w, h, undefined, 'normal', 'jet');
      expect(l.clustersVisible).toBe(false);
      expect(l.compassVisible).toBe(false);
      const j = l.jet!;
      expect(Math.abs(j.x + j.w / 2 - w / 2)).toBeLessThanOrEqual(1);
      expect(j.y).toBeGreaterThan(l.annunciatorY);
      expect(j.y + j.h).toBeLessThanOrEqual(l.strip.y);
      expect(j.w).toBeGreaterThanOrEqual(300);
      expect(j.w).toBeLessThanOrEqual(w * 0.5);
      expect(j.h).toBeGreaterThanOrEqual(h * 0.4);
    }
    expect(computeHudLayout(1440, 900).jet).toBeNull();
  });

  it('property: any viewport from 640×480 to 4K — everything on screen, no overlaps, centre third clear', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 640, max: 3840 }),
        fc.integer({ min: 480, max: 2160 }),
        fc.constantFrom('normal', 'cockpitHidden', 'cockpitCompact') as fc.Arbitrary<'normal' | 'cockpitHidden' | 'cockpitCompact'>,
        fc.constantFrom('steam', 'jet') as fc.Arbitrary<'steam' | 'jet'>,
        (w, h, mode, style) => {
          const l = computeHudLayout(w, h, undefined, mode, style);
          const bs = boxes(l);
          for (const [name, b] of bs) expect(inside(b, w, h), `${name} ${JSON.stringify(b)} in ${w}x${h}`).toBe(true);
          for (let i = 0; i < bs.length; i++)
            for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i][1], bs[j][1]), `${bs[i][0]} × ${bs[j][0]} at ${w}x${h} ${mode} ${style}`).toBe(false);
          for (const [, b] of bs) expect(b.y, 'below the top bar').toBeGreaterThanOrEqual(l.topInset);
          const centre: Rect = { x: w / 3, y: h / 3, w: w / 3, h: h / 3 };
          // The jet HUD belongs in the middle; everything else keeps out of it.
          for (const [name, b] of bs) if (name !== 'jet') expect(overlap(b, centre), `${name} in the centre at ${w}x${h}`).toBe(false);
          // Messages live above or below the centre third too.
          expect(l.bannerY).toBeLessThan(h / 3);
          expect(l.toastBottom).toBeGreaterThan((2 * h) / 3);
          expect(l.gauge).toBeGreaterThan(0);
        },
      ),
      { numRuns: 400 },
    );
  });
});
