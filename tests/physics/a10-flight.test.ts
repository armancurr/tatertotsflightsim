/**
 * A-10C functional flight tests: scripted pilots fly the full config through step() on the runway
 * world and the numbers are checked against the real aircraft (16 t combat weight, ISA):
 *   take-off (Vr ≈ 120 KIAS, MVR flaps, ground roll ≈ 700 m) → initial climb (≈ 5,000–6,000 fpm) →
 *   max level speed (≈ 340–380 KTAS loaded) → roll rate (≈ 90–110 °/s) → turns and g → stalls (clean
 *   ≈ 115–125 KIAS, landing config ≈ 95–105) and recovery → spin resistance → decelerons → approach
 *   (140 KIAS, flaps DN) and landing on runway 36.
 * Set A10_DEBUG=1 to print the measured numbers.
 */
import { describe, it, expect, vi } from 'vitest';
import { A10_AIRCRAFT, FT_TO_M, M_TO_FT } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { approachControls, createApproachState, createInitialState, createTrimmedState, defaultControls, FLAT_ENV } from '../../src/physics';
import { A10_CFG, across, along, bankTo, clamp1, deg, flyA10, fpm, ias, pitchTo, tas } from './a10-helpers';
import { headingError, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 60000 });

const log = (...a: unknown[]) => { if (process.env.A10_DEBUG) console.log(...a); };
const A = A10_AIRCRAFT;

interface Takeoff {
  state: AircraftState;
  rotateKt: number;
  liftoffKt: number;
  groundRollM: number;
  maxPitchOnGround: number;
}

/**
 * Line up, flaps MVR, run the engines up on the brakes (they hold ~55 % — not military), release,
 * full throttle, rotate at Vr at ~3 °/s toward 9° pitch; gear up once climbing.
 */
function takeoff(vrKt = 120): Takeoff {
  const base: Controls = { ...defaultControls(), flapsNotch: 1 };
  let s = createInitialState(RUNWAY_ENV, A10_CFG);
  s = flyA10(s, { ...base, throttle: 0.55, brake: 1 }, 8);
  expect(s.derived.groundSpeed, 'the brakes hold the run-up').toBeLessThan(0.5);
  const a0 = along(s);
  let rotateKt = 0;
  let liftoff: AircraftState | null = null;
  let maxPitchOnGround = 0;
  s = flyA10(s, (x) => {
    let elevator = 0;
    if (ias(x) >= vrKt || rotateKt > 0) {
      if (!rotateKt) rotateKt = ias(x);
      const qTarget = Math.min(3, 0.8 * (9 - x.derived.pitchDeg));
      elevator = clamp1((x.onGround ? 0.55 : 0.1) + 0.15 * (qTarget - deg(x.derived.q)));
    }
    return {
      ...base, throttle: 1, elevator,
      gearDown: !(liftoff && x.velocity.y > 2 && x.derived.altitudeAGL > 15),
      aileron: bankTo(x, 0), rudder: x.onGround ? clamp1(-0.1 * headingError(x, 0) - 0.05 * across(x)) : 0,
    };
  }, 90, {
    each: (x) => {
      if (x.onGround) maxPitchOnGround = Math.max(maxPitchOnGround, x.derived.pitchDeg);
      if (!liftoff && !x.onGround) liftoff = x;
    },
    until: (x) => !!liftoff && x.airborneTime > 4,
  });
  expect(s.crash, s.crash?.reason).toBeNull();
  expect(liftoff).not.toBeNull();
  const lo = liftoff as unknown as AircraftState;
  return { state: s, rotateKt, liftoffKt: ias(lo), groundRollM: along(lo) - a0, maxPitchOnGround };
}

