/**
 * Princess V50 (src/physics/hull.ts): the hull floats at its published draft, planes, reaches its
 * published top speed at rated rpm, turns banking into the turn, stops, goes astern, rides the
 * drawn sea, lies to its mooring lines, runs aground on a beach, bumps (or holes itself on) a
 * pontoon, rights itself, and stays deterministic, pure and cheap. The measured numbers are the
 * calibration table in the header of src/physics/hull.ts.
 */
import { describe, it, expect } from 'vitest';
import { MS_TO_KT, V50_AIRCRAFT } from '../../src/config';
import { createVesselState, hullGeometry, leverCommand, staticFloat, step, vesselSurfaceAt } from '../../src/physics';
import { bodyToWorld, quatFromEuler } from '../../src/physics/frames';
import type { AircraftState } from '../../src/types';
import { BEACH, DEEP_SEA, DT, V50_CALM, V50_CFG, atRest, drive, euler, helm, knots, pontoonEnv } from './v50-helpers';

const WC = V50_AIRCRAFT.watercraft!;

describe('Princess V50 hull: hydrostatics', () => {
  it('floats level at its half-load displacement, drawing ~1.1 m to the bottom of the drives', () => {
    const g = hullGeometry(WC, V50_AIRCRAFT.mass);
    expect(g.volume).toBeCloseTo(14200 / 1025, 3);
    const fl = staticFloat(V50_CALM);
    expect(Math.abs(fl.pitchDeg)).toBeLessThan(1);
    const s = atRest();
    // the lowest point of the hull (the pod skegs) below the water
    const lowest = Math.min(...WC.propulsors.map((p) => s.position.y + bodyToWorld(s.orientation, { x: p.position.x, y: p.position.y - p.diameter / 2, z: p.position.z }).y));
    expect(-lowest).toBeGreaterThan(0.95);
    expect(-lowest).toBeLessThan(1.25); // published draft 1.14 m
    // the hull's own draft (canoe body) and form
    expect(g.draft).toBeGreaterThan(0.5);
    expect(g.draft).toBeLessThan(0.8);
    expect(g.cb).toBeGreaterThan(0.35);
    expect(g.cb).toBeLessThan(0.55);
    expect(g.lwl).toBeGreaterThan(12);
    expect(g.lwl).toBeLessThan(14.2);
  });

  it('lies still in calm water with the lever in neutral', () => {
    const s0 = atRest();
    const s = drive(s0, 30, () => ({ throttle: 0 }));
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(0.5);
    expect(Math.abs(s.position.y - s0.position.y)).toBeLessThan(0.02);
    expect(s.phase).toBe('afloat');
    expect(s.vessel!.propulsors.every((p) => p.gear === 'neutral')).toBe(true);
  });

  it('rights itself from a 30° heel (positive stability)', () => {
    const s0 = atRest();
    const heeled: AircraftState = { ...s0, orientation: quatFromEuler(0, 0, 30) };
    const s = drive(heeled, 25, () => ({}));
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(3);
    expect(s.phase).toBe('afloat');
  });

  it('floats on the same Gerstner sea the renderer draws, heaving and pitching with it', () => {
    let s = createVesselState(DEEP_SEA, V50_CFG, { x: 0, z: 0, headingDeg: 35 }).state;
    const pitches: number[] = [];
    let err = 0;
    s = drive(s, 40, () => ({}), DEEP_SEA, V50_CFG, (t, st) => {
      if (t > 10) {
        pitches.push(euler(st).pitchDeg);
        // the surface under the CG this step (sampled before the step moved the hull ~0.1 m)
        err = Math.max(err, Math.abs(st.vessel!.surfaceY - vesselSurfaceAt(DEEP_SEA, st.position.x, st.position.z, st.vessel!.seaTime, V50_CFG)!));
      }
    });
    const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const sd = Math.sqrt(pitches.reduce((a, b) => a + (b - mean) ** 2, 0) / pitches.length);
    expect(sd).toBeGreaterThan(0.2); // it moves with the sea…
    expect(sd).toBeLessThan(6); // …without going wild
    expect(err).toBeLessThan(0.05);
    expect(s.phase).toBe('afloat');
  });
});

