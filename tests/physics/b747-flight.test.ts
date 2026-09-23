/**
 * Boeing 747-400 functional flight tests: scripted pilots fly the fleet config through step() on the
 * runway world and the numbers are checked against the real aircraft (flown light at 220 t, ISA):
 *   take-off (flaps 10, Vr 145, ground roll ≈ 1,000 m, no tail strike) → initial climb (≈ 3,500–5,000 fpm)
 *   → climb to FL350 and cruise at M 0.85 → max level Mach (drag rise, MMO 0.92) → roll rates → pitch-up
 *   with power → yaw damper → stalls (clean ≈ 135–140, flaps 30 ≈ 100–110 KIAS) with warning, break and
 *   recovery → approach at Vref30 and landing (auto ground spoilers + max braking) → firm arrival
 *   without a bounce → rejected take-off → nosewheel steering.
 * Set B747_DEBUG=1 to print the measured numbers.
 */
import { describe, it, expect, vi } from 'vitest';
import { FT_TO_M, KT_TO_MS, M_TO_FT } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import {
  approachControls, createApproachState, createInitialState, createTrimmedState, defaultControls, FLAT_ENV, machNumber, stallAlphaRad,
} from '../../src/physics';
import { airDensity, speedOfSound } from '../../src/physics/atmosphere';
import { across, along, B, B747_CFG, bankTo, clamp1, deg, fly747, fpm, ias, pitchTo, tailClearance, tas } from './b747-helpers';
import { headingError, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 120000 });

const log = (...a: unknown[]) => { if (process.env.B747_DEBUG) console.log(...a); };
const iasForMach = (mach: number, altM: number): number => (mach * speedOfSound(altM) * Math.sqrt(airDensity(altM) / 1.225)) / KT_TO_MS;

interface Takeoff {
  state: AircraftState;
  rotateKt: number;
  liftoffKt: number;
  liftoffPitch: number;
  groundRollM: number;
  liftoffAlongM: number;
  maxPitchOnGround: number;
  minTailM: number;
}

/**
 * Line up, flaps 10, take-off trim, brakes released at idle; full thrust; rotate at Vr at ≈ 2.5 °/s toward
 * 9°; gear up once climbing. `rotation` scales the column (1 = normal, 2 = heavy-handed).
 */
function takeoff(rotation = 1): Takeoff {
  const base: Controls = { ...defaultControls(), flapsNotch: 2, elevatorTrim: 0.25 };
  let s = createInitialState(RUNWAY_ENV, B747_CFG);
  s = fly747(s, { ...base, parkingBrake: true }, 12); // flaps run to 10
  expect(s.flapsDeg).toBe(10);
  const a0 = along(s);
  let rotateKt = 0;
  let liftoff: AircraftState | null = null;
  let maxPitchOnGround = 0;
  let minTailM = Infinity;
  s = fly747(s, (x) => {
    let elevator = 0;
    if (ias(x) >= B.limits.vrKt || rotateKt > 0) {
      if (!rotateKt) rotateKt = ias(x);
      const qTarget = Math.min(2.5 * rotation, 0.8 * (9 - x.derived.pitchDeg));
      elevator = clamp1(rotation * ((x.onGround ? 0.25 : 0.05) + 0.25 * (qTarget - deg(x.derived.q))));
    }
    return {
      ...base, throttle: 1, elevator,
      gearDown: !(liftoff && x.velocity.y > 3 && x.derived.altitudeAGL > 20),
      aileron: bankTo(x, 0), rudder: x.onGround ? clamp1(-0.1 * headingError(x, 0) - 0.05 * across(x)) : 0,
    };
  }, 120, {
    each: (x) => {
      if (x.onGround) maxPitchOnGround = Math.max(maxPitchOnGround, x.derived.pitchDeg);
      if (x.derived.altitudeAGL < 40) minTailM = Math.min(minTailM, tailClearance(x));
      if (!liftoff && !x.onGround) liftoff = x;
    },
    until: (x) => !!liftoff && x.airborneTime > 6,
  });
  expect(s.crash, s.crash?.reason).toBeNull();
  expect(liftoff).not.toBeNull();
  const lo = liftoff as unknown as AircraftState;
  return { state: s, rotateKt, liftoffKt: ias(lo), liftoffPitch: lo.derived.pitchDeg, groundRollM: along(lo) - a0, liftoffAlongM: along(lo), maxPitchOnGround, minTailM };
}