describe('A-10 take-off and climb', () => {
  it('rotate at Vr ≈ 120 KIAS, lift off 125–150 KIAS after a 650–1,000 m ground roll, no tail strike', () => {
    const t = takeoff();
    log(`take-off: rotate ${t.rotateKt.toFixed(0)} KIAS, lift-off ${t.liftoffKt.toFixed(0)} KIAS, ground roll ${t.groundRollM.toFixed(0)} m, max pitch on the wheels ${t.maxPitchOnGround.toFixed(1)}°`);
    expect(t.rotateKt).toBeGreaterThanOrEqual(119);
    expect(t.rotateKt).toBeLessThan(123);
    expect(t.liftoffKt).toBeGreaterThan(125);
    expect(t.liftoffKt).toBeLessThan(150);
    expect(t.groundRollM).toBeGreaterThan(650);
    expect(t.groundRollM).toBeLessThan(1000);
    // Tail (tailcone / fin roots) meets the runway at ~10–11° with the struts compressed.
    expect(t.maxPitchOnGround).toBeLessThan(10);
  });

  it('elevator authority: full aft stick cannot rotate it much below Vr (nose stays down until ~105 KIAS)', () => {
    let s = createInitialState(RUNWAY_ENV, A10_CFG);
    let noseUpKt = 0;
    s = flyA10(s, { ...defaultControls(), flapsNotch: 1, throttle: 1, elevator: 1 }, 60, {
      each: (x) => { if (!noseUpKt && !x.wheelContact[0]) noseUpKt = ias(x); },
      until: () => noseUpKt > 0,
    });
    log(`full aft stick from brake release: nose wheel off at ${noseUpKt.toFixed(0)} KIAS`);
    expect(noseUpKt).toBeGreaterThan(100);
    expect(noseUpKt).toBeLessThan(122);
  });

  it('initial climb at ~200 KIAS, military power, clean: 4,700–6,000 fpm (real ≈ 6,000 fpm light; 16 t loaded)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1000 * FT_TO_M, iasKt: 200, gearDown: false }, FLAT_ENV, A10_CFG);
    const c: Controls = { ...controls, gearDown: false, throttle: 1 };
    // Settle the spool, then climb at constant IAS (pitch for airspeed).
    let pitchCmd = state.derived.pitchDeg;
    const vs: number[] = [];
    const s = flyA10(state, (x) => {
      pitchCmd = Math.max(-5, Math.min(25, pitchCmd + 0.02 * (ias(x) - 200)));
      return { ...c, elevator: pitchTo(x, pitchCmd), aileron: bankTo(x, 0) };
    }, 90, {
      each: (x) => { if (x.time > 40 && x.position.y < 4000 * FT_TO_M) vs.push(fpm(x)); },
    });
    const mean = vs.reduce((a, b) => a + b, 0) / Math.max(1, vs.length);
    log(`climb at 200 KIAS: mean ${mean.toFixed(0)} fpm (n=${vs.length}), end ${(s.position.y * M_TO_FT).toFixed(0)} ft ${ias(s).toFixed(0)} KIAS`);
    expect(s.crash).toBeNull();
    expect(vs.length).toBeGreaterThan(100);
    expect(mean).toBeGreaterThan(4700);
    expect(mean).toBeLessThan(6000);
  });

  it('max level speed at 1,000 ft, full power, 4 Mavericks: 340–380 KTAS (381 KTAS clean at 5,000 ft)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1000 * FT_TO_M, iasKt: 330, gearDown: false }, FLAT_ENV, A10_CFG);
    const y0 = state.position.y;
    const s = flyA10(state, (x) => ({
      ...controls, gearDown: false, throttle: 1,
      elevator: clamp1(0.004 * (y0 - x.position.y) - 0.02 * x.velocity.y - 0.05 * deg(x.derived.q)),
      aileron: bankTo(x, 0),
    }), 240);
    log(`max level speed at 1,000 ft: ${tas(s).toFixed(0)} KTAS (${ias(s).toFixed(0)} KIAS), Δalt ${((s.position.y - y0) * M_TO_FT).toFixed(0)} ft`);
    expect(s.crash).toBeNull();
    expect(Math.abs(s.position.y - y0)).toBeLessThan(30);
    expect(tas(s)).toBeGreaterThan(340);
    expect(tas(s)).toBeLessThan(380);
    expect(ias(s)).toBeLessThan(A.limits.vneKt);
  });
});

