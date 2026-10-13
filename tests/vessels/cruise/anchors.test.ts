/**
 * The MS Tater Star model agrees with the physics (CRUISE_AIRCRAFT.watercraft / .geometry): the
 * drawn hull passes through the station table the physics floats; the propellers are centred on
 * the shaft propulsors with their diameter and turn with n (outward-turning pair); the rudders sit
 * on the foil centres with the foil area and swing their trailing edge to starboard for +steer (bow
 * to starboard); a thruster tunnel opens on both sides of the hull at every thruster; the helm eye
 * stands on the bridge — floor below, deckhead above, glass ahead — and sees over the bow; the
 * overall length, beam and height match; the nav lights are where the rules put them; and the
 * windows light up after sunset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createCruiseModel, CRUISE_PART, CRUISE_SHAPE, CRUISE_LIGHTS, tunnelOpenings, rudderDims, SHAFT_INDEX, THRUSTER_INDEX } from '../../../src/vessels/cruise';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { CRUISE_AIRCRAFT } from '../../../src/config';
import type { PropulsorState, VesselState } from '../../../src/types';
import { hullSectionAt, sectionHalfBreadth } from '../../../src/vessels/hullSection';

const G = CRUISE_AIRCRAFT.geometry;
const WC = CRUISE_AIRCRAFT.watercraft!;
const TOL = 0.03;
type Model = ReturnType<typeof createCruiseModel>;

function vessel(props: Partial<PropulsorState>[] = []): VesselState {
  return {
    seaTime: 0,
    propulsors: WC.propulsors.map((_p, i) => ({ rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...(props[i] ?? {}) })),
    tabs: 0, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0,
    displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
}
/** All shafts set to the same patch. */
const shafts = (p: Partial<PropulsorState>) => WC.propulsors.map((c) => (c.type === 'shaft' ? p : {}));
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(), ...patch };
}
function apply(m: Model, v: AircraftVisualState, frames = 1, dt = 1 / 30) {
  for (let i = 0; i < frames; i++) m.setVisualState(v, dt);
  m.root.updateMatrixWorld(true);
}
function part(m: Model, name: string): THREE.Object3D {
  const o = m.root.getObjectByName(name);
  if (!o) throw new Error(`missing part ${name}`);
  return o;
}
function bodyVerts(m: Model, mesh: THREE.Mesh): THREE.Vector3[] {
  m.root.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const p = mesh.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(toBody));
}
function toBody(m: Model, obj: THREE.Object3D, p = new THREE.Vector3()): THREE.Vector3 {
  m.root.updateMatrixWorld(true);
  return m.root.worldToLocal(obj.localToWorld(p.clone()));
}
const sideName = (i: number) => (WC.propulsors[i].position.x < 0 ? 'port' : 'starboard');

