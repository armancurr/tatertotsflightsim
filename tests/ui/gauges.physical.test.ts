/**
 * Every gauge moves the PHYSICALLY correct way (owner bug report: "the artificial horizon turns the
 * wrong way as the plane turns"). The drawers run on a geometry-tracking context, so the tests
 * measure what ends up on the screen: the horizon line's tilt, needle tip angles, the turn
 * coordinator's wings, the heading card under the lubber line…
 *
 * Conventions (src/types.ts): roll + = right wing down, pitch + = nose up, heading clockwise.
 * A right bank tilts the real horizon counter-clockwise as seen from the cockpit (its right end
 * rises) — the attitude indicator shows exactly that, with the aircraft symbol fixed.
 *
 * Layers: unit (known readings), functional (real physics from step() through updateInstruments
 * into the drawers: level, 30° right/left turns, climb, descent, slip/skid), property (fast-check).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import type { InstrumentReadings, AircraftState, Controls } from '../../src/types';
import {
  drawAirspeed, drawAttitude, drawAltimeter, drawTurnCoordinator, drawHeading, drawVsi, drawTachometer, drawCompassTape,
  drawGear, drawFlaps, drawTrim, drawThrottle, drawPanel, clearFaceCache, turnCoordinatorBankDeg, type GaugeDrawer,
} from '../../src/ui/gauges';
import { createInstrumentModel, updateInstruments, type HudReadings } from '../../src/ui/instruments';
import { geoCtx, installOffscreenStub, longest, screenTiltDeg, aboveLine, dialAngle, tipOf, wrap180, type GeoCtx, type Pt } from './geoCtx';
import { makeReadings, arbReadings } from './fixtures';
import { trimmed, fly, bankHold, pitchHold } from '../physics/helpers';

/** The dial markings' cream white (needles, the horizon line, the TC aircraft). */
const MARK = '#f2efe6';
const C: Pt = { x: 200, y: 200 };
const SIZE = 160;

let uninstall: () => void;
beforeAll(() => {
  uninstall = installOffscreenStub();
  clearFaceCache();
});
afterAll(() => {
  uninstall();
  clearFaceCache();
});

function draw(d: GaugeDrawer, r: InstrumentReadings): GeoCtx {
  const g = geoCtx();
  d(g.ctx, C.x, C.y, SIZE, r);
  return g;
}
const markFills = (g: GeoCtx) => g.fills.filter((f) => f.style === MARK);

// ─── Measurements ────────────────────────────────────────────────────────────

/** Attitude indicator: horizon tilt (+ = CCW), how far the aircraft symbol (centre) sits above it, and the sky pointer's dial angle. */
function measureAttitude(r: InstrumentReadings, c = C, g = draw(drawAttitude, r)) {
  const horizon = longest(g.segments.filter((s) => s.style === MARK));
  const tris = markFills(g);
  const sky = tris[2];
  const skyCentroid = { x: (sky.pts[0].x + sky.pts[1].x + sky.pts[2].x) / 3, y: (sky.pts[0].y + sky.pts[1].y + sky.pts[2].y) / 3 };
  return { tilt: screenTiltDeg(horizon), symbolAbove: aboveLine(horizon, c), skyPointer: dialAngle(c, skyCentroid) };
}

/** Clockwise dial angle of the last cream needle drawn (-180..180). */
function needleAngle(d: GaugeDrawer, r: InstrumentReadings): number {
  const f = markFills(draw(d, r)).filter((x) => x.pts.length >= 5);
  return dialAngle(C, tipOf(f[f.length - 1], C));
}
/** The same, 0..360 clockwise from 12 o'clock (for dials that sweep past 6 o'clock, like the ASI). */
const sweep = (d: GaugeDrawer, r: InstrumentReadings) => (needleAngle(d, r) + 360) % 360;

function altimeterHands(r: InstrumentReadings) {
  const f = markFills(draw(drawAltimeter, r));
  const [tenK, thousand, hundred] = f;
  const tri = tenK.pts.slice(0, 3);
  const centroid = { x: (tri[0].x + tri[1].x + tri[2].x) / 3, y: (tri[0].y + tri[1].y + tri[2].y) / 3 };
  return { h10000: dialAngle(C, centroid), h1000: dialAngle(C, tipOf(thousand, C)), h100: dialAngle(C, tipOf(hundred, C)) };
}

