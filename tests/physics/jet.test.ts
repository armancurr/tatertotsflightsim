/**
 * The F-16's F110 turbofan: static thrust (dry / afterburner), lapse with density, ram effect,
 * spool-up lag, the afterburner detent and ramp, core % as rpm, start/stop — plus a fuzz of random
 * throttle histories. And that the Cessna keeps its piston engine.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, F16_AIRCRAFT } from '../../src/config';
import type { EngineState } from '../../src/types';
import { airDensity } from '../../src/physics';
import { jetAbTarget, jetCoreTarget, jetThrust, steadyJetEngine, stepJetEngine } from '../../src/physics/jet';
import { DT, F16_CFG } from './helpers';

const J = F16_AIRCRAFT.engine.jet!;
const RHO0 = CONFIG.sim.seaLevelDensity;
const ctl = (throttle: number, engineOn = true) => ({ throttle, engineOn });

/** Run the engine at a fixed throttle for `seconds` (sea level, static unless mach given). */
function run(e: EngineState, throttle: number, seconds: number, each?: (e: EngineState, t: number) => void, mach = 0, rho = RHO0): EngineState {
  let s = e;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    s = stepJetEngine(s, ctl(throttle), DT, rho, mach, 0, F16_CFG);
    each?.(s, (i + 1) * DT);
  }
  return s;
}

describe('engine type', () => {
  it('the F-16 has a jet, the Cessna a piston engine', () => {
    expect(F16_AIRCRAFT.engine.type).toBe('jet');
    expect(CONFIG.aircraft.engine.type).toBe('piston');
    expect(CONFIG.aircraft.engine.jet).toBeNull();
  });
});

describe('F110 thrust', () => {
  it('sea-level static: ≈ 76 kN military, ≈ 129 kN full afterburner, a few kN at idle', () => {
    expect(jetThrust(1, 0, RHO0, 0, F16_CFG) / 1000).toBeCloseTo(76.3, 0);
    expect(jetThrust(1, 1, RHO0, 0, F16_CFG) / 1000).toBeCloseTo(129, 0);
    const idle = jetThrust(0, 0, RHO0, 0, F16_CFG);
    expect(idle).toBeGreaterThan(2000);
    expect(idle).toBeLessThan(6000);
  });

  it('falls with density (lapse); dips a little at low Mach (momentum drag) and recovers with ram, the afterburner most', () => {
    const rho10k = airDensity(10000);
    expect(jetThrust(1, 0, rho10k, 0, F16_CFG)).toBeLessThan(0.5 * jetThrust(1, 0, RHO0, 0, F16_CFG));
    const s0 = jetThrust(1, 0, RHO0, 0, F16_CFG);
    expect(jetThrust(1, 0, RHO0, 0.3, F16_CFG)).toBeLessThan(s0);
    expect(jetThrust(1, 0, RHO0, 0.3, F16_CFG)).toBeGreaterThan(0.85 * s0);
    expect(jetThrust(1, 1, rho10k, 1.6, F16_CFG)).toBeGreaterThan(jetThrust(1, 1, rho10k, 1, F16_CFG));
    // Max AB at M 0.9, sea level: ~1.1 × static (ram), as for a real F110.
    expect(jetThrust(1, 1, RHO0, 0.9, F16_CFG) / jetThrust(1, 1, RHO0, 0, F16_CFG)).toBeGreaterThan(1.03);
    const abGain = jetThrust(1, 1, rho10k, 1.8, F16_CFG) / jetThrust(1, 1, rho10k, 0, F16_CFG);
    const dryGain = jetThrust(1, 0, rho10k, 1.8, F16_CFG) / jetThrust(1, 0, rho10k, 0, F16_CFG);
    expect(abGain).toBeGreaterThan(dryGain);
  });

  it('speed limits roll thrust off: dynamic pressure low down (past ~M 1.3), ram temperature up high (past ~M 3.1)', () => {
    const rho40k = airDensity(12192);
    expect(jetThrust(1, 1, RHO0, 1.6, F16_CFG)).toBeLessThan(0.1 * jetThrust(1, 1, RHO0, 1.1, F16_CFG));
    expect(jetThrust(1, 1, rho40k, 3, F16_CFG)).toBeGreaterThan(jetThrust(1, 1, rho40k, 2, F16_CFG));
    expect(jetThrust(1, 1, rho40k, 3.4, F16_CFG)).toBeLessThan(0.1 * jetThrust(1, 1, rho40k, 3, F16_CFG));
    // Aircraft without the limits configured are untouched (the A-10's subsonic fans).
    const noLimits = { ...F16_CFG, aircraft: { ...F16_AIRCRAFT, engine: { ...F16_AIRCRAFT.engine, jet: { ...J, ramTempLimitK: undefined, dynamicPressureLimitPa: undefined } } } };
    expect(jetThrust(1, 1, RHO0, 1.5, noLimits)).toBeGreaterThan(jetThrust(1, 1, RHO0, 1.5, F16_CFG));
  });

  it('throttle mapping: idle → military below the detent, afterburner above it', () => {
    expect(jetCoreTarget(0, F16_CFG)).toBe(0);
    expect(jetCoreTarget(J.abDetent, F16_CFG)).toBe(1);
    expect(jetCoreTarget(1, F16_CFG)).toBe(1);
    expect(jetAbTarget(J.abDetent - 0.01, F16_CFG)).toBe(0);
    expect(jetAbTarget(J.abDetent + 0.001, F16_CFG)).toBeGreaterThanOrEqual(J.abMin - 0.01);
    expect(jetAbTarget(1, F16_CFG)).toBe(1);
  });
});