describe('Tater Star model anchors match CRUISE_AIRCRAFT', () => {
  let m: Model;
  beforeAll(() => {
    m = createCruiseModel();
    m.root.position.set(100, -4, 300);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.02, 0.9, -0.03, 'YXZ'));
    apply(m, state());
  });
  afterAll(() => m.dispose());

  it('the drawn hull passes through the station table (keel, chines, deck edges, every ring vertex)', () => {
    const verts = bodyVerts(m, part(m, CRUISE_PART.shell) as THREE.Mesh);
    const stations = WC.hull.stations;
    stations.forEach((s, k) => {
      const ring = verts.filter((v) => Math.abs(v.z - s.z) < 0.01 && v.y <= s.deckY + 0.01);
      expect(ring.length, `ring at z=${s.z}`).toBeGreaterThan(20);
      const near = (x: number, y: number) => Math.min(...ring.map((v) => Math.hypot(v.x - x, v.y - y)));
      expect(near(0, s.keelY), `keel @${s.z}`).toBeLessThan(TOL);
      for (const side of [1, -1]) {
        if (s.chineHalf > 0) expect(near(side * s.chineHalf, s.chineY), `chine @${s.z}`).toBeLessThan(TOL);
        expect(near(side * s.deckHalf, s.deckY), `deck edge @${s.z}`).toBeLessThan(TOL);
      }
      const end = k === 0 || k === stations.length - 1;
      for (const v of ring) {
        const off = Math.abs(v.x) - sectionHalfBreadth(s, v.y);
        if (end) expect(off, `cap @${s.z}`).toBeLessThan(TOL);
        else expect(Math.abs(off), `outline @${s.z} y=${v.y.toFixed(2)}`).toBeLessThan(TOL);
      }
    });
  });

  it('two propellers centred on the shaft propulsors, with their diameter, turning with n (outward-turning)', () => {
    expect(SHAFT_INDEX.length).toBe(2);
    const turn: number[] = [];
    for (const i of SHAFT_INDEX) {
      const p = WC.propulsors[i];
      const prop = part(m, `cruise.screw.${sideName(i)}.prop`);
      expect(toBody(m, prop).distanceTo(new THREE.Vector3(p.position.x, p.position.y, p.position.z)), `prop ${i}`).toBeLessThan(TOL);
      const blades = part(m, `cruise.screw.${sideName(i)}.blades`) as THREE.Mesh;
      const c = toBody(m, prop);
      let rMax = 0;
      for (const v of bodyVerts(m, blades)) rMax = Math.max(rMax, Math.hypot(v.x - c.x, v.y - c.y));
      expect(Math.abs(2 * rMax - p.diameter), `diameter ${i}`).toBeLessThan(0.05);
      const r0 = blades.rotation.z;
      apply(m, state({ vessel: vessel(shafts({ n: 2 })) }), 1, 0.01);
      turn.push(blades.rotation.z - r0);
      expect(Math.abs(blades.rotation.z - r0)).toBeCloseTo(2 * Math.PI * 2 * 0.01, 6);
    }
    // one turns each way
    expect(Math.sign(turn[0])).toBe(-Math.sign(turn[1]));
    apply(m, state());
  });

  it('rudders on the foil centres with the foil area; +steer swings the trailing edge to starboard', () => {
    for (const i of SHAFT_INDEX) {
      const p = WC.propulsors[i];
      const d = rudderDims(p);
      expect(d.chord * (d.yTop - d.yBot)).toBeCloseTo(p.foilArea, 3);
      const stock = part(m, `cruise.rudder.${sideName(i)}`);
      const blade = part(m, `cruise.rudder.${sideName(i)}.blade`) as THREE.Mesh;
      const vs = bodyVerts(m, blade);
      const box = new THREE.Box3().setFromPoints(vs);
      const centre = box.getCenter(new THREE.Vector3());
      expect(Math.abs(centre.x - p.foilCentre.x)).toBeLessThan(0.1);
      expect(Math.abs(centre.y - p.foilCentre.y)).toBeLessThan(0.1);
      expect(Math.abs(centre.z - p.foilCentre.z)).toBeLessThan(0.1);
      for (const deg of [25, -25]) {
        apply(m, state({ vessel: vessel(shafts({ steerDeg: deg })) }));
        const te = toBody(m, stock, new THREE.Vector3(0, 0, 0.7 * d.chord));
        expect(Math.sign(te.x - p.foilCentre.x), `TE at ${deg}`).toBe(Math.sign(deg));
        expect(stock.rotation.y).toBeCloseTo((deg * Math.PI) / 180, 6);
      }
      apply(m, state());
    }
  });

  it('a thruster tunnel opens on both sides at every thruster, on the hull skin', () => {
    const t = tunnelOpenings();
    expect(t.map((o) => o.index)).toEqual([...THRUSTER_INDEX]);
    for (const o of t) {
      const p = WC.propulsors[o.index];
      expect(o.z).toBe(p.position.z);
      expect(o.y).toBe(p.position.y);
      expect(o.x).toBeCloseTo(sectionHalfBreadth(hullSectionAt(WC.hull.stations, o.z), o.y), 6);
      expect(o.x).toBeGreaterThan(o.r); // the tunnel is longer than it is wide
    }
    // the dark bores are in the hull's details mesh, near both openings
    const verts = bodyVerts(m, part(m, CRUISE_PART.hullDetails) as THREE.Mesh);
    for (const o of t) {
      for (const side of [1, -1]) {
        const close = verts.filter((v) => Math.hypot(v.x - side * o.x, v.y - o.y, v.z - o.z) < o.r + 0.3);
        expect(close.length, `tunnel ${o.index} side ${side}`).toBeGreaterThan(10);
      }
    }
  });

  it('the helm eye stands on the bridge: floor below, deckhead above, glass ahead, and sees over the bow', () => {
    apply(m, state({ cameraMode: 'cockpit' }));
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const world = (p: THREE.Vector3) => m.root.localToWorld(p.clone());
    const worldDir = (d: THREE.Vector3) => world(d).sub(world(new THREE.Vector3())).normalize();
    const solid: THREE.Object3D[] = [];
    const glass: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      if (!(o as THREE.Mesh).isMesh) return;
      (o.name === CRUISE_PART.glass ? glass : solid).push(o);
    });
    const ray = new THREE.Raycaster();
    ray.near = 0.01;
    const cast = (d: THREE.Vector3, list: THREE.Object3D[], far = 40) => {
      ray.set(world(eye), worldDir(d));
      ray.far = far;
      return ray.intersectObjects(list, false);
    };
    const down = cast(new THREE.Vector3(0, -1, 0), solid, 3);
    expect(down.length).toBeGreaterThan(0);
    const floorY = m.root.worldToLocal(down[0].point.clone()).y;
    expect(eye.y - floorY).toBeGreaterThan(1.5);
    expect(eye.y - floorY).toBeLessThan(1.9);
    const up = cast(new THREE.Vector3(0, 1, 0), solid, 3);
    expect(up.length).toBeGreaterThan(0);
    expect(m.root.worldToLocal(up[0].point.clone()).y).toBeGreaterThan(eye.y + 0.5);
    for (const yaw of [-20, -10, 0, 10, 20]) {
      for (const pitch of [0, 8]) {
        const a = (yaw * Math.PI) / 180;
        const e = (pitch * Math.PI) / 180;
        const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
        expect(cast(d, solid, 200).map((h) => h.object.name), `yaw ${yaw} pitch ${pitch}`).toEqual([]);
        expect(cast(d, glass, 30).length, `glass yaw ${yaw}`).toBeGreaterThan(0);
      }
    }
    // over the bow: the first thing the eye meets toward the stem head is the stem itself
    const stem = new THREE.Vector3(G.spinnerTip.x, G.spinnerTip.y + 0.5, G.spinnerTip.z + 1);
    const toStem = stem.clone().sub(eye);
    const hits = cast(toStem.clone().normalize(), solid, toStem.length() + 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].distance).toBeGreaterThan(toStem.length() - 6);
    apply(m, state());
  });

  it('overall length 260.6 m, beam 31.5 m (bridge wings out past it), height keel → aft masthead', () => {
    const shell = new THREE.Box3().setFromPoints(bodyVerts(m, part(m, CRUISE_PART.shell) as THREE.Mesh));
    expect(shell.max.z - shell.min.z).toBeCloseTo(260.6, 1);
    expect(shell.max.x - shell.min.x).toBeCloseTo(31.5, 1);
    const all = new THREE.Box3();
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.noBounds) return;
      for (const v of bodyVerts(m, mesh)) all.expandByPoint(v);
    });
    const keel = Math.min(...WC.hull.stations.map((s) => s.keelY));
    expect(Math.abs(all.max.y - keel - G.height)).toBeLessThan(0.1);
    expect(all.max.x).toBeGreaterThan(CRUISE_SHAPE.beam / 2 + 1);
    expect(all.max.x).toBeLessThan(CRUISE_SHAPE.beam / 2 + 2.5);
    // the propellers and rudders stay within the keel's depth (a little below it at most)
    expect(all.min.y).toBeGreaterThan(keel - 0.5);
    // top deck ≈ 40.4 m above the keel (published)
    const top = CRUISE_SHAPE.tiers.find((t) => t.name === 'lidoAft')!;
    expect(top.y0 + 2.85 - keel).toBeCloseTo(40.4, 0);
  });

  it('nav lights: red to port and green to starboard on the bridge wings, two white mastheads (aft higher), a stern light', () => {
    const L = CRUISE_LIGHTS;
    expect(L.port.x).toBeLessThan(-CRUISE_SHAPE.beam / 2);
    expect(L.starboard.x).toBeGreaterThan(CRUISE_SHAPE.beam / 2);
    expect(L.aftMasthead.y).toBeGreaterThan(L.masthead.y + 1);
    expect(L.aftMasthead.z).toBeGreaterThan(L.masthead.z);
    expect(L.stern.z).toBeGreaterThanOrEqual(CRUISE_SHAPE.zStern);
    const nav = part(m, CRUISE_PART.navLights) as THREE.Mesh;
    const glows = part(m, CRUISE_PART.glows) as THREE.Points;
    apply(m, state({ lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }));
    expect(nav.visible).toBe(true);
    expect(glows.geometry.getAttribute('intensity').getX(0)).toBe(1);
    const col = nav.geometry.getAttribute('color');
    const pos = nav.geometry.getAttribute('position');
    let portRed = false;
    let stbdGreen = false;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getX(i) < -15 && col.getX(i) > 0.8 && col.getY(i) < 0.2) portRed = true;
      if (pos.getX(i) > 15 && col.getY(i) > 0.8 && col.getX(i) < 0.2) stbdGreen = true;
    }
    expect([portRed, stbdGreen]).toEqual([true, true]);
    apply(m, state({ lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false } }));
    expect(nav.visible).toBe(false);
  });

  it('windows light up after sunset (the scene sun below the horizon), dark by day', () => {
    const walls = part(m, CRUISE_PART.walls) as THREE.Mesh;
    const mat = walls.material as THREE.MeshStandardMaterial;
    const render = (elevDeg: number) => {
      const scene = new THREE.Scene();
      const sun = new THREE.DirectionalLight();
      const e = (elevDeg * Math.PI) / 180;
      sun.position.set(0, Math.sin(e) * 100, -Math.cos(e) * 100);
      scene.add(sun, sun.target);
      scene.updateMatrixWorld(true);
      walls.onBeforeRender({} as THREE.WebGLRenderer, scene, new THREE.PerspectiveCamera(), walls.geometry, mat, null as unknown as THREE.Group);
      return mat.emissiveIntensity;
    };
    expect(render(40)).toBe(0);
    expect(render(-10)).toBeGreaterThan(1);
    expect(render(5)).toBeGreaterThan(0);
    expect(render(5)).toBeLessThan(render(-10));
  });
});