/** Turn coordinator: tilt of the little aircraft's wings (+ = CCW, i.e. banked left) and the ball's offset (+ right). */
function measureTc(r: InstrumentReadings, c = C, g = draw(drawTurnCoordinator, r)) {
  const wings = markFills(g).find((f) => f.pts.length >= 4 && Math.hypot((f.pts[0].x + f.pts[1].x) / 2 - c.x, (f.pts[0].y + f.pts[1].y) / 2 - c.y) < SIZE * 0.1)!;
  const tilt = screenTiltDeg({ a: wings.pts[0], b: wings.pts[1], style: MARK, width: 1 });
  const balls = g.arcs.filter((a) => a.style === 'gradient' && a.r < SIZE * 0.1);
  const ball = balls.reduce((b, a) => (a.r < b.r ? a : b), balls[0]);
  return { tilt, ball: ball.c.x - c.x };
}

/** Heading indicator: the dial angle at which card bearing `deg` appears (0 = under the lubber line). */
function cardBearingAngle(r: InstrumentReadings, deg: number): number {
  const g = draw(drawHeading, r);
  const card = g.images[1];
  const R = SIZE * 0.3;
  return dialAngle(C, card.map(card.w / 2 + R * Math.sin((deg * Math.PI) / 180), card.h / 2 - R * Math.cos((deg * Math.PI) / 180)));
}

/** Compass tape: x of a label relative to the lubber mark (centre). */
function tapeLabelX(hdg: number, label: string): number | null {
  const g = geoCtx();
  drawCompassTape(g.ctx, 0, 0, 400, 50, hdg);
  const t = g.texts.find((x) => x.s === label);
  return t ? t.p.x - 200 : null;
}

// ─── Unit: known readings ────────────────────────────────────────────────────

describe('attitude indicator (drawn)', () => {
  it('level flight: horizon level through the aircraft symbol, sky pointer at the top', () => {
    const a = measureAttitude(makeReadings({ pitchDeg: 0, rollDeg: 0 }));
    expect(Math.abs(a.tilt)).toBeLessThan(0.01);
    expect(Math.abs(a.symbolAbove)).toBeLessThan(0.5);
    expect(Math.abs(a.skyPointer)).toBeLessThan(0.5);
  });

  it('30° RIGHT bank: the horizon rotates COUNTER-clockwise (its right end rises), sky pointer swings left', () => {
    const a = measureAttitude(makeReadings({ pitchDeg: 0, rollDeg: 30 }));
    expect(a.tilt).toBeCloseTo(30, 3);
    expect(a.skyPointer).toBeCloseTo(-30, 1);
  });

  it('30° LEFT bank: the horizon rotates clockwise (its left end rises)', () => {
    const a = measureAttitude(makeReadings({ pitchDeg: 0, rollDeg: -30 }));
    expect(a.tilt).toBeCloseTo(-30, 3);
    expect(a.skyPointer).toBeCloseTo(30, 1);
  });

  it('nose up puts the horizon BELOW the aircraft symbol; nose down above it', () => {
    expect(measureAttitude(makeReadings({ pitchDeg: 10, rollDeg: 0 })).symbolAbove).toBeGreaterThan(5);
    expect(measureAttitude(makeReadings({ pitchDeg: -10, rollDeg: 0 })).symbolAbove).toBeLessThan(-5);
    // In a bank the pitch offset is still measured square to the (tilted) horizon.
    expect(measureAttitude(makeReadings({ pitchDeg: 10, rollDeg: 45 })).symbolAbove).toBeGreaterThan(5);
  });

  it('inverted (roll 180°): horizon level again, sky pointer at the bottom', () => {
    const a = measureAttitude(makeReadings({ pitchDeg: 0, rollDeg: 180 }));
    expect(Math.abs(wrap180(a.tilt * 2)) / 2).toBeLessThan(0.01);
    expect(Math.abs(Math.abs(a.skyPointer) - 180)).toBeLessThan(0.5);
  });
});

