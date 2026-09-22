import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { computeAnimation, createAnimation, gearRetraction } from '../../src/aircraft/animate';
import { loftGeometry } from '../../src/aircraft/loft';
import { createAircraft } from '../../src/aircraft/index';
import { createDefaultVisualState, type AircraftVisualState } from '../../src/aircraft/types';
import { CONFIG } from '../../src/config';

const DEG = Math.PI / 180;
const S = CONFIG.aircraft.surfaces;

/** Finite doubles including wild out-of-range values (the model must clamp them). */
const wild = fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true });
const unit = fc.double({ min: -3, max: 3, noNaN: true });

const visualState = fc.record({
  elevator: unit,
  aileron: unit,
  rudder: unit,
  trim: unit,
  flapsDeg: fc.double({ min: -60, max: 90, noNaN: true }),
  gearPos: fc.double({ min: -1, max: 2, noNaN: true }),
  wheelCompression: fc.tuple(wild, wild, wild),
  wheelRollSpeed: fc.tuple(wild, wild, wild),
  nosewheelSteer: unit,
  propRpm: fc.double({ min: -500, max: 10000, noNaN: true }),
  time: fc.double({ min: -1e4, max: 1e5, noNaN: true }),
  cameraMode: fc.constantFrom('cockpit', 'chase', 'external', 'orbit' as const),
  lights: fc.record({ nav: fc.boolean(), strobe: fc.boolean(), beacon: fc.boolean(), landing: fc.boolean(), taxi: fc.boolean() }),
});

type VisualRecord = typeof visualState extends fc.Arbitrary<infer T> ? T : never;

function toState(r: VisualRecord): AircraftVisualState {
  return {
    ...createDefaultVisualState(),
    ...r,
    wheelCompression: [...r.wheelCompression] as [number, number, number],
    wheelRollSpeed: [...r.wheelRollSpeed] as [number, number, number],
  };
}

describe('property: animation mapping', () => {
  it('surface angles always stay within the configured limits and are finite', () => {
    const out = createAnimation();
    fc.assert(
      fc.property(visualState, (r) => {
        const a = computeAnimation(toState(r), out);
        for (const v of Object.values(a)) expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(a.elevatorRad)).toBeLessThanOrEqual(S.elevatorMaxDeg * DEG + 1e-9);
        expect(Math.abs(a.aileronLeftRad)).toBeLessThanOrEqual(S.aileronMaxDeg * DEG + 1e-9);
        expect(Math.abs(a.aileronRightRad)).toBeLessThanOrEqual(S.aileronMaxDeg * DEG + 1e-9);
        expect(Math.abs(a.rudderRad)).toBeLessThanOrEqual(S.rudderMaxDeg * DEG + 1e-9);
        expect(Math.abs(a.trimTabRad)).toBeLessThanOrEqual(S.trimTabMaxDeg * DEG + 1e-9);
        expect(a.flapRad).toBeGreaterThanOrEqual(0);
        expect(a.flapRad).toBeLessThanOrEqual(S.flapMaxDeg * DEG + 1e-9);
        expect(Math.abs(a.noseSteerRad)).toBeLessThanOrEqual(S.nosewheelSteerMaxDeg * DEG + 1e-9);
        for (const k of ['propBlend', 'nav', 'strobe', 'beacon', 'landing', 'taxi', 'noseGearRetract', 'mainGearRetract'] as const) {
          expect(a[k]).toBeGreaterThanOrEqual(0);
          expect(a[k]).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('gear motion is continuous in gearPos (no jumps between nearby positions)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: -1e-3, max: 1e-3, noNaN: true }), (p, dp) => {
        const a = { ...gearRetraction(p) };
        const b = { ...gearRetraction(Math.min(1, Math.max(0, p + dp))) };
        expect(Math.abs(a.main - b.main)).toBeLessThan(0.01);
        expect(Math.abs(a.nose - b.nose)).toBeLessThan(0.01);
        expect(Math.abs(a.door - b.door)).toBeLessThan(0.05);
      }),
      { numRuns: 400 },
    );
  });
});

describe('property: loft generator', () => {
  it('any set of star-shaped rings lofts into a valid mesh (indices in range, unit normals, closed seams)', () => {
    const ringArb = fc.array(fc.double({ min: 0.2, max: 2, noNaN: true }), { minLength: 3, maxLength: 12 });
    fc.assert(
      fc.property(fc.array(ringArb, { minLength: 2, maxLength: 6 }), fc.boolean(), (radiiSets, caps) => {
        const n = radiiSets[0].length;
        const rings = radiiSets.map((radii, i) => {
          const out: number[] = [];
          for (let j = 0; j < n; j++) {
            const r = radii[j % radii.length];
            const a = (2 * Math.PI * j) / n;
            out.push(r * Math.cos(a), r * Math.sin(a), i * 0.7);
          }
          return out;
        });
        const g = loftGeometry(rings, { capStart: caps, capEnd: caps });
        const pos = g.getAttribute('position');
        const nor = g.getAttribute('normal');
        const idx = g.getIndex()!;
        for (let k = 0; k < idx.count; k++) expect(idx.getX(k)).toBeLessThan(pos.count);
        for (let k = 0; k < nor.count; k++) {
          const l = Math.hypot(nor.getX(k), nor.getY(k), nor.getZ(k));
          expect(Math.abs(l - 1)).toBeLessThan(1e-4);
        }
        for (let i = 0; i < rings.length; i++) {
          const a = i * (n + 1);
          expect(pos.getX(a)).toBeCloseTo(pos.getX(a + n), 6);
          expect(pos.getY(a)).toBeCloseTo(pos.getY(a + n), 6);
        }
      }),
      { numRuns: 150 },
    );
  });
});

describe('property: the built model never produces NaN transforms', () => {
  let ac: ReturnType<typeof createAircraft>;
  beforeAll(() => {
    ac = createAircraft({ quality: 'low' });
  });

  it('random (including out-of-range) visual states leave every world matrix finite', () => {
    const m = new THREE.Matrix4();
    fc.assert(
      fc.property(visualState, fc.double({ min: -1, max: 2, noNaN: true }), (r, dt) => {
        ac.setVisualState(toState(r), dt);
        ac.root.updateMatrixWorld(true);
        ac.root.traverse((o) => {
          m.copy(o.matrixWorld);
          for (const e of m.elements) expect(Number.isFinite(e)).toBe(true);
        });
        expect(Number.isFinite(ac.landingLight.intensity)).toBe(true);
      }),
      { numRuns: 60 },
    );
  });
});