describe('A-10 handling', () => {
  function rollRate(kt: number): number {
    const { state, controls } = createTrimmedState({ altitudeM: 5000 * FT_TO_M, iasKt: kt, gearDown: false }, FLAT_ENV, A10_CFG);
    let maxP = 0;
    flyA10(state, { ...controls, gearDown: false, aileron: 1 }, 2, { each: (x) => { maxP = Math.max(maxP, deg(x.derived.p)); } });
    return maxP;
  }

  it('full-aileron roll rate ≈ 90–110 °/s at 250–300 KIAS (big ailerons, big roll inertia: slower when slow)', () => {
    const r250 = rollRate(250);
    const r300 = rollRate(300);
    const r150 = rollRate(150);
    log(`roll rate: 150 KIAS ${r150.toFixed(0)}, 250 KIAS ${r250.toFixed(0)}, 300 KIAS ${r300.toFixed(0)} °/s`);
    expect(r250).toBeGreaterThan(85);
    expect(r250).toBeLessThan(115);
    expect(r300).toBeGreaterThan(90);
    expect(r300).toBeLessThan(120);
    expect(r150).toBeLessThan(r250);
  });

  it('60° bank level turn at 300 KIAS, full power: 2 g, ~6 °/s, altitude held; 90° of heading in < 20 s', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 3000 * FT_TO_M, iasKt: 300, gearDown: false }, FLAT_ENV, A10_CFG);
    const y0 = state.position.y;
    const h0 = state.derived.headingDeg;
    let pullI = 0;
    let t90 = -1;
    const nSeen: number[] = [];
    const rate: number[] = [];
    let prevH = h0;
    const s = flyA10(state, (x) => {
      const err = y0 - x.position.y;
      pullI = Math.max(-0.3, Math.min(0.5, pullI + 0.0004 * err));
      return {
        ...controls, gearDown: false, throttle: 1, aileron: bankTo(x, 60),
        elevator: clamp1(pullI + 0.003 * err - 0.02 * x.velocity.y - 0.05 * deg(x.derived.q)),
      };
    }, 30, {
      each: (x) => {
        if (x.time > 8) {
          nSeen.push(x.derived.loadFactor);
          rate.push(headingError(x, prevH) * 120);
        }
        prevH = x.derived.headingDeg;
        if (t90 < 0 && Math.abs(headingError(x, h0)) > 90) t90 = x.time;
      },
    });
    const n = nSeen.reduce((a, b) => a + b, 0) / nSeen.length;
    const w = rate.reduce((a, b) => a + b, 0) / rate.length;
    log(`60° turn at 300 KIAS: mean ${n.toFixed(2)} g, ${w.toFixed(1)} °/s, 90° in ${t90.toFixed(1)} s, Δalt ${((s.position.y - y0) * M_TO_FT).toFixed(0)} ft, end ${ias(s).toFixed(0)} KIAS`);
    expect(s.crash).toBeNull();
    expect(n).toBeGreaterThan(1.85);
    expect(n).toBeLessThan(2.15);
    // ω = g·√(n² − 1)/V ≈ 9.81·1.73/160 m/s ≈ 6 °/s.
    expect(w).toBeGreaterThan(5);
    expect(w).toBeLessThan(7);
    expect(t90).toBeGreaterThan(0);
    expect(t90).toBeLessThan(20);
    expect(Math.abs(s.position.y - y0) * M_TO_FT).toBeLessThan(200);
  });

  it('full aft stick at 300 KIAS is lift-limited near the 7.33 g limit; a full pull at 430 KIAS breaks the airframe', () => {
    const pull = (kt: number) => {
      const { state, controls } = createTrimmedState({ altitudeM: 8000 * FT_TO_M, iasKt: kt, gearDown: false }, FLAT_ENV, A10_CFG);
      let maxN = 0;
      const s = flyA10(state, { ...controls, gearDown: false, elevator: 1 }, 3, { each: (x) => { maxN = Math.max(maxN, x.derived.loadFactor); } });
      return { s, maxN };
    };
    const at300 = pull(300);
    const at430 = pull(430);
    log(`full aft stick: 300 KIAS → ${at300.maxN.toFixed(1)} g; 430 KIAS → ${at430.s.crash?.reason ?? `${at430.maxN.toFixed(1)} g`}`);
    expect(at300.s.crash).toBeNull();
    expect(at300.maxN).toBeGreaterThan(5.5);
    expect(at300.maxN).toBeLessThan(8.5);
    expect(at430.s.crash?.reason).toMatch(/over-G/);
  });

  it('decelerons at 300 KIAS, idle: ≥ 1.5 kt/s more deceleration than clean, and no pitch change (< 1°)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 3000 * FT_TO_M, iasKt: 300, gearDown: false }, FLAT_ENV, A10_CFG);
    const run = (sb: boolean) => flyA10(state, { ...controls, gearDown: false, throttle: 0, speedBrake: sb }, 3);
    const clean = run(false);
    const brake = run(true);
    const extra = (ias(clean) - ias(brake)) / 3;
    log(`decelerons: +${extra.toFixed(1)} kt/s, pitch ${clean.derived.pitchDeg.toFixed(2)}° vs ${brake.derived.pitchDeg.toFixed(2)}°`);
    expect(extra).toBeGreaterThan(1.5);
    expect(Math.abs(brake.derived.pitchDeg - clean.derived.pitchDeg)).toBeLessThan(1);
  });

  it('hands-off, trimmed at 250 KIAS: a rudder/aileron kick (Dutch roll) and an elevator kick (short period) die out fast — the SAS', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 5000 * FT_TO_M, iasKt: 250, gearDown: false }, FLAT_ENV, A10_CFG);
    const c: Controls = { ...controls, gearDown: false };
    // Lateral-directional: 0.5 s of rudder + aileron, then hands off.
    let s = flyA10(state, { ...c, aileron: 0.3, rudder: 0.6 }, 0.5);
    const betaKick = Math.abs(deg(s.derived.beta));
    s = flyA10(s, c, 6);
    log(`Dutch roll: β ${betaKick.toFixed(1)}° → ${deg(s.derived.beta).toFixed(2)}° after 6 s; p ${deg(s.derived.p).toFixed(2)} r ${deg(s.derived.r).toFixed(2)} °/s; bank ${s.derived.rollDeg.toFixed(1)}°`);
    expect(betaKick).toBeGreaterThan(1);
    // β and the roll rate die out; the bank that is left just turns the aircraft (spirally neutral).
    expect(Math.abs(deg(s.derived.beta))).toBeLessThan(0.5);
    expect(Math.abs(deg(s.derived.p))).toBeLessThan(1);
    // Short period: 0.4 s of elevator, then hands off: α back within 0.3° of trim in 3 s (the slow phugoid may follow).
    let p = flyA10(state, { ...c, elevator: 0.3 }, 0.4);
    const aKick = deg(p.derived.alpha - state.derived.alpha);
    p = flyA10(p, c, 3);
    log(`short period: Δα ${aKick.toFixed(1)}° → ${deg(p.derived.alpha - state.derived.alpha).toFixed(2)}° after 3 s, q ${deg(p.derived.q).toFixed(2)} °/s`);
    expect(aKick).toBeGreaterThan(1);
    expect(Math.abs(deg(p.derived.alpha - state.derived.alpha))).toBeLessThan(0.3);
    expect(Math.abs(deg(p.derived.q))).toBeLessThan(1.5);
    expect(s.crash ?? p.crash).toBeNull();
  });
});

