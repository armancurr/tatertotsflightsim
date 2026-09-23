/**
 * Property tests: whatever the sim throws at the A-10 (NaN, infinities, out-of-range controls,
 * random time steps, stores arrays of any length), the animation stays finite and inside the real
 * surface limits, the model's transforms never go NaN, and the fixed anchors never move.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createA10Anim, stepA10Anim, A10_LIMITS } from '../../../src/aircraft/a10/animate';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { A10_WEAPONS } from '../../../src/config';

const DEG = Math.PI / 180;
const wild = fc.oneof(
  fc.double({ min: -3, max: 3, noNaN: true }),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1, -1, 1e9, -1e9),
);
const modes = fc.constantFrom('cockpit', 'chase', 'external', 'orbit') as fc.Arbitrary<AircraftVisualState['cameraMode']>;

const visualState: fc.Arbitrary<AircraftVisualState> = fc
  .record({
    elevator: wild,
    aileron: wild,
    rudder: wild,
    trim: wild,
    flapsDeg: fc.oneof(fc.double({ min: -10, max: 90, noNaN: true }), fc.constant(Number.NaN)),
    gearPos: wild,
    comp: fc.tuple(wild, wild, wild),
    roll: fc.tuple(wild, wild, wild),
    steer: wild,
    rpm: fc.oneof(fc.double({ min: -50, max: 200, noNaN: true }), fc.constant(Number.NaN)),
    running: fc.boolean(),
    time: fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constant(Number.NaN)),
    mode: modes,
    sb: wild,
    gun: wild,
    stores: fc.array(fc.boolean(), { maxLength: 6 }),
    crashed: fc.boolean(),
    crashAge: wild,
    aoa: wild,
    kt: wild,
    withInst: fc.boolean(),
    lights: fc.record({ nav: fc.boolean(), strobe: fc.boolean(), beacon: fc.boolean(), landing: fc.boolean(), taxi: fc.boolean() }),
  })
  .map((r) => ({
    ...createDefaultVisualState(),
    elevator: r.elevator,
    aileron: r.aileron,
    rudder: r.rudder,
    trim: r.trim,
    flapsDeg: r.flapsDeg,
    gearPos: r.gearPos,
    wheelCompression: r.comp,
    wheelRollSpeed: r.roll,
    nosewheelSteer: r.steer,
    propRpm: r.rpm,
    engineRunning: r.running,
    time: r.time,
    cameraMode: r.mode,
    speedBrake: r.sb,
    gunSpin: r.gun,
    stores: r.stores,
    crashed: r.crashed,
    crashAge: r.crashAge,
    lights: r.lights,
    instruments: r.withInst ? { ...createRestReadings(), aoaDeg: r.aoa, airspeedKt: r.kt, state: 'airborne' as const } : null,
  }));
const dtArb = fc.oneof(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.constantFrom(Number.NaN, -1, Number.POSITIVE_INFINITY));

describe('A-10 animation fuzz', () => {
  it('every output is finite and inside the real travel limits', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(visualState, dtArb), { minLength: 1, maxLength: 12 }), (steps) => {
        const a = createA10Anim();
        for (const [s, dt] of steps) {
          stepA10Anim(s, a, dt);
          for (const [k, val] of Object.entries(a)) {
            if (Array.isArray(val)) for (const x of val) expect(Number.isFinite(x), k).toBe(true);
            else expect(Number.isFinite(val as number), k).toBe(true);
          }
          const L = A10_LIMITS;
          expect(a.elevatorRad).toBeGreaterThanOrEqual(-L.elevatorUpDeg * DEG - 1e-9);
          expect(a.elevatorRad).toBeLessThanOrEqual(L.elevatorDownDeg * DEG + 1e-9);
          expect(Math.abs(a.rudderRad)).toBeLessThanOrEqual(L.rudderDeg * DEG + 1e-9);
          for (const d of [a.decelLeftUpperRad, a.decelLeftLowerRad, a.decelRightUpperRad, a.decelRightLowerRad]) expect(Math.abs(d)).toBeLessThanOrEqual((L.aileronDeg + L.splitDeg) * DEG + 1e-9);
          // The halves never cross: the lower half is always at or below the upper one.
          expect(a.decelLeftLowerRad).toBeGreaterThanOrEqual(a.decelLeftUpperRad - 1e-9);
          expect(a.decelRightLowerRad).toBeGreaterThanOrEqual(a.decelRightUpperRad - 1e-9);
          expect(a.flapRad).toBeGreaterThanOrEqual(0);
          expect(a.flapRad).toBeLessThanOrEqual(L.flapMaxDeg * DEG + 1e-9);
          for (const x of [a.slat, a.split, a.gunSpin, a.gunBlur, a.fanBlur, a.noseLeg, a.mainLeg, a.noseDoor]) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(1);
          }
          expect(Math.abs(a.gunAngle)).toBeLessThan(2 * Math.PI);
          expect(Math.abs(a.fanAngle)).toBeLessThan(2 * Math.PI);
          for (const c of a.compression) expect(c).toBeLessThanOrEqual(A10_LIMITS.maxCompression);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('A-10 model fuzz', () => {
  let m: ReturnType<typeof createA10Model>;
  beforeAll(() => {
    m = createA10Model();
  });
  afterAll(() => m.dispose());

  it('no transform ever goes NaN, and the muzzle and missile stations stay put', { timeout: 60_000 }, () => {
    const muzzle = m.root.getObjectByName(A10_PART.gunMuzzle)!;
    const mz = A10_WEAPONS.gun!.muzzle;
    fc.assert(
      fc.property(visualState, dtArb, (s, dt) => {
        m.setVisualState(s, dt);
        m.root.updateMatrixWorld(true);
        let bad = '';
        m.root.traverse((o) => {
          const e = o.matrixWorld.elements;
          for (let k = 0; k < 16; k++) if (!Number.isFinite(e[k])) bad = o.name;
        });
        expect(bad).toBe('');
        expect(muzzle.position.x).toBe(mz.x);
        expect(muzzle.position.z).toBe(mz.z);
        A10_WEAPONS.missiles!.stations.forEach((st, i) => {
          const o = m.root.getObjectByName(A10_PART.store(i))!;
          expect(o.position.distanceTo(new THREE.Vector3(st.x, st.y, st.z))).toBeLessThan(1e-9);
          expect(o.visible).toBe(s.stores?.[i] !== false);
        });
      }),
      { numRuns: 120 },
    );
  });
});
