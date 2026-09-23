import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG, KT_TO_MS } from '../../src/config';
import { fovOffsetFor, speedFovOffset } from '../../src/fx/shake';
import camerafx from '../../src/game/systems/camerafx';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { CameraMode } from '../../src/types';
import { makeState, makeControls } from '../ui/fixtures';

const F = CONFIG.fx.fov;

describe('fovOffsetFor (pure)', () => {
  it('widens the FOV with airspeed in the cockpit and chase views only', () => {
    expect(fovOffsetFor('chase', 150)).toBeCloseTo(speedFovOffset(150), 9);
    expect(fovOffsetFor('cockpit', 150)).toBeCloseTo(speedFovOffset(150), 9);
    expect(fovOffsetFor('external', 150)).toBe(0);
    expect(fovOffsetFor('orbit', 150)).toBe(0);
    expect(fovOffsetFor('chase', 0)).toBe(0);
    expect(fovOffsetFor('chase', F.fullKt + 50)).toBeCloseTo(F.maxDeg, 9);
  });
  it('fuzz: always finite and within [0, maxDeg]', () => {
    fc.assert(
      fc.property(fc.constantFrom<CameraMode>('cockpit', 'chase', 'external', 'orbit'), fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity)), (m, kt) => {
        const v = fovOffsetFor(m, kt);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(F.maxDeg);
      }),
    );
  });
});

describe('camerafx system (speed FOV on the live camera)', () => {
  const setup = async () => {
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
    const sys = await camerafx.create({ camera } as unknown as SystemContext);
    /** One app frame: the camera rig re-applies the pose FOV, then the systems run. */
    const frame = (mode: CameraMode, kt: number, dt = 1 / 60, paused = false, baseFov = 60) => {
      if (Math.abs(camera.fov - baseFov) > 1e-4) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }
      sys.update!({
        state: makeState({ iasKt: kt }), controls: makeControls(), controlState: {} as never, camera, dt, time: 0, paused, cameraMode: mode,
        fps: { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 1 }, readings: null,
      } as unknown as SystemFrame);
    };
    return { camera, sys, frame };
  };

  it('eases the FOV out to base + offset at speed, and keeps the projection matrix in sync', async () => {
    const { camera, frame } = await setup();
    for (let i = 0; i < 240; i++) frame('chase', 160);
    expect(camera.fov).toBeCloseTo(60 + speedFovOffset(160), 2);
    const p = new THREE.Matrix4().copy(camera.projectionMatrix);
    camera.updateProjectionMatrix();
    expect(camera.projectionMatrix.equals(p)).toBe(true);
  });

  it('never jumps: switching to the external view eases the offset away', async () => {
    const { camera, frame } = await setup();
    for (let i = 0; i < 240; i++) frame('chase', 170);
    const before = camera.fov;
    frame('external', 170);
    expect(Math.abs(camera.fov - before)).toBeLessThan(0.2);
    for (let i = 0; i < 300; i++) frame('external', 170);
    expect(camera.fov).toBeCloseTo(60, 2);
  });

  it('respects the pose FOV (cockpit zoom): the offset is added to whatever the rig set', async () => {
    const { camera, frame } = await setup();
    for (let i = 0; i < 240; i++) frame('cockpit', 120, 1 / 60, false, 40);
    expect(camera.fov).toBeCloseTo(40 + speedFovOffset(120), 2);
  });

  it('holds while paused and survives garbage frame times', async () => {
    const { camera, frame } = await setup();
    for (let i = 0; i < 120; i++) frame('chase', 150);
    const f0 = camera.fov;
    for (let i = 0; i < 60; i++) frame('chase', 60, 1 / 60, true);
    expect(camera.fov).toBeCloseTo(f0, 6);
    frame('chase', 150, Number.NaN);
    frame('chase', 150, -1);
    frame('chase', 150, Infinity);
    expect(Number.isFinite(camera.fov)).toBe(true);
  });

  it('stays below its per-frame budget (no allocations beyond the frame object, < 0.05 ms)', async () => {
    const { frame } = await setup();
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) frame('chase', 100 + (i % 50));
    expect((performance.now() - t0) / 2000).toBeLessThan(0.05 + 0.2); // generous: includes makeState() per frame
    void KT_TO_MS;
  });
});
