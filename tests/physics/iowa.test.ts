/**
 * USS Iowa (BB-61) on the hull model (src/physics/hull.ts): she floats at her published full-load
 * draft and metacentric height, rolls with a battleship's period and rights herself, makes ~33 kt
 * at full power with the propellers matched to their rated rpm, answers the telegraph slowly (big
 * turbines, big shafts), takes well over a kilometre to crash-stop, turns on her published
 * tactical diameter heeling outward, barely notices the default sea, lies to her lines, grounds on a
 * shelving bank without damage at dead slow (and holes herself at speed), bumps a pier (or holes
 * herself on it), and stays deterministic and cheap. The measured numbers are the calibration table
 * in the header of src/physics/hull.ts.
 */
import { describe, it, expect } from 'vitest';
import { IOWA_AIRCRAFT, IOWA_FRAME } from '../../src/config';
import { createVesselState, hullGeometry, leverCommand, staticFloat, step } from '../../src/physics';
import { bodyToWorld, quatFromEuler } from '../../src/physics/frames';
import type { AircraftState } from '../../src/types';
import { BANK, DT, IOWA_CALM, IOWA_CFG, OCEAN, WC, atRest, drive, euler, helm, knots, pierEnv, steadyLever, underway } from './iowa-helpers';

const MASS = IOWA_AIRCRAFT.mass;

/** Hard over from a steady `kt`: tactical diameter (transfer at 180° of heading change), advance, heel, speed after. */
function turningCircle(kt: number, seconds = 360) {
  const s0 = underway(kt);
  const lever = steadyLever(kt);
  let turned = 0;
  let prev = euler(s0).headingDeg;
  let advance = NaN;
  let tactical = NaN;
  let heelOut = 0;
  const s = drive(s0, seconds, () => ({ throttle: lever, rudder: 1 }), OCEAN, IOWA_CALM, (_t, st) => {
    const h = euler(st).headingDeg;
    let d = h - prev;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    turned += d;
    prev = h;
    if (turned >= 90 && Number.isNaN(advance)) advance = -st.position.z;
    if (turned >= 180 && Number.isNaN(tactical)) tactical = st.position.x;
    // a displacement hull turning to starboard heels to PORT (outward): roll < 0
    heelOut = Math.max(heelOut, -euler(st).rollDeg);
  });
  return { tactical, advance, heelOut, turned, final: s };
}

