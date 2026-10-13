/**
 * The Iowa's turret contract, pure maths (src/vessels/iowa/turrets.ts — what the naval gunnery
 * imports): a muzzle is at position + R_y(train) · ((x_k, trunnionHeight, −trunnionForward) +
 * R_x(elev) · (0, 0, −barrelLength)), train + = starboard, elevation + = up, barrel 0 the left gun.
 * Checked against hand-worked cases and, for random angles, against an independent three.js matrix
 * chain built the way the 3D model's rig is (rotation.y = −train, rotation.x = +elev).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { IOWA_WEAPONS, type NavalTurretConfig } from '../../../src/config';
import { IOWA_RECOIL_M, barrelOffset, foldTrain, iowaBoreBody, iowaMuzzleBody, iowaTrunnionBody } from '../../../src/vessels/iowa/turrets';
import { fcParams } from '../../support/fc';

const T = IOWA_WEAPONS.naval!.turrets;
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol = 1e-6) =>
  expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(tol);

/** The rig's own chain, independently: train pivot → elevation pivot → barrel → muzzle. */
function viaMatrices(t: NavalTurretConfig, train: number, elev: number, k: number, recoil = 0): THREE.Vector3 {
  const D = Math.PI / 180;
  const m = new THREE.Matrix4()
    .makeTranslation(t.position.x, t.position.y, t.position.z)
    .multiply(new THREE.Matrix4().makeRotationY(-train * D))
    .multiply(new THREE.Matrix4().makeTranslation(0, t.trunnionHeight, -t.trunnionForward))
    .multiply(new THREE.Matrix4().makeRotationX(elev * D))
    .multiply(new THREE.Matrix4().makeTranslation(barrelOffset(t, k), 0, recoil * IOWA_RECOIL_M));
  return new THREE.Vector3(0, 0, -t.barrelLength).applyMatrix4(m);
}

describe('Iowa turret maths (the gunnery contract)', () => {
  it('three triple turrets: I and II forward (II superfiring, higher), III aft stowed at 180°', () => {
    expect(T.map((t) => t.name)).toEqual(['I', 'II', 'III']);
    expect(T.every((t) => t.barrels === 3 && t.position.x === 0)).toBe(true);
    expect(T[0].position.z).toBeLessThan(T[1].position.z);
    expect(T[1].position.z).toBeLessThan(0);
    expect(T[2].position.z).toBeGreaterThan(0);
    expect(T[1].position.y).toBeGreaterThan(T[0].position.y + 3);
    expect(T[2].stowDeg).toBe(180);
  });

  it('trained ahead and level: the centre muzzle is straight ahead of the trunnion by the barrel length', () => {
    const t = T[0];
    near(iowaMuzzleBody(t, 0, 0, 1), { x: 0, y: t.position.y + t.trunnionHeight, z: t.position.z - t.trunnionForward - t.barrelLength });
    // the left gun is to port, the right one to starboard
    expect(iowaMuzzleBody(t, 0, 0, 0).x).toBeCloseTo(-t.barrelSpacing, 9);
    expect(iowaMuzzleBody(t, 0, 0, 2).x).toBeCloseTo(t.barrelSpacing, 9);
  });

  it('train + = starboard: at +90° the guns point to +X (and the left gun is then forward)', () => {
    const t = T[1];
    const m = iowaMuzzleBody(t, 90, 0, 1);
    near(m, { x: t.trunnionForward + t.barrelLength, y: t.position.y + t.trunnionHeight, z: t.position.z });
    expect(iowaMuzzleBody(t, 90, 0, 0).z).toBeLessThan(m.z);
    near(iowaBoreBody(90, 0), { x: 1, y: 0, z: 0 });
    near(iowaBoreBody(-90, 0), { x: -1, y: 0, z: 0 });
    // turret III stowed at 180°: guns over the fantail (+Z)
    const aft = iowaMuzzleBody(T[2], 180, 0, 1);
    expect(aft.z).toBeCloseTo(T[2].position.z + T[2].trunnionForward + T[2].barrelLength, 9);
  });

  it('elevation + = up: at 45° the muzzle rises by L sin 45° and comes back by L (1 − cos 45°)', () => {
    const t = T[0];
    const lvl = iowaMuzzleBody(t, 0, 0, 1);
    const up = iowaMuzzleBody(t, 0, 45, 1);
    expect(up.y - lvl.y).toBeCloseTo(t.barrelLength * Math.SQRT1_2, 9);
    expect(up.z - lvl.z).toBeCloseTo(t.barrelLength * (1 - Math.SQRT1_2), 9);
    const bore = iowaBoreBody(0, 45);
    near(bore, { x: 0, y: Math.SQRT1_2, z: -Math.SQRT1_2 });
    // the trunnion doesn't move with elevation
    near(iowaTrunnionBody(t, 0, 1), { x: 0, y: t.position.y + t.trunnionHeight, z: t.position.z - t.trunnionForward });
  });

  it('recoil slides the muzzle back along the bore by up to 1.22 m (48 in)', () => {
    const t = T[0];
    const a = iowaMuzzleBody(t, 30, 20, 2);
    const b = iowaMuzzleBody(t, 30, 20, 2, 1);
    const bore = iowaBoreBody(30, 20);
    expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeCloseTo(IOWA_RECOIL_M, 9);
    expect((a.x - b.x) * bore.x + (a.y - b.y) * bore.y + (a.z - b.z) * bore.z).toBeCloseTo(IOWA_RECOIL_M, 9);
  });

  it('matches the rig\'s matrix chain for any train, elevation, gun and recoil (fuzz)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.double({ min: -360, max: 360, noNaN: true }),
        fc.double({ min: -2, max: 45, noNaN: true }),
        fc.integer({ min: 0, max: 2 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (ti, train, elev, k, recoil) => {
          const t = T[ti];
          const out = { x: 0, y: 0, z: 0 };
          const r = iowaMuzzleBody(t, train, elev, k, recoil, out);
          expect(r).toBe(out); // writes into `out`: no allocation
          near(r, viaMatrices(t, train, elev, k, recoil), 1e-6);
          // the muzzle is barrelLength − recoil from its trunnion
          const tr = iowaTrunnionBody(t, train, k);
          expect(Math.hypot(r.x - tr.x, r.y - tr.y, r.z - tr.z)).toBeCloseTo(t.barrelLength - recoil * IOWA_RECOIL_M, 6);
        },
      ),
      fcParams(300),
    );
  });

  it('foldTrain: forward turrets in −180…180, the aft turret in 0…360', () => {
    expect(foldTrain(T[0], 270)).toBeCloseTo(-90, 9);
    expect(foldTrain(T[0], -190)).toBeCloseTo(170, 9);
    expect(foldTrain(T[2], -90)).toBeCloseTo(270, 9);
    expect(foldTrain(T[2], 540)).toBeCloseTo(180, 9);
    expect(foldTrain(T[2], Number.NaN)).toBe(180);
  });
});
