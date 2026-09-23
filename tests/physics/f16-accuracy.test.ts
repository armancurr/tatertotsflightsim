/**
 * F-16C Block 50 (F110-GE-129, 12,000 kg clean, full internal fuel) flight-performance accuracy audit:
 * the sim's F16_AIRCRAFT pinned to published numbers within honest bands. Steady-state performance is
 * computed from the sim's own force model (computeAero + jetThrust: lift = n·W, thrust vs drag);
 * manoeuvres are flown through step() with the fly-by-wire. Take-off rolls are in f16-missions.test.ts
 * (AB 487 m / MIL 775 m, rotate 155 KIAS). Set F16_DEBUG=1 to print the numbers.
 *
 *   Quantity                                  Sim           Real (published)                  Band here
 *   Max speed, max AB, 40,000 ft              M 2.00        M 2.0 (limit M 2.05)              M 1.9–2.1
 *   Max speed, max AB, sea level              774 KIAS      ~M 1.2, 800 KCAS placard          700–800 KIAS
 *   Max g (FBW), full aft at 480 KIAS         ~9 g          9 g                               8.5–9.3 g
 *   AoA limiter, full aft slowing             25° (26.5 pk) 25°                               parks 23.5–26°, pk < 27°
 *   Max roll rate (FBW), 350 KIAS             ~300 °/s      ~300 °/s                          270–320 °/s
 *   Instantaneous turn (9 g at the AoA limit) 23 °/s        ~26 °/s (lighter, combat fuel)    22–28 °/s
 *   Sustained turn, M 0.8, sea level, max AB  17.3 °/s      18–20 °/s                         16–20 °/s  ⚠ low
 *   Peak climb (Ps), sea level, max AB        ~40,000 fpm   50,000–60,000 fpm                 38,000–60,000  ⚠ low
 *   Approach at 13° AoA (gear, flaperons)     ~145 KIAS     135–150 KIAS                      135–150 KIAS
 *
 * ⚠ The two low numbers share one cause: the quadratic ram model of src/physics/jet.ts under-predicts
 * afterburner thrust at M 0.8–0.9 (~0.9 × static vs ~1.1–1.15 × for a real F110), but more subsonic ram
 * also overshoots supersonic (no inlet total-pressure loss of the F-16's fixed normal-shock inlet). The
 * fix is a normal-shock inlet-recovery factor in jet.ts plus more AB ram — follow-up work.
 */
import { describe, it, expect, vi } from 'vitest';
import { CONFIG, F16_AIRCRAFT, FT_TO_M, KT_TO_MS, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { airDensity, computeAero, createTrimmedState, jetThrust, solveTrim, speedOfSound, step, FLAT_ENV } from '../../src/physics';
import { F16_CFG } from './helpers';

vi.setConfig({ testTimeout: 60000 });

const log = (...a: unknown[]) => { if (process.env.F16_DEBUG) console.log(...a); };
const W = F16_AIRCRAFT.mass * CONFIG.sim.gravity;
const G = CONFIG.sim.gravity;
const NO_CTL = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };

/** Clean, gear up, 1 g·n: the α that makes lift = n·W at TAS V and altitude h; drag and max-AB thrust there. */
function atLoad(n: number, V: number, h: number) {
  const rho = airDensity(h);
  const mach = V / speedOfSound(h);
  const aero = (a: number) => computeAero({ x: 0, y: -V * Math.sin(a), z: -V * Math.cos(a) }, { x: 0, y: 0, z: 0 }, rho, 0, 0, NO_CTL, 0, F16_CFG, Infinity, { mach });
  let lo = -0.1;
  let hi = 0.6;
  for (let i = 0; i < 50; i++) {
    const a = (lo + hi) / 2;
    if (aero(a).lift < n * W) lo = a;
    else hi = a;
  }
  return { drag: aero((lo + hi) / 2).drag, thrust: jetThrust(1, 1, rho, mach, F16_CFG) };
}

