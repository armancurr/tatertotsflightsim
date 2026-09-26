/**
 * MS Tater Star, the Fantasy-class cruise ship (src/physics/hull.ts, CRUISE_AIRCRAFT): the hull
 * floats at the published 7.75 m draft, level, with a positive GM and a ~20 s roll; reaches the
 * published ~22 kt at full power, holds the 21 kt service speed, crash-stops in a few ship lengths,
 * turns in ~4 lengths heeling outward; and its tunnel thrusters (← / →) turn her on the spot at
 * 0 kt and do nothing at 15 kt while A / D alone put the rudders over. The measured numbers are the
 * cruise-ship calibration table in the header of src/physics/hull.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { CRUISE_AIRCRAFT, V50_AIRCRAFT } from '../../src/config';
import { createVesselState, hullGeometry, leverCommand, staticFloat, step } from '../../src/physics';
import { thrusterEffect } from '../../src/physics/hull';
import { bodyToWorld, quatFromEuler } from '../../src/physics/frames';
import type { AircraftState, Environment } from '../../src/types';
import { DT, V50_CALM, atRest, drive, euler, helm, knots } from './v50-helpers';
import { CRUISE_CALM, CRUISE_CFG, OCEAN, WC, shipAtRest } from './cruise-helpers';

// long scripted voyages (minutes of ship time at 120 Hz): generous timeouts for a loaded machine
vi.setConfig({ testTimeout: 180000 });

const L = CRUISE_AIRCRAFT.geometry.length;
const SHAFTS = WC.propulsors.filter((p) => p.type === 'shaft');
const THRUSTERS = WC.propulsors.map((p, i) => ({ p, i })).filter((t) => t.p.type === 'thruster');
const underway = (kt: number, env: Environment = OCEAN) => createVesselState(env, CRUISE_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: kt });

describe('Tater Star: the configuration', () => {
  it('is a displacement hull of the published size with two shaft propellers and six tunnel thrusters', () => {
    const st = WC.hull.stations;
    expect(WC.hull.kind).toBe('displacement');
    expect(WC.hull.planingLift).toBe(0);
    expect(st[st.length - 1].z - st[0].z).toBeCloseTo(260.6, 1);
    expect(2 * Math.max(...st.map((s) => s.deckHalf))).toBeCloseTo(31.5, 2);
    expect(SHAFTS.length).toBe(2);
    expect(THRUSTERS.length).toBe(6);
    expect(THRUSTERS.filter((t) => t.p.position.z < 0).length).toBe(3);
    for (const { p } of THRUSTERS) {
      expect(p.thruster!.maxThrustN).toBeGreaterThan(150000);
      expect(p.thruster!.fadeKt).toBeLessThanOrEqual(6);
    }
    // the shafts first (the helm's tachs and the engine voice read propulsors 0 and 1)
    expect(WC.propulsors[0].type).toBe('shaft');
    expect(WC.propulsors[1].type).toBe('shaft');
    // parallel midbody: several identical widest stations
    expect(st.filter((s) => s.deckHalf === 15.75 && s.chineHalf === 15.25).length).toBeGreaterThanOrEqual(2);
  });

  it('every propeller and thruster tunnel lies inside / under the hull, below the waterline', () => {
    const g = hullGeometry(WC, CRUISE_AIRCRAFT.mass);
    for (const p of WC.propulsors) {
      expect(p.position.y + p.diameter / 2, `${p.type} @${p.position.z}`).toBeLessThan(g.waterlineY - 1);
      const s = WC.hull.stations;
      expect(p.position.z).toBeGreaterThan(s[0].z);
      expect(p.position.z).toBeLessThan(s[s.length - 1].z);
    }
  });
});

describe('Tater Star hull: hydrostatics', () => {
  it('floats level at her full-load displacement, drawing the published 7.75 m', () => {
    const g = hullGeometry(WC, CRUISE_AIRCRAFT.mass);
    expect(g.volume).toBeCloseTo(CRUISE_AIRCRAFT.mass / 1025, 0);
    expect(Math.abs(staticFloat(CRUISE_CALM).pitchDeg)).toBeLessThan(0.3);
    const s = shipAtRest();
    const keel = Math.min(...WC.hull.stations.map((st) => s.position.y + bodyToWorld(s.orientation, { x: 0, y: st.keelY, z: st.z }).y));
    expect(-keel).toBeGreaterThan(7.5);
    expect(-keel).toBeLessThan(8.0);
    expect(g.lwl).toBeGreaterThan(220);
    expect(g.lwl).toBeLessThan(245);
    expect(g.cb).toBeGreaterThan(0.55);
    expect(g.cb).toBeLessThan(0.75);
  });

  it('lies still in calm water with the lever in neutral', () => {
    const s0 = shipAtRest();
    const s = drive(s0, 60, () => ({ throttle: 0 }), OCEAN, CRUISE_CALM);
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(0.5);
    expect(Math.abs(s.position.y - s0.position.y)).toBeLessThan(0.02);
    expect(s.phase).toBe('afloat');
  });

  it('has a positive GM: rights from a 20° heel with a ~20 s roll period', () => {
    const s0 = shipAtRest();
    const heeled: AircraftState = { ...s0, orientation: quatFromEuler(0, euler(s0).pitchDeg, 20) };
    const rolls: number[] = [];
    const s = drive(heeled, 90, () => ({}), OCEAN, CRUISE_CALM, (_t, st) => rolls.push(euler(st).rollDeg));
    const down: number[] = [];
    for (let i = 1; i < rolls.length; i++) if (rolls[i - 1] > 0 && rolls[i] <= 0) down.push(i * DT);
    expect(down.length).toBeGreaterThanOrEqual(2);
    const period = down[1] - down[0];
    expect(period).toBeGreaterThan(15);
    expect(period).toBeLessThan(26);
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(3);
    expect(s.phase).toBe('afloat');
  });

  it('rides the default sea: barely pitching, no slamming', () => {
    let s = createVesselState(OCEAN, CRUISE_CFG, { x: 0, z: 0, headingDeg: 35 }).state;
    const pitches: number[] = [];
    s = drive(s, 60, () => ({}), OCEAN, CRUISE_CFG, (t, st) => {
      if (t > 10) pitches.push(euler(st).pitchDeg);
    });
    const mean = pitches.reduce((a, b) => a + b, 0) / pitches.length;
    const sd = Math.sqrt(pitches.reduce((a, b) => a + (b - mean) ** 2, 0) / pitches.length);
    expect(sd).toBeLessThan(0.5); // a 260 m ship shrugs off a 12 kt sea
    expect(s.phase).toBe('afloat');
  });
});

describe('Tater Star hull: speed and power (calm sea)', () => {
  it('full ahead: ~22.3 kt (contract speed) at the rated 600 rpm, the propellers matched', () => {
    const c = underway(21);
    const s = drive(c.state, 360, () => ({ throttle: 1 }), OCEAN, CRUISE_CALM);
    expect(knots(s)).toBeGreaterThan(21.8);
    expect(knots(s)).toBeLessThan(23.2);
    for (const i of [0, 1]) {
      expect(s.vessel!.propulsors[i].rpm).toBeGreaterThan(590);
      expect(s.vessel!.propulsors[i].rpm).toBeLessThanOrEqual(600 * 1.02);
    }
    expect(Math.abs(euler(s).pitchDeg)).toBeLessThan(0.5);
  });

  it('gathers way slowly from rest: ~10 kt after 2 minutes, most of her speed in ~6', () => {
    let at2 = 0;
    const s = drive(shipAtRest(), 360, () => ({ throttle: 1 }), OCEAN, CRUISE_CALM, (t, st) => {
      if (Math.abs(t - 120) < DT / 2) at2 = knots(st);
    });
    expect(at2).toBeGreaterThan(7);
    expect(at2).toBeLessThan(13);
    expect(knots(s)).toBeGreaterThan(19);
  });

  it('holds the 21 kt service speed with the lever back from the stop', () => {
    const c = underway(21);
    expect(c.controls.throttle!).toBeGreaterThan(0.75);
    expect(c.controls.throttle!).toBeLessThan(0.97);
    const s = drive(c.state, 120, () => ({ throttle: c.controls.throttle }), OCEAN, CRUISE_CALM);
    expect(knots(s)).toBeGreaterThan(20);
    expect(knots(s)).toBeLessThan(22);
  });

  it('slow ahead (lever 0.2) is harbour speed at low rpm', () => {
    const c = underway(8);
    const s = drive(c.state, 300, () => ({ throttle: 0.2 }), OCEAN, CRUISE_CALM);
    expect(knots(s)).toBeGreaterThan(6);
    expect(knots(s)).toBeLessThan(10.5);
    expect(s.vessel!.propulsors[0].rpm).toBeLessThan(260);
    expect(leverCommand(0.2, WC).gear).toBe('ahead');
  });

  it('crash stop from 21 kt: dead in the water within ~6 minutes and 3–8 ship lengths, roughly on course', () => {
    const c = underway(21);
    let tStop = Infinity;
    let reach = Infinity;
    let hdg = 0;
    drive(c.state, 400, () => ({ throttle: -1 }), OCEAN, CRUISE_CALM, (t, st) => {
      if (tStop === Infinity && st.vessel!.speedMs <= 0) {
        tStop = t;
        reach = Math.hypot(st.position.x, st.position.z);
        hdg = euler(st).headingDeg;
      }
    });
    expect(tStop).toBeLessThan(380);
    expect(reach / L).toBeGreaterThan(3);
    expect(reach / L).toBeLessThan(8);
    expect(Math.min(hdg, 360 - hdg)).toBeLessThan(20);
  });

  it('goes astern', () => {
    const s = drive(shipAtRest(), 300, () => ({ throttle: -0.6 }), OCEAN, CRUISE_CALM);
    expect(s.vessel!.speedMs).toBeLessThan(-1.5);
    expect(knots(s)).toBeGreaterThan(-12);
  });
});

describe('Tater Star hull: handling', () => {
  it('hard over at 21 kt: a steady circle of ~3–4.5 ship lengths, heeling outward, no capsize', () => {
    const c = underway(21);
    const xs: number[] = [];
    let heelOut = 0;
    let heelIn = 0;
    const s = drive(c.state, 560, () => ({ throttle: c.controls.throttle, rudder: 1 }), OCEAN, CRUISE_CALM, (t, st) => {
      if (t > 250) xs.push(st.position.x);
      heelOut = Math.min(heelOut, euler(st).rollDeg);
      heelIn = Math.max(heelIn, euler(st).rollDeg);
    });
    expect(s.phase).toBe('afloat');
    const d = Math.max(...xs) - Math.min(...xs);
    expect(d / L).toBeGreaterThan(3);
    expect(d / L).toBeLessThan(4.5);
    // turning to starboard she heels to PORT (roll −), a few degrees — briefly inward as the rudder bites
    expect(heelOut).toBeLessThan(-3);
    expect(heelOut).toBeGreaterThan(-12);
    expect(heelIn).toBeLessThan(4);
    expect(s.derived.r).toBeGreaterThan(0.005);
    // loses speed in the turn
    expect(knots(s)).toBeLessThan(15);
  });

  it('the rudders swing at the steering gear rate to 35° and steer from A / D', () => {
    const c = underway(15);
    const s = drive(c.state, 5, () => ({ throttle: c.controls.throttle, rudder: 1 }), OCEAN, CRUISE_CALM);
    expect(s.vessel!.propulsors[0].steerDeg).toBeGreaterThan(10);
    expect(s.vessel!.propulsors[0].steerDeg).toBeLessThan(15);
    const full = drive(s, 20, () => ({ throttle: c.controls.throttle, rudder: 1 }), OCEAN, CRUISE_CALM);
    expect(full.vessel!.propulsors[0].steerDeg).toBeCloseTo(35, 5);
    const turned = drive(c.state, 60, () => ({ throttle: c.controls.throttle, rudder: 1 }), OCEAN, CRUISE_CALM);
    expect(euler(turned).headingDeg).toBeGreaterThan(15);
    expect(euler(turned).headingDeg).toBeLessThan(90);
  });
});

describe('Tater Star: tunnel thrusters (← / →)', () => {
  it('effect fades with speed: full below 1 kt, half near 3 kt, nothing from 5 kt', () => {
    expect(thrusterEffect(0, 5)).toBe(1);
    expect(thrusterEffect(-0.9, 5)).toBe(1);
    expect(thrusterEffect(3, 5)).toBeGreaterThan(0.3);
    expect(thrusterEffect(3, 5)).toBeLessThan(0.7);
    expect(thrusterEffect(5, 5)).toBe(0);
    expect(thrusterEffect(15, 5)).toBe(0);
    for (let k = 0; k <= 20; k += 0.5) expect(thrusterEffect(k + 0.5, 5)).toBeLessThanOrEqual(thrusterEffect(k, 5));
  });

  it('at 0 kt → turns her bow to starboard on the spot (~1°/s), ← to port, barely moving her', () => {
    const right = drive(shipAtRest(), 120, () => ({ aileron: 1 }), OCEAN, CRUISE_CALM);
    const hdg = euler(right).headingDeg;
    expect(hdg).toBeGreaterThan(60);
    expect(hdg).toBeLessThan(180);
    expect(right.derived.r * (180 / Math.PI)).toBeGreaterThan(0.5);
    expect(right.derived.r * (180 / Math.PI)).toBeLessThan(1.8);
    expect(Math.hypot(right.position.x, right.position.z)).toBeLessThan(15);
    const left = drive(shipAtRest(), 120, () => ({ aileron: -1 }), OCEAN, CRUISE_CALM);
    expect(360 - euler(left).headingDeg).toBeCloseTo(hdg, -0.5);
    // the rudders stay amidships: ← / → are the thrusters' on a ship that has them
    expect(right.vessel!.propulsors[0].steerDeg).toBe(0);
    // bow thrusters push to starboard, stern thrusters to port, at full thrust
    for (const { p, i } of THRUSTERS) {
      const t = right.vessel!.propulsors[i].thrust;
      expect(Math.sign(t)).toBe(p.position.z < 0 ? 1 : -1);
      expect(Math.abs(t)).toBeCloseTo(p.thruster!.maxThrustN, -2);
    }
  });

  it('spool up at their electric rate (~4 s to full)', () => {
    const s = drive(shipAtRest(), 2, () => ({ aileron: 1 }), OCEAN, CRUISE_CALM);
    const { p, i } = THRUSTERS[0];
    const f = s.vessel!.propulsors[i].thrust / p.thruster!.maxThrustN;
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  it('do nothing at 15 kt', () => {
    const c = underway(15);
    const a = drive(c.state, 60, () => ({ throttle: c.controls.throttle, aileron: 1 }), OCEAN, CRUISE_CALM);
    const b = drive(c.state, 60, () => ({ throttle: c.controls.throttle }), OCEAN, CRUISE_CALM);
    const d = Math.abs(((euler(a).headingDeg - euler(b).headingDeg + 540) % 360) - 180);
    expect(d).toBeLessThan(0.5);
    for (const { i } of THRUSTERS) expect(Math.abs(a.vessel!.propulsors[i].thrust)).toBe(0);
  });

  it('are off with the engines (E), and the engine readout ignores them', () => {
    const run = drive(shipAtRest(), 10, () => ({ aileron: 1 }), OCEAN, CRUISE_CALM);
    expect(run.engine.thrust).toBeLessThan(1e5); // shafts idling in neutral: no ahead thrust counted
    const off = drive(run, 10, () => ({ aileron: 1, engineOn: false }), OCEAN, CRUISE_CALM);
    expect(off.engine.running).toBe(false);
    for (const { i } of THRUSTERS) expect(Math.abs(off.vessel!.propulsors[i].thrust)).toBe(0);
  });

  it('a vessel without thrusters still steers with ← / → (the V50 is unchanged)', () => {
    const s = drive(atRest(), 3, () => ({ throttle: 0.1, aileron: 1 }), undefined, V50_CALM);
    expect(s.vessel!.propulsors[0].steerDeg).toBeGreaterThan(20);
  });

  it('swinging her bow gently against a quay: alongside, not holed, not aground', () => {
    const env: Environment = { ...OCEAN, obstacleTop: (x) => (x > 18 ? 2 : -Infinity) };
    let touched = false;
    const s = drive(shipAtRest(env), 90, () => ({ aileron: 1 }), env, CRUISE_CALM, (_t, st) => {
      touched ||= st.vessel!.touching;
      expect(st.vessel!.aground).toBe(false);
    });
    expect(touched).toBe(true);
    expect(s.phase).toBe('afloat');
  });
});

describe('Tater Star: the shore and structures', () => {
  it('driven onto a shelving shore at 15 kt, the hull is holed', () => {
    const shore: Environment = { groundHeight: (_x, z) => (z >= -600 ? -40 : Math.min(3, -40 + (-600 - z) * 0.1)), surfaceAt: () => 'water', waterLevel: () => 0 };
    const c = underway(15, shore);
    const s = drive(c.state, 200, () => ({ throttle: c.controls.throttle }), shore, CRUISE_CALM);
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toMatch(/aground/i);
  });

  it('rammed into a quay at 8 kt: holed', () => {
    const env: Environment = { ...OCEAN, obstacleTop: (_x, z) => (z < -400 ? 2 : -Infinity) };
    const c = underway(8, env);
    const s = drive(c.state, 150, () => ({ throttle: c.controls.throttle }), env, CRUISE_CALM);
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toMatch(/collision/i);
  });
});

describe('Tater Star: purity and cost', () => {
  it('is pure and deterministic', () => {
    const s0 = createVesselState(OCEAN, CRUISE_CFG, { x: 10, z: -20, headingDeg: 120, speedKt: 12 }).state;
    const frozen = JSON.stringify(s0);
    const script = (t: number) => ({ throttle: 0.7, rudder: Math.sin(t / 5), aileron: Math.cos(t / 3) });
    const a = drive(s0, 10, script, OCEAN, CRUISE_CFG);
    const b = drive(s0, 10, script, OCEAN, CRUISE_CFG);
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a step costs well under 0.25 ms (52 × 16 buoyancy columns, 27 wave samples)', () => {
    let s = createVesselState(OCEAN, CRUISE_CFG, { x: 0, z: 0, headingDeg: 0, speedKt: 18 }).state;
    const c = helm({ throttle: 0.9, rudder: 0.3, aileron: 0.5 });
    for (let i = 0; i < 200; i++) s = step(s, c, DT, OCEAN, CRUISE_CFG);
    const t0 = performance.now();
    const n = 2000;
    for (let i = 0; i < n; i++) s = step(s, c, DT, OCEAN, CRUISE_CFG);
    const us = ((performance.now() - t0) * 1000) / n;
    expect(us).toBeLessThan(250);
  });

  it('the V50 is still the V50 (a thruster-free vessel is untouched by the thruster code)', () => {
    expect(V50_AIRCRAFT.watercraft!.propulsors.every((p) => p.type !== 'thruster')).toBe(true);
  });
});