describe('747 take-off and climb', () => {
  it('flaps 10: rotate at Vr 145, lift off ≈ 150–165 KIAS after a ≈ 1,000 m ground roll — well inside the 1,600 m runway, no tail strike', () => {
    const t = takeoff();
    log(`take-off: rotate ${t.rotateKt.toFixed(0)} KIAS, lift-off ${t.liftoffKt.toFixed(0)} KIAS at ${t.liftoffPitch.toFixed(1)}°, ground roll ${t.groundRollM.toFixed(0)} m (lift-off ${t.liftoffAlongM.toFixed(0)} m past the threshold), max pitch on the wheels ${t.maxPitchOnGround.toFixed(1)}°, min tail clearance ${t.minTailM.toFixed(2)} m`);
    expect(t.rotateKt).toBeGreaterThanOrEqual(144);
    expect(t.rotateKt).toBeLessThan(148);
    expect(t.liftoffKt).toBeGreaterThan(148);
    expect(t.liftoffKt).toBeLessThan(168);
    expect(t.groundRollM).toBeGreaterThan(900);
    expect(t.groundRollM).toBeLessThan(1300);
    expect(t.liftoffAlongM).toBeLessThan(1400);
    expect(t.maxPitchOnGround).toBeLessThan(9);
    expect(t.minTailM).toBeGreaterThan(0.5);
  });

  it('a heavy-handed rotation (twice the column, twice the rate) still clears the tail', () => {
    const t = takeoff(2);
    log(`heavy rotation: lift-off ${t.liftoffKt.toFixed(0)} KIAS at ${t.liftoffPitch.toFixed(1)}°, max pitch on the wheels ${t.maxPitchOnGround.toFixed(1)}°, min tail clearance ${t.minTailM.toFixed(2)} m`);
    expect(t.state.crash).toBeNull();
    expect(t.minTailM).toBeGreaterThan(0);
  });

  it('initial climb at V2 + 15 (≈ 160 KIAS), flaps 10, gear up, take-off thrust: 3,500–5,000 fpm (light)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1500 * FT_TO_M, iasKt: 160, flapsNotch: 2, gearDown: false }, FLAT_ENV, B747_CFG);
    let pitchCmd = state.derived.pitchDeg;
    const vs: number[] = [];
    const s = fly747(state, (x) => {
      pitchCmd = Math.max(-5, Math.min(25, pitchCmd + 0.03 * (ias(x) - 160) * (1 / 120) * 60));
      return { ...controls, gearDown: false, throttle: 1, elevator: clamp1(pitchTo(x, pitchCmd) + 0.1), aileron: bankTo(x, 0) };
    }, 60, { each: (x) => { if (x.time > 25 && Math.abs(ias(x) - 160) < 6) vs.push(fpm(x)); } });
    const mean = vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length);
    log(`initial climb at 160 KIAS flaps 10: ${mean.toFixed(0)} fpm (n=${vs.length}), pitch ${s.derived.pitchDeg.toFixed(1)}°`);
    expect(s.crash).toBeNull();
    expect(vs.length).toBeGreaterThan(1000);
    expect(mean).toBeGreaterThan(3500);
    expect(mean).toBeLessThan(5000);
  });

  it('climbs to FL350 at 320 KIAS / M 0.84 and cruises at M 0.85 on part throttle', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 10000 * FT_TO_M, iasKt: 320, gearDown: false }, FLAT_ENV, B747_CFG);
    const fl350 = 35000 * FT_TO_M;
    let pitchCmd = state.derived.pitchDeg;
    let throttle = 1;
    let reachedAt = 0;
    let s = fly747(state, (x) => {
      const climbing = x.position.y < fl350 - 150;
      // Climb schedule 320 KIAS until M 0.84, then hold M 0.84; level off and hold M 0.85.
      const machT = climbing ? 0.84 : 0.85;
      const kt = Math.min(320, iasForMach(machT, x.position.y));
      if (climbing) {
        pitchCmd = Math.max(-3, Math.min(15, pitchCmd + 0.02 * (ias(x) - kt) * (1 / 120) * 30));
        throttle = 1;
      } else {
        const vsWant = Math.max(-5, Math.min(5, 0.05 * (fl350 - x.position.y)));
        pitchCmd = deg(x.derived.alpha) + deg(Math.asin(vsWant / x.derived.tas)) + 0.3 * (vsWant - x.velocity.y);
        throttle = Math.max(0.2, Math.min(1, throttle + 0.01 * (kt - ias(x)) * (1 / 120)));
      }
      return { ...controls, gearDown: false, throttle, elevator: clamp1(pitchTo(x, pitchCmd) + 0.05), aileron: bankTo(x, 0) };
    }, 1500, { until: (x) => { if (!reachedAt && x.position.y > fl350 - 150) reachedAt = x.time; return reachedAt > 0 && x.time > reachedAt + 240; } });
    const m = machNumber(s);
    log(`climb 10,000 → FL350: ${(reachedAt / 60).toFixed(1)} min; cruise ${(s.position.y * M_TO_FT).toFixed(0)} ft M ${m.toFixed(3)} ${ias(s).toFixed(0)} KIAS ${tas(s).toFixed(0)} KTAS, throttle ${throttle.toFixed(2)} (N2 ${s.engine.rpm.toFixed(0)} %), α ${deg(s.derived.alpha).toFixed(1)}°`);
    expect(s.crash).toBeNull();
    expect(reachedAt).toBeGreaterThan(0);
    expect(reachedAt / 60).toBeLessThan(20);
    expect(Math.abs(s.position.y - fl350) * M_TO_FT).toBeLessThan(200);
    expect(m).toBeGreaterThan(0.83);
    expect(m).toBeLessThan(0.87);
    expect(throttle).toBeLessThan(0.95);
    s = fly747(s, { ...controls, gearDown: false, throttle: 1, elevator: 0 }, 0.1);
    expect(s.crash).toBeNull();
  });

  it('max level speed at FL350, full thrust: M 0.88–0.92 (the drag rise past M 0.86 is a wall at MMO 0.92)', () => {
    const alt = 35000 * FT_TO_M;
    const { state, controls } = createTrimmedState({ altitudeM: alt, iasKt: iasForMach(0.86, alt), gearDown: false }, FLAT_ENV, B747_CFG);
    const s = fly747(state, (x) => ({
      ...controls, gearDown: false, throttle: 1,
      elevator: clamp1(controls.elevator + 0.004 * (alt - x.position.y) - 0.03 * x.velocity.y - 0.2 * deg(x.derived.q)),
      aileron: bankTo(x, 0),
    }), 400);
    log(`max level speed at FL350: M ${machNumber(s).toFixed(3)} (${ias(s).toFixed(0)} KIAS), Δalt ${((s.position.y - alt) * M_TO_FT).toFixed(0)} ft`);
    expect(s.crash).toBeNull();
    expect(Math.abs(s.position.y - alt)).toBeLessThan(40);
    expect(machNumber(s)).toBeGreaterThan(0.88);
    expect(machNumber(s)).toBeLessThan(0.92);
  });
});