describe('A-10 stalls and spins', () => {
  /** Idle, wings level, slow down ~1–2 kt/s holding altitude, then full aft stick until the break; recover. */
  function stall(flapsNotch: number, gearDown: boolean) {
    const { state, controls } = createTrimmedState({ altitudeM: 8000 * FT_TO_M, iasKt: 170, gearDown, flapsNotch }, FLAT_ENV, A10_CFG);
    const y0 = state.position.y;
    const aS = A.aero.stallAlphaDeg + (A.aero.stallAlphaFlapsShiftDeg * A.flaps.notchesDeg[flapsNotch]) / A.surfaces.flapMaxDeg;
    let warnKt = 0;
    let stallKt = 0;
    let bankAtBreak = 0;
    let s = flyA10(state, (x) => ({
      ...controls, throttle: 0,
      elevator: stallKt ? 1 : Math.max(-0.2, clamp1(0.1 + 0.006 * (y0 - x.position.y) - 0.02 * x.velocity.y - 0.3 * x.derived.q)),
      aileron: bankTo(x, 0),
    }), 120, {
      each: (x) => {
        if (!warnKt && deg(x.derived.alpha) > aS - A.stall.warningMarginDeg) warnKt = ias(x);
        if (!stallKt && x.stalled) stallKt = ias(x);
        if (stallKt) bankAtBreak = Math.max(bankAtBreak, Math.abs(x.derived.rollDeg));
      },
      until: (x) => stallKt > 0 && x.stalled && deg(x.derived.alpha) > aS + 2,
    });
    // Recovery: unload, full power, wings level, then ease out of the dive.
    const yBreak = s.position.y;
    let minY = yBreak;
    let unstalledAfter = -1;
    const t0 = s.time;
    s = flyA10(s, (x) => ({
      ...controls, throttle: 1,
      elevator: x.stalled ? -0.4 : clamp1(0.06 + 0.04 * (8 - x.derived.pitchDeg) - 0.1 * deg(x.derived.q)),
      aileron: bankTo(x, 0),
    }), 25, { each: (x) => { minY = Math.min(minY, x.position.y); if (unstalledAfter < 0 && !x.stalled) unstalledAfter = x.time - t0; } });
    return { s, warnKt, stallKt, bankAtBreak, unstalledAfter, lossFt: (yBreak - minY) * M_TO_FT };
  }

  it('clean, idle: stall warning first, breaks straight at 115–125 KIAS; unload + power recovers, < 800 ft lost', () => {
    const r = stall(0, false);
    log(`clean stall: warning ${r.warnKt.toFixed(0)} KIAS, break ${r.stallKt.toFixed(1)} KIAS, bank ${r.bankAtBreak.toFixed(1)}°, unstalled after ${r.unstalledAfter.toFixed(1)} s, lost ${r.lossFt.toFixed(0)} ft`);
    expect(r.stallKt).toBeGreaterThan(112);
    expect(r.stallKt).toBeLessThan(125);
    expect(r.warnKt - r.stallKt).toBeGreaterThan(4);
    expect(r.bankAtBreak).toBeLessThan(15);
    expect(r.unstalledAfter).toBeGreaterThan(0);
    expect(r.unstalledAfter).toBeLessThan(3);
    expect(r.lossFt).toBeLessThan(800);
    expect(r.s.crash).toBeNull();
    expect(r.s.stalled).toBe(false);
  });

  it('landing configuration (gear down, flaps DN), idle: breaks at 95–105 KIAS and recovers', () => {
    const r = stall(2, true);
    log(`landing-config stall: warning ${r.warnKt.toFixed(0)} KIAS, break ${r.stallKt.toFixed(1)} KIAS, bank ${r.bankAtBreak.toFixed(1)}°, lost ${r.lossFt.toFixed(0)} ft`);
    expect(r.stallKt).toBeGreaterThan(95);
    expect(r.stallKt).toBeLessThan(105);
    expect(r.bankAtBreak).toBeLessThan(15);
    expect(r.lossFt).toBeLessThan(900);
    expect(r.s.crash).toBeNull();
    expect(r.s.stalled).toBe(false);
  });

  it('departure-resistant: a held pro-spin input spins it slowly; opposite rudder + forward stick stop it in < 5 s, releasing the controls in < 10 s', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 15000 * FT_TO_M, iasKt: 150, gearDown: false }, FLAT_ENV, A10_CFG);
    const pro: Controls = { ...controls, gearDown: false, throttle: 0, elevator: 1, rudder: 1 };
    const spun = flyA10(state, pro, 10);
    const yaw = Math.abs(deg(spun.derived.r));
    expect(spun.stalled).toBe(true);
    expect(yaw).toBeGreaterThan(30);
    const stopAfter = (s0: AircraftState, pilot: (x: AircraftState) => Controls) => {
      let t = -1;
      flyA10(s0, pilot, 20, { each: (x) => { if (t < 0 && !x.stalled && Math.abs(x.derived.r) < 0.1) t = x.time - s0.time; }, until: () => t >= 0 });
      return t;
    };
    const pare = stopAfter(spun, (x) => ({ ...controls, gearDown: false, throttle: 0, elevator: -0.3, rudder: x.derived.r > 0.05 ? -1 : 0 }));
    const release = stopAfter(spun, () => ({ ...controls, gearDown: false, throttle: 0, elevator: 0, rudder: 0 }));
    log(`spin: yaw ${yaw.toFixed(0)} °/s after 10 s pro-spin; anti-spin stops it in ${pare.toFixed(1)} s, hands-off in ${release.toFixed(1)} s`);
    expect(pare).toBeGreaterThan(0);
    expect(pare).toBeLessThan(5);
    expect(release).toBeGreaterThan(0);
    expect(release).toBeLessThan(10);
  });
});