describe('USS Iowa hull: hydrostatics (1980s full load, 58,400 t)', () => {
  it('floats level at 11.3 m draft on a 262 m waterline, block coefficient ~0.58', () => {
    const g = hullGeometry(WC, MASS);
    expect(g.volume).toBeCloseTo(MASS / 1025, 3);
    expect(g.lwl).toBeGreaterThan(258);
    expect(g.lwl).toBeLessThan(266); // 262.13 m
    const fl = staticFloat(IOWA_CALM);
    expect(Math.abs(fl.pitchDeg)).toBeLessThan(0.25);
    const s = atRest();
    // keel amidships below the still water: 37 ft 2 in = 11.33 m at full load
    const keel = s.position.y + bodyToWorld(s.orientation, { x: 0, y: WC.hull.stations[8].keelY, z: WC.hull.stations[8].z }).y;
    expect(-keel).toBeGreaterThan(11.0);
    expect(-keel).toBeLessThan(11.6);
    // the waterline sits where IOWA_FRAME says (the model's boot top is painted there)
    expect(Math.abs(g.waterlineY - IOWA_FRAME.cgBelowWl)).toBeLessThan(0.25);
    // the true block coefficient on the published dimensions: 58,400 t / ρ / (262.13 × 32.97 × 11.33)
    expect(g.volume / (262.13 * 32.97 * 11.33)).toBeGreaterThan(0.55);
    expect(g.volume / (262.13 * 32.97 * 11.33)).toBeLessThan(0.62);
    // the drawn beam: 32.97 m
    const beam = 2 * Math.max(...WC.hull.stations.map((st) => st.deckHalf));
    expect(beam).toBeCloseTo(32.96, 1);
    expect(WC.hull.stations[WC.hull.stations.length - 1].z - WC.hull.stations[0].z).toBeCloseTo(270.43, 2);
  });

  it('rolls with a ~16 s period: GM ≈ 2.8 m (published 2.82 m), and the roll dies away', () => {
    const s0 = atRest();
    const heeled: AircraftState = { ...s0, orientation: quatFromEuler(0, euler(s0).pitchDeg, 4) };
    const rolls: [number, number][] = [];
    const s = drive(heeled, 90, () => ({}), OCEAN, IOWA_CALM, (t, st) => rolls.push([t, euler(st).rollDeg]));
    const down: number[] = [];
    for (let i = 1; i < rolls.length; i++) if (rolls[i - 1][1] > 0 && rolls[i][1] <= 0) down.push(rolls[i][0]);
    expect(down.length).toBeGreaterThan(2);
    const T = (down[down.length - 1] - down[0]) / (down.length - 1);
    expect(T).toBeGreaterThan(14);
    expect(T).toBeLessThan(19);
    const I = IOWA_AIRCRAFT.inertia.roll * (1 + WC.hull.addedMass.roll);
    const gm = (4 * Math.PI ** 2 * I) / (MASS * 9.80665 * T * T);
    expect(gm).toBeGreaterThan(2.5);
    expect(gm).toBeLessThan(3.2);
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(1.5);
  });

  it('lies still in calm water with the telegraph at stop', () => {
    const s0 = atRest();
    const s = drive(s0, 30, () => ({ throttle: 0 }));
    expect(Math.hypot(s.position.x - s0.position.x, s.position.z - s0.position.z)).toBeLessThan(0.5);
    expect(Math.abs(s.position.y - s0.position.y)).toBeLessThan(0.05);
    expect(s.phase).toBe('afloat');
  });

  it('rights herself from a 30° heel (deck edge under) without capsizing', () => {
    const s0 = atRest();
    const s = drive({ ...s0, orientation: quatFromEuler(0, 0, -30) }, 150, () => ({}), OCEAN, IOWA_CALM);
    expect(s.phase).toBe('afloat');
    expect(Math.abs(euler(s).rollDeg)).toBeLessThan(3);
  });

  it('barely notices the default sea (12 kt wind): heaves and pitches a fraction of a degree', () => {
    let s = createVesselState(OCEAN, IOWA_CFG, { x: 0, z: 0, headingDeg: 35 }).state;
    const pitches: number[] = [];
    const rolls: number[] = [];
    s = drive(s, 60, () => ({}), OCEAN, IOWA_CFG, (t, st) => {
      if (t > 15) {
        pitches.push(euler(st).pitchDeg);
        rolls.push(euler(st).rollDeg);
      }
    });
    const sd = (a: number[]) => {
      const m = a.reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };
    expect(sd(pitches)).toBeLessThan(0.5);
    expect(sd(rolls)).toBeLessThan(1.5);
    expect(s.phase).toBe('afloat');
  });
});

