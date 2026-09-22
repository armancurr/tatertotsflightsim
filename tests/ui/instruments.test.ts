import { describe, it, expect } from 'vitest';
import { CONFIG, cloneConfig, M_TO_FT, MS_TO_KT } from '../../src/config';
import { createInstrumentModel, updateInstruments, gearStateFromPos, engineStatusOf, rawSlipBall, rawTurnRate } from '../../src/ui/instruments';
import { stallAlphaRad, simStateLabel, createInitialState, step, createTrimmedState } from '../../src/physics';
import { makeState, makeControls } from './fixtures';

const DT = 1 / 60;
const RAD = 180 / Math.PI;

/** Feed the same state for `seconds` at 60 Hz, return the last reading. */
function hold(m: ReturnType<typeof createInstrumentModel>, s: ReturnType<typeof makeState>, seconds: number, c = makeControls()) {
  let r = updateInstruments(m, s, c, DT);
  const n = Math.round(seconds / DT) - 1;
  for (let i = 0; i < n; i++) r = updateInstruments(m, { ...s, time: s.time + (i + 1) * DT }, c, DT);
  return r;
}

describe('instrument model: basic readings', () => {
  it('first update shows the true values immediately (no lag from zero at start-up)', () => {
    const m = createInstrumentModel();
    const r = updateInstruments(m, makeState({ iasKt: 92, altFt: 4500, headingDeg: 123, vsFpm: 500 }), makeControls(), DT);
    expect(r.airspeedKt).toBeCloseTo(92, 1);
    expect(r.altitudeFt).toBeCloseTo(4500, 0);
    expect(r.headingDeg).toBeCloseTo(123, 1);
    expect(r.verticalSpeedFpm).toBeCloseTo(500, 0);
  });

  it('reports IAS in knots, altitude in feet MSL, AGL in feet and ground speed in knots', () => {
    const s = makeState({ iasKt: 75, altFt: 1200, aglFt: 1100, groundSpeedKt: 80 });
    const r = updateInstruments(createInstrumentModel(), s, makeControls(), DT);
    expect(r.airspeedKt).toBeCloseTo(s.derived.ias * MS_TO_KT, 3);
    expect(r.altitudeFt).toBeCloseTo(s.position.y * M_TO_FT, 3);
    expect(r.altitudeAglFt).toBeCloseTo(1100, 1);
    expect(r.groundSpeedKt).toBeCloseTo(80, 1);
  });

  it('attitude comes straight from the gyro: pitch and roll never lag', () => {
    const m = createInstrumentModel();
    updateInstruments(m, makeState({ pitchDeg: 0, rollDeg: 0 }), makeControls(), DT);
    const r = updateInstruments(m, makeState({ pitchDeg: 12, rollDeg: -35, time: 10 + DT }), makeControls(), DT);
    expect(r.pitchDeg).toBe(12);
    expect(r.rollDeg).toBeCloseTo(-35, 10);
  });

  it('airspeed and altimeter needles are smoothed (needleTau) but converge quickly', () => {
    const m = createInstrumentModel();
    updateInstruments(m, makeState({ iasKt: 60, altFt: 1000 }), makeControls(), DT);
    const r1 = updateInstruments(m, makeState({ iasKt: 120, altFt: 2000, time: 10 + DT }), makeControls(), DT);
    expect(r1.airspeedKt).toBeGreaterThan(60);
    expect(r1.airspeedKt).toBeLessThan(120);
    const k = 1 - Math.exp(-DT / CONFIG.hud.needleTau);
    expect(r1.airspeedKt).toBeCloseTo(60 + 60 * k, 3);
    const r2 = hold(m, makeState({ iasKt: 120, altFt: 2000, time: 11 }), 1);
    expect(r2.airspeedKt).toBeCloseTo(120, 1);
    expect(r2.altitudeFt).toBeCloseTo(2000, 0);
  });

  it('heading wraps the short way round and stays in [0, 360)', () => {
    const m = createInstrumentModel();
    updateInstruments(m, makeState({ headingDeg: 359 }), makeControls(), DT);
    const r = updateInstruments(m, makeState({ headingDeg: 1, time: 10 + DT }), makeControls(), DT);
    expect(r.headingDeg >= 359 || r.headingDeg < 1).toBe(true);
    expect(r.headingDeg).toBeGreaterThanOrEqual(0);
    expect(r.headingDeg).toBeLessThan(360);
    const later = hold(m, makeState({ headingDeg: 1, time: 11 }), 1);
    expect(later.headingDeg).toBeCloseTo(1, 1);
    const wrapped = updateInstruments(createInstrumentModel(), makeState({ headingDeg: 360 }), makeControls(), DT);
    expect(wrapped.headingDeg).toBe(0);
  });

  it('VSI lags like a real instrument: first-order with hud.vsiLagTau', () => {
    const m = createInstrumentModel();
    updateInstruments(m, makeState({ vsFpm: 0 }), makeControls(), DT);
    const tau = CONFIG.hud.vsiLagTau;
    const r = hold(m, makeState({ vsFpm: 1000, time: 10 + DT }), tau);
    expect(r.verticalSpeedFpm).toBeGreaterThan(1000 * (1 - Math.exp(-1)) - 25);
    expect(r.verticalSpeedFpm).toBeLessThan(1000 * (1 - Math.exp(-1)) + 25);
    const later = hold(m, makeState({ vsFpm: 1000, time: 20 }), 8 * tau);
    expect(later.verticalSpeedFpm).toBeCloseTo(1000, 0);
  });

  it('a custom config changes the VSI lag', () => {
    const cfg = cloneConfig();
    cfg.hud.vsiLagTau = 0.05;
    const m = createInstrumentModel(cfg);
    updateInstruments(m, makeState({ vsFpm: 0 }), makeControls(), DT, cfg);
    let r = updateInstruments(m, makeState({ vsFpm: 1000, time: 10 + DT }), makeControls(), DT, cfg);
    for (let i = 0; i < 20; i++) r = updateInstruments(m, makeState({ vsFpm: 1000, time: 10 + (i + 2) * DT }), makeControls(), DT, cfg);
    expect(r.verticalSpeedFpm).toBeGreaterThan(990);
  });

  it('snaps to the new values after a reset (sim time went backwards)', () => {
    const m = createInstrumentModel();
    hold(m, makeState({ iasKt: 110, vsFpm: 1500, altFt: 6000, time: 100 }), 2);
    const r = updateInstruments(m, makeState({ iasKt: 0, vsFpm: 0, altFt: 100, time: 0 }), makeControls(), DT);
    expect(r.airspeedKt).toBeCloseTo(0, 5);
    expect(r.verticalSpeedFpm).toBeCloseTo(0, 5);
    expect(r.altitudeFt).toBeCloseTo(100, 3);
  });

  it('dt of zero (paused) holds the needles', () => {
    const m = createInstrumentModel();
    const a = updateInstruments(m, makeState({ iasKt: 80 }), makeControls(), DT);
    const b = updateInstruments(m, makeState({ iasKt: 140, time: 10 }), makeControls(), 0);
    expect(b.airspeedKt).toBe(a.airspeedKt);
  });

  it('airspeed never reads negative (the needle rests on its stop)', () => {
    const r = updateInstruments(createInstrumentModel(), makeState({ iasKt: -8 }), makeControls(), DT);
    expect(r.airspeedKt).toBe(0);
  });
});

