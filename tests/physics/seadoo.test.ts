/**
 * Sea-Doo RXP-X 325 (src/physics/hull.ts, the 'jet' propulsor, the rider and righting): floats at its
 * draft, launches 0–60 mph in ~3.4 s, planes in a couple of seconds, holds its governed ~58 kt, carves
 * tight turns banked into the turn, steers only with flow through the nozzle (plus the off-throttle
 * assist), brakes and backs with the iBR bucket, jumps and lands, spills its rider on a hard nose-in,
 * is righted after a capsize, beaches, bumps pontoons, and stays deterministic and cheap. The measured
 * numbers are the calibration table in the header of src/physics/hull.ts.
 */
import { describe, it, expect } from 'vitest';
import { SEADOO_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState, hullGeometry, staticFloat, step } from '../../src/physics';
import { bodyToWorld, quatFromEuler } from '../../src/physics/frames';
import type { AircraftState } from '../../src/types';
import { BEACH, DEEP_SEA, DT, MPH, SD_CALM, SD_CFG, SD_ROUGH, atRest, drive, euler, helm, knots, pontoonEnv } from './seadoo-helpers';

const WC = SEADOO_AIRCRAFT.watercraft!;
const JET = WC.propulsors[0];

/** Put a state in the air: `height` m above its floating height, `kt` ahead, pitched. */
function airborne(s0: AircraftState, height: number, kt: number, pitchDeg: number): AircraftState {
  const q = quatFromEuler(0, pitchDeg, 0);
  const v = kt * 0.514444;
  return { ...s0, position: { ...s0.position, y: s0.position.y + height }, orientation: q, velocity: { x: 0, y: -0.5, z: -v } };
}

describe('Sea-Doo hull: hydrostatics', () => {
  it('floats at its loaded displacement, level, drawing ~0.25 m', () => {
    const g = hullGeometry(WC, SEADOO_AIRCRAFT.mass);
    expect(g.volume).toBeCloseTo(490 / 1025, 4);
    const fl = staticFloat(SD_CALM);
    expect(Math.abs(fl.pitchDeg)).toBeLessThan(3);
    expect(g.draft).toBeGreaterThan(0.18);
    expect(g.draft).toBeLessThan(0.35);
    expect(g.lwl).toBeGreaterThan(2.5);
    expect(g.lwl).toBeLessThan(3.2);
    const s = atRest();
    // freeboard at the footwells (the deck edge amidships) above the water
    const deck = s.position.y + bodyToWorld(s.orientation, { x: 0.62, y: WC.hull.stations[4].deckY, z: 0.4 }).y;
    expect(deck).toBeGreaterThan(0.12);
  });

  it('lies still in iBR neutral at idle (the bucket cancels the jet)', () => {
    const s0 = atRest();
    const s = drive(s0, 20, () => ({ throttle: 0 }));
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(1.5);
    expect(s.phase).toBe('afloat');
    expect(s.engine.running).toBe(true);
    expect(s.vessel!.propulsors[0].gear).toBe('neutral');
    expect(s.vessel!.propulsors[0].rpm).toBeGreaterThan(1500);
    expect(s.vessel!.propulsors[0].rpm).toBeLessThan(2000);
  });

  it('rights itself from a 20° heel with the rider sitting still', () => {
    const s0 = atRest();
    const s = drive({ ...s0, orientation: quatFromEuler(0, 0, 20) }, 10, () => ({}));
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(3);
    expect(s.phase).toBe('afloat');
  });

  it('the rider leaning heels it at rest (a body-frame roll moment, limited to a person)', () => {
    const s = drive(atRest(), 6, () => ({ aileron: 1 }));
    expect(s.vessel!.rider!.lean).toBeGreaterThan(0.3); // leaning to starboard (their balance eases it as it heels)
    expect(euler(s).rollDeg).toBeGreaterThan(3); // starboard down
    expect(euler(s).rollDeg).toBeLessThan(25);
    expect(s.vessel!.rider!.aboard).toBe(true);
  });
});