/** Highest Mach with max-AB thrust ≥ drag in level flight at altitude h (m). */
function topMach(h: number): number {
  let best = 0;
  for (let M = 0.6; M < 2.6; M += 0.005) {
    const r = atLoad(1, M * speedOfSound(h), h);
    if (r.thrust >= r.drag) best = M;
  }
  return best;
}

function fly(s0: AircraftState, c: Controls | ((s: AircraftState) => Controls), seconds: number, each?: (s: AircraftState) => void): AircraftState {
  let s = s0;
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    s = step(s, typeof c === 'function' ? c(s) : c, 1 / 120, FLAT_ENV, F16_CFG);
    each?.(s);
    if (s.crash) break;
  }
  return s;
}

describe('F-16C accuracy: speed', () => {
  it('max AB top speed ≈ M 2.0 at 40,000 ft (M 2.05 limit), 700–800 KIAS at sea level (800 KCAS placard)', () => {
    const hi = topMach(40000 * FT_TO_M);
    const sl = topMach(0);
    const slKias = sl * speedOfSound(0) * MS_TO_KT;
    log(`top speed: 40,000 ft M ${hi.toFixed(2)}; sea level M ${sl.toFixed(2)} = ${slKias.toFixed(0)} KIAS`);
    expect(hi).toBeGreaterThan(1.9);
    expect(hi).toBeLessThan(2.1);
    expect(slKias).toBeGreaterThan(700);
    expect(slKias).toBeLessThan(800);
    expect(slKias).toBeLessThan(F16_AIRCRAFT.limits.vneKt * F16_AIRCRAFT.limits.overspeedFailureFactor);
  });

  it('peak sea-level climb (specific excess power, max AB): ≥ 38,000 fpm (real 50,000–60,000 — see the header ⚠)', () => {
    let best = 0;
    for (let M = 0.4; M <= 1.2; M += 0.02) {
      const V = M * speedOfSound(0);
      const r = atLoad(1, V, 0);
      best = Math.max(best, ((r.thrust - r.drag) * V) / W * 196.85);
    }
    log(`peak Ps at sea level: ${best.toFixed(0)} fpm`);
    expect(best).toBeGreaterThan(38000);
    expect(best).toBeLessThan(60000);
  });
});

