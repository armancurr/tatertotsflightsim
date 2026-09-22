import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { WRECK, charProgress, deformWreckPoint, wingFoldTransform, tailSkewTransform } from '../../src/aircraft/wreck';
import { createAircraft, PART } from '../../src/aircraft/index';
import { createDefaultVisualState, type AircraftVisualState } from '../../src/aircraft/types';

const P = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('wreck deformation (pure)', () => {
  it('leaves the cabin section alone', () => {
    const out = new THREE.Vector3();
    for (const p of [P(0, 0.9, 0), P(0.5, 0, 0.5), P(-0.5, -0.4, 1.5), P(2.0, 1.0, -0.3), P(-2.3, 1.0, 0.2)]) {
      deformWreckPoint(p, out);
      expect(out.distanceTo(p)).toBeLessThan(1e-9);
    }
  });
  it('folds the left outer wing down at the strut, crumples the nose aft and skews the tail', () => {
    const out = new THREE.Vector3();
    deformWreckPoint(P(-5.2, 1.1, 0.3), out);
    expect(out.y).toBeLessThan(1.1 - 0.5);
    deformWreckPoint(P(5.2, 1.1, 0.3), out);
    expect(out.distanceTo(P(5.2, 1.1, 0.3))).toBeLessThan(1e-9);
    deformWreckPoint(P(0, 0, -1.95), out);
    expect(out.z).toBeGreaterThan(-1.95 + 0.08);
    deformWreckPoint(P(0, 0.5, 5.5), out);
    expect(Math.abs(out.x)).toBeGreaterThan(0.2);
  });
  it('the rigid tail and wing-fold transforms match the skin deformation where they apply', () => {
    const out = new THREE.Vector3();
    const tail = tailSkewTransform();
    const fold = wingFoldTransform();
    for (const p of [P(0, 1.2, 5.3), P(1.5, 0, 5.4), P(-0.3, 0.2, 4.9)]) {
      deformWreckPoint(p, out);
      expect(out.distanceTo(p.clone().applyMatrix4(tail))).toBeLessThan(0.03);
    }
    for (const p of [P(-4.0, 1.07, 0.2), P(-3.0, 1.03, 0.9)]) {
      const q = p.clone().applyMatrix4(fold);
      deformWreckPoint(p, out);
      expect(out.distanceTo(q)).toBeLessThan(0.03);
    }
  });
  it('charring spreads over a few seconds and saturates', () => {
    expect(charProgress(0)).toBe(0);
    expect(charProgress(WRECK.charSeconds)).toBeCloseTo(1, 6);
    let prev = 0;
    for (let t = 0; t <= 20; t += 0.1) {
      const c = charProgress(t);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = c;
    }
  });
});

describe('property: wreck deformation is finite, bounded and continuous', () => {
  it('any airframe point moves less than 1.2 m and nearby points stay nearby', () => {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    fc.assert(
      fc.property(
        fc.double({ min: -6, max: 6, noNaN: true }),
        fc.double({ min: -1.5, max: 2, noNaN: true }),
        fc.double({ min: -2.5, max: 6.5, noNaN: true }),
        (x, y, z) => {
          // Only points on the airframe: out on the left wing that means near the wing itself.
          fc.pre(!(x < -2.4 && (Math.abs(y - 1.0) > 0.35 || z < -0.9 || z > 1.4)));
          // …and aft of the wing only the fuselage and the tail (stabiliser span ±1.73 m).
          fc.pre(!(z > 1.5 && Math.abs(x) > 1.8));
          const p = P(x, y, z);
          deformWreckPoint(p, a);
          expect(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)).toBe(true);
          expect(a.distanceTo(p)).toBeLessThan(1.2);
          deformWreckPoint(P(x + 0.004, y - 0.003, z + 0.002), b);
          expect(a.distanceTo(b)).toBeLessThan(0.05);
        },
      ),
      { numRuns: 400 },
    );
  });
  it('charProgress is in [0, 1] for any age', () => {
    fc.assert(
      fc.property(fc.oneof(fc.double({ noNaN: false }), fc.constantFrom(Number.NaN, Infinity, -Infinity)), (t) => {
        const c = charProgress(t);
        expect(Number.isFinite(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe('wreck appearance on the built model', () => {
  let ac: ReturnType<typeof createAircraft>;
  const st = (patch: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), ...patch });
  const snapshot = () => {
    ac.root.updateMatrixWorld(true);
    const out: number[] = [];
    ac.root.traverse((o) => {
      const m = o as THREE.Mesh;
      out.push(o.visible ? 1 : 0, ...o.matrixWorld.elements);
      if (m.isMesh) out.push(m.geometry.id);
    });
    return out;
  };
  beforeAll(() => {
    ac = createAircraft({ quality: 'low' });
  });

  it('crashed: glass gone, prop bent and stopped, left wing folded, gear collapsed, lights dead', () => {
    ac.setVisualState(st({ crashed: false }), 1 / 60);
    const wing = ac.root.getObjectByName(PART.wing) as THREE.Mesh;
    const wingGeo = wing.geometry;
    ac.setVisualState(st({ crashed: true, crashAge: 8, propRpm: 2400, lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: false } }), 1 / 60);
    ac.root.updateMatrixWorld(true);
    expect(ac.root.getObjectByName(PART.glass)!.visible).toBe(false);
    expect(wing.geometry).not.toBe(wingGeo);
    const blades = ac.root.getObjectByName(PART.propBlades) as THREE.Mesh;
    expect(blades.visible).toBe(true);
    expect(ac.root.getObjectByName(PART.propDisc)!.visible).toBe(false);
    const spin0 = blades.parent!.rotation.z;
    ac.setVisualState(st({ crashed: true, crashAge: 8.1, propRpm: 2400 }), 1 / 60);
    expect(blades.parent!.rotation.z).toBe(spin0);
    const nose = ac.root.getObjectByName(PART.axleNose)!.getWorldPosition(new THREE.Vector3());
    expect(ac.root.worldToLocal(nose).z).toBeGreaterThan(-1.0);
    expect(ac.root.getObjectByName('navLights')!.visible).toBe(false);
    expect(ac.root.getObjectByName('lightGlows')!.visible).toBe(false);
    expect(ac.landingLight.visible).toBe(false);
  });

  it('resetting (crashed = false) restores the intact aircraft exactly (transforms, visibility, geometry)', () => {
    const v = st({ gearPos: 1, propRpm: 0, time: 1 });
    ac.setVisualState(v, 1 / 60);
    const before = snapshot();
    ac.setVisualState(st({ crashed: true, crashAge: 3 }), 1 / 60);
    ac.setVisualState(st({ crashed: true, crashAge: 9 }), 1 / 60);
    expect(snapshot()).not.toEqual(before);
    ac.setVisualState(v, 1 / 60);
    expect(snapshot()).toEqual(before);
    expect(ac.root.getObjectByName(PART.glass)!.visible).toBe(true);
    const wing = ac.root.getObjectByName(PART.wing) as THREE.Mesh;
    const pos = wing.geometry.getAttribute('position');
    let minY = Infinity;
    for (let i = 0; i < pos.count; i++) if (pos.getX(i) < -5) minY = Math.min(minY, pos.getY(i));
    expect(minY).toBeGreaterThan(0.9);
  });
});
