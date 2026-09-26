// @vitest-environment happy-dom
/**
 * Helicopter instruments and HUD (Bell 206B-3 JetRanger, fleet id b206): the rotor readings (NR, N2,
 * N1, torque, collective, SAS, low rotor RPM, VRS, blade stall), the N2 / NR needle split with the
 * engine off, no fixed-wing stall warning, the helicopter slip ball, no gear warnings on skids, the
 * helicopter annunciators and start hint, the dual tach / torquemeter / 0–150 kt ASI drawers, the
 * helicopter systems strip, the HUD layout with four gauges on the right, the K flash and the
 * helicopter block of the Controls page.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { CONFIG, type Config } from '../../src/config';
import type { AircraftState, InstrumentReadings, RotorState } from '../../src/types';
import { createInitialState, FLAT_ENV } from '../../src/physics';
import { getAircraftDef } from '../../src/fleet';
import { createInstrumentModel, updateInstruments, rawSlipBall } from '../../src/ui/instruments';
import { gearWarning } from '../../src/ui/gearWarning';
import { annunciations, startHint } from '../../src/ui/messages';
import { controlGroups, controlNotes } from '../../src/ui/controls';
import {
  drawDualTach, drawTorque, makeHeliAirspeed, drawSystemsStrip, systemsStripWidth, HELI_SYSTEM_CELLS, HELI_MARKS,
  dualTachNeedleDeg, torqueNeedleDeg, heliAsiNeedleDeg,
} from '../../src/ui/gauges';
import { computeHudLayout, createHud, type Hud, type HudInfo } from '../../src/ui/hud';
import { makeControls, makeReadings, makeState, mockCtx, type MockCtx } from './fixtures';

const HELI: Config = getAircraftDef('b206').config;
const NOMINAL_OMEGA = (HELI.aircraft.rotorcraft!.rotor.nominalRpm * 2 * Math.PI) / 60;
const DT = 1 / 60;

/**
 * A hand-made rotor block. Starts from whatever the physics' initial state carries (so fields added
 * to RotorState later are there) and sets every field the instruments read.
 */
function makeRotor(over: Partial<RotorState> = {}): RotorState {
  const physics = createInitialState(FLAT_ENV, HELI).rotor;
  return {
    ...(physics ?? {}),
    omega: NOMINAL_OMEGA,
    vi: 9,
    viTail: 6,
    thrust: 12700,
    tailThrust: 900,
    flapLong: 0,
    flapLat: 0,
    enginePower: 150000,
    n1: 0.9,
    govInt: 0,
    torque: 0.6,
    collective: 0.5,
    cyclicLong: 0,
    cyclicLat: 0,
    pedal: 0,
    sasOn: true,
    sasLong: 0,
    sasLat: 0,
    sasYaw: 0,
    headingRef: 0,
    vrs: 0,
    bladeStall: 0,
    groundEffect: 0,
    fx: 0,
    fy: 12700,
    ...over,
  } as RotorState;
}

interface HeliSpec {
  airborne?: boolean;
  running?: boolean;
  alphaDeg?: number;
  rotor?: Partial<RotorState> | null;
  crashed?: boolean;
  time?: number;
  gearPos?: number;
}

/** A hand-built helicopter state: the b206's initial state with a made-up rotor block. */
function heliState(spec: HeliSpec = {}): AircraftState {
  const base = createInitialState(FLAT_ENV, HELI);
  const airborne = spec.airborne ?? true;
  const s: AircraftState = {
    ...base,
    time: spec.time ?? 10,
    position: { ...base.position, y: airborne ? 150 : base.position.y },
    phase: spec.crashed ? 'crashed' : airborne ? 'airborne' : 'ground',
    onGround: !airborne,
    gearPos: spec.gearPos ?? 1,
    engine: { ...base.engine, running: spec.running ?? true, starting: false, failed: false, rpm: HELI.aircraft.rotorcraft!.rotor.nominalRpm },
    derived: { ...base.derived, alpha: ((spec.alphaDeg ?? 0) * Math.PI) / 180, loadFactor: 1, altitudeAGL: airborne ? 150 : 0 },
  };
  if (spec.rotor === null) delete s.rotor;
  else s.rotor = makeRotor(spec.rotor ?? {});
  return s;
}

const finiteDeep = (v: unknown): boolean => {
  if (typeof v === 'number') return Number.isFinite(v);
  if (v && typeof v === 'object') return Object.values(v).every(finiteDeep);
  return true;
};

