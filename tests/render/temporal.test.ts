/**
 * Temporal reprojection for the cloud buffer (temporal.ts): projection of a
 * world point with the previous frame's view-projection matrix, history
 * acceptance/rejection, and the per-frame jitter sequence.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { projectToUv, historyWeight, frameJitter, type UvResult } from '../../src/render/temporal';

function camera(x: number, y: number, z: number, yawDeg: number, pitchDeg: number) {
  const c = new THREE.PerspectiveCamera(60, 1.6, 0.1, 90000);
  c.position.set(x, y, z);
  c.rotation.set((pitchDeg * Math.PI) / 180, (-yawDeg * Math.PI) / 180, 0, 'YXZ');
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}
const viewProj = (c: THREE.PerspectiveCamera) => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).elements;

describe('reprojection', () => {
  it('matches three.js Vector3.project for any camera pose and point in front', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        fc.double({ min: -360, max: 360, noNaN: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: 5, max: 40000, noNaN: true }),
        (x, y, yaw, pitch, sx, sy, dist) => {
          const c = camera(x, y, 100, yaw, pitch);
          const dir = new THREE.Vector3(sx, sy, -1).normalize().transformDirection(c.matrixWorld);
          const p = c.position.clone().addScaledVector(dir, dist);
          const r: UvResult = { u: 0, v: 0, valid: false };
          projectToUv(viewProj(c), p.x, p.y, p.z, r);
          const q = p.clone().project(c);
          expect(r.valid).toBe(true);
          expect(r.u).toBeCloseTo(q.x * 0.5 + 0.5, 5);
          expect(r.v).toBeCloseTo(q.y * 0.5 + 0.5, 5);
        },
      ),
    );
  });
  it('a static camera reprojects a pixel onto itself; a camera moving right shifts distant-ish points left', () => {
    const a = camera(0, 1000, 0, 0, 0);
    const b = camera(50, 1000, 0, 0, 0);
    const p = new THREE.Vector3(0, 1000, -2000);
    const r: UvResult = { u: 0, v: 0, valid: false };
    projectToUv(viewProj(a), p.x, p.y, p.z, r);
    expect(r.u).toBeCloseTo(0.5, 9);
    expect(r.v).toBeCloseTo(0.5, 9);
    // current camera b sees the point left of centre; in the previous frame (a) it was centred
    const now: UvResult = { u: 0, v: 0, valid: false };
    projectToUv(viewProj(b), p.x, p.y, p.z, now);
    expect(now.u).toBeLessThan(0.5);
  });
  it('points behind the camera or at infinity are invalid; output is always finite', () => {
    const c = camera(0, 0, 0, 0, 0);
    const r: UvResult = { u: 0, v: 0, valid: true };
    projectToUv(viewProj(c), 0, 0, 100, r);
    expect(r.valid).toBe(false);
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.double({ noNaN: true }), (x, y, z) => {
        projectToUv(viewProj(c), x, y, z, r);
        expect(Number.isFinite(r.u) && Number.isFinite(r.v)).toBe(true);
      }),
    );
  });
});

describe('history weight', () => {
  it('keeps (1 − alpha) of the history when it is on screen and saw the same occluder depth', () => {
    expect(historyWeight(0.5, 0.5, true, 1200, 1210, 0.1)).toBeCloseTo(0.9, 9);
  });
  it('rejects history that is off screen, invalid, or from a different occluder (disocclusion)', () => {
    expect(historyWeight(-0.01, 0.5, true, 1200, 1200, 0.1)).toBe(0);
    expect(historyWeight(0.5, 1.2, true, 1200, 1200, 0.1)).toBe(0);
    expect(historyWeight(0.5, 0.5, false, 1200, 1200, 0.1)).toBe(0);
    // the aircraft (15 m) moved over sky pixels (infinite clip depth)
    expect(historyWeight(0.5, 0.5, true, 15, 65000, 0.1)).toBe(0);
    expect(historyWeight(0.5, 0.5, true, 65000, 15, 0.1)).toBe(0);
  });
  it('property: always in [0, 1 − alpha]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2, max: 3, noNaN: true }),
        fc.double({ min: -2, max: 3, noNaN: true }),
        fc.boolean(),
        fc.double({ min: 0.01, max: 1e5, noNaN: true }),
        fc.double({ min: 0.01, max: 1e5, noNaN: true }),
        fc.double({ min: 0.02, max: 1, noNaN: true }),
        (u, v, ok, a, b, alpha) => {
          const w = historyWeight(u, v, ok, a, b, alpha);
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1 - alpha + 1e-12);
        },
      ),
    );
  });
});

describe('frame jitter', () => {
  it('is in [0, 1), low-discrepancy over consecutive frames', () => {
    const vals = Array.from({ length: 16 }, (_, i) => frameJitter(i));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // any 8 consecutive frames cover every eighth of [0,1) at most twice
    for (let s = 0; s < 8; s++) {
      const bins = new Array(8).fill(0);
      for (let i = s; i < s + 8; i++) bins[Math.floor(vals[i] * 8)]++;
      expect(Math.max(...bins)).toBeLessThanOrEqual(2);
    }
  });
});
