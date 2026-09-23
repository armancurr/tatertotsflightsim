/**
 * 747-400 flight deck displays: the readings (engine map, fuel, V-speeds, placards; fuzz: finite and
 * in range) and the painters on a recording canvas (PFD, ND, upper/lower EICAS, standby): what they
 * show is physically right (horizon tilts with the bank, route ahead is up, the four N1 readouts),
 * and nothing ever draws a NaN, whatever the readings.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDeckReadings, updateDeckReadings, coreFromN2, maxSpeedFor, ENGINE_MAP, type DeckReadings } from '../../../src/aircraft/b747/flightDeckReadings';
import { drawPfd, drawNd, drawEicasUpper, drawEicasLower, drawStandby, ndProject, activeFix, ND_ROUTE, vsiScale, DC } from '../../../src/aircraft/b747/flightDeckDisplays';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { B747_AIRCRAFT, CONFIG } from '../../../src/config';
import { geoCtx, longest, screenTiltDeg } from '../../ui/geoCtx';

const S = 384;
function vs(r: Record<string, unknown> = {}, patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), cameraMode: 'cockpit', engineRunning: true, instruments: { ...createRestReadings(), engineStatus: 'RUNNING', rpm: 60, ...r } as never, ...patch };
}
const read = (r: Record<string, unknown> = {}, patch: Partial<AircraftVisualState> = {}, pos = { x: 0, z: 0 }) => updateDeckReadings(createDeckReadings(), vs(r, patch), pos, 0);

function allFinite(o: DeckReadings): boolean {
  const nums: number[] = [o.ias, o.mach, o.altFt, o.aglFt, o.vsFpm, o.pitch, o.roll, o.hdg, o.track, o.gsKt, o.tasKt, o.fpa, o.slip, o.n1Ref, o.flapsDeg, o.flapsTargetDeg, o.fuelT, o.tat, o.v1, o.vr, o.v2, o.vref, o.selSpd, o.selAlt, o.selHdg, o.vmax, o.vstall, o.vminMan, o.x, o.z, o.time];
  for (const e of o.engines) nums.push(e.n1, e.egt, e.n2, e.ff, e.oilP, e.oilT, e.oilQ, e.vib);
  return nums.every(Number.isFinite);
}

describe('747 deck readings (unit)', () => {
  it('engine map: idle N1 ≈ 22 %, takeoff ≈ 101 %, EGT below the redline, monotonic with the core speed', () => {
    const idle = read({ rpm: 60 });
    const full = read({ rpm: 100 });
    for (const e of idle.engines) {
      expect(e.n1).toBeGreaterThan(20);
      expect(e.n1).toBeLessThan(25);
      expect(e.ff).toBeLessThan(1);
    }
    for (const e of full.engines) {
      expect(e.n1).toBeGreaterThan(97);
      expect(e.n1).toBeLessThan(ENGINE_MAP.n1Red);
      expect(e.egt).toBeLessThan(ENGINE_MAP.egtRed);
      expect(e.ff).toBeGreaterThan(8);
    }
    let prev = -1;
    for (let n2 = 60; n2 <= 100; n2 += 2) {
      const n1 = read({ rpm: n2 }).engines[2].n1;
      expect(n1).toBeGreaterThan(prev);
      prev = n1;
    }
    // Four engines, four slightly different readouts.
    expect(new Set(full.engines.map((e) => e.n1.toFixed(1))).size).toBeGreaterThan(1);
    expect(coreFromN2(60)).toBe(0);
    expect(coreFromN2(100)).toBe(1);
  });

  it('engines off: N1 and fuel flow at zero, the shutdown caution is up', () => {
    const r = read({ engineStatus: 'OFF', rpm: 0 }, { engineRunning: false });
    for (const e of r.engines) {
      expect(e.n1).toBeLessThan(1);
      expect(e.ff).toBe(0);
    }
    expect(r.alerts.slice(0, r.alertCount).some((a) => a.text.includes('SHUTDOWN'))).toBe(true);
  });

  it('the fuel totaliser counts down with the fuel flow', () => {
    const o = createDeckReadings();
    const v = vs({ rpm: 100 });
    const f0 = o.fuelT;
    for (let i = 0; i < 600; i++) updateDeckReadings(o, v, null, 0.1);
    // 60 s at ~4 × 9 t/h ≈ 0.6 t.
    expect(f0 - o.fuelT).toBeGreaterThan(0.4);
    expect(f0 - o.fuelT).toBeLessThan(0.8);
  });

  it('V-speeds and the barber pole come from the config and the 747 placards', () => {
    const r = read();
    expect(r.vr).toBe(B747_AIRCRAFT.limits.vrKt);
    expect(r.v1).toBeLessThan(r.vr);
    expect(r.v2).toBeGreaterThan(r.vr);
    expect(r.vref).toBe(Math.round(CONFIG.hud.glass.vrefFactor * B747_AIRCRAFT.limits.vsoKt));
    expect(maxSpeedFor(0, false)).toBe(B747_AIRCRAFT.limits.vneKt);
    expect(maxSpeedFor(0, true)).toBe(B747_AIRCRAFT.gear.vleKt);
    expect(maxSpeedFor(30, true)).toBe(180);
    expect(maxSpeedFor(20, false)).toBe(230);
  });
});

describe('747 deck readings (fuzz)', () => {
  const n = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, 1e300, -1e300));
  it('whatever the instruments hold, every reading is finite and inside its display range', () => {
    fc.assert(
      fc.property(n, n, n, n, n, n, n, n, n, n, fc.constantFrom('RUNNING', 'OFF', 'STARTING', 'FAILED', undefined), (ias, alt, vs2, pitch, roll, hdg, rpm, flaps, gear, dt, st) => {
        const o = createDeckReadings();
        updateDeckReadings(o, vs({ airspeedKt: ias, altitudeFt: alt, verticalSpeedFpm: vs2, pitchDeg: pitch, rollDeg: roll, headingDeg: hdg, rpm, flapsDeg: flaps, flapsTargetDeg: flaps, engineStatus: st }, { gearPos: gear, time: dt }), { x: ias, z: alt }, dt);
        expect(allFinite(o)).toBe(true);
        expect(o.hdg >= 0 && o.hdg < 360).toBe(true);
        expect(o.ias >= 0 && o.ias <= 999).toBe(true);
        for (const e of o.engines) expect(e.n1 >= 0 && e.n1 <= 115).toBe(true);
        expect(o.alertCount >= 0 && o.alertCount <= o.alerts.length).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe('747 deck painters (recording canvas)', () => {
  it('PFD: the horizon tilts with the bank; speed, altitude and heading read out', () => {
    const g = geoCtx();
    const r = read({ airspeedKt: 187.4, altitudeFt: 3456, headingDeg: 92, rollDeg: 20, pitchDeg: 4, onGround: false, altitudeAglFt: 3400 });
    drawPfd(g.ctx, S, r);
    expect(g.numbers.every(Number.isFinite)).toBe(true);
    const whites = g.segments.filter((s) => s.style === DC.white);
    const horizon = longest(whites);
    // Right wing down → the horizon's right end rises on screen (a +20° bank shows as −20° tilt… i.e. counter-clockwise).
    expect(Math.abs(Math.abs(screenTiltDeg(horizon)) - 20)).toBeLessThan(1.5);
    const texts = g.texts.map((t) => t.s);
    expect(texts).toContain('187');
    expect(texts).toContain('3');
    expect(texts).toContain('092');
    for (const t of g.texts) {
      expect(t.p.x).toBeGreaterThanOrEqual(-1);
      expect(t.p.x).toBeLessThanOrEqual(S + 1);
      expect(t.p.y).toBeGreaterThanOrEqual(-1);
      expect(t.p.y).toBeLessThanOrEqual(S + 1);
    }
  });

  it('PFD on the runway: V1 and VR bugs on the speed tape, TO/GA modes', () => {
    const g = geoCtx();
    drawPfd(g.ctx, S, read({ airspeedKt: 140, onGround: true }));
    const texts = g.texts.map((t) => t.s);
    expect(texts).toContain('V1');
    expect(texts).toContain('VR');
    expect(texts).toContain('TO/GA');
  });

  it('VSI scale: monotonic, ±1000 → 0.4, saturates at ±6000', () => {
    expect(vsiScale(0)).toBe(0);
    expect(vsiScale(1000)).toBeCloseTo(0.4);
    expect(vsiScale(-6000)).toBeCloseTo(-1);
    expect(vsiScale(20000)).toBeCloseTo(1);
    for (let v = -6000; v < 6000; v += 250) expect(vsiScale(v + 250)).toBeGreaterThan(vsiScale(v));
  });

  it('ND: a fix straight ahead plots above the aircraft; right is right; the active waypoint is in the route', () => {
    const p = ndProject(0, -5000, 0, 0, 0, 100, 300, 0.01);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(250);
    const east = ndProject(5000, 0, 0, 0, 0, 100, 300, 0.01);
    expect(east.x).toBeCloseTo(150);
    // Heading east: a fix to the east is straight ahead.
    const ahead = ndProject(5000, 0, 0, 0, 90, 100, 300, 0.01);
    expect(ahead.x).toBeCloseTo(100);
    expect(ahead.y).toBeCloseTo(250);
    for (const [x, z] of [[0, 0], [1e5, -1e5], [NaN, 3]]) {
      const i = activeFix(x, z);
      expect(i >= 0 && i < ND_ROUTE.length).toBe(true);
    }
    const g = geoCtx();
    drawNd(g.ctx, S, read({ headingDeg: 358, groundSpeedKt: 140 }, {}, { x: 0, z: 600 }));
    expect(g.numbers.every(Number.isFinite)).toBe(true);
    const texts = g.texts.map((t) => t.s);
    expect(texts).toContain('358');
    expect(texts.some((t) => t.startsWith('GS 140'))).toBe(true);
    expect(g.segments.some((s) => s.style === DC.magenta)).toBe(true);
  });

  it('upper EICAS: four N1 and EGT readouts, gear DOWN, flaps with the lever setting', () => {
    const g = geoCtx();
    const r = read({ rpm: 90, flapsDeg: 10, flapsTargetDeg: 20 });
    drawEicasUpper(g.ctx, S, r);
    const texts = g.texts.map((t) => t.s);
    for (const e of r.engines) expect(texts).toContain(e.n1.toFixed(1));
    for (const e of r.engines) expect(texts).toContain(String(Math.round(e.egt)));
    expect(texts).toContain('DOWN');
    expect(texts).toContain('20');
    expect(texts).toContain('FLAPS');
  });

  it('lower EICAS and standby draw with finite numbers', () => {
    const g = geoCtx();
    const r = read({ rpm: 80 });
    drawEicasLower(g.ctx, S, r);
    drawStandby(g.ctx, 128, r);
    expect(g.numbers.every(Number.isFinite)).toBe(true);
    const texts = g.texts.map((t) => t.s);
    for (const e of r.engines) expect(texts).toContain(e.n2.toFixed(1));
  });

  it('fuzz: every painter, any readings → only finite numbers reach the canvas', () => {
    const n = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, 1e300));
    fc.assert(
      fc.property(n, n, n, n, n, n, n, n, fc.boolean(), (ias, alt, pitch, roll, hdg, vsp, x, z, ground) => {
        const r = read({ airspeedKt: ias, altitudeFt: alt, pitchDeg: pitch, rollDeg: roll, headingDeg: hdg, verticalSpeedFpm: vsp, onGround: ground, altitudeAglFt: alt }, {}, { x, z });
        const g = geoCtx();
        drawPfd(g.ctx, S, r);
        drawNd(g.ctx, S, r);
        drawEicasUpper(g.ctx, S, r);
        drawEicasLower(g.ctx, S, r);
        drawStandby(g.ctx, 96, r);
        expect(g.numbers.every(Number.isFinite)).toBe(true);
      }),
      { numRuns: 120 },
    );
  }, 30000);
});