describe('needles and cards (drawn)', () => {
  it('ASI turns clockwise with airspeed', () => {
    const a60 = sweep(drawAirspeed, makeReadings({ airspeedKt: 60 }));
    const a100 = sweep(drawAirspeed, makeReadings({ airspeedKt: 100 }));
    expect(a60).toBeGreaterThan(0);
    expect(a100).toBeGreaterThan(a60);
  });

  it('altimeter: all three hands turn clockwise; 1,250 ft puts the 100-ft hand at 3 o\'clock', () => {
    const h = altimeterHands(makeReadings({ altitudeFt: 1250 }));
    expect(h.h100).toBeCloseTo(90, 0);
    expect(h.h1000).toBeCloseTo(45, 0);
    expect(h.h10000).toBeCloseTo(4.5, 0);
    const h2 = altimeterHands(makeReadings({ altitudeFt: 1300 }));
    expect(h2.h100).toBeGreaterThan(h.h100);
    expect(h2.h1000).toBeGreaterThan(h.h1000);
    expect(h2.h10000).toBeGreaterThan(h.h10000);
  });

  it('VSI: 0 at 9 o\'clock, a climb swings the needle UP, a descent DOWN', () => {
    expect(needleAngle(drawVsi, makeReadings({ verticalSpeedFpm: 0 }))).toBeCloseTo(-90, 1);
    const up = needleAngle(drawVsi, makeReadings({ verticalSpeedFpm: 800 }));
    const dn = needleAngle(drawVsi, makeReadings({ verticalSpeedFpm: -800 }));
    expect(up).toBeGreaterThan(-90);
    expect(up).toBeLessThan(90);
    expect(Math.abs(dn)).toBeGreaterThan(90);
  });

  it('tachometer turns clockwise with rpm', () => {
    expect(needleAngle(drawTachometer, makeReadings({ rpm: 2500 }))).toBeGreaterThan(needleAngle(drawTachometer, makeReadings({ rpm: 1000 })));
  });

  it('turn coordinator: a right turn banks the little aircraft right (CW); the ball shows the slip/skid side', () => {
    const r = measureTc(makeReadings({ turnRateDegPerSec: 3, slipSkid: 0 }));
    expect(r.tilt).toBeCloseTo(-turnCoordinatorBankDeg(3), 3);
    expect(Math.abs(r.ball)).toBeLessThan(0.5);
    expect(measureTc(makeReadings({ turnRateDegPerSec: -3 })).tilt).toBeCloseTo(turnCoordinatorBankDeg(3), 3);
    expect(measureTc(makeReadings({ slipSkid: 0.6 })).ball).toBeGreaterThan(3);
    expect(measureTc(makeReadings({ slipSkid: -0.6 })).ball).toBeLessThan(-3);
  });

  it('heading indicator: the current heading sits under the lubber line; turning right brings higher numbers under it', () => {
    for (const hdg of [0, 30, 90, 200, 355]) expect(Math.abs(wrap180(cardBearingAngle(makeReadings({ headingDeg: hdg }), hdg)))).toBeLessThan(0.5);
    // At 030° north is 30° to the LEFT of the nose.
    expect(cardBearingAngle(makeReadings({ headingDeg: 30 }), 0)).toBeCloseTo(-30, 1);
    // Card bearing 40 is right of the lubber at 030°, and moves toward it as the heading increases.
    const a = cardBearingAngle(makeReadings({ headingDeg: 30 }), 40);
    const b = cardBearingAngle(makeReadings({ headingDeg: 35 }), 40);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeLessThan(a);
  });

  it('compass tape: north is right of the lubber at 350°, left of it at 010°; labels slide left in a right turn', () => {
    expect(tapeLabelX(350, 'N')!).toBeGreaterThan(0);
    expect(tapeLabelX(10, 'N')!).toBeLessThan(0);
    expect(tapeLabelX(35, '3')!).toBeLessThan(tapeLabelX(25, '3')!);
  });
});