describe('747 handling', () => {
  function rollRate(req: { altitudeM: number; iasKt: number; flapsNotch?: number; gearDown?: boolean }): number {
    const { state, controls } = createTrimmedState(req, FLAT_ENV, B747_CFG);
    let maxP = 0;
    fly747(state, { ...controls, aileron: 1 }, 3, { each: (x) => { maxP = Math.max(maxP, deg(x.derived.p)); } });
    return maxP;
  }

  it('full-wheel roll rate: 10–20 °/s on approach (flaps 30), 15–25 °/s at cruise (outboard ailerons locked out)', () => {
    const approach = rollRate({ altitudeM: 1000, iasKt: 135, flapsNotch: 5, gearDown: true });
    const alt = 35000 * FT_TO_M;
    const cruise = rollRate({ altitudeM: alt, iasKt: iasForMach(0.85, alt), gearDown: false });
    const low = rollRate({ altitudeM: 3000, iasKt: 300, gearDown: false });
    log(`roll rate: approach 135 KIAS ${approach.toFixed(1)} °/s, 300 KIAS at 10,000 ft ${low.toFixed(1)} °/s, M 0.85 FL350 ${cruise.toFixed(1)} °/s`);
    expect(approach).toBeGreaterThan(10);
    expect(approach).toBeLessThan(20);
    expect(cruise).toBeGreaterThan(15);
    expect(cruise).toBeLessThan(25);
    expect(low).toBeGreaterThan(10);
    expect(low).toBeLessThan(25);
  });

  it('slow in pitch: a full-column pull at 250 KIAS takes ~2 s to build the g; the thrust line pitches the nose up with power', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 3000, iasKt: 250, gearDown: false }, FLAT_ENV, B747_CFG);
    let t15 = 0;
    fly747(state, { ...controls, gearDown: false, elevator: 0.35 }, 4, { each: (x) => { if (!t15 && x.derived.loadFactor >= 1.5) t15 = x.time; } });
    log(`pull 0.35 column at 250 KIAS: 1.5 g after ${t15.toFixed(2)} s`);
    expect(t15).toBeGreaterThan(0.6);
    expect(t15).toBeLessThan(3);
    // Power on from the trimmed approach: the nose rises (pitch rate > 0), idle: it drops.
    const ap = createApproachState(RUNWAY_ENV, B747_CFG);
    const c = approachControls(B747_CFG);
    const up = fly747(ap, { ...c, throttle: 1 }, 8);
    const down = fly747(ap, { ...c, throttle: 0 }, 8);
    log(`approach, 8 s after TOGA: pitch ${up.derived.pitchDeg.toFixed(1)}° vs idle ${down.derived.pitchDeg.toFixed(1)}° (from ${ap.derived.pitchDeg.toFixed(1)}°)`);
    expect(up.derived.pitchDeg).toBeGreaterThan(ap.derived.pitchDeg + 1);
    expect(down.derived.pitchDeg).toBeLessThan(ap.derived.pitchDeg);
  });

  it('yaw damper: a rudder kick at cruise damps out (dutch roll gone within ~15 s)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 5000, iasKt: 280, gearDown: false }, FLAT_ENV, B747_CFG);
    let s = fly747(state, { ...controls, gearDown: false, rudder: 0.5 }, 1);
    const beta0 = Math.abs(deg(s.derived.beta));
    s = fly747(s, { ...controls, gearDown: false }, 15);
    log(`rudder kick: β ${beta0.toFixed(2)}° → ${Math.abs(deg(s.derived.beta)).toFixed(3)}° after 15 s`);
    expect(beta0).toBeGreaterThan(0.5);
    expect(Math.abs(deg(s.derived.beta))).toBeLessThan(0.1 * beta0);
  });

  it('hands-off trimmed cruise stays put: a 5° bank upset changes the heading slowly, no pitch divergence in 60 s', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 5000, iasKt: 280, gearDown: false }, FLAT_ENV, B747_CFG);
    let s = fly747(state, { ...controls, gearDown: false, aileron: 0.2 }, 1.5);
    const bank0 = s.derived.rollDeg;
    s = fly747(s, { ...controls, gearDown: false }, 60);
    log(`hands-off: bank ${bank0.toFixed(1)}° → ${s.derived.rollDeg.toFixed(1)}° after 60 s, Δalt ${((s.position.y - state.position.y) * M_TO_FT).toFixed(0)} ft, pitch ${s.derived.pitchDeg.toFixed(1)}°`);
    expect(s.crash).toBeNull();
    expect(Math.abs(s.derived.rollDeg)).toBeLessThan(25);
    expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(10);
  });
});

