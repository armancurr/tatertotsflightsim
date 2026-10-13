/**
 * Offshore models (render, run in Node): finite geometry, triangle budgets and LOD, the helideck
 * drawn where the physics has it, the turbine instances yawed into the wind with the rotor turning
 * at the commanded rpm, the flame and night uniforms, the buoys bobbing on the waves, and the
 * draw-call budget of the whole offshore scene.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildPlatformGeometry, createPlatformModel } from '../../../src/world/offshore/platformModel';
import { createWindFarmModel, buildRotor, buildTurbineStatic, buildSubstation } from '../../../src/world/offshore/windFarmModel';
import { createRaceCourseModel, BUOY } from '../../../src/world/offshore/raceModel';
import { raceCourse } from '../../../src/world/offshore/raceCourse';
import { PLATFORM, helideckCircumradius } from '../../../src/world/offshore/platform';
import { TURBINE, windFarmLayout } from '../../../src/world/offshore/windFarm';
import { getSeaSpectrum } from '../../../src/world/water/waves';

function finite(g: THREE.BufferGeometry): boolean {
  const p = g.getAttribute('position').array as Float32Array;
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
  const n = g.getAttribute('normal')?.array as Float32Array | undefined;
  if (n) for (let i = 0; i < n.length; i++) if (!Number.isFinite(n[i])) return false;
  return true;
}
const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** Draw calls of an object tree for a camera at `cam` (LOD resolved, invisible skipped). */
function drawCalls(root: THREE.Object3D, cam: THREE.Vector3): number {
  let n = 0;
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (o instanceof THREE.LOD) {
      const d = cam.distanceTo(o.getWorldPosition(new THREE.Vector3()));
      const levels = o.levels;
      let pick = levels[0].object;
      for (const l of levels) if (d >= l.distance) pick = l.object;
      walk(pick);
      return;
    }
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n++;
    for (const c of o.children) walk(c);
  };
  walk(root);
  return n;
}

describe('platform model', () => {
  it('near and far geometry are finite; the far LOD is a few hundred triangles; the near one under 60k', () => {
    const near = buildPlatformGeometry(0, 41);
    const far = buildPlatformGeometry(1, 41);
    expect(finite(near)).toBe(true);
    expect(finite(far)).toBe(true);
    expect(tris(near)).toBeGreaterThan(5000);
    expect(tris(near)).toBeLessThan(60000);
    expect(tris(far)).toBeLessThan(1500);
    // it reaches from the sea bed to the derrick crown
    near.computeBoundingBox();
    expect(near.boundingBox!.min.y).toBeLessThanOrEqual(-41);
    expect(near.boundingBox!.max.y).toBeGreaterThanOrEqual(PLATFORM.derrick.floorY + PLATFORM.derrick.height);
    near.dispose();
    far.dispose();
  });

  it('the helideck surface is drawn at the deck height the physics lands on, over the octagon', () => {
    const g = buildPlatformGeometry(0, 41);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const hd = PLATFORM.helideck;
    let top = 0;
    let maxR = 0;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (Math.abs(y - hd.y) < 0.001 && n.getY(i) > 0.99) {
        top++;
        maxR = Math.max(maxR, Math.hypot(p.getX(i) - hd.cx, p.getZ(i) - hd.cz));
      }
    }
    expect(top).toBeGreaterThanOrEqual(8);
    expect(maxR).toBeCloseTo(helideckCircumradius(), 3);
    g.dispose();
  });

  it('the flame animates and burns brighter at night; the flare lights the platform at night; its glow shows only at night', () => {
    const m = createPlatformModel(41);
    m.update(1, 0);
    const flame = m.root.getObjectByName('offshore.flame')!.children[0] as THREE.Mesh;
    const fm = flame.material as THREE.ShaderMaterial;
    const day = fm.uniforms.uIntensity.value as number;
    const dayLight = m.uniforms.uFlareColor.value.r;
    expect(m.root.getObjectByName('offshore.flareGlow')!.visible).toBe(false);
    m.update(1, 1);
    expect(fm.uniforms.uIntensity.value).toBeGreaterThan(day * 2);
    expect(m.uniforms.uFlareColor.value.r).toBeGreaterThan(dayLight * 5);
    expect(m.uniforms.uNight.value).toBe(1);
    expect(m.root.getObjectByName('offshore.flareGlow')!.visible).toBe(true);
    m.update(2.3, 1);
    expect(fm.uniforms.uTime.value).toBe(2.3);
    expect(m.flareLevel()).toBeGreaterThan(0.6);
    expect(m.flareLevel()).toBeLessThan(1.4);
    m.dispose();
  });
});