describe('system cells (drawn)', () => {
  const markX = (g: GeoCtx, style: string) => {
    const f = g.fills.filter((x) => x.style === style);
    const p = f[f.length - 1].pts;
    return p.reduce((s, q) => s + q.x, 0) / p.length;
  };
  it('flap pointer moves right as the flaps come down; trim thumb right for nose-up', () => {
    const f0 = geoCtx();
    drawFlaps(f0.ctx, 0, 0, 200, 60, makeReadings({ flapsDeg: 0, flapsTargetDeg: 0 }));
    const f20 = geoCtx();
    drawFlaps(f20.ctx, 0, 0, 200, 60, makeReadings({ flapsDeg: 20, flapsTargetDeg: 20 }));
    expect(markX(f20, '#eef3fa')).toBeGreaterThan(markX(f0, '#eef3fa') + 20);
    const up = geoCtx();
    drawTrim(up.ctx, 0, 0, 200, 60, makeReadings({ trimPct: 50 }));
    const dn = geoCtx();
    drawTrim(dn.ctx, 0, 0, 200, 60, makeReadings({ trimPct: -50 }));
    expect(markX(up, '#f7d37a')).toBeGreaterThan(100);
    expect(markX(dn, '#f7d37a')).toBeLessThan(100);
  });

  it('the flap cell uses the flown aircraft\'s own notches: ticks at its gates, full flaps at the right end (F-16 20°, A-10 7° gate lit)', () => {
    const ticks = (g: GeoCtx) => g.segments.filter((sg) => Math.abs(sg.a.x - sg.b.x) < 1e-6 && (sg.style === '#8fd3ff' || sg.style === 'rgba(255,255,255,0.45)'));
    const cessnaFull = geoCtx();
    drawFlaps(cessnaFull.ctx, 0, 0, 200, 60, makeReadings({ flapsDeg: 30, flapsTargetDeg: 30 }));
    const f16Full = geoCtx();
    drawFlaps(f16Full.ctx, 0, 0, 200, 60, { ...makeReadings({ flapsDeg: 20, flapsTargetDeg: 20 }), flapNotchesDeg: [0, 10, 20] });
    expect(ticks(cessnaFull).length).toBe(4);
    expect(ticks(f16Full).length).toBe(3);
    expect(markX(f16Full, '#eef3fa')).toBeCloseTo(markX(cessnaFull, '#eef3fa'), 0);
    const a10 = geoCtx();
    drawFlaps(a10.ctx, 0, 0, 200, 60, { ...makeReadings({ flapsDeg: 7, flapsTargetDeg: 7 }), flapNotchesDeg: [0, 7, 20] });
    expect(ticks(a10).filter((t) => t.style === '#8fd3ff').length).toBe(1);
  });

  it('the instruments pass the aircraft\'s flap notches to the strip', async () => {
    const { CONFIG, F16_AIRCRAFT } = await import('../../src/config');
    const f16 = { ...CONFIG, aircraft: F16_AIRCRAFT };
    const t = trimmed({ iasKt: 300 }, f16);
    const r = updateInstruments(createInstrumentModel(), t.state, t.controls, 0.016, f16);
    expect(r.flapNotchesDeg).toEqual(F16_AIRCRAFT.flaps.notchesDeg);
  });

  it('gear cell says DOWN/UP/TRANSIT; throttle knob moves right with power', () => {
    for (const [gear, word] of [['down', 'DOWN'], ['up', 'UP'], ['transit', 'TRANSIT']] as const) {
      const g = geoCtx();
      drawGear(g.ctx, 0, 0, 200, 60, makeReadings({ gear, gearLight: gear === 'down' ? 'green' : gear === 'up' ? 'off' : 'red' }));
      expect(g.texts.map((t) => t.s)).toContain(word);
    }
    const knob = (pct: number) => {
      const g = geoCtx();
      drawThrottle(g.ctx, 0, 0, 200, 60, makeReadings({ throttlePct: pct }));
      const a = g.arcs.filter((x) => x.style === '#101214');
      return a[a.length - 1].c.x;
    };
    expect(knob(90)).toBeGreaterThan(knob(20) + 50);
  });
});

describe('3D cockpit panel (drawPanel) uses the same geometry', () => {
  it('its attitude indicator tilts the horizon counter-clockwise in a right bank, and its TC banks right', () => {
    const W = 2048;
    const H = 1024;
    for (const roll of [30, -30]) {
      const g = geoCtx();
      drawPanel(g.ctx, W, H, makeReadings({ rollDeg: roll, pitchDeg: 0, turnRateDegPerSec: roll / 10 }));
      const horizon = longest(g.segments.filter((s) => s.style === MARK));
      expect(screenTiltDeg(horizon)).toBeCloseTo(roll, 2);
      // The TC wings: the MARK polygon whose first edge is the longest near-horizontal-ish bar in the lower-left gauge.
      const s = Math.min(H * 0.41, W * 0.2);
      const tc: Pt = { x: W * 0.03 + s * 0.55, y: H * 0.075 + s * 0.55 + s * 1.1 };
      const m = measureTc(makeReadings(), tc, g);
      expect(Math.sign(m.tilt)).toBe(roll > 0 ? -1 : 1);
    }
  });
});