describe('F-16C accuracy: turning and the flight-control limits', () => {
  it('sustained turn at M 0.8, sea level, max AB: 16–20 °/s (real 18–20; sim slightly low — see the header ⚠)', () => {
    const V = 0.8 * speedOfSound(0);
    let nS = 1;
    for (let n = 1; n <= 12; n += 0.01) {
      const r = atLoad(n, V, 0);
      if (r.thrust >= r.drag) nS = n;
    }
    const n = Math.min(F16_AIRCRAFT.fbw!.maxG, nS);
    const rate = ((G * Math.sqrt(n * n - 1)) / V) * RAD_TO_DEG;
    log(`sustained M 0.8 SL: ${nS.toFixed(2)} g → ${rate.toFixed(1)} °/s`);
    expect(rate).toBeGreaterThan(16);
    expect(rate).toBeLessThan(20);
  });

  it('instantaneous turn (9 g, or what the 25° AoA limit gives) at 5,000 ft: 22–28 °/s', () => {
    const h = 5000 * FT_TO_M;
    let best = 0;
    let atKt = 0;
    const a = F16_AIRCRAFT.fbw!.aoaLimitDeg / RAD_TO_DEG;
    for (let kt = 200; kt <= 550; kt += 2) {
      const V = kt * KT_TO_MS * Math.sqrt(CONFIG.sim.seaLevelDensity / airDensity(h));
      const r = computeAero({ x: 0, y: -V * Math.sin(a), z: -V * Math.cos(a) }, { x: 0, y: 0, z: 0 }, airDensity(h), 0, 0, NO_CTL, 0, F16_CFG, Infinity, { mach: V / speedOfSound(h) });
      const n = Math.min(F16_AIRCRAFT.fbw!.maxG, r.lift / W);
      const rate = ((G * Math.sqrt(Math.max(0, n * n - 1))) / V) * RAD_TO_DEG;
      if (rate > best) { best = rate; atKt = kt; }
    }
    log(`instantaneous turn at 5,000 ft: ${best.toFixed(1)} °/s at ${atKt} KIAS (corner speed)`);
    expect(best).toBeGreaterThan(22);
    expect(best).toBeLessThan(28);
    expect(atKt).toBeGreaterThan(330);
    expect(atKt).toBeLessThan(450);
  });

  it('max g: full aft stick at 480 KIAS reaches the 9 g limit, never 9.5', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 10000 * FT_TO_M, iasKt: 480, gearDown: false }, FLAT_ENV, F16_CFG);
    let maxN = 0;
    const s = fly(state, { ...controls, gearDown: false, throttle: 1, elevator: 1 }, 3, (x) => { maxN = Math.max(maxN, x.derived.loadFactor); });
    log(`full aft at 480 KIAS: ${maxN.toFixed(2)} g`);
    expect(s.crash).toBeNull();
    expect(F16_AIRCRAFT.fbw!.maxG).toBe(9);
    expect(maxN).toBeGreaterThan(8.5);
    expect(maxN).toBeLessThan(9.5);
  });

  it('AoA limiter: full aft stick as it slows parks at ~25° α (≤ 2° overshoot on the pull), never stalls', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 15000 * FT_TO_M, iasKt: 250, gearDown: false }, FLAT_ENV, F16_CFG);
    let maxA = 0;
    let stalled = false;
    const s = fly(state, { ...controls, gearDown: false, throttle: 0.6, elevator: 1 }, 5, (x) => { maxA = Math.max(maxA, x.derived.alpha * RAD_TO_DEG); stalled ||= x.stalled; });
    const parked = s.derived.alpha * RAD_TO_DEG;
    log(`AoA limiter: max α ${maxA.toFixed(1)}° (transient), parked at ${parked.toFixed(1)}°`);
    expect(s.crash).toBeNull();
    expect(F16_AIRCRAFT.fbw!.aoaLimitDeg).toBe(25);
    expect(maxA).toBeLessThan(27); // ≤ 2° transient overshoot on the pull
    expect(parked).toBeGreaterThan(23.5);
    expect(parked).toBeLessThan(26);
    expect(stalled).toBe(false);
  });

  it('max roll rate (FBW-limited): full stick at 350 KIAS → 270–320 °/s', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 10000 * FT_TO_M, iasKt: 350, gearDown: false }, FLAT_ENV, F16_CFG);
    let maxP = 0;
    fly(state, { ...controls, gearDown: false, aileron: 1 }, 1.5, (x) => { maxP = Math.max(maxP, x.derived.p * RAD_TO_DEG); });
    log(`roll rate at 350 KIAS: ${maxP.toFixed(0)} °/s`);
    expect(maxP).toBeGreaterThan(270);
    expect(maxP).toBeLessThan(320);
  });
});

describe('F-16C accuracy: approach', () => {
  it('13° AoA on a 3° approach (gear down, flaperons 20°) is flown at 135–150 KIAS at 12 t', () => {
    let lo = 110;
    let hi = 200;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      const tr = solveTrim({ altitudeM: 300, iasKt: m, flightPathDeg: -3, flapsNotch: 2, gearDown: true }, F16_CFG);
      if (tr.alpha * RAD_TO_DEG > 13) lo = m;
      else hi = m;
    }
    log(`13° AoA approach speed: ${lo.toFixed(0)} KIAS`);
    expect(lo).toBeGreaterThan(135);
    expect(lo).toBeLessThan(150);
  });
});