describe('F110 dynamics', () => {
  it('spools idle → military in ~4–5 s (95 % thrust), slowly at first', () => {
    const e0 = steadyJetEngine(0, RHO0, 0, F16_CFG);
    const mil = jetThrust(1, 0, RHO0, 0, F16_CFG);
    let t95 = Infinity;
    let at1s = 0;
    run(e0, J.abDetent, 8, (e, t) => {
      if (Math.abs(t - 1) < DT / 2) at1s = e.thrust;
      if (t95 === Infinity && e.thrust >= 0.95 * mil) t95 = t;
    });
    expect(t95).toBeGreaterThan(3.5);
    expect(t95).toBeLessThan(5.5);
    expect(at1s).toBeLessThan(0.4 * mil);
  });

  it('reports core % as rpm: ≈ 70 % at idle, 100 % at military', () => {
    expect(steadyJetEngine(0, RHO0, 0, F16_CFG).rpm).toBeCloseTo(70, 0);
    expect(steadyJetEngine(1, RHO0, 0, F16_CFG).rpm).toBeCloseTo(100, 0);
    const e = run(steadyJetEngine(0, RHO0, 0, F16_CFG), J.abDetent, 10);
    expect(e.rpm).toBeGreaterThan(99);
    expect(e.rpm).toBeLessThan(101);
  });

  it('afterburner: stays out below the detent; lights past it at military and ramps in ~1 s; cuts quickly', () => {
    const mil = steadyJetEngine(1, RHO0, 0, F16_CFG);
    const belowDetent = run(mil, J.abDetent - 0.02, 3);
    expect(belowDetent.afterburner ?? 0).toBe(0);
    let tFull = Infinity;
    const lit = run(mil, 1, 3, (e, t) => { if (tFull === Infinity && (e.afterburner ?? 0) >= 0.99) tFull = t; });
    expect(tFull).toBeGreaterThan(0.5);
    expect(tFull).toBeLessThan(1.5);
    expect(lit.thrust / 1000).toBeGreaterThan(125);
    let tOut = Infinity;
    run(lit, 0.8, 2, (e, t) => { if (tOut === Infinity && (e.afterburner ?? 0) === 0) tOut = t; });
    expect(tOut).toBeLessThan(0.6);
  });

  it('the afterburner will not light until the core is near military (slam from idle)', () => {
    let abBeforeCore = false;
    run(steadyJetEngine(0, RHO0, 0, F16_CFG), 1, 6, (e) => {
      if ((e.afterburner ?? 0) > 0 && e.power < J.abLightCore - 1e-9) abBeforeCore = true;
    });
    expect(abBeforeCore).toBe(false);
  });

  it('shut down: no thrust, the core spins down to windmilling; switched on: starts after startTime', () => {
    let e = steadyJetEngine(1, RHO0, 0, F16_CFG);
    for (let i = 0; i < 120 * 20; i++) e = stepJetEngine(e, ctl(0.5, false), DT, RHO0, 0.5, 300, F16_CFG);
    expect(e.running).toBe(false);
    expect(e.thrust).toBe(0);
    expect(e.afterburner ?? 0).toBe(0);
    expect(e.rpm).toBeGreaterThan(5); // windmilling at 300 kt
    expect(e.rpm).toBeLessThan(30);
    let startedAt = Infinity;
    for (let i = 0; i < 120 * 15; i++) {
      e = stepJetEngine(e, ctl(0), DT, RHO0, 0, 0, F16_CFG);
      if (e.running && startedAt === Infinity) startedAt = (i + 1) * DT;
    }
    expect(startedAt).toBeCloseTo(F16_AIRCRAFT.engine.startTime, 0);
    expect(e.rpm).toBeGreaterThan(65);
  });
});

describe('fuzz: random throttle histories', () => {
  it('thrust, core and afterburner always finite and within their physical ranges', () => {
    const seg = fc.record({
      throttle: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
      on: fc.boolean(),
      seconds: fc.double({ min: 0.05, max: 4, noNaN: true }),
      alt: fc.double({ min: -100, max: 18000, noNaN: true }),
      mach: fc.double({ min: 0, max: 2.2, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 12 }), (script) => {
        let e = steadyJetEngine(0, RHO0, 0, F16_CFG);
        for (const g of script) {
          const rho = airDensity(g.alt);
          const tMax = jetThrust(1, 1, rho, g.mach, F16_CFG);
          for (let i = 0; i < Math.round(g.seconds / DT); i++) {
            e = stepJetEngine(e, ctl(g.throttle, g.on), DT, rho, g.mach, g.mach * 600, F16_CFG);
            const ab = e.afterburner ?? 0;
            if (![e.thrust, e.power, e.rpm, ab].every(Number.isFinite)) return false;
            if (e.thrust < 0 || e.thrust > tMax + 1e-6) return false;
            if (e.power < 0 || e.power > 1 || ab < 0 || ab > 1) return false;
            if (e.rpm < 0 || e.rpm > 105) return false;
          }
        }
        return true;
      }),
      { numRuns: 60 },
    );
  });
});