describe('USS Iowa hull: power and speed (calm sea)', () => {
  it('full ahead (212,000 shp): ~33 kt with all four shafts at their rated ~202 rpm', () => {
    const s = drive(underway(30), 240, () => ({ throttle: 1 }));
    expect(knots(s)).toBeGreaterThan(32); // 33 kt at normal displacement; ~32.5 kt at full load
    expect(knots(s)).toBeLessThan(34);
    for (const p of s.vessel!.propulsors) {
      expect(p.rpm).toBeGreaterThan(4750); // the propellers are matched: rated turbine rpm at top speed
      expect(p.rpm).toBeLessThanOrEqual(4900 * 1.02);
      expect(p.load).toBeGreaterThan(0.9); // full power
      expect((Math.abs(p.n) * 60)).toBeGreaterThan(195); // ~202 rpm at the propeller
      expect((Math.abs(p.n) * 60)).toBeLessThan(206);
    }
    expect(Math.abs(euler(s).pitchDeg)).toBeLessThan(0.5); // a little squat by the stern, no more
  });

  it('from rest, full ahead: 10 kt in about a minute, 30 kt in about three', () => {
    let t10 = Infinity;
    let t30 = Infinity;
    drive(atRest(), 300, () => ({ throttle: 1 }), OCEAN, IOWA_CALM, (t, st) => {
      if (knots(st) >= 10 && t10 === Infinity) t10 = t;
      if (knots(st) >= 30 && t30 === Infinity) t30 = t;
    });
    expect(t10).toBeGreaterThan(30);
    expect(t10).toBeLessThan(90);
    expect(t30).toBeGreaterThan(120);
    expect(t30).toBeLessThan(280);
  });

  it('slow ahead is a few knots at a few dozen shaft rpm; the lever has a stop detent and reduced astern', () => {
    const slow = drive(atRest(), 600, () => ({ throttle: 0.2 }));
    expect(knots(slow)).toBeGreaterThan(7);
    expect(knots(slow)).toBeLessThan(11);
    expect(Math.abs(slow.vessel!.propulsors[0].n) * 60).toBeLessThan(60);
    expect(leverCommand(0.03, WC).gear).toBe('neutral');
    expect(leverCommand(0.5, WC).gear).toBe('ahead');
    expect(leverCommand(-0.5, WC).gear).toBe('astern');
    expect(leverCommand(1, WC).rpm).toBe(WC.engine.maxRpm);
    expect(leverCommand(-1, WC).rpm).toBeLessThan(WC.engine.maxRpm * 0.55);
  });

  it('goes astern at about half her ahead speed, holding her heading', () => {
    const s = drive(atRest(), 500, () => ({ throttle: -1 }));
    expect(knots(s)).toBeLessThan(-12);
    expect(knots(s)).toBeGreaterThan(-19);
    expect(Math.abs(euler(s).headingDeg) % 360).toBeLessThan(3);
  });

  it('crash stop from 30 kt (full astern) takes minutes and well over a kilometre', () => {
    let tStop = Infinity;
    let dStop = Infinity;
    const s0 = underway(30);
    drive(s0, 500, () => ({ throttle: -1 }), OCEAN, IOWA_CALM, (t, st) => {
      if (tStop === Infinity && st.vessel!.speedMs <= 0) {
        tStop = t;
        dStop = -st.position.z;
      }
    });
    expect(tStop).toBeGreaterThan(150);
    expect(tStop).toBeLessThan(400);
    expect(dStop).toBeGreaterThan(1000);
    expect(dStop).toBeLessThan(2500);
  });

  it('only the two inboard shafts carry rudders (31.6 m² each, 340 ft²); the helm swings them at ~2.8 °/s', () => {
    const areas = WC.propulsors.map((p) => p.foilArea);
    expect(areas.filter((a) => a > 30).length).toBe(2);
    WC.propulsors.forEach((p) => {
      if (p.foilArea > 30) expect(Math.abs(p.position.x)).toBeLessThan(6);
      else expect(p.foilArea).toBeLessThan(1);
    });
    const s = drive(underway(30), 5, () => ({ throttle: steadyLever(30), rudder: 1 }));
    for (const p of s.vessel!.propulsors) {
      expect(p.steerDeg).toBeGreaterThan(12);
      expect(p.steerDeg).toBeLessThan(16);
    }
  });
});

describe('USS Iowa hull: handling', () => {
  it('hard over at 30 kt: tactical diameter ~800 m (published 744 m), speed bleeds off, heels outward a few degrees', () => {
    const r = turningCircle(30);
    expect(r.tactical).toBeGreaterThan(680);
    expect(r.tactical).toBeLessThan(880);
    expect(r.advance).toBeGreaterThan(550);
    expect(r.advance).toBeLessThan(1000);
    expect(r.heelOut).toBeGreaterThan(2);
    expect(r.heelOut).toBeLessThan(9);
    expect(knots(r.final)).toBeLessThan(24);
    expect(knots(r.final)).toBeGreaterThan(14);
    expect(r.final.phase).toBe('afloat');
  });

  it('hard over at 20 kt: about the same circle (published 695 m), less heel', () => {
    const r = turningCircle(20, 420);
    expect(r.tactical).toBeGreaterThan(640);
    expect(r.tactical).toBeLessThan(880);
    expect(r.heelOut).toBeLessThan(4);
    expect(r.final.derived.r).toBeGreaterThan(0.005); // still turning to starboard
  });
});