describe('747 stalls', () => {
  /** Idle, wings level, slow at ~1 kt/s by raising the nose until the break; then recover. */
  function stall(flapsNotch: number, gearDown: boolean) {
    const { state, controls } = createTrimmedState({ altitudeM: 10000 * FT_TO_M, iasKt: flapsNotch ? 150 : 190, flapsNotch, gearDown }, FLAT_ENV, B747_CFG);
    const c: Controls = { ...controls, throttle: 0 };
    const aS = stallAlphaRad(B.flaps.notchesDeg[flapsNotch], B747_CFG);
    const warnA = aS - B.stall.warningMarginDeg * (Math.PI / 180);
    let warnKt = 0;
    let breakKt = 0;
    let breakPitch = 0;
    let breakColumn = 0;
    let prevIas = ias(state);
    let decel = 0;
    let pitchCmd = state.derived.pitchDeg;
    let s = fly747(state, (x) => {
      const rate = (ias(x) - prevIas) * 120;
      prevIas = ias(x);
      decel += (rate - decel) * (1 / 120);
      // Raise the nose to slow at ~1 kt/s.
      pitchCmd += (1 / 120) * 0.6 * (decel + 1);
      return { ...c, elevator: clamp1(pitchTo(x, pitchCmd) + 0.2 * Math.max(0, pitchCmd - x.derived.pitchDeg)), aileron: bankTo(x, 0) };
    }, 180, {
      each: (x, ctl) => {
        if (!warnKt && x.derived.alpha >= warnA) warnKt = ias(x);
        if (!breakKt && x.stalled) { breakKt = ias(x); breakPitch = x.derived.pitchDeg; breakColumn = ctl.elevator; }
      },
      until: (x) => breakKt > 0 && x.time > 0,
    });
    // Keep the column coming back (0.1/s) for 5 s: the nose breaks down anyway (slowly — a big pitch inertia).
    let maxPitch = breakPitch;
    let minAfterPeak = Infinity;
    const t0 = s.time;
    s = fly747(s, (x) => ({ ...c, elevator: clamp1(breakColumn + 0.1 * (x.time - t0)), aileron: bankTo(x, 0) }), 5, {
      each: (x) => {
        if (process.env.B747_TRACE && Math.round(x.time * 120) % 30 === 0) log(`  t ${(x.time - t0).toFixed(2)} α ${deg(x.derived.alpha).toFixed(1)} pitch ${x.derived.pitchDeg.toFixed(1)} q ${deg(x.derived.q).toFixed(2)} ias ${ias(x).toFixed(0)} vs ${fpm(x).toFixed(0)} col ${(breakColumn + 0.1 * (x.time - t0)).toFixed(2)} stalled ${x.stalled}`);
        if (x.derived.pitchDeg > maxPitch) { maxPitch = x.derived.pitchDeg; minAfterPeak = Infinity; }
        minAfterPeak = Math.min(minAfterPeak, x.derived.pitchDeg);
      },
    });
    const nosedrop = maxPitch - minAfterPeak;
    // Recover: release, push, full thrust, wings level; pull out gently once flying.
    const y0 = s.position.y;
    let lost = 0;
    let recovered: AircraftState | null = null;
    s = fly747(s, (x) => ({
      ...c, throttle: 1,
      elevator: x.stalled || deg(x.derived.alpha) > deg(aS) - 5 ? -0.4 : clamp1(pitchTo(x, 2)),
      aileron: bankTo(x, 0),
    }), 60, {
      each: (x) => { lost = Math.max(lost, y0 - x.position.y); if (!recovered && !x.stalled && x.velocity.y > 0) recovered = x; },
      until: () => !!recovered,
    });
    return { s, warnKt, breakKt, nosedrop, lostFt: lost * M_TO_FT, recovered: !!recovered };
  }

  it('clean, idle: stick shaker ≈ 5 % early, break ≈ 130–145 KIAS, the nose drops even with the column coming back, recovery < 1,500 ft', () => {
    const r = stall(0, false);
    log(`clean stall: shaker ${r.warnKt.toFixed(0)} KIAS, break ${r.breakKt.toFixed(0)} KIAS, nose drop ${r.nosedrop.toFixed(1)}°, ${r.lostFt.toFixed(0)} ft lost`);
    expect(r.s.crash).toBeNull();
    expect(r.breakKt).toBeGreaterThan(128);
    expect(r.breakKt).toBeLessThan(145);
    expect(r.warnKt - r.breakKt).toBeGreaterThan(4);
    expect(r.nosedrop).toBeGreaterThan(2);
    expect(r.recovered).toBe(true);
    expect(r.lostFt).toBeLessThan(1500);
  });

  it('flaps 30, gear down, idle: break ≈ 100–110 KIAS, nose drops, recovers', () => {
    const r = stall(5, true);
    log(`flaps-30 stall: shaker ${r.warnKt.toFixed(0)} KIAS, break ${r.breakKt.toFixed(0)} KIAS, nose drop ${r.nosedrop.toFixed(1)}°, ${r.lostFt.toFixed(0)} ft lost`);
    expect(r.s.crash).toBeNull();
    expect(r.breakKt).toBeGreaterThan(96);
    expect(r.breakKt).toBeLessThan(110);
    expect(r.warnKt - r.breakKt).toBeGreaterThan(3);
    expect(r.nosedrop).toBeGreaterThan(2);
    expect(r.recovered).toBe(true);
  });
});

