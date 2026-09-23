/**
 * Jet HUD, A-10 variant: with the GAU-8's gun line 2° below the datum the weapons HUD draws the
 * real (conformal) gun cross, so the jet HUD drops its fixed boresight cross; the F-16 keeps it.
 * The heading-tape geometry is shared with the weapons HUD's range caret.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getAircraftDef } from '../../src/fleet';
import { CONFIG } from '../../src/config';
import { createJetHudState, drawJetHud, jetHeadingTape, jetHudGeometry, jetHudOmitsGunCross } from '../../src/ui/jetHud';
import { geoCtx } from './geoCtx';
import { makeReadings } from './fixtures';

const W = 520;
const H = 540;
const r = () => ({ ...makeReadings({ airspeedKt: 300, altitudeFt: 3000, gear: 'up', gearLight: 'off' }), betaDeg: 0, flightPathDeg: 0, speedBrake: false });

/** Segments with both ends within `d` px of the boresight. */
function nearBore(cfg: typeof CONFIG): number {
  const g = geoCtx();
  drawJetHud(g.ctx, W, H, r(), createJetHudState(), cfg);
  const b = jetHudGeometry(r(), W, H, cfg).bore;
  return g.segments.filter((s) => Math.hypot(s.a.x - b.x, s.a.y - b.y) < H * 0.03 && Math.hypot(s.b.x - b.x, s.b.y - b.y) < H * 0.03 && Math.abs(s.a.y - s.b.y) > 1).length;
}

describe('jet HUD: A-10 variant', () => {
  it('the F-16 keeps its fixed gun cross; the A-10 (gun line 2° down) leaves it to the weapons HUD', () => {
    const f16 = getAircraftDef('f16').config;
    const a10 = getAircraftDef('a10').config;
    expect(jetHudOmitsGunCross(f16)).toBe(false);
    expect(jetHudOmitsGunCross(a10)).toBe(true);
    expect(jetHudOmitsGunCross(CONFIG)).toBe(false);
    expect(nearBore(f16)).toBeGreaterThan(0);
    expect(nearBore(a10)).toBe(0);
  });

  it('heading tape: bottom with the gear up (ticks rise), top with it down; ±20° across 46 % of the width', () => {
    const up = jetHeadingTape(W, H, true);
    expect(up.y).toBeCloseTo(H * 0.88, 9);
    expect(up.dir).toBe(-1);
    expect(up.halfWidth).toBeCloseTo(W * 0.23, 9);
    expect(up.ppd * 40).toBeCloseTo(W * 0.46, 9);
    const dn = jetHeadingTape(W, H, false);
    expect(dn.y).toBeCloseTo(H * 0.12, 9);
    expect(dn.dir).toBe(1);
    fc.assert(fc.property(fc.double(), fc.double(), fc.boolean(), (w, h, g) => {
      const t = jetHeadingTape(w, h, g);
      expect(Number.isFinite(t.y) && Number.isFinite(t.ppd) && Number.isFinite(t.halfWidth)).toBe(true);
    }));
  });
});