describe('Sea-Doo: the waterjet, speed and power (calm)', () => {
  it('0–60 mph in ~3.4 s (±25 %), on the plane in ~2 s', () => {
    let t60 = Infinity;
    let tPlane = Infinity;
    drive(atRest(), 8, () => ({ throttle: 1, elevator: -0.5 }), DEEP_SEA, SD_CALM, (t, st) => {
      if (t60 === Infinity && st.vessel!.speedMs >= 60 * MPH) t60 = t;
      if (tPlane === Infinity && st.vessel!.planing > 0.5) tPlane = t;
    });
    expect(t60).toBeGreaterThan(3.4 * 0.75);
    expect(t60).toBeLessThan(3.4 * 1.25);
    expect(tPlane).toBeLessThan(2.5);
  });

  it('holds its governed top speed, ~58 kt (67 mph), with the limiter pulling the rpm back', () => {
    const s = drive(atRest(), 25, () => ({ throttle: 1 }));
    expect(knots(s)).toBeGreaterThan(55.5);
    expect(knots(s)).toBeLessThan(59.5);
    expect(s.vessel!.propulsors[0].rpm).toBeLessThanOrEqual(8000 * 1.02);
    expect(s.vessel!.planing).toBeGreaterThan(0.5);
    const trim = euler(s).pitchDeg;
    expect(trim).toBeGreaterThan(-2.5); // skimming almost level on its aft bottom
    expect(trim).toBeLessThan(7);
    const j = s.vessel!.propulsors[0].jet!;
    expect(j.jetSpeed).toBeGreaterThan(s.vessel!.speedMs); // the jet leaves faster than the hull moves
    expect(j.bucket).toBeLessThan(0.05);
  });

  it('without the governor it would run faster (the top speed is the limiter, not the power)', () => {
    const free: Config = { ...SD_CALM, aircraft: { ...SEADOO_AIRCRAFT, watercraft: { ...WC, propulsors: [{ ...JET, jet: { ...JET.jet!, speedLimitKt: 200 } }] } } };
    const s = drive(atRest(), 25, () => ({ throttle: 1 }), DEEP_SEA, free);
    expect(knots(s)).toBeGreaterThan(60);
  });

  it('a jet has no thrust without flow: engine off → no thrust at all', () => {
    const run = drive(atRest(), 4, () => ({ throttle: 0.6 }));
    const off = drive(run, 4, () => ({ throttle: 0.6, engineOn: false }));
    expect(off.engine.running).toBe(false);
    expect(Math.abs(off.vessel!.propulsors[0].thrust)).toBeLessThan(1);
    expect(off.vessel!.propulsors[0].jet!.flow).toBeLessThan(1e-3);
  });

  it('VTS trim down brings the bow down on the plane', () => {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 40 });
    const up = drive(c.state, 6, () => ({ throttle: c.controls.throttle, elevatorTrim: 1 }));
    const down = drive(c.state, 6, () => ({ throttle: c.controls.throttle, elevatorTrim: -1 }));
    expect(down.vessel!.propulsors[0].jet!.trimDeg).toBeGreaterThan(5);
    expect(euler(down).pitchDeg).toBeLessThan(euler(up).pitchDeg - 0.3);
  });
});

describe('Sea-Doo: steering by the nozzle', () => {
  it('carves a banked turn at speed: banked INTO the turn, the rider leaning in, no capsize', () => {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 20 });
    let roll = 0;
    let rMin = Infinity;
    let heading = 0;
    let prev = 0;
    const s = drive(c.state, 24, (t) => ({ throttle: 0.35, aileron: t > 0.5 ? 1 : 0 }), DEEP_SEA, SD_CALM, (t, st) => {
      const h = euler(st).headingDeg;
      heading += ((h - prev + 540) % 360) - 180;
      prev = h;
      if (t > 4) {
        roll = Math.max(roll, euler(st).rollDeg);
        rMin = Math.min(rMin, st.derived.r);
        expect(st.vessel!.rider!.lean).toBeGreaterThan(0.3); // leaning into the turn
      }
    });
    expect(s.phase).toBe('afloat');
    expect(s.vessel!.rider!.aboard).toBe(true);
    expect(roll).toBeGreaterThan(8); // + = starboard down, into a starboard turn
    expect(roll).toBeLessThan(45);
    expect(rMin).toBeGreaterThan(0.1); // turning all the way round…
    expect(heading).toBeGreaterThan(150);
    // …on a circle ~120 m across at ~20 kt: 2 U / r
    expect((s.vessel!.speedMs / s.derived.r) * 2).toBeLessThan(160);
  });

  it('full throttle and full lock from rest or at speed: a hard carve, never a capsize', () => {
    for (const kt of [0, 12, 40]) {
      const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: kt });
      const s = drive(c.state, 10, () => ({ throttle: 1, aileron: 1 }), DEEP_SEA, SD_CALM, (_t, st) => {
        expect(st.vessel!.rider!.aboard).toBe(true);
      });
      expect(s.phase).toBe('afloat');
      expect(s.derived.r).toBeGreaterThan(0.08);
    }
  });

  it('no steering at idle: stopped in neutral, the bars barely do anything; with flow they spin it', () => {
    const s0 = atRest();
    const turned = (s: AircraftState) => Math.abs(((euler(s).headingDeg - euler(s0).headingDeg + 540) % 360) - 180);
    const idle = drive(s0, 6, () => ({ throttle: 0, rudder: 1 }));
    expect(idle.vessel!.propulsors[0].steerDeg).toBeGreaterThan(20); // the nozzle turns…
    expect(turned(idle)).toBeLessThan(15); // …but there's hardly any flow to steer with (the idle creep)
    const flow = drive(s0, 6, () => ({ throttle: 0.25, rudder: 1 }));
    expect(turned(flow)).toBeGreaterThan(60);
  });

  it('off the throttle at speed the off-throttle assist (OTAS) gives it steering; without OTAS it barely turns', () => {
    const noOtas: Config = { ...SD_CALM, aircraft: { ...SEADOO_AIRCRAFT, watercraft: { ...WC, propulsors: [{ ...JET, jet: { ...JET.jet!, otas: { ...JET.jet!.otas, minKt: 999 } } }] } } };
    const run = (cfg: Config) => {
      const c = createVesselState(DEEP_SEA, cfg, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
      let yaw = 0;
      drive(c.state, 2, () => ({ throttle: 0, rudder: 1 }), DEEP_SEA, cfg, (_t, st) => {
        yaw = Math.max(yaw, ((euler(st).headingDeg + 540) % 360) - 180);
      });
      return yaw;
    };
    const withAssist = run(SD_CALM);
    const without = run(noOtas);
    expect(withAssist).toBeGreaterThan(without + 4);
    expect(without).toBeLessThan(25);
  });
});

