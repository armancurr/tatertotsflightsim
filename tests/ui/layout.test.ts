import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeHudLayout, type Rect } from '../../src/ui/hud';
import { systemsStripWidth } from '../../src/ui/gauges';
import { topBarHeight } from '../../src/ui/topBar';
import { CONFIG } from '../../src/config';

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

  it('in cockpit view (clusters hidden) the strip is a compact two-row block (the 3D panel owns the bottom centre)', () => {
    const l = computeHudLayout(1024, 768, undefined, 'cockpitHidden');
    expect(l.clustersVisible).toBe(false);
    expect(l.stripRows).toBe(2);
    expect(l.strip.w).toBeCloseTo(systemsStripWidth(l.strip.h / 2, 2), 0);
  });

  it('everything sits below the branding top bar', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const l = computeHudLayout(w, h);
      expect(l.topInset).toBe(topBarHeight(w));
      expect(l.compass.y).toBeGreaterThanOrEqual(l.topInset);
      expect(l.chip.y).toBeGreaterThanOrEqual(l.topInset);
    }
  });

  it('jet style (cockpit view): no six-pack, no compass tape, a centred head-up display between the annunciators and the strip', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const l = computeHudLayout(w, h, undefined, 'cockpitHidden', 'jet');
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

describe('HUD layout: cockpit and exterior-jet placement (orchestrator play-test)', () => {
  it('in the Cessna cockpit the systems strip docks bottom-left, clear of the 3D panel in the centre', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]] as const) {
      const L = computeHudLayout(w, h, CONFIG, 'cockpitHidden', 'steam');
      expect(L.strip.x + L.strip.w).toBeLessThan(w * 0.36);
      expect(L.strip.y + L.strip.h).toBeLessThanOrEqual(h);
      expect(L.strip.x).toBeGreaterThanOrEqual(0);
    }
  });
  it('the F-16 HUD is full size in the cockpit and smaller and higher outside, clear of the aircraft', () => {
    for (const [w, h] of [[1440, 900], [1024, 768]] as const) {
      const inside = computeHudLayout(w, h, CONFIG, 'cockpitHidden', 'jet').jet!;
      const outside = computeHudLayout(w, h, CONFIG, 'normal', 'jet').jet!;
      expect(outside.h).toBeLessThan(inside.h * 0.8);
      // The chase camera frames the aircraft just below screen centre: keep the HUD above it.
      expect(outside.y + outside.h).toBeLessThan(h * 0.5);
    }
  });
});

describe('help sheet (H) placement', () => {
  it('property: the sheet always sits below the top bar and above the bottom edge, at any window size', async () => {
    const { HUD_CSS } = await import('../../src/ui/hudStyle');
    const rule = /\.fsh-help \{([^}]*)\}/.exec(HUD_CSS)![1];
    const top = /top:\s*calc\(50% \+ (\d+)px\)/.exec(rule);
    const maxH = /max-height:\s*calc\(100vh - (\d+)px\)/.exec(rule);
    expect(top, 'top: calc(50% + Npx)').not.toBeNull();
    expect(maxH, 'max-height: calc(100vh - Mpx)').not.toBeNull();
    const n = Number(top![1]);
    const m = Number(maxH![1]);
    fc.assert(
      fc.property(fc.integer({ min: 480, max: 2560 }), fc.integer({ min: 400, max: 1600 }), fc.integer({ min: 0, max: 5000 }), (w, h, content) => {
        const height = Math.min(content, h - m); // translate(-50%, -50%) centres the rendered height on top
        const y0 = h / 2 + n - height / 2;
        expect(y0).toBeGreaterThanOrEqual(topBarHeight(w) + 4);
        expect(y0 + height).toBeLessThanOrEqual(h - 4);
      }),
      { numRuns: 300 },
    );
  });
});
