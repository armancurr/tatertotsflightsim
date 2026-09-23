/**
 * Gun recoil (src/physics/recoil.ts + step()): while `controls.gunFiring` is true and the aircraft
 * carries a gun (`cfg.weapons.gun`), the physics pushes back with `gun.recoilN` along the barrel
 * (body +Z, tilted by the gun-line depression `boresightDownDeg`) at `gun.muzzle`, so the moment arm
 * gives the right small pitch/yaw:
 *   A-10C GAU-8/A: 45 kN on the centreline 0.55 m below the CG, gun line 2° down → the line of
 *     action passes ~0.3 m below the CG: a small nose-down moment, no yaw, no roll.
 *   F-16C M61A1: 18 kN in the left strake → a slight nose-left yaw.
 *   Cessna: no gun → nothing.
 * Layers: unit (the wrench), functional (a 2 s burst from trimmed flight), fuzz (random states and
 * trigger sequences: finite, and always slower along the nose than without firing).
 */
import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { A10_AIRCRAFT, A10_WEAPONS, CONFIG, F16_AIRCRAFT, F16_WEAPONS, FT_TO_M, KT_TO_MS, MS_TO_KT, type Config } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createInitialState, createTrimmedState, step, FLAT_ENV } from '../../src/physics';
import { gunRecoil } from '../../src/physics/recoil';
import { omegaFromPqr, quatFromEuler, worldToBody } from '../../src/physics/frames';
import { allFinite, deepFreeze, headingError } from './helpers';

vi.setConfig({ testTimeout: 60000 });

const DT = CONFIG.sim.fixedDt;
const A10: Config = { ...CONFIG, aircraft: A10_AIRCRAFT, weapons: A10_WEAPONS };
const F16: Config = { ...CONFIG, aircraft: F16_AIRCRAFT, weapons: F16_WEAPONS };
const D = Math.PI / 180;

/** Body-frame forward speed u (m/s) of a state, measured in a given body frame (default its own). */
const forward = (s: AircraftState, q = s.orientation) => -worldToBody(q, s.velocity).z;

function flyFor(s0: AircraftState, c: Controls, seconds: number, cfg: Config): AircraftState {
  let s = s0;
  for (let i = 0; i < Math.round(seconds / DT); i++) s = step(s, c, DT, FLAT_ENV, cfg);
  return s;
}

describe('gunRecoil — the wrench (unit)', () => {
  it('A-10: 45 kN along the 2°-depressed gun line, at the muzzle below the CG → small nose-down, no yaw/roll', () => {
    const g = A10_WEAPONS.gun!;
    const w = gunRecoil(true, A10);
    expect(Math.hypot(w.fx, w.fy, w.fz)).toBeCloseTo(g.recoilN, 6);
    expect(w.fz).toBeCloseTo(g.recoilN * Math.cos(g.boresightDownDeg * D), 6); // backwards (body +Z)
    expect(w.fy).toBeCloseTo(g.recoilN * Math.sin(g.boresightDownDeg * D), 6); // the barrel points 2° down → recoil 2° up
    expect(w.fx).toBe(0);
    // τ = r × F about the CG.
    const r = g.muzzle;
    expect(w.tx).toBeCloseTo(r.y * w.fz - r.z * w.fy, 6);
    expect(w.ty).toBeCloseTo(r.z * w.fx - r.x * w.fz, 6);
    expect(w.tz).toBeCloseTo(r.x * w.fy - r.y * w.fx, 6);
    expect(w.tx, 'nose-down (torque x < 0)').toBeLessThan(0);
    expect(Math.abs(w.ty)).toBeLessThan(1e-9);
    expect(Math.abs(w.tz)).toBeLessThan(1e-9);
    // Line of action ~0.3 m below the CG (|r × d|): "the gun line passes close to the CG".
    const arm = Math.abs(w.tx) / g.recoilN;
    expect(arm).toBeGreaterThan(0.2);
    expect(arm).toBeLessThan(0.4);
  });

  it('F-16: the M61A1 sits left of the centreline → a slight nose-left yaw moment', () => {
    const w = gunRecoil(true, F16);
    expect(w.fz).toBeCloseTo(F16_WEAPONS.gun!.recoilN, 6);
    // Yaw moment N (+ nose right) = −torque_body.y.
    expect(-w.ty, 'nose left').toBeLessThan(0);
    expect(Math.abs(w.ty)).toBeCloseTo(Math.abs(F16_WEAPONS.gun!.muzzle.x) * F16_WEAPONS.gun!.recoilN, 3);
    expect(Math.abs(w.tx)).toBeLessThan(1000); // muzzle 3 cm above the CG: next to no pitch
  });

  it('nothing when the trigger is off, gunFiring is undefined, or there is no gun (Cessna)', () => {
    for (const w of [gunRecoil(false, A10), gunRecoil(undefined, A10), gunRecoil(true, CONFIG), gunRecoil(true, { ...CONFIG, weapons: undefined } as unknown as Config)]) {
      expect([w.fx, w.fy, w.fz, w.tx, w.ty, w.tz]).toEqual([0, 0, 0, 0, 0, 0]);
    }
  });
});