describe('Sea-Doo: the iBR reverse bucket', () => {
  it('braking (Space) from 40 kt stops it much sooner than coasting', () => {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 40 });
    const stopAt = (brake: number) => {
      let d = Infinity;
      drive(c.state, 20, () => ({ throttle: 0, brake }), DEEP_SEA, SD_CALM, (_t, st) => {
        if (d === Infinity && st.vessel!.speedMs < 1) d = -st.position.z;
      });
      return d;
    };
    const braked = stopAt(1);
    const coast = stopAt(0);
    expect(braked).toBeLessThan(coast * 0.8);
    expect(braked).toBeLessThan(90);
  });

  it('the lever astern drops the bucket and backs it', () => {
    const s = drive(atRest(), 10, () => ({ throttle: -0.7 }));
    expect(s.vessel!.propulsors[0].jet!.bucket).toBeGreaterThan(0.95);
    expect(s.vessel!.propulsors[0].gear).toBe('astern');
    expect(s.vessel!.speedMs).toBeLessThan(-1);
    expect(s.vessel!.speedMs).toBeGreaterThan(-6);
  });
});

describe('Sea-Doo: jumps, spills and capsizes', () => {
  it('flies off a crest and lands flat without a crash (rider stays on)', () => {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 45 });
    const s0 = airborne(c.state, 1.5, 45, 4);
    let wasDry = false;
    const s = drive(s0, 6, () => ({ throttle: c.controls.throttle }), DEEP_SEA, SD_CALM, (_t, st) => {
      if (st.vessel!.displacedVolume === 0) wasDry = true;
    });
    expect(wasDry).toBe(true);
    expect(s.phase).toBe('afloat');
    expect(s.vessel!.rider!.aboard).toBe(true);
    expect(knots(s)).toBeGreaterThan(30);
  });

  it('in a rough sea at full throttle it gets airborne off the crests, the pump ventilates, and it never wrecks', () => {
    let s = createVesselState(DEEP_SEA, SD_ROUGH, { x: 0, z: 0, headingDeg: 200, speedKt: 35 }).state;
    let air = 0;
    let maxAir = 0;
    let vent = 0;
    s = drive(s, 30, () => ({ throttle: 1 }), DEEP_SEA, SD_ROUGH, (_t, st) => {
      air = st.vessel!.displacedVolume === 0 ? air + DT : 0;
      maxAir = Math.max(maxAir, air);
      vent = Math.max(vent, st.vessel!.propulsors[0].jet!.ventilation);
    });
    expect(maxAir).toBeGreaterThan(0.1);
    expect(vent).toBeGreaterThan(0.9);
    expect(s.phase).toBe('afloat');
  });

  it('a hard nose-in at speed spills the rider (the tether stops the engine); they swim back and climb on', () => {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 50 });
    const s0 = airborne(c.state, 1.5, 50, -30);
    let spilled = false;
    const s1 = drive(s0, 3, () => ({ throttle: 1 }), DEEP_SEA, SD_CALM, (_t, st) => {
      if (st.vessel!.rider!.off === 'spill') spilled = true;
    });
    expect(spilled).toBe(true);
    expect(s1.phase).toBe('afloat');
    expect(s1.engine.running).toBe(false);
    const s2 = drive(s1, 25, () => ({ throttle: 0 }));
    expect(s2.vessel!.rider!.aboard).toBe(true);
    expect(s2.engine.running).toBe(true);
    expect(s2.phase).toBe('afloat');
  });

  it('capsized, it is rolled back upright over ~3 s once nearly stopped — no wreck', () => {
    const s0 = atRest();
    const flipped: AircraftState = { ...s0, orientation: quatFromEuler(30, 0, 170) };
    let righting = 0;
    let offSeen = false;
    const s = drive(flipped, 14, () => ({ throttle: 0 }), DEEP_SEA, SD_CALM, (_t, st) => {
      if ((st.vessel!.righting ?? 0) > 0) righting += DT;
      if (st.vessel!.rider!.off === 'capsize') offSeen = true;
      expect(st.phase).toBe('afloat');
    });
    expect(offSeen).toBe(true);
    expect(righting).toBeGreaterThan(2);
    expect(righting).toBeLessThan(4);
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(8);
    expect(s.vessel!.rider!.aboard).toBe(true);
    expect(s.engine.running).toBe(true);
  });
});