describe('Princess V50 hull: speed and power (calm sea)', () => {
  it('climbs over the hump bow-up, planes, and reaches ~34 kt at the rated 3,500 rpm', () => {
    let humpTrim = 0;
    let t25 = Infinity;
    let tPlane = Infinity;
    const s = drive(atRest(), 90, () => ({ throttle: 1 }), DEEP_SEA, V50_CALM, (t, st) => {
      const kt = knots(st);
      if (kt > 8 && kt < 20) humpTrim = Math.max(humpTrim, euler(st).pitchDeg);
      if (kt >= 25 && t25 === Infinity) t25 = t;
      if (st.vessel!.planing > 0.5 && tPlane === Infinity) tPlane = t;
    });
    expect(humpTrim).toBeGreaterThan(4); // 5–6° at the hump
    expect(humpTrim).toBeLessThan(9);
    expect(tPlane).toBeLessThan(20); // on the plane
    expect(t25).toBeLessThan(25);
    expect(knots(s)).toBeGreaterThan(33); // published 34 kt
    expect(knots(s)).toBeLessThan(36);
    const rpm = s.vessel!.propulsors[0].rpm;
    expect(rpm).toBeGreaterThan(3400); // the propellers are matched: rated rpm at top speed
    expect(rpm).toBeLessThanOrEqual(3500 * 1.02);
    expect(euler(s).pitchDeg).toBeGreaterThan(2.5); // running trim 3–4°
    expect(euler(s).pitchDeg).toBeLessThan(5);
    expect(s.vessel!.planing).toBeGreaterThan(0.7); // mostly carried by dynamic lift
  });

  it('cruises at ~30 kt with the lever back from the stop, and slow ahead is a few knots at low rpm', () => {
    const cruise = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
    expect(cruise.controls.throttle!).toBeGreaterThan(0.6);
    expect(cruise.controls.throttle!).toBeLessThan(1);
    const s = drive(cruise.state, 20, () => ({ throttle: cruise.controls.throttle }));
    expect(knots(s)).toBeGreaterThan(28);
    expect(knots(s)).toBeLessThan(32);
    const slow = drive(atRest(), 40, () => ({ throttle: 0.2 }));
    expect(knots(slow)).toBeGreaterThan(5);
    expect(knots(slow)).toBeLessThan(10);
    expect(slow.vessel!.propulsors[0].rpm).toBeLessThan(1500);
  });

  it('the lever: a neutral detent, ahead, astern (at reduced rpm)', () => {
    expect(leverCommand(0.05, WC).gear).toBe('neutral');
    expect(leverCommand(-0.05, WC).gear).toBe('neutral');
    expect(leverCommand(0.5, WC).gear).toBe('ahead');
    expect(leverCommand(-0.5, WC).gear).toBe('astern');
    expect(leverCommand(1, WC).rpm).toBe(WC.engine.maxRpm);
    expect(leverCommand(-1, WC).rpm).toBeLessThan(WC.engine.maxRpm * 0.7);
  });

  it('goes astern', () => {
    const s = drive(atRest(), 30, () => ({ throttle: -0.6 }));
    expect(s.vessel!.speedMs).toBeLessThan(-2.5);
    expect(knots(s)).toBeGreaterThan(-14);
    expect(Math.abs(euler(s).headingDeg - 0) % 360).toBeLessThan(5);
  });

  it('crash-stops from 30 kt within ~15 s and under 200 m', () => {
    const c = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
    let tStop = Infinity;
    let dStop = Infinity;
    drive(c.state, 30, (t) => ({ throttle: t < 0.5 ? c.controls.throttle : -1 }), DEEP_SEA, V50_CALM, (t, st) => {
      if (tStop === Infinity && st.vessel!.speedMs <= 0) {
        tStop = t;
        dStop = -st.position.z;
      }
    });
    expect(tStop).toBeLessThan(16);
    expect(dStop).toBeLessThan(200);
  });
});