describe('USS Iowa hull: the berth, the shore and structures', () => {
  it('lies to her lines in the sea and the wind, and casts off when the telegraph rings ahead', () => {
    const s0 = createVesselState(OCEAN, IOWA_CFG, { x: 0, z: 0, headingDeg: 0, moored: true }).state;
    let maxOff = 0;
    const held = drive(s0, 60, () => ({ throttle: 0 }), OCEAN, IOWA_CFG, (_t, st) => {
      maxOff = Math.max(maxOff, Math.hypot(st.position.x, st.position.z));
    });
    expect(maxOff).toBeLessThan(1.5);
    expect(held.vessel!.mooring).not.toBeNull();
    const off = drive(held, 90, () => ({ throttle: 0.3 }), OCEAN, IOWA_CFG);
    expect(off.vessel!.mooring).toBeNull();
    expect(-off.position.z).toBeGreaterThan(40);
  });

  it('dead slow onto a shelving bank: aground without damage, and backs off full astern', () => {
    let aground = false;
    let s = drive(atRest(BANK), 600, () => ({ throttle: 0.08 }), BANK, IOWA_CALM, (_t, st) => {
      aground ||= st.vessel!.aground;
    });
    expect(aground).toBe(true);
    expect(s.phase).toBe('afloat');
    expect(knots(s)).toBeLessThan(1);
    s = drive(s, 400, () => ({ throttle: -1 }), BANK, IOWA_CALM);
    expect(s.vessel!.aground).toBe(false);
    expect(s.phase).toBe('afloat');
  });

  it('driven onto the bank at speed, the hull is holed', () => {
    const s = drive(underway(20), 300, () => ({ throttle: steadyLever(20) }), BANK, IOWA_CALM);
    expect(s.phase).toBe('crashed');
    expect(s.crash!.reason).toMatch(/aground/i);
  });

  it('bumps a pier at dead slow (~4 kt) and is held off it; rams it at 10 kt and is holed', () => {
    const env = pierEnv(-150);
    let touched = false;
    const s = drive(atRest(env), 300, () => ({ throttle: 0.07 }), env, IOWA_CALM, (_t, st) => {
      touched ||= st.vessel!.touching;
      expect(st.vessel!.aground).toBe(false);
    });
    expect(touched).toBe(true);
    expect(s.phase).toBe('afloat');
    const stem = s.position.z + bodyToWorld(s.orientation, { x: 0, y: 0, z: WC.hull.stations[0].z }).z;
    expect(stem).toBeGreaterThan(-150 - 2);
    const ramEnv = pierEnv(-400);
    const rammed = drive(underway(10), 120, () => ({ throttle: steadyLever(10) }), ramEnv, IOWA_CALM);
    expect(rammed.phase).toBe('crashed');
    expect(rammed.crash!.reason).toMatch(/collision/i);
  });
});

describe('USS Iowa hull: purity and cost', () => {
  it('is pure and deterministic', () => {
    const s0 = createVesselState(OCEAN, IOWA_CFG, { x: 10, z: -20, headingDeg: 120, speedKt: 18 }).state;
    const frozen = JSON.stringify(s0);
    const a = drive(s0, 5, (t) => ({ throttle: 0.7, rudder: Math.sin(t) }), OCEAN, IOWA_CFG);
    const b = drive(s0, 5, (t) => ({ throttle: 0.7, rudder: Math.sin(t) }), OCEAN, IOWA_CFG);
    expect(JSON.stringify(s0)).toBe(frozen);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a step costs well under 0.5 ms (64 × 16 buoyancy columns, 27 wave samples)', () => {
    let s = createVesselState(OCEAN, IOWA_CFG, { x: 0, z: 0, headingDeg: 0, speedKt: 25 }).state;
    const c = helm({ throttle: 0.9, rudder: 0.3 });
    for (let i = 0; i < 200; i++) s = step(s, c, DT, OCEAN, IOWA_CFG);
    const t0 = performance.now();
    const n = 1000;
    for (let i = 0; i < n; i++) s = step(s, c, DT, OCEAN, IOWA_CFG);
    const us = ((performance.now() - t0) * 1000) / n;
    expect(us).toBeLessThan(500);
  });
});