describe('A-10 approach and landing', () => {
  it('from a 6 km final at 140 KIAS (gear down, flaps DN): 3° glide, flare, touchdown 115–135 KIAS on the runway, stop with brakes + decelerons', () => {
    const base = approachControls(A10_CFG);
    const aim = A.spawn.approach.aimPointM;
    let s = createApproachState(RUNWAY_ENV, A10_CFG);
    expect(ias(s)).toBeCloseTo(140, 0);
    expect(s.gearPos).toBe(1);
    expect(s.flapsDeg).toBe(20);
    let td: AircraftState | null = null;
    let flaring = false;
    const pilot = (x: AircraftState): Controls => {
      if (x.onGround || td) {
        return {
          ...base, throttle: 0, speedBrake: true, elevator: x.derived.pitchDeg > 1 ? -0.2 : 0,
          brake: x.wheelContact[0] ? 1 : 0, rudder: clamp1(-0.2 * across(x) - 0.2 * headingError(x, 0)), aileron: bankTo(x, 0),
        };
      }
      const h = x.derived.altitudeAGL + A.geometry.leftMainWheel.y; // main-wheel height
      if (h < 10) flaring = true;
      const V = Math.hypot(x.velocity.x, x.velocity.y, x.velocity.z);
      const gamma = deg(Math.asin(x.velocity.y / V));
      const gDes = -deg(Math.atan2(Math.max(h, 0), Math.max(aim - along(x), 60)));
      const lat = clamp1(bankTo(x, Math.max(-10, Math.min(10, -0.3 * across(x)))));
      if (flaring) {
        const vsTarget = -0.6 - 0.12 * h;
        return { ...base, throttle: 0, elevator: clamp1(0.05 + 0.12 * (vsTarget - x.velocity.y) - 0.05 * deg(x.derived.q)), aileron: lat };
      }
      return {
        ...base,
        // 140 KIAS on final, bleeding to ~130 on short final (below ~150 ft).
        throttle: Math.max(0, Math.min(1, base.throttle + 0.02 * ((h > 45 ? 140 : 130) - ias(x)))),
        elevator: clamp1(0.08 * (gDes - gamma) - 0.05 * deg(x.derived.q)),
        aileron: lat,
      };
    };
    s = flyA10(s, pilot, 240, {
      each: (x) => { if (!td && x.touchdown) td = x; },
      until: (x) => !!td && x.derived.groundSpeed < 0.5,
    });
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(td).not.toBeNull();
    const t = (td as unknown as AircraftState).touchdown!;
    const rollout = along(s) - along(td as unknown as AircraftState);
    log(`landing: touchdown ${t.airspeedKt.toFixed(0)} KIAS ${t.verticalSpeedFpm.toFixed(0)} fpm pitch ${t.pitchDeg.toFixed(1)}° ${t.rating} at ${along(td as unknown as AircraftState).toFixed(0)} m, rollout ${rollout.toFixed(0)} m`);
    expect(t.onRunway).toBe(true);
    expect(t.airspeedKt).toBeGreaterThan(115);
    expect(t.airspeedKt).toBeLessThan(135);
    expect(['butter', 'smooth', 'firm']).toContain(t.rating);
    expect(t.pitchDeg, 'no tail strike').toBeLessThan(10);
    expect(rollout).toBeGreaterThan(300);
    expect(rollout).toBeLessThan(1200);
    expect(Math.abs(across(s))).toBeLessThan(10);
  });
});
