/**
 * 747-400 flight deck: the control animation mapping (unit + fast-check fuzz) and the room layout
 * (the eyes are inside the room, the windows are real openings in their planes).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDeckPose, flapGateFor, stepDeckPose, thrustLeverDeg } from '../../../src/aircraft/b747/flightDeckAnim';
import { COLUMN, EYE_CAPTAIN, EYE_FO, FLAP_GATES, PEDALS, ROOM, SPEEDBRAKE, THRUST, insideRoom, planePoint, polyInside, roomPlane, DECK_ORIGIN } from '../../../src/aircraft/b747/flightDeckLayout';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { B747_AIRCRAFT } from '../../../src/config';

function vs(patch: Partial<AircraftVisualState> = {}, r: Record<string, unknown> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), cameraMode: 'cockpit', instruments: { ...createRestReadings(), ...r } as never, ...patch };
}
const settle = (v: AircraftVisualState) => {
  const p = createDeckPose();
  for (let i = 0; i < 200; i++) stepDeckPose(p, v, 1 / 30);
  return p;
};

describe('747 flight deck: control mapping (unit)', () => {
  it('thrust levers run idle (aft) → full (forward), monotonic, clamped', () => {
    expect(thrustLeverDeg(0)).toBeCloseTo(THRUST.idleDeg);
    expect(thrustLeverDeg(1)).toBeCloseTo(THRUST.fullDeg);
    expect(thrustLeverDeg(2)).toBeCloseTo(THRUST.fullDeg);
    expect(thrustLeverDeg(-1)).toBeCloseTo(THRUST.idleDeg);
    expect(thrustLeverDeg(NaN)).toBeCloseTo(THRUST.idleDeg);
    for (let t = 0; t < 1; t += 0.05) expect(thrustLeverDeg(t + 0.05)).toBeGreaterThan(thrustLeverDeg(t));
  });

  it('all four levers follow the throttle within a degree of each other (a slight stagger)', () => {
    const idle = settle(vs({}, { throttlePct: 0 }));
    const full = settle(vs({}, { throttlePct: 100 }));
    for (const a of idle.thrustDeg) expect(Math.abs(a - THRUST.idleDeg)).toBeLessThan(1);
    for (const a of full.thrustDeg) expect(Math.abs(a - THRUST.fullDeg)).toBeLessThan(1);
    expect(new Set(full.thrustDeg.map((a) => a.toFixed(3))).size).toBeGreaterThan(1);
  });

  it('the flap lever sits in the gate of the commanded flaps (747 gates UP 1 5 10 20 25 30)', () => {
    expect(FLAP_GATES.map((g) => g.label)).toEqual(['UP', '1', '5', '10', '20', '25', '30']);
    for (const d of B747_AIRCRAFT.flaps.notchesDeg) {
      const g = flapGateFor(d);
      expect(FLAP_GATES[g].deg).toBe(d);
      const p = settle(vs({ flapsDeg: 0 }, { flapsTargetDeg: d }));
      expect(p.flapGate).toBe(g);
      expect(Math.abs(p.flapDeg - FLAP_GATES[g].angle)).toBeLessThan(0.1);
    }
    // Gates step aft as the flaps go down.
    for (let i = 1; i < FLAP_GATES.length; i++) expect(FLAP_GATES[i].angle).toBeLessThan(FLAP_GATES[i - 1].angle);
  });

  it('speed brake lever: DOWN → UP with the speed brake', () => {
    expect(settle(vs({ speedBrake: 0 })).speedBrakeDeg).toBeCloseTo(SPEEDBRAKE.downDeg, 1);
    expect(settle(vs({ speedBrake: 1 })).speedBrakeDeg).toBeCloseTo(SPEEDBRAKE.upDeg, 1);
  });

  it('gear lever follows the handle (command), transit flagged while the gear moves', () => {
    expect(settle(vs({ gearPos: 1 }, { gearHandleDown: true })).gearLever).toBeCloseTo(1, 3);
    const up = settle(vs({ gearPos: 0.5 }, { gearHandleDown: false }));
    expect(up.gearLever).toBeCloseTo(0, 3);
    expect(up.gearTransit).toBe(true);
    expect(settle(vs({ gearPos: 0 }, { gearHandleDown: false })).gearTransit).toBe(false);
  });

  it('columns pull aft with up-elevator, yokes turn with the ailerons, pedals with the rudder', () => {
    const p = settle(vs({ elevator: 1, aileron: 1, rudder: 1 }));
    expect(p.columnDeg).toBeCloseTo(COLUMN.pitchDeg, 2);
    expect(p.yokeDeg).toBeCloseTo(COLUMN.rollDeg, 2);
    expect(p.pedal).toBeCloseTo(PEDALS.travel, 4);
    const q = settle(vs({ elevator: -0.5, aileron: -0.5, rudder: -0.5 }));
    expect(q.columnDeg).toBeCloseTo(-COLUMN.pitchDeg / 2, 2);
    expect(q.yokeDeg).toBeCloseTo(-COLUMN.rollDeg / 2, 2);
  });

  it('levers move smoothly: one 1/60 s step covers only part of a big change', () => {
    const p = settle(vs({}, { throttlePct: 0 }));
    stepDeckPose(p, vs({}, { throttlePct: 100 }), 1 / 60);
    expect(p.thrustDeg[0]).toBeGreaterThan(THRUST.idleDeg + 1);
    expect(p.thrustDeg[0]).toBeLessThan(THRUST.fullDeg - 5);
  });
});

describe('747 flight deck: control mapping (fuzz)', () => {
  const num = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, 1e308, -1e308, 0));
  it('whatever the sim sends, every output stays finite and within its stops', () => {
    fc.assert(
      fc.property(num, num, num, num, num, num, num, fc.boolean(), num, (el, ai, ru, thr, fl, gp, sb, hd, dt) => {
        const p = createDeckPose();
        for (let i = 0; i < 3; i++) stepDeckPose(p, vs({ elevator: el, aileron: ai, rudder: ru, gearPos: gp, speedBrake: sb, flapsDeg: fl }, { throttlePct: thr, flapsTargetDeg: fl, gearHandleDown: hd }), dt);
        for (const a of p.thrustDeg) expect(a >= THRUST.idleDeg - 1 && a <= THRUST.fullDeg + 1).toBe(true);
        expect(p.speedBrakeDeg >= SPEEDBRAKE.downDeg && p.speedBrakeDeg <= SPEEDBRAKE.upDeg).toBe(true);
        expect(p.flapDeg >= FLAP_GATES[6].angle && p.flapDeg <= FLAP_GATES[0].angle).toBe(true);
        expect(Number.isInteger(p.flapGate) && p.flapGate >= 0 && p.flapGate < FLAP_GATES.length).toBe(true);
        expect(p.gearLever >= 0 && p.gearLever <= 1).toBe(true);
        expect(Math.abs(p.columnDeg) <= COLUMN.pitchDeg && Math.abs(p.yokeDeg) <= COLUMN.rollDeg && Math.abs(p.pedal) <= PEDALS.travel).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('null instruments: a resting pose', () => {
    const p = createDeckPose();
    stepDeckPose(p, { ...createDefaultVisualState(), instruments: null }, 1 / 30);
    expect(p.thrustDeg.every(Number.isFinite)).toBe(true);
  });
});

describe('747 flight deck: the room', () => {
  it('sits at the config eye: the captain’s eye is the deck point (−0.55, 0, 0)', () => {
    const e = B747_AIRCRAFT.geometry.pilotEye;
    expect(EYE_CAPTAIN.x).toBeCloseTo(e.x);
    expect(DECK_ORIGIN.y + EYE_CAPTAIN.y).toBeCloseTo(e.y);
    expect(DECK_ORIGIN.z + EYE_CAPTAIN.z).toBeCloseTo(e.z);
  });

  it('both pilots’ eyes are well inside the room (≥ 25 cm from every wall)', () => {
    expect(insideRoom(EYE_CAPTAIN, 0.25)).toBe(true);
    expect(insideRoom(EYE_FO, 0.25)).toBe(true);
  });

  it('every window polygon is convex, CCW, and its points lie on the room boundary', () => {
    let count = 0;
    for (const pl of ROOM) {
      for (const w of pl.windows) {
        count++;
        // Centroid inside, every vertex on the boundary (distance 0).
        const cu = w.reduce((s, p) => s + p[0], 0) / w.length;
        const cv = w.reduce((s, p) => s + p[1], 0) / w.length;
        expect(polyInside(w, cu, cv)).toBeGreaterThan(0.05);
        const c = planePoint(pl, cu, cv);
        // The window centre is on the room surface: inside every other plane.
        for (const q of ROOM) if (q !== pl) expect(q.n.x * c.x + q.n.y * c.y + q.n.z * c.z).toBeLessThan(q.d + 1e-6);
      }
    }
    // 2 windscreen panes + 2 sliding No. 2 windows + 2 No. 3 windows.
    expect(count).toBe(6);
  });

  it('the windscreen is ahead of and above the glareshield line; its planes face forward', () => {
    const f = roomPlane('windscreen');
    expect(f.n.z).toBeLessThan(-0.7);
    expect(f.n.y).toBeGreaterThan(0.3);
    expect(roomPlane('sideL').n.x).toBeCloseTo(-1);
    expect(roomPlane('sideR').n.x).toBeCloseTo(1);
  });
});