describe('helicopter instrument model: rotor readings', () => {
  it('b206 is a helicopter by its config (rotorcraft set), with the 206 limits', () => {
    expect(HELI.aircraft.rotorcraft).not.toBeNull();
    expect(HELI.aircraft.limits.vneKt).toBe(130);
    expect(CONFIG.aircraft.rotorcraft).toBeNull();
  });

  it('NR, N2, N1, torque and collective in %, SAS, VRS and blade stall straight from the rotor state', () => {
    const r = updateInstruments(createInstrumentModel(), heliState({ rotor: { n1: 0.93, torque: 0.72, vrs: 0.2, bladeStall: 0.1 } }), makeControls({ throttle: 0.45 }), DT, HELI);
    expect(r.rotor).toBeDefined();
    const rot = r.rotor!;
    expect(rot.nrPct).toBeCloseTo(100, 3);
    expect(rot.n2Pct).toBeCloseTo(100, 3);
    expect(rot.n1Pct).toBeCloseTo(93, 3);
    expect(rot.torquePct).toBeCloseTo(72, 3);
    expect(rot.collectivePct).toBeCloseTo(45, 6);
    expect(rot.sas).toBe(true);
    expect(rot.vrs).toBeCloseTo(0.2, 6);
    expect(rot.bladeStall).toBeCloseTo(0.1, 6);
    expect(rot.lowRotorRpm).toBe(false);
    expect(rot.overTorque).toBe(false);
    expect(finiteDeep(r)).toBe(true);
  });

  it('throttle % on a helicopter is the collective lever', () => {
    const r = updateInstruments(createInstrumentModel(), heliState(), makeControls({ throttle: 0.62 }), DT, HELI);
    expect(r.throttlePct).toBeCloseTo(62, 6);
    expect(r.rotor!.collectivePct).toBeCloseTo(62, 6);
  });

  it('the needles are smoothed like the others (a step in torque is not shown at once)', () => {
    const m = createInstrumentModel();
    updateInstruments(m, heliState({ rotor: { torque: 0.3 } }), makeControls(), DT, HELI);
    const r = updateInstruments(m, heliState({ time: 10 + DT, rotor: { torque: 0.9 } }), makeControls(), DT, HELI);
    expect(r.rotor!.torquePct).toBeGreaterThan(30);
    expect(r.rotor!.torquePct).toBeLessThan(90);
  });

  it('SAS reading follows the rotor state; without one, the K switch (absent = on)', () => {
    expect(updateInstruments(createInstrumentModel(), heliState({ rotor: { sasOn: false } }), makeControls(), DT, HELI).rotor!.sas).toBe(false);
    expect(updateInstruments(createInstrumentModel(), heliState({ rotor: null }), makeControls({ stabilityAssist: false }), DT, HELI).rotor!.sas).toBe(false);
    expect(updateInstruments(createInstrumentModel(), heliState({ rotor: null }), makeControls(), DT, HELI).rotor!.sas).toBe(true);
  });

  it('overtorque above 100 %', () => {
    expect(updateInstruments(createInstrumentModel(), heliState({ rotor: { torque: 1.04 } }), makeControls(), DT, HELI).rotor!.overTorque).toBe(true);
    expect(updateInstruments(createInstrumentModel(), heliState({ rotor: { torque: 0.99 } }), makeControls(), DT, HELI).rotor!.overTorque).toBe(false);
  });

  it('without a rotor state (physics not stepped yet) every reading is still finite', () => {
    const r = updateInstruments(createInstrumentModel(), heliState({ rotor: null }), makeControls(), DT, HELI);
    expect(r.rotor).toBeDefined();
    expect(finiteDeep(r)).toBe(true);
    expect(r.rotor!.nrPct).toBeCloseTo(100, 3); // the engine rpm is the rotor rpm
  });

  it('fixed-wing readings carry no rotor block', () => {
    const r = updateInstruments(createInstrumentModel(), makeState(), makeControls(), DT);
    expect(r.rotor).toBeUndefined();
  });

  it('property: garbage in the rotor state never gives a non-finite or out-of-range reading', () => {
    const wild = fc.oneof(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 1e12));
    fc.assert(
      fc.property(wild, wild, wild, wild, wild, wild, wild, fc.double({ min: -1, max: 1, noNaN: true }), fc.boolean(), (omega, n1, torque, power, vrs, bs, fx, dt, airborne) => {
        const m = createInstrumentModel();
        const c = makeControls({ throttle: 0.5 });
        updateInstruments(m, heliState({ airborne }), c, DT, HELI);
        const r = updateInstruments(m, heliState({ airborne, time: 10.1, rotor: { omega, n1, torque, enginePower: power, vrs, bladeStall: bs, fx } }), c, dt, HELI);
        expect(finiteDeep(r)).toBe(true);
        const rot = r.rotor!;
        for (const v of [rot.nrPct, rot.n2Pct, rot.n1Pct, rot.torquePct, rot.collectivePct]) expect(v).toBeGreaterThanOrEqual(0);
        expect(rot.vrs).toBeLessThanOrEqual(1);
        expect(rot.bladeStall).toBeLessThanOrEqual(1);
        expect(Math.abs(r.slipSkid)).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe('helicopter instrument model: low rotor RPM', () => {
  const lowRpm = (spec: HeliSpec, pct: number, collective: number) =>
    updateInstruments(createInstrumentModel(), heliState({ ...spec, rotor: { omega: (NOMINAL_OMEGA * pct) / 100 } }), makeControls({ throttle: collective }), DT, HELI).rotor!.lowRotorRpm;

  it('airborne below 95 % NR: warning; in the green: none', () => {
    expect(lowRpm({ airborne: true }, 92, 0.2)).toBe(true);
    expect(lowRpm({ airborne: true }, 94.5, 0.5)).toBe(true);
    expect(lowRpm({ airborne: true }, 97, 0.5)).toBe(false);
    expect(lowRpm({ airborne: true }, 110, 0.5)).toBe(false);
  });

  it('on the ground only with the collective raised above 0.3 and the engine running', () => {
    expect(lowRpm({ airborne: false }, 80, 0.5)).toBe(true);
    expect(lowRpm({ airborne: false }, 80, 0.1)).toBe(false);
    expect(lowRpm({ airborne: false, running: false }, 0, 0.5)).toBe(false);
    // Engine off, rotor stopped, lever down: a quiet cold cockpit.
    expect(lowRpm({ airborne: false, running: false }, 0, 0)).toBe(false);
  });

  it('never once crashed', () => {
    expect(lowRpm({ airborne: false, crashed: true }, 20, 0.8)).toBe(false);
  });
});

describe('helicopter instrument model: the N2 / NR needle split', () => {
  it('engine driving: N2 rides with NR', () => {
    const m = createInstrumentModel();
    let r = updateInstruments(m, heliState(), makeControls(), DT, HELI);
    for (let i = 1; i <= 60; i++) r = updateInstruments(m, heliState({ time: 10 + i * DT, rotor: { omega: NOMINAL_OMEGA * 0.97 } }), makeControls(), DT, HELI);
    expect(r.rotor!.n2Pct).toBeCloseTo(r.rotor!.nrPct, 1);
    expect(r.rotor!.nrPct).toBeCloseTo(97, 1);
  });

  it('engine off in autorotation: NR held up by the airflow, N2 spins down on its own', () => {
    const m = createInstrumentModel();
    updateInstruments(m, heliState(), makeControls(), DT, HELI);
    let r = updateInstruments(m, heliState({ time: 10 + DT }), makeControls(), DT, HELI);
    const n2s: number[] = [];
    for (let i = 2; i <= 600; i++) {
      r = updateInstruments(m, heliState({ time: 10 + i * DT, running: false, rotor: { enginePower: 0, n1: 0, torque: 0 } }), makeControls({ throttle: 0.1 }), DT, HELI);
      if (i % 60 === 0) n2s.push(r.rotor!.n2Pct);
    }
    expect(r.rotor!.nrPct).toBeCloseTo(100, 1);
    expect(r.rotor!.n2Pct).toBeLessThan(10);
    // Monotonic spin-down, and it takes a few seconds (not a snap).
    for (let i = 1; i < n2s.length; i++) expect(n2s[i]).toBeLessThanOrEqual(n2s[i - 1]);
    expect(n2s[0]).toBeGreaterThan(50);
  });

  it('a running engine whose rotor overruns it (NR above 100 %) is governed: N2 stays at 100 %', () => {
    const m = createInstrumentModel();
    updateInstruments(m, heliState(), makeControls(), DT, HELI);
    let r = updateInstruments(m, heliState({ time: 10 + DT }), makeControls(), DT, HELI);
    for (let i = 2; i <= 180; i++) r = updateInstruments(m, heliState({ time: 10 + i * DT, rotor: { omega: NOMINAL_OMEGA * 1.06, enginePower: 0 } }), makeControls(), DT, HELI);
    expect(r.rotor!.nrPct).toBeCloseTo(106, 1);
    expect(r.rotor!.n2Pct).toBeCloseTo(100, 1);
  });

  it('a reset (time going back) snaps the needles to the new state', () => {
    const m = createInstrumentModel();
    updateInstruments(m, heliState({ time: 100 }), makeControls(), DT, HELI);
    const r = updateInstruments(m, heliState({ time: 0, running: false, airborne: false, rotor: { omega: 0, enginePower: 0, n1: 0, torque: 0 } }), makeControls(), DT, HELI);
    expect(r.rotor!.nrPct).toBe(0);
    expect(r.rotor!.n2Pct).toBe(0);
    expect(r.rotor!.n1Pct).toBe(0);
  });
});

describe('helicopter: stall warning, slip ball, gear', () => {
  it('no stall warning for a helicopter at α = 90° (air from above in a hover); the Cessna warns', () => {
    const r = updateInstruments(createInstrumentModel(), { ...heliState({ alphaDeg: 90 }), stalled: true }, makeControls(), DT, HELI);
    expect(r.stallWarning).toBe(false);
    expect(annunciations(r, HELI).map((a) => a.id)).not.toContain('stall');
    const c = updateInstruments(createInstrumentModel(), makeState({ alphaDeg: 90 }), makeControls(), DT);
    expect(c.stallWarning).toBe(true);
  });

  it('slip ball from the rotor body side force: a force to the right swings the ball left, none centres it', () => {
    const at = (fx: number) => rawSlipBall(heliState({ rotor: { fx } }), makeControls(), HELI);
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(1500)).toBeLessThan(-0.1);
    expect(at(-1500)).toBeGreaterThan(0.1);
    // Nothing from the fixed-wing side-force derivatives: rudder and sideslip do not move it by themselves.
    const s = heliState({ rotor: { fx: 0 } });
    s.derived = { ...s.derived, beta: 0.5, tas: 40 };
    expect(rawSlipBall(s, makeControls({ rudder: 1 }), HELI)).toBeCloseTo(0, 6);
  });

  it('the fixed skids never raise a gear warning, whatever the gear handle says', () => {
    const r = updateInstruments(createInstrumentModel(), heliState({ airborne: true }), makeControls({ gearDown: false, throttle: 0 }), DT, HELI);
    expect(r.gearHorn).toBe(false);
    expect(r.gearUnsafe).toBe(false);
    expect(r.gearSquat).toBe(false);
    expect(r.gearOverspeed).toBe(false);
    const g = updateInstruments(createInstrumentModel(), heliState({ airborne: false }), makeControls({ gearDown: false }), DT, HELI);
    expect(g.gearSquat).toBe(false);
    expect(g.gearHorn).toBe(false);
    for (const gear of ['up', 'transit', 'down'] as const) {
      for (const onGround of [true, false]) {
        const w = gearWarning({ onGround, crashed: false, gear, handleDown: false, throttlePct: 0, flapsDeg: 40, iasKt: 300, aglFt: 50 }, HELI);
        expect(w.horn || w.gearUnsafe || w.squatSwitch || w.overspeed).toBe(false);
      }
    }
    const ids = annunciations(g, HELI).map((a) => a.id);
    for (const id of ['gearUnsafe', 'gearSquat', 'gearOverspeed', 'flapOverspeed']) expect(ids).not.toContain(id);
  });
});

describe('helicopter annunciators and hint', () => {
  const rot = (over: Partial<NonNullable<InstrumentReadings['rotor']>>): InstrumentReadings =>
    makeReadings({
      rotor: { nrPct: 100, n2Pct: 100, n1Pct: 90, torquePct: 60, collectivePct: 50, sas: true, lowRotorRpm: false, overTorque: false, vrs: 0, bladeStall: 0, ...over },
    });
  const ids = (r: InstrumentReadings) => annunciations(r, HELI).map((a) => a.id);

  it('LOW ROTOR RPM (red warning), OVERTORQUE, VORTEX RING above 0.5, RETREATING BLADE STALL above 0.3 (cautions)', () => {
    expect(ids(rot({}))).toEqual([]);
    const low = annunciations(rot({ lowRotorRpm: true }), HELI).find((a) => a.id === 'lowRotor')!;
    expect(low.text).toBe('LOW ROTOR RPM');
    expect(low.level).toBe('warning');
    expect(ids(rot({ overTorque: true }))).toContain('overTorque');
    expect(ids(rot({ vrs: 0.6 }))).toContain('vortexRing');
    expect(ids(rot({ vrs: 0.4 }))).not.toContain('vortexRing');
    expect(ids(rot({ bladeStall: 0.35 }))).toContain('bladeStall');
    expect(ids(rot({ bladeStall: 0.25 }))).not.toContain('bladeStall');
    const all = annunciations(rot({ overTorque: true, vrs: 1, bladeStall: 1 }), HELI);
    expect(all.map((a) => a.text)).toEqual(expect.arrayContaining(['OVERTORQUE', 'VORTEX RING', 'RETREATING BLADE STALL']));
    for (const a of all) expect(a.level).toBe('caution');
    // Nothing is lit once crashed: the crash banner says it all.
    expect(ids({ ...rot({ lowRotorRpm: true, overTorque: true, vrs: 1, bladeStall: 1 }), state: 'crashed' })).toEqual([]);
  });

  it('fixed-wing readings never light a helicopter annunciator', () => {
    for (const id of ['lowRotor', 'overTorque', 'vortexRing', 'bladeStall']) expect(annunciations(makeReadings()).map((a) => a.id)).not.toContain(id);
  });

  it('the start hint of a helicopter names the collective, pedals, engine and K, not rotate speeds or gear', () => {
    const h = startHint(HELI);
    expect(h).toMatch(/collective/);
    expect(h).toMatch(/pedals/);
    expect(h).toMatch(/K stability assist/);
    expect(h).toMatch(/E engine/);
    expect(h).not.toMatch(/gear|flaps|pull up/);
    expect(startHint()).toMatch(/pull up/);
  });
});

describe('helicopter gauges', () => {
  it('needle maps: dual tach 0 → -135°, 120 → +135°, the working range spread out; torque linear to 110; ASI 0 at 12', () => {
    expect(dualTachNeedleDeg(0)).toBeCloseTo(-135, 6);
    expect(dualTachNeedleDeg(120)).toBeCloseTo(135, 6);
    expect(dualTachNeedleDeg(NaN)).toBeCloseTo(-135, 6);
    // 95–104 % (the green) spans ≥ 25°: readable at a glance.
    expect(dualTachNeedleDeg(HELI_MARKS.nr.greenHigh) - dualTachNeedleDeg(HELI_MARKS.nr.greenLow)).toBeGreaterThan(25);
    for (let v = 0; v < 120; v += 1) expect(dualTachNeedleDeg(v + 1)).toBeGreaterThan(dualTachNeedleDeg(v));
    expect(torqueNeedleDeg(0)).toBeCloseTo(-135, 6);
    expect(torqueNeedleDeg(110)).toBeCloseTo(135, 6);
    expect(torqueNeedleDeg(500)).toBeCloseTo(135, 6);
    expect(heliAsiNeedleDeg(0)).toBe(0);
    expect(heliAsiNeedleDeg(150)).toBeCloseTo(330, 6);
    expect(heliAsiNeedleDeg(1000)).toBeLessThanOrEqual(335);
  });

  it('the drawers never emit NaN, whatever the readings (with or without a rotor block)', () => {
    const asi = makeHeliAirspeed(130);
    const garbage = makeReadings({ airspeedKt: NaN, rotor: { nrPct: NaN, n2Pct: Infinity, n1Pct: -5, torquePct: 1e9, collectivePct: NaN, sas: false, lowRotorRpm: true, overTorque: true, vrs: NaN, bladeStall: 2 } });
    for (const r of [garbage, makeReadings()]) {
      for (const size of [80, 126, 300]) {
        const m = mockCtx();
        asi(m.ctx, 100, 100, size, r);
        drawDualTach(m.ctx, 100, 100, size, r);
        drawTorque(m.ctx, 100, 100, size, r);
        drawSystemsStrip(m.ctx, 0, 0, 500, 50, r, 1, 'heli');
        drawSystemsStrip(m.ctx, 0, 0, 300, 90, r, 2, 'heli');
        expect(m.bad()).toEqual([]);
      }
    }
  });

  it('the helicopter strip shows collective, TRQ, N1, NR, SAS and the skids — no flaps, gear or brakes', () => {
    const m = mockCtx();
    const r = makeReadings({ rotor: { nrPct: 100, n2Pct: 100, n1Pct: 91, torquePct: 64, collectivePct: 55, sas: false, lowRotorRpm: false, overTorque: false, vrs: 0, bladeStall: 0 } });
    drawSystemsStrip(m.ctx, 0, 0, 560, 50, r, 1, 'heli');
    const t = m.texts().join(' ');
    for (const s of ['COLLECTIVE', '55%', 'TRQ', '64%', 'N1', '91%', 'NR', '100%', 'SAS OFF', 'SKIDS', 'ENGINE']) expect(t).toContain(s);
    for (const s of ['FLAPS', 'GEAR', 'BRAKE', 'THROTTLE', 'TRIM']) expect(t).not.toContain(s);
    expect(Object.keys(HELI_SYSTEM_CELLS)).toEqual(['collective', 'torque', 'n1', 'nr', 'sas', 'engine']);
    expect(systemsStripWidth(10, 1, 'heli')).toBeGreaterThan(0);
  });

  it('the dual tach and torquemeter draw their faces (NR/N2 legends, TRQ, N1 window)', () => {
    const m = mockCtx();
    const r = makeReadings({ rotor: { nrPct: 100, n2Pct: 40, n1Pct: 0, torquePct: 0, collectivePct: 0, sas: true, lowRotorRpm: false, overTorque: false, vrs: 0, bladeStall: 0 } });
    drawDualTach(m.ctx, 100, 100, 200, r);
    drawTorque(m.ctx, 100, 100, 200, r);
    const t = m.texts().join(' ');
    expect(t).toMatch(/ROTOR/);
    expect(t).toMatch(/TRQ/);
    expect(t).toMatch(/N1 0\.0/);
  });
});

describe('helicopter HUD layout', () => {
  it('four gauges on the right, the helicopter strip; nothing overlaps and the middle stays clear, 1024–1920 px', () => {
    for (const [w, h] of [[1024, 700], [1024, 768], [1280, 800], [1440, 900], [1920, 1080]]) {
      const L = computeHudLayout(w, h, HELI, 'normal', 'steam');
      expect(L.rightGauges).toBe(4);
      expect(L.stripKind).toBe('heli');
      expect(L.right.w).toBeGreaterThan(L.left.w);
      expect(L.left.x + L.left.w).toBeLessThanOrEqual(L.right.x);
      expect(L.right.x + L.right.w).toBeLessThanOrEqual(w);
      const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlaps(L.strip, L.left)).toBe(false);
      expect(overlaps(L.strip, L.right)).toBe(false);
      // The middle of the screen stays clear.
      for (const r of [L.left, L.right, L.strip]) expect(r.y).toBeGreaterThan(h * 0.6);
    }
    const fixed = computeHudLayout(1440, 900, CONFIG, 'normal', 'steam');
    expect(fixed.rightGauges).toBe(3);
    expect(fixed.stripKind).toBe('fixed');
  });
});

describe('helicopter HUD', () => {
  const contexts = new Map<HTMLCanvasElement, MockCtx>();
  let hud: Hud;

  beforeEach(() => {
    contexts.clear();
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      let m = contexts.get(this);
      if (!m) {
        m = mockCtx(this.width, this.height);
        contexts.set(this, m);
      }
      return m.ctx;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
    (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: 1440, height: 900 });
    document.body.innerHTML = '<div id="hud"></div>';
  });
  afterEach(() => hud?.dispose());

  const info = (over: Partial<HudInfo> = {}): HudInfo => ({
    cameraMode: 'chase', paused: false, fps: 60, timeOfDay: 'Morning', state: heliState(), controls: makeControls(), mouseYoke: false, ...over,
  });

  it('renders for a helicopter without throwing: dual tach and torquemeter in the right cluster, no NaN anywhere', () => {
    hud = createHud(document.getElementById('hud')!, { config: HELI, style: 'steam' });
    const gauges = [...document.querySelectorAll('canvas[data-gauge]')].map((c) => c.getAttribute('data-gauge'));
    expect(gauges).toEqual(['airspeed', 'attitude', 'altimeter', 'heading', 'vsi', 'dualTach', 'torque']);
    const m = createInstrumentModel();
    for (let i = 0; i < 5; i++) {
      const s = heliState({ time: 10 + i * DT });
      const r = updateInstruments(m, s, makeControls(), DT, HELI);
      expect(() => hud.update(r, info({ state: s }), DT)).not.toThrow();
    }
    // Without a rotor state as well.
    const r0 = updateInstruments(createInstrumentModel(), heliState({ rotor: null }), makeControls(), DT, HELI);
    expect(() => hud.update(r0, info(), DT)).not.toThrow();
    for (const mc of contexts.values()) expect(mc.bad()).toEqual([]);
    const texts = [...contexts.values()].flatMap((mc) => mc.texts()).join(' ');
    expect(texts).toContain('COLLECTIVE');
    expect(texts).toContain('SAS ON');
    expect(texts).not.toContain('FLAPS');
  });

  it('a model without setPanelDrawer is fine (the helicopter draws its own panel)', () => {
    expect(() => {
      hud = createHud(document.getElementById('hud')!, { config: HELI, style: 'steam', aircraft: undefined });
    }).not.toThrow();
  });

  it('flashes "Stability assist ON/OFF (K)" when the K switch toggles, and lights LOW ROTOR RPM', () => {
    hud = createHud(document.getElementById('hud')!, { config: HELI, style: 'steam' });
    const m = createInstrumentModel();
    const r = updateInstruments(m, heliState({ rotor: { omega: NOMINAL_OMEGA * 0.9 } }), makeControls(), DT, HELI);
    const toasts = () => [...document.querySelectorAll('.fsh-toast')].map((e) => e.textContent).join(' | ');
    hud.update(r, info({ controls: makeControls() }), DT);
    expect(toasts()).not.toMatch(/Stability assist/);
    hud.update(r, info({ controls: makeControls({ stabilityAssist: false }) }), DT);
    expect(toasts()).toContain('Stability assist OFF (K)');
    hud.update(r, info({ controls: makeControls({ stabilityAssist: true }) }), DT);
    expect(toasts()).toContain('Stability assist ON (K)');
    const low = document.querySelector('[data-ann="lowRotor"]') as HTMLElement;
    expect(low.hidden).toBe(false);
    expect(low.textContent).toBe('LOW ROTOR RPM');
    expect((document.querySelector('[data-ann="stall"]') as HTMLElement).hidden).toBe(true);
  });

  it('a fixed-wing HUD never flashes the stability assist', () => {
    hud = createHud(document.getElementById('hud')!);
    const r = updateInstruments(createInstrumentModel(), makeState(), makeControls(), DT);
    hud.update(r, { ...info({ state: makeState() }), controls: makeControls() }, DT);
    hud.update(r, { ...info({ state: makeState() }), controls: makeControls({ stabilityAssist: false }) }, DT);
    expect([...document.querySelectorAll('.fsh-toast')].map((e) => e.textContent).join(' ')).not.toMatch(/Stability/);
  });
});

describe('helicopter controls page', () => {
  it('a Helicopter block first for the JetRanger: collective, cyclic, pedals, attitude reference, engine, K', () => {
    const g = controlGroups(HELI);
    expect(g[0].id).toBe('helicopter');
    const rows = g[0].rows;
    const find = (id: string) => rows.find((r) => r.ids.includes(id as never))!;
    expect(find('throttleUp').action).toMatch(/collective/i);
    expect(find('throttleUp').keys).toEqual(expect.arrayContaining(['W', 'PgUp', 'S', 'PgDn']));
    expect(find('pitchUp').action).toMatch(/cyclic/i);
    expect(find('rollLeft').action).toMatch(/cyclic/i);
    expect(find('yawLeft').action).toMatch(/pedal/i);
    expect(find('trimNoseUp').keys).toEqual(['[', '/', ']']);
    expect(find('engine').keys).toEqual(['E']);
    expect(find('stabilityAssist').keys).toEqual(['K']);
    expect(find('stabilityAssist').action).toMatch(/stability assist/i);
  });

  it('fixed-wing pages keep their five groups, with a proper label for K and a JetRanger note', () => {
    const g = controlGroups();
    expect(g.map((x) => x.id)).toEqual(['flight', 'engine', 'weapons', 'cameras', 'sim']);
    const k = g.flatMap((x) => x.rows).find((r) => r.ids.includes('stabilityAssist'))!;
    expect(k.action).toMatch(/Stability assist.*helicopter/i);
    expect(k.keys).toEqual(['K']);
    expect(controlNotes().join(' ')).toMatch(/JetRanger/);
  });
});
