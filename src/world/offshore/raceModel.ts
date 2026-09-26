/**
 * Race course model (render): the inflatable marks, bobbing on the drawn waves.
 *
 *  - Turn buoys: tall orange inflatable cylinders with a cone top and a white band (≈1.7 m Ø,
 *    3.4 m above the water); slalom buoys: yellow, a little smaller — one InstancedMesh each.
 *  - The start/finish gate: an inflatable arch (red and white, a checkered banner) on two floats.
 *  - The next mark's marker: a floating green chevron that spins above it.
 * Buoys heave, pitch and roll with the same Gerstner trains the water shader draws near the camera
 * (buoyancy.ts), so they sit on the waves. No allocation per frame.
 */
import * as THREE from 'three';
import { MeshBuilder, mat } from '../traffic/models/builder';
import { hullWaveMotion, newWaveMotion, shoalFactor, waveWeights } from '../traffic/buoyancy';
import type { WaveSpectrum } from '../water/waves';
import { GATE_SPAN, type RaceCourse } from './raceCourse';
import { createFlareUniforms, createOffshoreMaterial, type FlareLightUniforms } from './materials';

const ORANGE = mat(0xff5a0a, 0.45, 0);
const YELLOW = mat(0xffcc10, 0.45, 0);
const WHITE = mat(0xf2f2ee, 0.5, 0);
const RED = mat(0xd4201a, 0.5, 0);
const BLACK = mat(0x151515, 0.6, 0);
const DARK = mat(0x2a2a2a, 0.8, 0);

/** Buoy dimensions (m): radius at the waterline, height above it. */
export const BUOY = { turn: { r: 0.85, h: 3.4 }, slalom: { r: 0.7, h: 2.6 } } as const;

/** Water displacement range of the sea shader (ships.ts WATER_DISP_RANGE). */
const DISP_RANGE = 1500;

function buoyGeometry(r: number, h: number, body: ReturnType<typeof mat>): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.cylinder([0, -0.6, 0], [0, h * 0.72, 0], r, r * 0.92, 16, body);
  b.cylinder([0, h * 0.72, 0], [0, h, 0], r * 0.92, 0.12, 16, body);
  b.cylinder([0, h * 0.38, 0], [0, h * 0.5, 0], r * 1.01, r * 1.0, 16, WHITE, false);
  b.cylinder([0, -0.6, 0], [0, 0.1, 0], r * 1.05, r * 1.05, 16, DARK, false);
  return b.build();
}

function archGeometry(): THREE.BufferGeometry {
  const b = new MeshBuilder();
  const R = GATE_SPAN / 2;
  const tube = 0.8;
  const n = 28;
  // the arch in the model's XY plane (the gate line along X, drive through along ±Z)
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI;
    const a1 = ((i + 1) / n) * Math.PI;
    const m = Math.floor(i / 2) % 2 ? WHITE : RED;
    b.cylinder([Math.cos(a0) * R, Math.sin(a0) * R * 0.62 + 0.8, 0], [Math.cos(a1) * R, Math.sin(a1) * R * 0.62 + 0.8, 0], tube, tube, 12, m, false);
  }
  // floats at both feet
  for (const sx of [-1, 1]) b.cylinder([sx * R, -0.5, 0], [sx * R, 1.2, 0], 1.6, 1.4, 16, RED);
  // checkered banner under the crown
  const bw = 8;
  const bh = 1.4;
  const y0 = R * 0.62 - 1.5;
  const cells = 10;
  for (let i = 0; i < cells; i++)
    for (let j = 0; j < 2; j++) {
      const m = (i + j) % 2 ? BLACK : WHITE;
      b.box(-bw / 2 + (i + 0.5) * (bw / cells), y0 + (j + 0.5) * (bh / 2), 0, bw / cells, bh / 2, 0.1, m);
    }
  return b.build();
}

function markerGeometry(): THREE.BufferGeometry {
  // a downward chevron (an inverted cone with a ring), bright green
  const g1 = new THREE.ConeGeometry(1.4, 2.6, 4, 1);
  g1.rotateX(Math.PI);
  g1.translate(0, 1.3, 0);
  return g1;
}

export interface RaceCourseModel {
  group: THREE.Group;
  uniforms: FlareLightUniforms;
  /**
   * Per frame: bob every mark on the waves (camera at camX, camZ for the shader's wave weights),
   * put the marker over mark `next` (−1 hides it).
   */
  update(waveTime: number, camX: number, camZ: number, next: number, time: number, night: number): void;
  /** World heave of mark i (m, the latest update). */
  heave(i: number): number;
  dispose(): void;
}