describe('recoil in step()', () => {
  it('one step: the velocity change is exactly recoil/m·dt along the gun line (same state, same controls otherwise)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1000, iasKt: 300, gearDown: false }, FLAT_ENV, A10);
    deepFreeze(state);
    const a = step(state, controls, DT, FLAT_ENV, A10);
    const b = step(state, { ...controls, gunFiring: true }, DT, FLAT_ENV, A10);
    const dv = worldToBody(state.orientation, { x: b.velocity.x - a.velocity.x, y: b.velocity.y - a.velocity.y, z: b.velocity.z - a.velocity.z });
    const w = gunRecoil(true, A10);
    expect(dv.z).toBeCloseTo((w.fz / A10_AIRCRAFT.mass) * DT, 9);
    expect(dv.y).toBeCloseTo((w.fy / A10_AIRCRAFT.mass) * DT, 9);
    expect(dv.x).toBeCloseTo(0, 9);
    // Pitch acceleration from the moment arm (nose-down), none in yaw/roll.
    expect(b.angularVelocity.x - a.angularVelocity.x).toBeCloseTo((w.tx / A10_AIRCRAFT.inertia.pitch) * DT, 9);
    expect(b.angularVelocity.y - a.angularVelocity.y).toBeCloseTo(0, 12);
    expect(b.angularVelocity.z - a.angularVelocity.z).toBeCloseTo(0, 12);
  });

  it('the Cessna ignores gunFiring completely (no gun)', () => {
    const { state, controls } = createTrimmedState({ altitudeM: 1000, iasKt: 100, gearDown: true });
    const a = flyFor(state, controls, 1, CONFIG);
    const b = flyFor(state, { ...controls, gunFiring: true }, 1, CONFIG);
    expect(b).toEqual(a);
  });

  it('pure and deterministic with the gun firing', () => {
    const s0 = deepFreeze(createInitialState(FLAT_ENV, A10));
    const c: Controls = { ...defaultish(), throttle: 1, gunFiring: true };
    const a = flyFor(s0, c, 2, A10);
    const b = flyFor(s0, c, 2, A10);
    expect(b).toEqual(a);
  });
});

function defaultish(): Controls {
  return { throttle: 0, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true };
}

describe('a 2 s GAU-8 burst from trimmed flight (functional)', () => {
  /** Trimmed, hands-off at 300 KIAS level; fly 2 s with and without the gun. */
  function burst(cfg: Config, iasKt = 300, altFt = 3000) {
    const { state, controls } = createTrimmedState({ altitudeM: altFt * FT_TO_M, iasKt, gearDown: false }, FLAT_ENV, cfg);
    const quiet = flyFor(state, controls, 2, cfg);
    let maxPitch = 0;
    let maxHdg = 0;
    let s = state;
    for (let i = 0; i < Math.round(2 / DT); i++) {
      s = step(s, { ...controls, gunFiring: true }, DT, FLAT_ENV, cfg);
      maxPitch = Math.max(maxPitch, Math.abs(s.derived.pitchDeg - state.derived.pitchDeg));
      maxHdg = Math.max(maxHdg, Math.abs(headingError(s, state.derived.headingDeg)));
    }
    return { start: state, quiet, firing: s, maxPitch, maxHdg };
  }

  it('A-10 at 300 KIAS: ≈ 11 kt more speed lost over the burst than without firing (F·t/m), attitude nearly unchanged', () => {
    const r = burst(A10);
    const g = A10_WEAPONS.gun!;
    // Expected: the recoil impulse along the flight path, F·cos(gun line)·t/m (the small attitude change adds a little back).
    const expectedKt = ((g.recoilN * Math.cos(g.boresightDownDeg * D) * 2) / A10_AIRCRAFT.mass) * MS_TO_KT;
    expect(expectedKt).toBeGreaterThan(5);
    expect(expectedKt).toBeLessThan(12);
    const lostKt = (r.quiet.derived.ias - r.firing.derived.ias) * MS_TO_KT;
    if (process.env.RECOIL_DEBUG) console.log(`A-10 burst: expected ${expectedKt.toFixed(2)} kt, lost ${lostKt.toFixed(2)} kt more; max Δpitch ${r.maxPitch.toFixed(2)}°, max Δheading ${r.maxHdg.toFixed(2)}°`);
    expect(lostKt).toBeGreaterThan(0.75 * expectedKt);
    expect(lostKt).toBeLessThan(1.1 * expectedKt);
    expect(lostKt).toBeGreaterThan(5);
    expect(lostKt).toBeLessThan(12);
    expect(r.maxPitch).toBeLessThan(2);
    expect(r.maxHdg).toBeLessThan(1.5);
    expect(r.firing.crash).toBeNull();
  });

  it('F-16 (FBW) at 450 KIAS: a 2 s M61 burst barely moves it — the nose drifts ~1° left', () => {
    const r = burst(F16, 450);
    const lostKt = (r.quiet.derived.ias - r.firing.derived.ias) * MS_TO_KT;
    const expectedKt = ((F16_WEAPONS.gun!.recoilN * 2) / F16_AIRCRAFT.mass) * MS_TO_KT;
    expect(lostKt).toBeGreaterThan(0.75 * expectedKt);
    expect(lostKt).toBeLessThan(1.1 * expectedKt);
    expect(r.maxPitch).toBeLessThan(1);
    // ~11 kN·m nose-left: the FBW's sideslip loop (no integrator) lets ~0.7° of β and ~1° of heading through.
    expect(r.maxHdg).toBeLessThan(1.5);
    expect(headingError(r.firing, r.quiet.derived.headingDeg), 'nose left of the quiet run').toBeLessThanOrEqual(1e-6);
  });

  it('A-10 on the ground with the parking brake: firing never moves it forward or crashes it', () => {
    let s = createInitialState(FLAT_ENV, A10);
    const c: Controls = { ...defaultish(), parkingBrake: true, gunFiring: true };
    for (let i = 0; i < 120 * 3; i++) {
      s = step(s, c, DT, FLAT_ENV, A10);
      expect(allFinite(s)).toBe(true);
    }
    expect(s.crash).toBeNull();
    expect(s.onGround).toBe(true);
    expect(s.derived.groundSpeed).toBeLessThan(0.5);
  });
});