describe('Sea-Doo: the beach and the marina', () => {
  it('slides gently onto a beach at low speed: beached, not wrecked', () => {
    let aground = false;
    const s0 = createVesselState(BEACH, SD_CALM, { x: 0, z: -150, headingDeg: 0 }).state;
    const s = drive(s0, 90, () => ({ throttle: 0.15 }), BEACH, SD_CALM, (_t, st) => {
      aground ||= st.vessel!.aground;
    });
    expect(aground).toBe(true);
    expect(s.phase).toBe('afloat');
    expect(knots(s)).toBeLessThan(3);
  });

  it('driven onto the beach at full speed, it is wrecked', () => {
    const c = createVesselState(BEACH, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 45 });
    const s = drive(c.state, 20, () => ({ throttle: 1 }), BEACH, SD_CALM);
    expect(s.phase).toBe('crashed');
  });

  it('bumps a pontoon at a few knots without damage; rams it at 30 kt and is holed', () => {
    const env = pontoonEnv(-25);
    let touched = false;
    const slow = drive(atRest(env), 30, () => ({ throttle: 0.1 }), env, SD_CALM, (_t, st) => {
      touched ||= st.vessel!.touching;
    });
    expect(touched).toBe(true);
    expect(slow.phase).toBe('afloat');
    const env2 = pontoonEnv(-80);
    const c = createVesselState(env2, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: 30 });
    const fast = drive(c.state, 10, () => ({ throttle: c.controls.throttle }), env2, SD_CALM);
    expect(fast.phase).toBe('crashed');
    expect(fast.crash!.reason).toMatch(/collision/i);
  });

  it('moored at the berth it stays put, and casts off when the throttle goes in', () => {
    const s0 = createVesselState(DEEP_SEA, SD_CFG, { x: 0, z: 0, headingDeg: 0, moored: true }).state;
    const held = drive(s0, 15, () => ({ throttle: 0 }), DEEP_SEA, SD_CFG);
    expect(Math.hypot(held.position.x, held.position.z)).toBeLessThan(1.5);
    expect(held.vessel!.mooring).not.toBeNull();
    const off = drive(held, 5, () => ({ throttle: 0.3 }), DEEP_SEA, SD_CFG);
    expect(off.vessel!.mooring).toBeNull();
    expect(-off.position.z).toBeGreaterThan(5);
  });
});

describe('Sea-Doo: purity and cost', () => {
  it('is pure and deterministic', () => {
    const s0 = createVesselState(DEEP_SEA, SD_CFG, { x: 5, z: -20, headingDeg: 70, speedKt: 30 }).state;
    const frozen = JSON.stringify(s0);
    const ctl = (t: number) => ({ throttle: 0.8, aileron: Math.sin(t * 2), elevator: Math.cos(t) * 0.5 });
    const a = drive(s0, 5, ctl, DEEP_SEA, SD_CFG);
    const b = drive(s0, 5, ctl, DEEP_SEA, SD_CFG);
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a step costs well under 0.2 ms', () => {
    let s = createVesselState(DEEP_SEA, SD_CFG, { x: 0, z: 0, headingDeg: 0, speedKt: 40 }).state;
    const c = helm({ throttle: 0.9, aileron: 0.3 });
    for (let i = 0; i < 200; i++) s = step(s, c, DT, DEEP_SEA, SD_CFG);
    const t0 = performance.now();
    const n = 2000;
    for (let i = 0; i < n; i++) s = step(s, c, DT, DEEP_SEA, SD_CFG);
    expect(((performance.now() - t0) * 1000) / n).toBeLessThan(200);
  });
});