export function createRaceCourseModel(course: RaceCourse, spectrum: WaveSpectrum, depthAt: (x: number, z: number) => number): RaceCourseModel {
  const group = new THREE.Group();
  group.name = 'offshore.raceCourse';
  const uniforms = createFlareUniforms();
  const material = createOffshoreMaterial(uniforms, { flare: false, name: 'offshore.buoys' });
  const turnIdx: number[] = [];
  const slalomIdx: number[] = [];
  course.marks.forEach((m, i) => {
    if (m.kind === 'turn') turnIdx.push(i);
    else if (m.kind === 'slalom') slalomIdx.push(i);
  });
  const turnGeo = buoyGeometry(BUOY.turn.r, BUOY.turn.h, ORANGE);
  const slalomGeo = buoyGeometry(BUOY.slalom.r, BUOY.slalom.h, YELLOW);
  const turns = new THREE.InstancedMesh(turnGeo, material, Math.max(1, turnIdx.length));
  const slaloms = new THREE.InstancedMesh(slalomGeo, material, Math.max(1, slalomIdx.length));
  turns.name = 'offshore.turnBuoys';
  slaloms.name = 'offshore.slalomBuoys';
  turns.count = turnIdx.length;
  slaloms.count = slalomIdx.length;
  for (const im of [turns, slaloms]) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = true;
    im.frustumCulled = false;
  }
  const archGeo = archGeometry();
  const arch = new THREE.Mesh(archGeo, material);
  arch.name = 'offshore.startArch';
  arch.castShadow = true;
  const g = course.marks[0];
  arch.position.set(g.x, 0, g.z);
  // the arch's plane is across the direction of travel: model +Z along the travel direction
  arch.rotation.y = Math.atan2(g.dx, g.dz);
  const markerGeo = markerGeometry();
  const markerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 3.2, 0.6), fog: true });
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.name = 'offshore.nextMarker';
  group.add(turns, slaloms, arch, marker);

  const n = course.marks.length;
  const heaves = new Float64Array(n);
  const shoal = course.marks.map((m) => shoalFactor(Math.max(0, depthAt(m.x, m.z))));
  const weights = new Float64Array(spectrum.trains.length);
  const wm = newWaveMotion();
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const DEG = Math.PI / 180;

  const pose = (i: number, waveTime: number, camX: number, camZ: number, L: number): void => {
    const m = course.marks[i];
    const r = Math.hypot(m.x - camX, m.z - camZ);
    wm.heave = 0;
    wm.pitch = 0;
    wm.roll = 0;
    if (r < DISP_RANGE && waveWeights(spectrum, r, DISP_RANGE, weights) > 0) hullWaveMotion(spectrum, weights, shoal[i], m.x, m.z, waveTime, 0, L, L, wm, 3);
    heaves[i] = wm.heave;
  };

  return {
    group,
    uniforms,
    update(waveTime, camX, camZ, next, time, night) {
      uniforms.uNight.value = night;
      for (let k = 0; k < turnIdx.length; k++) {
        const i = turnIdx[k];
        pose(i, waveTime, camX, camZ, 1.8);
        e.set(wm.pitch * DEG * 1.4, 0, -wm.roll * DEG * 1.4, 'YXZ');
        q.setFromEuler(e);
        p.set(course.marks[i].x, heaves[i], course.marks[i].z);
        turns.setMatrixAt(k, mtx.compose(p, q, one));
      }
      for (let k = 0; k < slalomIdx.length; k++) {
        const i = slalomIdx[k];
        pose(i, waveTime, camX, camZ, 1.5);
        e.set(wm.pitch * DEG * 1.4, 0, -wm.roll * DEG * 1.4, 'YXZ');
        q.setFromEuler(e);
        p.set(course.marks[i].x, heaves[i], course.marks[i].z);
        slaloms.setMatrixAt(k, mtx.compose(p, q, one));
      }
      turns.instanceMatrix.needsUpdate = true;
      slaloms.instanceMatrix.needsUpdate = true;
      pose(0, waveTime, camX, camZ, GATE_SPAN);
      arch.position.y = heaves[0];
      if (next >= 0 && next < n) {
        const m = course.marks[next];
        const top = m.kind === 'gate' ? GATE_SPAN * 0.31 + 3.5 : m.kind === 'turn' ? BUOY.turn.h + 3 : BUOY.slalom.h + 3;
        marker.visible = true;
        marker.position.set(m.x, heaves[next] + top + Math.sin(time * 2.4) * 0.5, m.z);
        marker.rotation.y = time * 1.6;
      } else marker.visible = false;
    },
    heave: (i) => heaves[i] ?? 0,
    dispose() {
      turnGeo.dispose();
      slalomGeo.dispose();
      archGeo.dispose();
      markerGeo.dispose();
      material.dispose();
      markerMat.dispose();
      turns.dispose();
      slaloms.dispose();
    },
  };
}

/** Soft-obstacle lookup for the marks (inflatable: a hull bumps off, nothing crashes). Allocation-free. */
export function createBuoyObstacles(course: RaceCourse): (x: number, z: number) => number {
  const g = course.marks[0];
  const R = GATE_SPAN / 2;
  // arch feet (the floats), across the travel direction
  const px = g.dz;
  const pz = -g.dx;
  const feet = [g.x + px * R, g.z + pz * R, g.x - px * R, g.z - pz * R];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const m of course.marks) {
    minX = Math.min(minX, m.x);
    maxX = Math.max(maxX, m.x);
    minZ = Math.min(minZ, m.z);
    maxZ = Math.max(maxZ, m.z);
  }
  minX -= 20;
  maxX += 20;
  minZ -= 20;
  maxZ += 20;
  return (x, z) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return -Infinity;
    for (let i = 1; i < course.marks.length; i++) {
      const m = course.marks[i];
      const r = m.kind === 'turn' ? BUOY.turn.r + 0.15 : BUOY.slalom.r + 0.15;
      const dx = x - m.x;
      const dz = z - m.z;
      if (dx * dx + dz * dz <= r * r) return m.kind === 'turn' ? BUOY.turn.h : BUOY.slalom.h;
    }
    for (let k = 0; k < 4; k += 2) {
      const dx = x - feet[k];
      const dz = z - feet[k + 1];
      if (dx * dx + dz * dz <= 1.7 * 1.7) return 1.2;
    }
    return -Infinity;
  };
}