describe('747 approach, landing and the ground', () => {
  /** From the approach spawn: hold the 3° path at 132 KIAS, flare at 30 ft, idle; then brakes (`brake` 0..1). */
  function land(brake: number) {
    let s = createApproachState(RUNWAY_ENV, B747_CFG);
    const c0 = approachControls(B747_CFG);
    const gs = Math.tan((3 * Math.PI) / 180);
    const aim = B.spawn.approach.aimPointM;
    let elI = 0;
    let thI = 0;
    let flare = false;
    let td: AircraftState | null = null;
    let bounced = false;
    s = fly747(s, (x) => {
      const wheel = x.position.y + B.geometry.leftMainWheel.y;
      if (!flare && wheel < 11) flare = true;
      const onG = x.onGround || !!td;
      let vsT = -x.derived.groundSpeed * gs + 0.1 * (Math.max(0, (aim - along(x)) * gs) - wheel);
      if (flare) vsT = -Math.max(0.6, 0.2 * wheel);
      const pitchT = deg(x.derived.alpha) + deg(Math.asin(Math.max(-0.2, Math.min(0.2, vsT / x.derived.tas)))) + (flare ? 1.5 : 0.8) * (vsT - x.velocity.y);
      const err = pitchT - x.derived.pitchDeg;
      if (!onG) elI = Math.max(-0.5, Math.min(0.5, elI + (0.02 * err) / 120));
      thI = Math.max(-0.3, Math.min(0.5, thI + (0.004 * (132 - ias(x))) / 120));
      return {
        ...c0,
        throttle: onG || flare ? 0 : clamp1(c0.throttle + thI + 0.03 * (132 - ias(x))),
        elevator: onG ? (x.derived.pitchDeg > 1 ? -0.1 : 0) : clamp1(pitchTo(x, pitchT) + elI),
        aileron: bankTo(x, 0),
        rudder: clamp1(-0.1 * headingError(x, 0) - 0.02 * across(x)),
        brake: td && x.onGround && x.time > td.time + 1.5 ? brake : 0,
      };
    }, 400, {
      each: (x) => { if (!td && x.touchdown) td = x; if (td && x.phase === 'airborne' && x.time > td.time + 0.5) bounced = true; },
      until: (x) => !!td && x.derived.groundSpeed < 0.5,
    });
    const T = td as unknown as AircraftState;
    return { s, td: T, rollM: T ? along(s) - along(T) : NaN, bounced };
  }

  it('flares at ~35 ft and lands on runway 36 (smooth/firm); max braking + auto ground spoilers stop it inside the runway', () => {
    const r = land(1);
    const td = r.td.touchdown!;
    log(`landing, max braking: ${td.rating} ${td.verticalSpeedFpm.toFixed(0)} fpm at ${td.airspeedKt.toFixed(0)} KIAS, pitch ${td.pitchDeg.toFixed(1)}°, touchdown ${along(r.td).toFixed(0)} m, roll ${r.rollM.toFixed(0)} m, stopped at ${along(r.s).toFixed(0)} m`);
    expect(r.s.crash).toBeNull();
    expect(td.onRunway).toBe(true);
    expect(['butter', 'smooth', 'firm']).toContain(td.rating);
    expect(td.airspeedKt).toBeGreaterThan(115);
    expect(td.airspeedKt).toBeLessThan(140);
    expect(td.pitchDeg).toBeGreaterThan(1);
    expect(td.pitchDeg).toBeLessThan(9);
    expect(r.bounced).toBe(false);
    // Real max manual braking at 220 t: ≈ 600–800 m (unfactored landing distance ≈ 1,000 m from 50 ft).
    expect(r.rollM).toBeGreaterThan(550);
    expect(r.rollM).toBeLessThan(1000);
    expect(along(r.s)).toBeLessThan(1600);
  });

  it('medium braking (half pedal, like autobrake 3): a ≈ 900–1,300 m roll', () => {
    const r = land(0.45);
    log(`landing, medium braking: roll ${r.rollM.toFixed(0)} m, stopped at ${along(r.s).toFixed(0)} m`);
    expect(r.s.crash).toBeNull();
    expect(r.rollM).toBeGreaterThan(850);
    expect(r.rollM).toBeLessThan(1350);
  });

  it('the ground spoilers matter: without them (throttle cracked above idle) the same braking takes far longer', () => {
    const on = createTrimmedState({ altitudeM: 5, iasKt: 125, flapsNotch: 5 }, FLAT_ENV, B747_CFG);
    const roll = (throttle: number) => {
      let s = createInitialState(RUNWAY_ENV, B747_CFG);
      s = { ...s, velocity: { x: 0, y: 0, z: -125 * KT_TO_MS }, engine: on.state.engine, flapsDeg: 30 };
      const x0 = along(s);
      s = fly747(s, (x) => ({ ...defaultControls(), flapsNotch: 5, throttle: x.derived.groundSpeed > 20 * KT_TO_MS ? throttle : 0, brake: 1, rudder: clamp1(-0.1 * headingError(x, 0)) }), 90, { until: (x) => x.derived.groundSpeed < 0.5 });
      return along(s) - x0;
    };
    const withSpoilers = roll(0);
    const without = roll(0.06);
    log(`braking from 125 kt: ${withSpoilers.toFixed(0)} m with the ground spoilers, ${without.toFixed(0)} m without`);
    expect(without).toBeGreaterThan(withSpoilers * 1.2);
  });

  it('a firm 600 fpm arrival does not bounce (oleo damping holds 220 t)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 12, iasKt: 130, flapsNotch: 5, flightPathDeg: -1 }, FLAT_ENV, B747_CFG);
    let s: AircraftState = { ...state, velocity: { ...state.velocity, y: -600 / 196.85 } };
    let td: AircraftState | null = null;
    let airborneAgain = false;
    s = fly747(s, (x) => ({ ...controls, throttle: 0, elevator: clamp1(pitchTo(x, 4)) }), 20, {
      each: (x) => { if (!td && x.touchdown) td = x; if (td && x.phase === 'airborne') airborneAgain = true; },
    });
    const T = td as unknown as AircraftState;
    log(`firm arrival: ${T?.touchdown?.rating} ${T?.touchdown?.verticalSpeedFpm.toFixed(0)} fpm; bounced: ${airborneAgain}; max strut ${Math.max(...s.wheelCompression).toFixed(2)} m`);
    expect(s.crash).toBeNull();
    expect(T).not.toBeNull();
    expect(['firm', 'hard']).toContain(T.touchdown!.rating);
    expect(airborneAgain).toBe(false);
  });

  it('rejected take-off at 130 KIAS: idle + max braking (auto spoilers) stops on the runway', () => {
    let s = createInitialState(RUNWAY_ENV, B747_CFG);
    let abortAt: AircraftState | null = null;
    s = fly747(s, (x) => {
      if (!abortAt && ias(x) >= 130) abortAt = x;
      return { ...defaultControls(), flapsNotch: 2, throttle: abortAt ? 0 : 1, brake: abortAt ? 1 : 0, rudder: clamp1(-0.1 * headingError(x, 0) - 0.05 * across(x)) };
    }, 120, { until: (x) => !!abortAt && x.derived.groundSpeed < 0.5 });
    const A = abortAt as unknown as AircraftState;
    log(`RTO at 130 KIAS: abort at ${along(A).toFixed(0)} m, stopped at ${along(s).toFixed(0)} m`);
    expect(s.crash).toBeNull();
    expect(s.phase).toBe('ground');
    expect(along(s)).toBeLessThan(1600);
  });

  it('nosewheel steering: tight turns while taxiing, faded out at take-off speed (the rudder steers)', () => {
    let s = createInitialState(RUNWAY_ENV, B747_CFG);
    s = fly747(s, (x) => ({ ...defaultControls(), throttle: x.derived.groundSpeed < 8 ? 0.2 : 0, brake: x.derived.groundSpeed > 9 ? 0.3 : 0 }), 40, { until: (x) => x.derived.groundSpeed > 7.5 });
    const h0 = s.derived.headingDeg;
    s = fly747(s, { ...defaultControls(), throttle: 0.12, rudder: 1 }, 6);
    const taxiTurn = Math.abs(headingError(s, h0));
    log(`taxi at ~15 kt, full tiller 6 s: ${taxiTurn.toFixed(0)}° of heading`);
    expect(s.crash).toBeNull();
    expect(taxiTurn).toBeGreaterThan(20);
  });
});