describe('recoil fuzz (property)', () => {
  const stateArb = fc.record({
    altitudeM: fc.double({ min: 300, max: 6000, noNaN: true }),
    iasKt: fc.double({ min: 150, max: 420, noNaN: true }),
    headingDeg: fc.double({ min: 0, max: 360, noNaN: true }),
    pitchDeg: fc.double({ min: -60, max: 60, noNaN: true }),
    rollDeg: fc.double({ min: -180, max: 180, noNaN: true }),
    p: fc.double({ min: -1, max: 1, noNaN: true }),
    q: fc.double({ min: -0.4, max: 0.4, noNaN: true }),
    r: fc.double({ min: -0.3, max: 0.3, noNaN: true }),
    f16: fc.boolean(),
  });
  const seqArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 60 });
  const ctlArb = fc.record({
    throttle: fc.double({ min: 0, max: 1, noNaN: true }),
    elevator: fc.double({ min: -1, max: 1, noNaN: true }),
    aileron: fc.double({ min: -1, max: 1, noNaN: true }),
    rudder: fc.double({ min: -1, max: 1, noNaN: true }),
  });

  interface Start { altitudeM: number; iasKt: number; headingDeg: number; pitchDeg: number; rollDeg: number; p: number; q: number; r: number; f16: boolean }
  function airborne(x: Start) {
    const cfg = x.f16 ? F16 : A10;
    const { state } = createTrimmedState({ altitudeM: x.altitudeM, iasKt: 250, gearDown: false }, FLAT_ENV, cfg);
    const q = quatFromEuler(x.headingDeg, x.pitchDeg, x.rollDeg);
    const V = x.iasKt * KT_TO_MS * Math.sqrt(CONFIG.sim.seaLevelDensity / state.derived.density);
    const h = x.headingDeg * D;
    const th = x.pitchDeg * D;
    const s: AircraftState = {
      ...state,
      orientation: q,
      velocity: { x: Math.sin(h) * Math.cos(th) * V, y: Math.sin(th) * V, z: -Math.cos(h) * Math.cos(th) * V },
      angularVelocity: omegaFromPqr(x.p, x.q, x.r),
    };
    return { s, cfg };
  }

  it('random airborne states × random trigger sequences: always finite, and always slower along the nose than the same run without firing', () => {
    fc.assert(fc.property(stateArb, seqArb, ctlArb, (x, seq, ctl) => {
      const { s: s0, cfg } = airborne(x);
      const base: Controls = { ...defaultish(), ...ctl, gearDown: false };
      let a = s0;
      let b = s0;
      let fired = false;
      for (const on of seq) {
        a = step(a, base, DT, FLAT_ENV, cfg);
        b = step(b, { ...base, gunFiring: on }, DT, FLAT_ENV, cfg);
        fired ||= on;
        if (!allFinite(b)) return false;
      }
      if (a.crash || b.crash) return true; // over-G/overspeed from the random start: nothing to compare
      // Compared in the same (quiet run's) body frame: firing only ever takes speed off along the nose.
      const du = forward(b, a.orientation) - forward(a, a.orientation);
      return fired ? du < 0 : du === 0;
    }), { numRuns: 150 });
  });

  it('random controls, full power, trigger held for 20 s: never NaN', () => {
    fc.assert(fc.property(ctlArb, fc.double({ min: 180, max: 350, noNaN: true }), (ctl, ias) => {
      const { state } = createTrimmedState({ altitudeM: 2000, iasKt: ias, gearDown: false }, FLAT_ENV, A10);
      let s = state;
      const c: Controls = { ...defaultish(), ...ctl, throttle: 1, gearDown: false, gunFiring: true };
      for (let i = 0; i < 120 * 20; i++) {
        s = step(s, c, DT, FLAT_ENV, A10);
        if (!allFinite(s)) return false;
        if (s.crash) break;
      }
      return true;
    }), { numRuns: 12 });
  });
});