describe('Princess V50 hull: handling', () => {
  it('hard over at 30 kt: banks INTO the turn, ~120 m circle, no capsize', () => {
    const c = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
    const xs: number[] = [];
    let roll = 0;
    const s = drive(c.state, 40, (t) => ({ throttle: c.controls.throttle, rudder: t > 1 ? 1 : 0 }), DEEP_SEA, V50_CALM, (t, st) => {
      if (t > 8) {
        xs.push(st.position.x);
        roll = Math.max(roll, euler(st).rollDeg);
      }
    });
    expect(s.phase).toBe('afloat');
    expect(roll).toBeGreaterThan(3); // + = starboard down: into a starboard turn
    expect(roll).toBeLessThan(20);
    const d = Math.max(...xs) - Math.min(...xs);
    expect(d).toBeGreaterThan(70);
    expect(d).toBeLessThan(220);
    expect(s.derived.r).toBeGreaterThan(0.1); // still turning to starboard
  });

  it('slow speed: turns tightly (a few boat lengths), heeling outward like a displacement hull', () => {
    const xs: number[] = [];
    let roll = 0;
    drive(atRest(), 80, (t) => ({ throttle: 0.2, rudder: t > 20 ? -1 : 0 }), DEEP_SEA, V50_CALM, (t, st) => {
      if (t > 40) {
        xs.push(st.position.x);
        roll = Math.max(roll, euler(st).rollDeg);
      }
    });
    const d = Math.max(...xs) - Math.min(...xs);
    expect(d).toBeGreaterThan(35);
    expect(d).toBeLessThan(110);
    expect(roll).toBeGreaterThan(0); // turning to port, heeled to starboard (outward)
    expect(roll).toBeLessThan(5);
  });

  it('the drives turn less at speed (IPS steering limits)', () => {
    const c = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
    const fast = drive(c.state, 3, () => ({ throttle: c.controls.throttle, rudder: 1 }));
    const slow = drive(atRest(), 3, () => ({ throttle: 0.1, rudder: 1 }));
    expect(slow.vessel!.propulsors[0].steerDeg).toBeGreaterThan(20);
    expect(fast.vessel!.propulsors[0].steerDeg).toBeLessThan(14);
  });

  it('trim tabs down bring the bow down on the plane', () => {
    const c = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 28 });
    const up = drive(c.state, 15, () => ({ throttle: c.controls.throttle }));
    const down = drive(c.state, 15, () => ({ throttle: c.controls.throttle, elevatorTrim: -1 }));
    expect(down.vessel!.tabs).toBeGreaterThan(0.9);
    expect(euler(down).pitchDeg).toBeLessThan(euler(up).pitchDeg - 0.5);
  });
});

describe('Princess V50 hull: the berth, the shore and structures', () => {
  it('lies to its mooring lines in the sea and wind, and casts off when the lever goes into gear', () => {
    const s0 = createVesselState(DEEP_SEA, V50_CFG, { x: 0, z: 0, headingDeg: 0, moored: true }).state;
    let maxOff = 0;
    const held = drive(s0, 30, () => ({ throttle: 0 }), DEEP_SEA, V50_CFG, (_t, st) => {
      maxOff = Math.max(maxOff, Math.hypot(st.position.x, st.position.z));
    });
    expect(maxOff).toBeLessThan(1.5);
    expect(held.vessel!.mooring).not.toBeNull();
    const off = drive(held, 10, () => ({ throttle: 0.2 }), DEEP_SEA, V50_CFG);
    expect(off.vessel!.mooring).toBeNull();
    expect(-off.position.z).toBeGreaterThan(5);
  });

  it('runs gently aground on a shelving beach at dead slow (no damage) and backs off astern', () => {
    let aground = false;
    let s = drive(atRest(BEACH), 150, () => ({ throttle: 0.09 }), BEACH, V50_CALM, (_t, st) => {
      aground ||= st.vessel!.aground;
    });
    expect(aground).toBe(true);
    expect(s.phase).toBe('afloat');
    expect(knots(s)).toBeLessThan(1.5);
    expect(s.vessel!.depthUnderKeel).toBeLessThan(0.3);
    s = drive(s, 40, () => ({ throttle: -1 }), BEACH, V50_CALM);
    expect(s.vessel!.aground).toBe(false);
    expect(s.phase).toBe('afloat');
  });

  it('driven hard onto the beach, the hull is holed', () => {
    const c = createVesselState(BEACH, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 28 });
    const s = drive(c.state, 30, () => ({ throttle: 1 }), BEACH, V50_CALM);
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toMatch(/aground/i);
  });

  it('bumps a pontoon at walking pace without damage, and is held off it', () => {
    const env = pontoonEnv(-40);
    let touched = false;
    const s = drive(atRest(env), 60, () => ({ throttle: 0.12 }), env, V50_CALM, (_t, st) => {
      touched ||= st.vessel!.aground;
    });
    expect(touched).toBe(true);
    expect(s.phase).toBe('afloat');
    // the stem stays out of the pontoon (within the contact spring's give)
    const stem = s.position.z + bodyToWorld(s.orientation, { x: 0, y: 0, z: WC.hull.stations[0].z }).z;
    expect(stem).toBeGreaterThan(-40 - 0.6);
  });

  it('rammed at speed, a pontoon holes the hull', () => {
    const env = pontoonEnv(-150);
    const c = createVesselState(env, V50_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 20 });
    const s = drive(c.state, 20, () => ({ throttle: c.controls.throttle }), env, V50_CALM);
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toMatch(/collision/i);
  });
});