describe('wind farm model', () => {
  it('turbine parts are finite and light (a few hundred triangles each)', () => {
    for (const g of [buildTurbineStatic(40), buildRotor(), buildSubstation(40)]) {
      expect(finite(g)).toBe(true);
      expect(tris(g)).toBeLessThan(3000);
      g.dispose();
    }
    const r = buildRotor();
    r.computeBoundingBox();
    // the rotor spans its diameter
    expect(r.boundingBox!.max.y).toBeGreaterThan(TURBINE.rotorRadius - 3);
    expect(r.boundingBox!.max.y).toBeLessThan(TURBINE.rotorRadius + 1);
    r.dispose();
  });

  it('one instance per turbine; every nacelle faces the wind; the rotors sit upwind at hub height', () => {
    const m = createWindFarmModel(() => 30, 215);
    const towers = m.group.getObjectByName('offshore.turbines') as THREE.InstancedMesh;
    const rotors = m.group.getObjectByName('offshore.rotors') as THREE.InstancedMesh;
    const n = windFarmLayout().turbines.length;
    expect(towers.count).toBe(n);
    expect(rotors.count).toBe(n);
    const mtx = new THREE.Matrix4();
    const fwd = new THREE.Vector3();
    const toward = new THREE.Vector3(Math.sin((215 * Math.PI) / 180), 0, -Math.cos((215 * Math.PI) / 180));
    for (let i = 0; i < n; i++) {
      towers.getMatrixAt(i, mtx);
      fwd.set(0, 0, -1).transformDirection(mtx);
      expect(fwd.dot(toward)).toBeGreaterThan(0.999);
      rotors.getMatrixAt(i, mtx);
      const p = new THREE.Vector3().setFromMatrixPosition(mtx);
      const t = m.turbines[i];
      expect(p.y).toBeCloseTo(TURBINE.hubHeight, 3);
      expect((p.x - t.x) * toward.x + (p.z - t.z) * toward.z).toBeCloseTo(TURBINE.overhang, 3);
      // the rotor's axis (model −Z) points into the wind, tilted up
      fwd.set(0, 0, -1).transformDirection(mtx);
      expect(fwd.x * toward.x + fwd.z * toward.z).toBeGreaterThan(0.99);
      expect(fwd.y).toBeGreaterThan(0.05);
    }
    // veer 90°: everything follows
    m.setWind(305);
    towers.getMatrixAt(0, mtx);
    fwd.set(0, 0, -1).transformDirection(mtx);
    expect(fwd.x * Math.sin((305 * Math.PI) / 180) - fwd.z * Math.cos((305 * Math.PI) / 180)).toBeGreaterThan(0.999);
    m.dispose();
  });

  it('the rotors turn at the commanded rpm (and not at all at 0 rpm or while paused)', () => {
    const m = createWindFarmModel(() => 30, 215);
    const a0 = m.rotorAngle;
    m.update(10, 6, 0); // 6 rpm for 10 s = one full turn
    const turned = Math.abs(m.rotorAngle - a0);
    expect(Math.min(turned, Math.PI * 2 - turned)).toBeLessThan(1e-6);
    m.update(2.5, 6, 0); // a quarter turn
    expect(Math.abs(Math.abs(m.rotorAngle) - Math.PI / 2)).toBeLessThan(1e-6);
    const a1 = m.rotorAngle;
    m.update(1, 0, 0);
    m.update(0, 6, 0);
    expect(m.rotorAngle).toBe(a1);
    m.dispose();
  });

  it('nacelle lights sit on the nacelle roof', () => {
    const m = createWindFarmModel(() => 30, 215);
    const v = new THREE.Vector3();
    m.nacelleLight(3, 1, v);
    expect(v.y).toBeGreaterThan(TURBINE.hubHeight + TURBINE.nacelle.height / 2);
    expect(Math.hypot(v.x - m.turbines[3].x, v.z - m.turbines[3].z)).toBeLessThan(TURBINE.nacelle.length);
    m.dispose();
  });
});

describe('race course model', () => {
  it('one instance per buoy, bobbing on the waves near the camera and still far away; the marker follows the next mark', () => {
    const c = raceCourse();
    const m = createRaceCourseModel(c, getSeaSpectrum(), () => 8);
    const turns = m.group.getObjectByName('offshore.turnBuoys') as THREE.InstancedMesh;
    const sl = m.group.getObjectByName('offshore.slalomBuoys') as THREE.InstancedMesh;
    expect(turns.count + sl.count).toBe(c.marks.length - 1);
    let moved = 0;
    const h0 = c.marks.map((_, i) => (m.update(0, c.cx, c.cz, 3, 0, 0), m.heave(i)));
    for (let t = 0.5; t < 6; t += 0.5) {
      m.update(t, c.cx, c.cz, 3, t, 0);
      for (let i = 0; i < c.marks.length; i++) {
        expect(Math.abs(m.heave(i))).toBeLessThan(2);
        if (Math.abs(m.heave(i) - h0[i]) > 0.02) moved++;
      }
    }
    expect(moved).toBeGreaterThan(10);
    m.update(3, c.cx + 50000, c.cz, 3, 3, 0);
    expect(m.heave(3)).toBe(0);
    const marker = m.group.getObjectByName('offshore.nextMarker')!;
    m.update(1, c.cx, c.cz, 4, 1, 0);
    expect(marker.visible).toBe(true);
    expect(Math.hypot(marker.position.x - c.marks[4].x, marker.position.z - c.marks[4].z)).toBeLessThan(1e-6);
    expect(marker.position.y).toBeGreaterThan(BUOY.turn.h);
    m.update(1, c.cx, c.cz, -1, 1, 0);
    expect(marker.visible).toBe(false);
    m.dispose();
  });
});

describe('draw-call budget', () => {
  it('platform + wind farm + race course: ≤ 10 draw calls near and far', () => {
    const root = new THREE.Group();
    const p = createPlatformModel(41);
    const f = createWindFarmModel(() => 30, 215);
    const r = createRaceCourseModel(raceCourse(), getSeaSpectrum(), () => 8);
    p.update(0, 1);
    r.update(0, 0, 0, 1, 0, 1);
    root.add(p.root, f.group, r.group);
    root.updateMatrixWorld(true);
    const near = drawCalls(root, new THREE.Vector3(0, 60, 150));
    const far = drawCalls(root, new THREE.Vector3(0, 600, 9000));
    // + the shared light points (1): platform LOD 1 + flame 1 + glow 1, farm 3, race 4
    expect(near).toBeLessThanOrEqual(10);
    expect(far).toBeLessThanOrEqual(10);
    p.dispose();
    f.dispose();
    r.dispose();
  });
});