describe('instrument model: systems', () => {
  it('maps throttle, rpm, trim, brakes and parking brake', () => {
    const r = updateInstruments(
      createInstrumentModel(),
      makeState({ rpm: 2450 }),
      makeControls({ throttle: 0.73, elevatorTrim: -0.4, brake: 0.8, parkingBrake: true }),
      DT,
    );
    expect(r.throttlePct).toBeCloseTo(73, 5);
    expect(r.rpm).toBeCloseTo(2450, 3);
    expect(r.trimPct).toBeCloseTo(-40, 5);
    expect(r.brakes).toBe(true);
    expect(r.parkingBrake).toBe(true);
    const off = updateInstruments(createInstrumentModel(), makeState(), makeControls({ brake: 0 }), DT);
    expect(off.brakes).toBe(false);
    expect(off.parkingBrake).toBe(false);
  });

  it('engine status: RUNNING / STARTING / OFF / FAILED', () => {
    const e = createInitialState().engine;
    expect(engineStatusOf({ ...e, running: true, starting: false, failed: false })).toBe('RUNNING');
    expect(engineStatusOf({ ...e, running: false, starting: true, failed: false })).toBe('STARTING');
    expect(engineStatusOf({ ...e, running: false, starting: false, failed: false })).toBe('OFF');
    expect(engineStatusOf({ ...e, running: true, starting: false, failed: true })).toBe('FAILED');
    const r = updateInstruments(createInstrumentModel(), makeState({ running: false, starting: true }), makeControls(), DT);
    expect(r.engineStatus).toBe('STARTING');
  });

  it('flaps: actual deflection plus the commanded notch from config', () => {
    const r = updateInstruments(createInstrumentModel(), makeState({ flapsDeg: 12.5 }), makeControls({ flapsNotch: 3 }), DT);
    expect(r.flapsDeg).toBeCloseTo(12.5, 5);
    expect(r.flapsTargetDeg).toBe(CONFIG.aircraft.flaps.notchesDeg[3]);
    const r0 = updateInstruments(createInstrumentModel(), makeState({ flapsDeg: 0 }), makeControls({ flapsNotch: 0 }), DT);
    expect(r0.flapsTargetDeg).toBe(0);
  });

  it('gear state and the 172RG gear lights: green down & locked, red in transit, off when up', () => {
    expect(gearStateFromPos(1)).toBe('down');
    expect(gearStateFromPos(0.5)).toBe('transit');
    expect(gearStateFromPos(0)).toBe('up');
    const lights = [1, 0.4, 0].map((g) => updateInstruments(createInstrumentModel(), makeState({ gearPos: g }), makeControls(), DT));
    expect(lights.map((r) => [r.gear, r.gearLight])).toEqual([
      ['down', 'green'],
      ['transit', 'red'],
      ['up', 'off'],
    ]);
  });

  it('exposes the gear handle position for the panel lever', () => {
    const r = updateInstruments(createInstrumentModel(), makeState({ gearPos: 0.5 }), makeControls({ gearDown: false }), DT);
    expect(r.gearHandleDown).toBe(false);
  });
});