// ─── Functional: real physics → instruments → drawn gauges ──────────────────

interface Snap {
  s: AircraftState;
  r: HudReadings;
}

/** Fly the trimmed 172 with a pilot for `seconds`, feeding the instrument model every 1/60 s; returns snapshots each second. */
function flight(pilot: (s: AircraftState, base: Controls) => Controls, seconds: number): Snap[] {
  const t = trimmed({ iasKt: 100, gearDown: false });
  let s = t.state;
  const m = createInstrumentModel();
  const out: Snap[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    const c = pilot(s, t.controls);
    s = fly(s, c, 1 / 60);
    const r = updateInstruments(m, s, c, 1 / 60);
    if ((i + 1) % 60 === 0) out.push({ s, r });
  }
  return out;
}

describe('functional: real flight states drive every gauge the physically correct way', () => {
  const turn = (bank: number, rudder = 0) => (s: AircraftState, b: Controls) => ({ ...b, aileron: bankHold(s, bank), rudder, elevator: b.elevator + 0.08 * Math.min(1, Math.abs(bank) / 30) });

  it('level: horizon level and through the symbol, wings level, heading steady', () => {
    const snaps = flight((_s, b) => b, 6);
    const { r } = snaps[snaps.length - 1];
    const a = measureAttitude(r);
    expect(Math.abs(a.tilt)).toBeLessThan(2);
    expect(Math.abs(measureTc(r).tilt)).toBeLessThan(3);
    expect(Math.abs(wrap180(snaps[5].r.headingDeg - snaps[1].r.headingDeg))).toBeLessThan(3);
  });

  for (const dir of [1, -1] as const) {
    const name = dir > 0 ? 'RIGHT' : 'LEFT';
    it(`30° ${name} turn from step(): AI tilts ${dir > 0 ? 'CCW' : 'CW'}, TC and heading agree, compass/card turn the right way`, () => {
      const snaps = flight(turn(30 * dir), 14);
      const late = snaps.slice(6);
      for (const { s, r } of late) {
        // Physics: banked the commanded way and turning that way.
        expect(Math.sign(s.derived.rollDeg)).toBe(dir);
        const a = measureAttitude(r);
        expect(a.tilt).toBeCloseTo(r.rollDeg, 1);
        expect(Math.sign(a.tilt)).toBe(dir);
        expect(Math.sign(a.skyPointer)).toBe(-dir);
        // TC: little aircraft banked into the turn (screen tilt opposite to CCW for a right turn).
        const tc = measureTc(r);
        expect(Math.sign(r.turnRateDegPerSec)).toBe(dir);
        expect(Math.sign(tc.tilt)).toBe(-dir);
        // Coordinated-ish: the ball stays near the middle.
        expect(Math.abs(r.slipSkid)).toBeLessThan(0.35);
        // The heading under the lubber line is the reading.
        expect(Math.abs(wrap180(cardBearingAngle(r, r.headingDeg)))).toBeLessThan(0.5);
      }
      // Heading moves the way of the bank, the card rotates so that the numbers under the lubber line follow.
      const h0 = late[0].r.headingDeg;
      const h1 = late[late.length - 1].r.headingDeg;
      expect(Math.sign(wrap180(h1 - h0))).toBe(dir);
      expect(Math.abs(wrap180(h1 - h0))).toBeGreaterThan(20);
      // A card bearing that was ahead of the nose on the turn side comes toward the lubber line.
      const ahead = h0 + 15 * dir;
      const before = cardBearingAngle(late[0].r, ahead);
      const after = cardBearingAngle(late[1].r, ahead);
      expect(Math.abs(after)).toBeLessThan(Math.abs(before));
      // The compass tape slides the other way under the lubber mark.
      const lab = String(Math.round(((h0 + 360) % 360) / 10) % 36 || 'N');
      const x0 = tapeLabelX(late[0].r.headingDeg, lab);
      const x1 = tapeLabelX(late[1].r.headingDeg, lab);
      if (x0 !== null && x1 !== null) expect(Math.sign(x1 - x0)).toBe(-dir);
    });
  }

  it('skid (too much rudder into a right turn) throws the ball OUTSIDE (left); a slip drops it INSIDE (right)', () => {
    const skid = flight(turn(30, 0.6), 8);
    const slip = flight(turn(30, -0.6), 8);
    expect(skid[skid.length - 1].r.slipSkid).toBeLessThan(-0.1);
    expect(measureTc(skid[skid.length - 1].r).ball).toBeLessThan(-2);
    expect(slip[slip.length - 1].r.slipSkid).toBeGreaterThan(0.1);
    expect(measureTc(slip[slip.length - 1].r).ball).toBeGreaterThan(2);
  });

  it('climb at full power: nose-up horizon below the symbol, VSI up, altimeter hands advance clockwise, tach up', () => {
    const snaps = flight((s, b) => ({ ...b, throttle: 1, elevator: pitchHold(s, 9) }), 10);
    const a = snaps[4];
    const b = snaps[8];
    expect(b.r.verticalSpeedFpm).toBeGreaterThan(200);
    expect(measureAttitude(b.r).symbolAbove).toBeGreaterThan(3);
    const vsi = needleAngle(drawVsi, b.r);
    expect(vsi).toBeGreaterThan(-90);
    expect(vsi).toBeLessThan(90);
    expect(b.r.altitudeFt).toBeGreaterThan(a.r.altitudeFt);
    const h0 = altimeterHands(a.r);
    const h1 = altimeterHands(b.r);
    expect(wrap180(h1.h100 - h0.h100)).toBeGreaterThan(0);
    expect(wrap180(h1.h1000 - h0.h1000)).toBeGreaterThan(0);
    const cruise = flight((_s, c) => ({ ...c, throttle: 0.45 }), 4);
    expect(needleAngle(drawTachometer, b.r)).toBeGreaterThan(needleAngle(drawTachometer, cruise[3].r));
  });

  it('descent at idle: nose-down horizon above the symbol (or level), VSI down, altimeter hands go back', () => {
    const snaps = flight((s, b) => ({ ...b, throttle: 0, elevator: pitchHold(s, -6) }), 10);
    const a = snaps[4];
    const b = snaps[8];
    expect(b.r.verticalSpeedFpm).toBeLessThan(-200);
    expect(measureAttitude(b.r).symbolAbove).toBeLessThan(0);
    expect(Math.abs(needleAngle(drawVsi, b.r))).toBeGreaterThan(90);
    expect(wrap180(altimeterHands(b.r).h100 - altimeterHands(a.r).h100)).toBeLessThan(0);
  });

  it('airspeed: diving builds speed and the ASI needle follows clockwise', () => {
    const snaps = flight((s, b) => ({ ...b, throttle: 0.8, elevator: pitchHold(s, -8) }), 8);
    expect(snaps[7].r.airspeedKt).toBeGreaterThan(snaps[1].r.airspeedKt);
    expect(sweep(drawAirspeed, snaps[7].r)).toBeGreaterThan(sweep(drawAirspeed, snaps[1].r));
  });
});