describe('Princess V50 hull: engines, purity, cost', () => {
  it('E stops the engines (no thrust) and restarts them after the crank', () => {
    const run = drive(atRest(), 10, () => ({ throttle: 0.5 }));
    const off = drive(run, 5, () => ({ throttle: 0.5, engineOn: false }));
    expect(off.engine.running).toBe(false);
    // (the stopped propellers only windmill: a little drag, no thrust)
    expect(off.vessel!.propulsors.every((p) => p.thrust < 0 && p.thrust > -400)).toBe(true);
    let cranked = false;
    const on = drive(off, 6, () => ({ throttle: 0, engineOn: true }), DEEP_SEA, V50_CALM, (_t, st) => {
      if (st.engine.starting) cranked = true;
    });
    expect(cranked).toBe(true);
    expect(on.engine.running).toBe(true);
    expect(on.vessel!.propulsors[0].rpm).toBeGreaterThan(600);
  });

  it('is pure and deterministic', () => {
    const s0 = createVesselState(DEEP_SEA, V50_CFG, { x: 10, z: -20, headingDeg: 120, speedKt: 18 }).state;
    const frozen = JSON.stringify(s0);
    const a = drive(s0, 5, (t) => ({ throttle: 0.7, rudder: Math.sin(t) }), DEEP_SEA, V50_CFG);
    const b = drive(s0, 5, (t) => ({ throttle: 0.7, rudder: Math.sin(t) }), DEEP_SEA, V50_CFG);
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a step costs well under 0.2 ms', () => {
    let s = createVesselState(DEEP_SEA, V50_CFG, { x: 0, z: 0, headingDeg: 0, speedKt: 25 }).state;
    const c = helm({ throttle: 0.9, rudder: 0.3 });
    for (let i = 0; i < 200; i++) s = step(s, c, DT, DEEP_SEA, V50_CFG);
    const t0 = performance.now();
    const n = 2000;
    for (let i = 0; i < n; i++) s = step(s, c, DT, DEEP_SEA, V50_CFG);
    const us = ((performance.now() - t0) * 1000) / n;
    expect(us).toBeLessThan(200);
  });

  it('knots() and the derived speeds agree', () => {
    const c = createVesselState(DEEP_SEA, V50_CALM, { x: 0, z: 0, headingDeg: 90, speedKt: 20 });
    const s = drive(c.state, 5, () => ({ throttle: c.controls.throttle }));
    expect(Math.abs(s.derived.groundSpeed * MS_TO_KT - knots(s))).toBeLessThan(1);
    expect(s.derived.headingDeg).toBeGreaterThan(85);
    expect(s.derived.headingDeg).toBeLessThan(95);
  });
});
