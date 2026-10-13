/** Shared helpers for the Sea-Doo model tests: visual / vessel states, body-frame vertices and bounds, draw calls. */
import * as THREE from 'three';
import { createSeadooModel } from '../../../src/vessels/seadoo';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import type { JetPropulsorState, PropulsorState, RiderState, VesselState } from '../../../src/types';

export type Model = ReturnType<typeof createSeadooModel>;

export interface SkiInput {
  steerDeg?: number;
  bucket?: number;
  trimDeg?: number;
  speedMs?: number;
  rider?: Partial<RiderState> | null;
  righting?: number;
  jet?: Partial<JetPropulsorState> | null;
}

export function vessel(o: SkiInput = {}): VesselState {
  const jet: JetPropulsorState = { bucket: o.bucket ?? 0, trimDeg: o.trimDeg ?? 0, flow: 0, jetSpeed: 0, ventilation: 0, nozzleClear: false, ...(o.jet ?? {}) };
  const prop: PropulsorState = { rpm: 3000, n: 50, gear: 'ahead', thrust: 0, steerDeg: o.steerDeg ?? 0, load: 0, boost: 0, jet };
  const v: VesselState = {
    seaTime: 0, propulsors: [prop], tabs: 0, mooring: null, speedMs: o.speedMs ?? 0, leewayDeg: 0, trimDeg: 0, planing: 0,
    wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
  if (o.rider !== null) v.rider = { lean: 0, foreAft: 0, aboard: true, off: null, offTime: 0, ...(o.rider ?? {}) };
  if (o.righting !== undefined) v.righting = o.righting;
  return v;
}

export function state(o: SkiInput = {}, patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(o), ...patch };
}

export function apply(m: Model, v: AircraftVisualState, frames = 1, dt = 1 / 30) {
  for (let i = 0; i < frames; i++) m.setVisualState(v, dt);
  m.root.updateMatrixWorld(true);
}

export function part(m: Model, name: string): THREE.Object3D {
  const o = m.root.getObjectByName(name);
  if (!o) throw new Error(`missing part ${name}`);
  return o;
}

/** Vertices of a mesh in the root (body) frame (skinned meshes posed by their bones). */
export function bodyVerts(m: Model, mesh: THREE.Mesh): THREE.Vector3[] {
  m.root.updateMatrixWorld(true);
  const sk = mesh as THREE.SkinnedMesh;
  if (sk.isSkinnedMesh) sk.skeleton.update();
  const toBody = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const p = mesh.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => {
    const v = new THREE.Vector3();
    if (sk.isSkinnedMesh) sk.getVertexPosition(i, v);
    else v.fromBufferAttribute(p, i);
    return v.applyMatrix4(toBody);
  });
}

/** Exact bounds in the body frame of every visible mesh vertex (optionally skipping some subtrees). */
export function bounds(m: Model, skip: string[] = []): THREE.Box3 {
  const box = new THREE.Box3();
  m.root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    let skipped = false;
    o.traverseAncestors((a) => {
      if (skip.includes(a.name)) skipped = true;
    });
    if (skipped || skip.includes(o.name)) return;
    for (const v of bodyVerts(m, mesh)) box.expandByPoint(v);
  });
  return box;
}

export function toBody(m: Model, obj: THREE.Object3D, p = new THREE.Vector3()): THREE.Vector3 {
  m.root.updateMatrixWorld(true);
  return m.root.worldToLocal(obj.localToWorld(p.clone()));
}

/** Draw calls and triangles of the visible model (one call per visible mesh / points object). */
export function budget(root: THREE.Object3D) {
  let calls = 0;
  let tris = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!(m.isMesh || (o as THREE.Points).isPoints)) return;
    calls++;
    const g = m.geometry;
    tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return { calls, tris };
}

/** Refresh skinned meshes' bounds (their bones move) so raycasts see the posed rider. */
export function refreshSkinnedBounds(m: Model) {
  m.root.updateMatrixWorld(true);
  m.root.traverse((o) => {
    const sk = o as THREE.SkinnedMesh;
    if (sk.isSkinnedMesh) {
      sk.skeleton.update();
      sk.computeBoundingSphere();
      sk.computeBoundingBox();
    }
  });
}