// ─── Property: random readings → finite geometry, sign-consistent gauges ────

describe('property: any readings draw finite geometry with the right senses', () => {
  it('attitude tilt follows roll (CCW for right bank), VSI side follows climb/descent, TC follows turn rate', () => {
    fc.assert(
      fc.property(arbReadings, (r) => {
        for (const d of [drawAirspeed, drawAttitude, drawAltimeter, drawTurnCoordinator, drawHeading, drawVsi, drawTachometer]) {
          const g = draw(d, r);
          expect(g.numbers.every(Number.isFinite)).toBe(true);
        }
        const roll = r.rollDeg;
        if (Number.isFinite(roll) && Math.abs(wrap180(roll)) > 2 && Math.abs(wrap180(roll)) < 88) {
          expect(Math.sign(measureAttitude(r).tilt)).toBe(Math.sign(wrap180(roll)));
        }
        const vs = r.verticalSpeedFpm;
        if (Number.isFinite(vs) && Math.abs(vs) > 60) {
          const a = needleAngle(drawVsi, r);
          if (vs > 0) expect(Math.abs(a)).toBeLessThan(90);
          else expect(Math.abs(a)).toBeGreaterThan(90);
        }
        const tr = r.turnRateDegPerSec;
        if (Number.isFinite(tr) && Math.abs(tr) > 0.2) expect(Math.sign(measureTc(r).tilt)).toBe(-Math.sign(tr));
      }),
      { numRuns: 150 },
    );
  });
});