describe('instrument model: warnings', () => {
  const margin = CONFIG.aircraft.stall.warningMarginDeg;

  it('stall warning sounds within warningMarginDeg of the stall angle while airborne', () => {
    const crit = stallAlphaRad(0) * RAD;
    const near = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: crit - margin + 0.5 }), makeControls(), DT);
    const far = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: crit - margin - 1 }), makeControls(), DT);
    expect(near.stallWarning).toBe(true);
    expect(far.stallWarning).toBe(false);
  });

  it('flaps lower the stall angle, so the warning comes earlier with flaps down', () => {
    const alpha = stallAlphaRad(30) * RAD - margin + 0.3;
    const flapsDown = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: alpha, flapsDeg: 30 }), makeControls(), DT);
    const clean = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: alpha, flapsDeg: 0 }), makeControls(), DT);
    expect(flapsDown.stallWarning).toBe(true);
    expect(clean.stallWarning).toBe(false);
  });

  it('no stall warning on the ground, however high the angle of attack', () => {
    const r = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: 25, onGround: true, phase: 'ground' }), makeControls(), DT);
    expect(r.stallWarning).toBe(false);
  });

  it('overspeed above Vne', () => {
    const vne = CONFIG.aircraft.limits.vneKt;
    expect(updateInstruments(createInstrumentModel(), makeState({ iasKt: vne + 3 }), makeControls(), DT).overspeed).toBe(true);
    expect(updateInstruments(createInstrumentModel(), makeState({ iasKt: vne - 3 }), makeControls(), DT).overspeed).toBe(false);
  });

  it('aoa, g and state label', () => {
    const s = makeState({ alphaDeg: 7.5, loadFactor: 2.1, stalled: true });
    const r = updateInstruments(createInstrumentModel(), s, makeControls(), DT);
    expect(r.aoaDeg).toBeCloseTo(7.5, 5);
    expect(r.gLoad).toBeCloseTo(2.1, 5);
    expect(r.state).toBe(simStateLabel(s));
    expect(r.state).toBe('stalled');
  });
});

