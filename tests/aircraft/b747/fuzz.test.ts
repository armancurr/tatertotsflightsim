/**
 * Property tests: whatever the sim throws at the 747 (NaN, infinities, out-of-range controls,
 * random time steps), the animation stays finite and inside the real surface limits, the model's
 * transforms never go NaN, and the anchors (the wing-gear truck, the fin top) never move.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createB747Anim, stepB747Anim, B747_LIMITS } from '../../../src/aircraft/b747/animate';
import { createB747Model, B747_PART } from '../../../src/aircraft/b747';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

const DEG = Math.PI / 180;
const L = B747_LIMITS;
const wild = fc.oneof(
  fc.double({ min: -3, max: 3, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, -1, 1e9, -1e9),
);
const modes = fc.constantFrom('cockpit', 'chase', 'external', 'orbit') as fc.Arbitrary<AircraftVisualState['cameraMode']>;
const phases = fc.constantFrom('ground', 'airborne', 'landed', 'crashed') as fc.Arbitrary<'ground' | 'airborne' | 'landed' | 'crashed'>;

const visualState: fc.Arbitrary<AircraftVisualState> = fc
  .record({
    elevator: wild, aileron: wild, rudder: wild, trim: wild,
    flapsDeg: fc.oneof(fc.double({ min: -10, max: 90, noNaN: true }), fc.constant(Number.NaN)),
    gearPos: wild, comp: fc.tuple(wild, wild, wild), roll: fc.tuple(wild, wild, wild), steer: wild,
    rpm: fc.oneof(fc.double({ min: -50, max: 200, noNaN: true }), fc.constant(Number.NaN)),
    running: fc.boolean(),
    time: fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constant(Number.NaN)),
    mode: modes, sb: wild, crashed: fc.boolean(), crashAge: wild, phase: phases, kt: wild, withInst: fc.boolean(),
    lights: fc.record({ nav: fc.boolean(), strobe: fc.boolean(), beacon: fc.boolean(), landing: fc.boolean(), taxi: fc.boolean() }),
  })
  .map((r) => ({
    ...createDefaultVisualState(),
    elevator: r.elevator, aileron: r.aileron, rudder: r.rudder, trim: r.trim, flapsDeg: r.flapsDeg, gearPos: r.gearPos,
    wheelCompression: r.comp, wheelRollSpeed: r.roll, nosewheelSteer: r.steer, propRpm: r.rpm, engineRunning: r.running,
    time: r.time, cameraMode: r.mode, speedBrake: r.sb, crashed: r.crashed, crashAge: r.crashAge, lights: r.lights,
    instruments: r.withInst ? { ...createRestReadings(), airspeedKt: r.kt, state: r.phase } : null,
  }));
const dtArb = fc.oneof(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.constantFrom(Number.NaN, -1, Number.POSITIVE_INFINITY));

describe('747 animation fuzz', () => {
  it('every output is finite and inside the real travel limits', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(visualState, dtArb), { minLength: 1, maxLength: 12 }), (steps) => {
        const a = createB747Anim();
        for (const [s, dt] of steps) {
          stepB747Anim(s, a, dt);
          for (const [k, val] of Object.entries(a)) {
            if (Array.isArray(val)) for (const x of val) expect(Number.isFinite(x), k).toBe(true);
            else expect(Number.isFinite(val as number), k).toBe(true);
          }
          const e = 1e-9;
          expect(a.elevatorRad).toBeGreaterThanOrEqual(-L.elevatorUpDeg * DEG - e);
          expect(a.elevatorRad).toBeLessThanOrEqual(L.elevatorDownDeg * DEG + e);
          for (const r of [a.rudderUpperRad, a.rudderLowerRad]) expect(Math.abs(r)).toBeLessThanOrEqual(L.rudderDeg * DEG + e);
          for (const r of [a.aileronLeftInRad, a.aileronRightInRad, a.aileronLeftOutRad, a.aileronRightOutRad]) expect(Math.abs(r)).toBeLessThanOrEqual(L.aileronDeg * DEG + e);
          for (const r of [a.spoilerLeftRad, a.spoilerRightRad]) {
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(L.spoilerMaxDeg * DEG + e);
          }
          expect(a.flapDeg).toBeGreaterThanOrEqual(0);
          expect(a.flapDeg).toBeLessThanOrEqual(30 + e);
          for (const k of [a.flapTravel, a.krueger, a.legs, a.doors, a.nav, a.strobe, a.beacon, a.landing, a.taxi, a.logo, a.fanBlur]) {
            expect(k).toBeGreaterThanOrEqual(0);
            expect(k).toBeLessThanOrEqual(1);
          }
          expect(Math.abs(a.noseSteerRad)).toBeLessThanOrEqual(L.noseSteerDeg * DEG + e);
          for (const c of a.compression) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(L.maxCompression);
          }
          expect(Math.abs(a.truckTiltRad)).toBeLessThanOrEqual(L.truckTiltDeg * DEG + e);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('747 model fuzz', () => {
  let m: ReturnType<typeof createB747Model>;
  beforeAll(() => {
    m = createB747Model();
  });
  afterAll(() => m.dispose());

  it('no transform or light ever goes NaN, and the fixed anchors stay put', () => {
    const fin = m.root.getObjectByName(B747_PART.tail)!;
    const fin0 = fin.matrixWorld.clone();
    fc.assert(
      fc.property(fc.array(fc.tuple(visualState, dtArb), { minLength: 1, maxLength: 6 }), (steps) => {
        for (const [s, dt] of steps) m.setVisualState(s, dt);
        m.root.updateMatrixWorld(true);
        m.root.traverse((o) => {
          for (const e of o.matrixWorld.elements) expect(Number.isFinite(e), o.name).toBe(true);
        });
        expect(Number.isFinite(m.landingLight!.intensity)).toBe(true);
        const glow = m.root.getObjectByName(B747_PART.glows) as THREE.Points;
        const it = glow.geometry.getAttribute('intensity');
        for (let i = 0; i < it.count; i++) expect(Number.isFinite(it.getX(i))).toBe(true);
        for (let k = 0; k < 16; k++) expect(fin.matrixWorld.elements[k]).toBeCloseTo(fin0.elements[k], 9);
      }),
      { numRuns: 60 },
    );
  }, 60000);
});
