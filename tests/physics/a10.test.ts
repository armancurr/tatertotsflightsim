/**
 * A-10C Thunderbolt II flight model — unit and property tests: the airframe numbers, the twin
 * TF34-GE-100A (no afterburner, slow spool, high-bypass lapse), the straight-wing lift curve (CLα,
 * CLmax, gentle stall, flaps), the decelerons, the thrust line, inertia, trim and the gear.
 * Real data: USAF fact sheet, Jane's, T.O. 1A-10C-1 summary numbers (see src/config.ts makeA10).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { A10_AIRCRAFT, A10_WEAPONS, CONFIG, F16_AIRCRAFT, FT_TO_M, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import type { EngineState } from '../../src/types';
import { getAircraftDef } from '../../src/fleet';
import {
  airDensity, computeAero, createInitialState, defaultControls, dragCoefficient, jetThrust, liftCoefficient, solveTrim,
  steadyJetEngine, step, stepJetEngine, FLAT_ENV,
} from '../../src/physics';
import { A10_CFG, DT } from './a10-helpers';
import { F16_CFG, allFinite } from './helpers';

const A = A10_AIRCRAFT;
const D = Math.PI / 180;
const RHO0 = CONFIG.sim.seaLevelDensity;
const NO_CTL = { elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0 };
const bodyVel = (V: number, a: number) => ({ x: 0, y: -V * Math.sin(a), z: -V * Math.cos(a) });

function clMax(flapsDeg: number): { a: number; cl: number } {
  let best = { a: 0, cl: -Infinity };
  for (let a = 0; a <= 40; a += 0.05) {
    const cl = liftCoefficient(a * D, flapsDeg, A10_CFG);
    if (cl > best.cl) best = { a, cl };
  }
  return best;
}

describe('A-10C airframe', () => {
  it('is in the fleet with its gun and Mavericks, and flies this config', () => {
    const def = getAircraftDef('a10');
    expect(def.config.aircraft).toBe(A10_AIRCRAFT);
    expect(def.config.weapons).toBe(A10_WEAPONS);
    expect(def.config.weapons.gun?.name).toMatch(/GAU-8/);
  });

  it('combat weight 16 t, wing 47.01 m² × 17.53 m (AR ≈ 6.5), g limits +7.33 / −3, Vne 450 KIAS', () => {
    expect(A.mass).toBe(16000);
    expect(A.wingArea).toBeCloseTo(47.01, 2);
    expect(A.wingSpan).toBeCloseTo(17.53, 2);
    const ar = (A.wingSpan * A.wingSpan) / A.wingArea;
    expect(ar).toBeGreaterThan(6.4);
    expect(ar).toBeLessThan(6.6);
    expect(A.limits.gLimitPos).toBeCloseTo(7.33, 2);
    expect(A.limits.gLimitNeg).toBe(-3);
    expect(A.limits.vneKt).toBe(450);
    expect(A.limits.structuralFailureG).toBeCloseTo(1.5 * 7.33, 0);
  });

  it('keeps the fixed geometry contract (span, wheels, fins, gun on the centreline)', () => {
    const g = A.geometry;
    const tips = g.structuralPoints.filter((p) => p.name.endsWith('Wingtip'));
    expect(Math.max(...tips.map((p) => Math.abs(p.x))) * 2).toBeCloseTo(17.53, 1);
    expect(g.length).toBeCloseTo(16.26, 2);
    expect(g.noseWheel).toEqual({ x: 0.3, y: -1.95, z: -4.85 });
    expect(g.leftMainWheel).toEqual({ x: -2.62, y: -1.95, z: 0.55 });
    expect(g.rightMainWheel).toEqual({ x: 2.62, y: -1.95, z: 0.55 });
    expect(g.verticalTailTop).toEqual({ x: 0, y: 2.52, z: 8.6 });
    expect(g.pilotEye).toEqual({ x: 0, y: 1.1, z: -4.3 });
    expect(A10_WEAPONS.gun!.muzzle.x).toBe(0);
  });

  it('direct hydraulic controls: no fly-by-wire; flaps UP / MVR 7° / DN 20°', () => {
    expect(A.fbw).toBeNull();
    expect(A.flaps.notchesDeg).toEqual([0, 7, 20]);
    expect(A.surfaces.flapMaxDeg).toBe(20);
  });

  it('inertia from the mass distribution: big roll inertia (long wing + stores), yaw ≈ pitch + roll', () => {
    const I = A.inertia;
    expect(I.roll).toBeGreaterThan(5 * F16_AIRCRAFT.inertia.roll);
    expect(I.roll).toBeGreaterThan(60000);
    expect(I.roll).toBeLessThan(120000);
    expect(I.pitch).toBeGreaterThan(100000);
    expect(I.pitch).toBeLessThan(170000);
    expect(I.yaw / (I.pitch + I.roll)).toBeGreaterThan(0.85);
    expect(I.yaw / (I.pitch + I.roll)).toBeLessThan(1.05);
  });
});

describe('TF34-GE-100A × 2 (no afterburner)', () => {
  const J = A.engine.jet!;

  it('a jet: 2 × 40.3 kN at sea-level static, military = maximum (no afterburner), a few kN at idle', () => {
    expect(A.engine.type).toBe('jet');
    expect(jetThrust(1, 0, RHO0, 0, A10_CFG) / 1000).toBeCloseTo(80.6, 0);
    expect(J.maxThrustN).toBe(J.milThrustN);
    expect(jetThrust(1, 1, RHO0, 0, A10_CFG)).toBeCloseTo(jetThrust(1, 0, RHO0, 0, A10_CFG), 6);
    const idle = jetThrust(0, 0, RHO0, 0, A10_CFG);
    expect(idle).toBeGreaterThan(2000);
    expect(idle).toBeLessThan(6000);
  });

  it('slow spool: idle → 95 % thrust takes 6–8 s (the F-16 takes ~4 s)', () => {
    const t95 = (cfg: typeof A10_CFG) => {
      let e = steadyJetEngine(0, RHO0, 0, cfg);
      const mil = jetThrust(1, 0, RHO0, 0, cfg);
      for (let i = 1; i <= 120 * 20; i++) {
        e = stepJetEngine(e, { throttle: cfg.aircraft.engine.jet!.abDetent, engineOn: true }, DT, RHO0, 0, 0, cfg);
        if (e.thrust >= 0.95 * mil) return i * DT;
      }
      return Infinity;
    };
    const a10 = t95(A10_CFG);
    expect(a10).toBeGreaterThan(6);
    expect(a10).toBeLessThan(8);
    expect(a10).toBeGreaterThan(t95(F16_CFG) + 1.5);
  });

  it('high-bypass lapse: at Mach 0.5 (sea level) ~60–75 % of static thrust; much more lapse than the F-16 dry', () => {
    const r = jetThrust(1, 0, RHO0, 0.5, A10_CFG) / jetThrust(1, 0, RHO0, 0, A10_CFG);
    expect(r).toBeGreaterThan(0.6);
    expect(r).toBeLessThan(0.75);
    expect(r).toBeLessThan(jetThrust(1, 0, RHO0, 0.5, F16_CFG) / jetThrust(1, 0, RHO0, 0, F16_CFG) - 0.1);
    // Altitude: 15,000 ft has ~64 % of the air → roughly 70 % of the thrust.
    const alt = jetThrust(1, 0, airDensity(15000 * FT_TO_M), 0, A10_CFG) / jetThrust(1, 0, RHO0, 0, A10_CFG);
    expect(alt).toBeGreaterThan(0.6);
    expect(alt).toBeLessThan(0.8);
  });

  it('fuzz: no throttle history ever lights an afterburner or exceeds military thrust', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ throttle: fc.double({ min: -0.5, max: 1.5, noNaN: true }), seconds: fc.double({ min: 0.05, max: 5, noNaN: true }), engineOn: fc.boolean() }), { minLength: 1, maxLength: 12 }),
      fc.double({ min: 0, max: 0.8, noNaN: true }),
      (segs, mach) => {
        let e: EngineState = steadyJetEngine(0, RHO0, mach, A10_CFG);
        const cap = jetThrust(1, 0, RHO0, mach, A10_CFG) + 1e-6;
        for (const sg of segs) {
          for (let i = 0; i < Math.round(sg.seconds / DT); i++) {
            e = stepJetEngine(e, { throttle: sg.throttle, engineOn: sg.engineOn }, DT, RHO0, mach, 200, A10_CFG);
            if ((e.afterburner ?? 0) !== 0 || !(e.thrust <= cap) || !allFinite(e)) return false;
          }
        }
        return true;
      },
    ), { numRuns: 60 });
  });
});

describe('straight-wing aerodynamics', () => {
  it('CLα ≈ 4.8–5.0 / rad (thick, AR 6.5 straight wing)', () => {
    const slope = (liftCoefficient(8 * D, 0, A10_CFG) - liftCoefficient(2 * D, 0, A10_CFG)) / (6 * D);
    expect(slope).toBeGreaterThan(4.8);
    expect(slope).toBeLessThan(5.0);
  });

  it('CLmax clean 1.4–1.5 at 16–18.5° α (slats out); MVR 7° and DN 20° flaps raise it to ~1.6 / ~1.9', () => {
    const clean = clMax(0);
    expect(clean.cl).toBeGreaterThan(1.4);
    expect(clean.cl).toBeLessThan(1.5);
    expect(clean.a).toBeGreaterThanOrEqual(16);
    expect(clean.a).toBeLessThanOrEqual(18.5);
    const mvr = clMax(7);
    const dn = clMax(20);
    expect(mvr.cl).toBeGreaterThan(clean.cl + 0.1);
    expect(dn.cl).toBeGreaterThan(1.85);
    expect(dn.cl).toBeLessThan(2.05);
  });

  it('static stall speeds at 16 t: clean 115–125 KIAS, landing (DN) 95–105 KIAS', () => {
    const W = A.mass * CONFIG.sim.gravity;
    const vs = (cl: number) => Math.sqrt((2 * W) / (RHO0 * A.wingArea * cl)) * MS_TO_KT;
    expect(vs(clMax(0).cl)).toBeGreaterThan(115);
    expect(vs(clMax(0).cl)).toBeLessThan(125);
    expect(vs(clMax(20).cl)).toBeGreaterThan(95);
    expect(vs(clMax(20).cl)).toBeLessThan(105);
  });

  it('gentle stall: 5° past the peak the wing still makes ≥ 75 % of CLmax (the Cessna < 70 %); no cliff', () => {
    const { a, cl } = clMax(0);
    expect(liftCoefficient((a + 5) * D, 0, A10_CFG)).toBeGreaterThan(0.75 * cl);
    let c172 = { a: 0, cl: 0 };
    for (let x = 0; x < 30; x += 0.05) if (liftCoefficient(x * D, 0, CONFIG) > c172.cl) c172 = { a: x, cl: liftCoefficient(x * D, 0, CONFIG) };
    expect(liftCoefficient((c172.a + 5) * D, 0, CONFIG)).toBeLessThan(0.7 * c172.cl);
    for (let x = a; x < a + 15; x += 0.1) {
      expect(Math.abs(liftCoefficient((x + 0.1) * D, 0, A10_CFG) - liftCoefficient(x * D, 0, A10_CFG))).toBeLessThan(0.02);
    }
    // Buffet margin: the stall warning sounds this far ahead of the break.
    expect(A.stall.warningMarginDeg).toBeGreaterThanOrEqual(3);
  });

  it('decelerons: +0.08–0.10 CD, and no pitch, roll or yaw change', () => {
    const v = bodyVel(140, 3 * D);
    const out = computeAero(v, { x: 0, y: 0, z: 0 }, RHO0, 0, 0, NO_CTL, 30000, A10_CFG, Infinity, { speedBrake: 1, mach: 0.41 });
    const inn = computeAero(v, { x: 0, y: 0, z: 0 }, RHO0, 0, 0, NO_CTL, 30000, A10_CFG, Infinity, { speedBrake: 0, mach: 0.41 });
    expect(out.CD - inn.CD).toBeGreaterThanOrEqual(0.08);
    expect(out.CD - inn.CD).toBeLessThanOrEqual(0.1);
    expect(out.tx).toBeCloseTo(inn.tx, 6);
    expect(out.ty).toBeCloseTo(inn.ty, 6);
    expect(out.tz).toBeCloseTo(inn.tz, 6);
  });

  it('thrust line just above the CG: full power pitches the nose down only a little (|ΔCm| < 0.02 at 250 KIAS)', () => {
    const V = 250 / MS_TO_KT;
    const v = bodyVel(V, 2 * D);
    const lo = computeAero(v, { x: 0, y: 0, z: 0 }, RHO0, 0, 0, NO_CTL, jetThrust(0, 0, RHO0, 0.38, A10_CFG), A10_CFG);
    const hi = computeAero(v, { x: 0, y: 0, z: 0 }, RHO0, 0, 0, NO_CTL, jetThrust(1, 0, RHO0, 0.38, A10_CFG), A10_CFG);
    const dCm = (hi.tx - lo.tx) / (0.5 * RHO0 * V * V * A.wingArea * A.meanChord);
    expect(dCm).toBeLessThan(0); // nose-down
    expect(dCm).toBeGreaterThan(-0.02);
  });

  it('thick-wing drag rise: the drag coefficient climbs past M ≈ 0.65 (450 KIAS / M 0.75 is a wall)', () => {
    const cd = (m: number) => dragCoefficient(1 * D, 0, 0, 0, A10_CFG, undefined, m);
    expect(cd(0.55)).toBeCloseTo(cd(0.3), 6);
    expect(cd(0.75)).toBeGreaterThan(1.5 * cd(0.5));
  });
});

describe('trim and the gear', () => {
  it('trims hands-off from 150 to 330 KIAS clean and on a 3° approach at 130–150 KIAS (flaps DN)', () => {
    for (let kt = 150; kt <= 330; kt += 30) {
      const tr = solveTrim({ altitudeM: 1000, iasKt: kt, gearDown: false }, A10_CFG);
      expect(tr.converged, `${kt} KIAS`).toBe(true);
      expect(Math.abs(tr.elevatorTrim)).toBeLessThan(0.8);
    }
    for (let kt = 130; kt <= 150; kt += 10) {
      const tr = solveTrim({ altitudeM: 300, iasKt: kt, flightPathDeg: -3, flapsNotch: 2, gearDown: true }, A10_CFG);
      expect(tr.converged, `approach ${kt} KIAS`).toBe(true);
      expect(tr.alpha * RAD_TO_DEG).toBeGreaterThan(2);
      expect(tr.alpha * RAD_TO_DEG).toBeLessThan(9);
    }
  });

  it('spawns resting level on its gear (struts 15–50 % compressed) and stays put with the parking brake', () => {
    let s = createInitialState(FLAT_ENV, A10_CFG);
    expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(0.5);
    for (const c of s.wheelCompression) {
      expect(c / A.geometry.strutTravel).toBeGreaterThan(0.15);
      expect(c / A.geometry.strutTravel).toBeLessThan(0.5);
    }
    let maxVs = 0;
    for (let i = 0; i < 120 * 10; i++) {
      s = step(s, { ...defaultControls(), parkingBrake: true }, DT, FLAT_ENV, A10_CFG);
      maxVs = Math.max(maxVs, Math.abs(s.derived.verticalSpeed));
    }
    expect(s.crash).toBeNull();
    expect(s.onGround).toBe(true);
    expect(maxVs).toBeLessThan(0.05);
    expect(s.derived.groundSpeed).toBeLessThan(0.05);
    expect(Math.abs(s.derived.pitchDeg)).toBeLessThan(0.5);
  });

  it('fuzz: spawns stable on any flat field elevation', () => {
    fc.assert(fc.property(fc.double({ min: -50, max: 3000, noNaN: true }), (h) => {
      const env = { ...FLAT_ENV, groundHeight: () => h };
      let s = createInitialState(env, A10_CFG);
      for (let i = 0; i < 120 * 3; i++) s = step(s, { ...defaultControls(), parkingBrake: true }, DT, env, A10_CFG);
      return s.crash === null && s.onGround && Math.abs(s.derived.verticalSpeed) < 0.05 && Math.abs(s.derived.pitchDeg) < 0.5;
    }), { numRuns: 15 });
  });
});