describe('instrument model: turn coordinator', () => {
  it('coordinated flight centres the ball', () => {
    expect(rawSlipBall(makeState({ betaDeg: 0 }), makeControls())).toBeCloseTo(0, 6);
  });

  it('a slip (air from the right, right wing low) drops the ball to the right; a skid throws it left', () => {
    expect(rawSlipBall(makeState({ betaDeg: 6 }), makeControls())).toBeGreaterThan(0.1);
    expect(rawSlipBall(makeState({ betaDeg: -6 }), makeControls())).toBeLessThan(-0.1);
  });

  it('taxiing round a right turn swings the ball to the outside (left)', () => {
    const s = makeState({ onGround: true, phase: 'ground', iasKt: 0, groundSpeedKt: 15, r: 0.3, betaDeg: 0 });
    expect(rawSlipBall(s, makeControls())).toBeLessThan(-0.05);
  });

  it('ball is damped (liquid-filled tube) and stays within -1..1', () => {
    const m = createInstrumentModel();
    updateInstruments(m, makeState({ betaDeg: 0 }), makeControls(), DT);
    const r1 = updateInstruments(m, makeState({ betaDeg: 40, time: 10 + DT }), makeControls(), DT);
    expect(r1.slipSkid).toBeGreaterThan(0);
    expect(r1.slipSkid).toBeLessThan(rawSlipBall(makeState({ betaDeg: 40 }), makeControls()));
    const r2 = hold(m, makeState({ betaDeg: 40, time: 11 }), 3);
    expect(r2.slipSkid).toBeLessThanOrEqual(1);
    expect(r2.slipSkid).toBeGreaterThan(0.9);
  });

  it('turn rate is the heading rate: a right turn reads positive', () => {
    // 30° right bank, yaw/pitch rates of a coordinated 3°/s turn.
    const psiDot = 3 / RAD;
    const phi = 30 / RAD;
    const s = makeState({ rollDeg: 30, r: psiDot * Math.cos(phi), q: psiDot * Math.sin(phi) });
    expect(rawTurnRate(s)).toBeCloseTo(3, 3);
    const r = hold(createInstrumentModel(), s, 2);
    expect(r.turnRateDegPerSec).toBeCloseTo(3, 1);
    const left = makeState({ rollDeg: -30, r: -psiDot * Math.cos(phi), q: psiDot * Math.sin(phi) });
    expect(rawTurnRate(left)).toBeCloseTo(-3, 3);
  });
});

describe('instrument model: functional (real physics)', () => {
  it('on the runway at rest: 0 kt, CG height above the (flat, sea-level) runway, heading 360→0, gear green', () => {
    const s = createInitialState();
    const r = updateInstruments(createInstrumentModel(), s, makeControls(), DT);
    expect(r.airspeedKt).toBeLessThan(1);
    expect(r.altitudeFt).toBeCloseTo(s.position.y * 3.28084, 2);
    expect(r.altitudeFt).toBeGreaterThan(0);
    expect(r.altitudeFt).toBeLessThan(10);
    expect(r.headingDeg < 1 || r.headingDeg > 359).toBe(true);
    expect(r.gearLight).toBe('green');
    expect(r.state).toBe('ground');
    expect(r.stallWarning).toBe(false);
  });

  it('in a real climb the VSI lags the true vertical speed, then tracks it within the first-order lag bound', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1000, iasKt: 90, flightPathDeg: 0, flapsNotch: 0, gearDown: true, headingDeg: 0 });
    const m = createInstrumentModel();
    let s = state;
    updateInstruments(m, s, controls, DT);
    const climb = { ...controls, throttle: 1 };
    const tau = CONFIG.hud.vsiLagTau;
    const trueFpm: number[] = [];
    let lagWhileRising = 0;
    let r = updateInstruments(m, s, climb, DT);
    for (let i = 0; i < 60 * 15; i++) {
      for (let k = 0; k < 2; k++) s = step(s, climb, 1 / 120);
      r = updateInstruments(m, s, climb, DT);
      trueFpm.push(s.derived.verticalSpeed * 196.8504);
      if (i === 60 * 5) lagWhileRising = r.verticalSpeedFpm - trueFpm[i];
    }
    // Five seconds after full power the climb rate is still building and the VSI reads short of it.
    expect(trueFpm[60 * 5]).toBeGreaterThan(trueFpm[60 * 4]);
    expect(lagWhileRising).toBeLessThan(0);
    // A first-order lag following a ramp of slope k trails it by k·tau: bound the error by the recent rate.
    const recent = trueFpm.slice(-60 * 3);
    let maxRate = 0;
    for (let i = 1; i < recent.length; i++) maxRate = Math.max(maxRate, Math.abs(recent[i] - recent[i - 1]) / DT);
    const err = Math.abs(r.verticalSpeedFpm - trueFpm[trueFpm.length - 1]);
    expect(err).toBeLessThanOrEqual(maxRate * tau * 1.3 + 30);
  });
});
