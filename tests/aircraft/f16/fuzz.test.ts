/**
 * Property tests: whatever the sim throws at the F-16 (NaN, infinities, out-of-range controls,
 * random time steps), the animation stays finite and inside the real surface limits, and the
 * model's transforms never go NaN.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createF16Anim, stepF16Anim, F16_LIMITS } from '../../../src/aircraft/f16/animate';
import { createF16Model, F16_PART } from '../../../src/aircraft/f16';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';

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
    flapsDeg: fc.oneof(fc.double({ min: -10, max: 60, noNaN: true }), fc.constant(Number.NaN)),
    gearPos: wild,
    comp: fc.tuple(wild, wild, wild),
    roll: fc.tuple(wild, wild, wild),
    steer: wild,
    rpm: wild,
    running: fc.boolean(),
    time: fc.oneof(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.constant(Number.NaN)),
    mode: modes,
    ab: wild,
    sb: wild,
    crashed: fc.boolean(),
    crashAge: wild,
    aoa: wild,
    thr: fc.oneof(fc.double({ min: -50, max: 200, noNaN: true }), fc.constant(Number.NaN)),
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
    afterburner: r.ab,
    speedBrake: r.sb,
    crashed: r.crashed,
    crashAge: r.crashAge,
    lights: r.lights,
    instruments: r.withInst ? { ...createRestReadings(), aoaDeg: r.aoa, throttlePct: r.thr, state: 'airborne' as const } : null,
  }));

const dtArb = fc.oneof(fc.double({ min: 0, max: 0.5, noNaN: true }), fc.constantFrom(Number.NaN, -1, Number.POSITIVE_INFINITY));

describe('F-16 animation fuzz', () => {
  it('every output stays finite and inside the real surface limits', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(visualState, dtArb), { minLength: 1, maxLength: 25 }), (steps) => {
        const a = createF16Anim();
        for (const [v, dt] of steps) {
          stepF16Anim(v, a, dt);
          for (const [k, val] of Object.entries(a)) {
            if (Array.isArray(val)) for (const x of val) expect(Number.isFinite(x), k).toBe(true);
            else expect(Number.isFinite(val as number), k).toBe(true);
          }
          const L = F16_LIMITS;
          expect(Math.abs(a.stabLeftRad)).toBeLessThanOrEqual(L.stabMaxDeg * DEG + 1e-9);
          expect(Math.abs(a.stabRightRad)).toBeLessThanOrEqual(L.stabMaxDeg * DEG + 1e-9);
          for (const f of [a.flaperonLeftRad, a.flaperonRightRad]) {
            expect(f).toBeGreaterThanOrEqual(-L.flaperonUpDeg * DEG - 1e-9);
            expect(f).toBeLessThanOrEqual(L.flaperonFlapDeg * DEG + 1e-9);
          }
          expect(Math.abs(a.rudderRad)).toBeLessThanOrEqual(L.rudderDeg * DEG + 1e-9);
          expect(a.lefRad).toBeGreaterThanOrEqual(L.lefMinDeg * DEG - 1e-9);
          expect(a.lefRad).toBeLessThanOrEqual(L.lefMaxDeg * DEG + 1e-9);
          expect(a.speedBrakeRad).toBeGreaterThanOrEqual(0);
          expect(a.speedBrakeRad).toBeLessThanOrEqual(L.speedBrakeDeg * DEG + 1e-9);
          for (const u of [a.speedBrake, a.nozzleOpen, a.heat, a.ab, a.noseLeg, a.mainLeg, a.noseDoor, a.mainDoor, a.nav, a.formation, a.strobe, a.landing, a.taxi]) {
            expect(u).toBeGreaterThanOrEqual(0);
            expect(u).toBeLessThanOrEqual(1);
          }
          for (const c of a.compression) {
            expect(c).toBeGreaterThanOrEqual(0);
            expect(c).toBeLessThanOrEqual(L.maxCompression);
          }
          expect(Math.abs(a.noseSteerRad)).toBeLessThanOrEqual(L.noseSteerDeg * DEG + 1e-9);
          for (const w of a.wheelAngle) expect(Math.abs(w)).toBeLessThan(Math.PI * 2 + 1e-9);
        }
      }),
      { numRuns: 300 },
    );
  }, 60000);

  it('the legs never move while the doors are shut (doors lead the legs both ways)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (g) => {
        const a = stepF16Anim({ ...createDefaultVisualState(), gearPos: g }, createF16Anim(), 0);
        if (a.noseLeg > 0.001 && a.noseLeg < 0.999) expect(a.noseDoor).toBeGreaterThan(0.99);
        if (a.mainLeg > 0.001 && a.mainLeg < 0.999) expect(a.mainDoor).toBeGreaterThan(0.99);
      }),
      { numRuns: 400 },
    );
  });
});

describe('F-16 model fuzz', () => {
  let m: ReturnType<typeof createF16Model>;
  beforeAll(() => {
    m = createF16Model();
  });
  afterAll(() => m.dispose());

  it('random visual state sequences never produce a NaN transform anywhere in the model', () => {
    const e = new THREE.Matrix4().elements;
    fc.assert(
      fc.property(fc.array(fc.tuple(visualState, dtArb), { minLength: 1, maxLength: 8 }), (steps) => {
        for (const [v, dt] of steps) m.setVisualState(v, dt);
        m.root.updateMatrixWorld(true);
        m.root.traverse((o) => {
          const el = o.matrixWorld.elements;
          for (let i = 0; i < 16; i++) expect(Number.isFinite(el[i]), o.name).toBe(true);
          void e;
        });
        const plume = m.root.getObjectByName(F16_PART.plume) as THREE.Mesh;
        const u = (plume.material as THREE.ShaderMaterial).uniforms;
        for (const k of ['uAB', 'uTime', 'uLen']) expect(Number.isFinite(u[k].value)).toBe(true);
      }),
      { numRuns: 120 },
    );
  }, 60000);
});
