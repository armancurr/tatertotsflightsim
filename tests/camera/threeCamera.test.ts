import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { applyCameraPose } from '../../src/camera/threeCamera';
import { createCameraRig, updateCameraRig } from '../../src/camera/cameraRig';
import { quatFromEuler } from '../../src/physics/frames';

describe('applyCameraPose', () => {
  it('copies position and orientation onto a three.js camera', () => {
    const cam = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1000);
    const q = quatFromEuler(90, 5, 0);
    applyCameraPose(cam, { position: { x: 1, y: 2, z: 3 }, quaternion: q, fov: 50 });
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
    expect(cam.quaternion.toArray()).toEqual([q.x, q.y, q.z, q.w]);
    // three.js camera looks down its local -Z: heading 90 → looking east
    const dir = new THREE.Vector3();
    cam.updateMatrixWorld();
    cam.getWorldDirection(dir);
    expect(dir.x).toBeGreaterThan(0.99);
  });
  it('updates the projection matrix only when the fov changes', () => {
    const cam = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
    const spy = vi.spyOn(cam, 'updateProjectionMatrix');
    const pose = { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, fov: 60 };
    applyCameraPose(cam, pose);
    expect(spy).not.toHaveBeenCalled();
    applyCameraPose(cam, { ...pose, fov: 45 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(cam.fov).toBe(45);
    applyCameraPose(cam, { ...pose, fov: 45 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('a chase pose from the rig makes the three camera look at the aircraft', () => {
    const cam = new THREE.PerspectiveCamera(60, 1.5, 0.1, 1000);
    const target = { position: { x: 0, y: 100, z: 0 }, orientation: quatFromEuler(0, 0, 0), velocity: { x: 0, y: 0, z: 0 }, onGround: false };
    const { pose } = updateCameraRig(createCameraRig('chase'), target, { dx: 0, dy: 0, wheel: 0, dragging: false, shake: 0 }, 1 / 60);
    applyCameraPose(cam, pose);
    cam.updateMatrixWorld();
    const p = new THREE.Vector3(0, 100, 0).project(cam);
    expect(Math.abs(p.x)).toBeLessThan(0.2);
    expect(Math.abs(p.y)).toBeLessThan(0.5);
    expect(p.z).toBeLessThan(1);
  });
});
