/**
 * The Princess V50 model agrees with the physics (V50_AIRCRAFT.watercraft / .geometry) within
 * 2–3 cm: the drawn hull passes through the station table the physics floats, the twin
 * counter-rotating props are centred on each propulsor position with its diameter, the trim tabs
 * hinge at the transom at the tab positions; and it moves the right way: +steer (bow to starboard)
 * swings the IPS drive's pull to port, props spin with n (counter-rotating, blur at speed), tabs
 * go trailing-edge down. The helm eye sits in the saloon above the sole and under the hardtop
 * with only windscreen glass between it and the horizon ahead; overall length, beam and height
 * match the published boat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createV50Model, V50_PART, V50_SHAPE, TAB_MAX_DEG } from '../../../src/vessels/v50';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { V50_AIRCRAFT } from '../../../src/config';
import type { PropulsorState, VesselState } from '../../../src/types';
import { sectionHalfBreadth } from '../../../src/vessels/hullSection';
import { V50_LIGHTS } from '../../../src/vessels/v50/hull';

const G = V50_AIRCRAFT.geometry;
const WC = V50_AIRCRAFT.watercraft!;
const TOL = 0.02;
type Model = ReturnType<typeof createV50Model>;

function prop(patch: Partial<PropulsorState> = {}): PropulsorState {
  return { rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...patch };
}
function vessel(patch: Partial<VesselState> = {}, props: Partial<PropulsorState>[] = [{}, {}]): VesselState {
  return {
    seaTime: 0, propulsors: props.map(prop), tabs: 0, mooring: null, speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0,
    wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
    ...patch,
  };
}
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
/** Vertices of a mesh in the root (body) frame. */
function bodyVerts(m: Model, mesh: THREE.Mesh): THREE.Vector3[] {
  m.root.updateMatrixWorld(true);
  const toBody = new THREE.Matrix4().copy(m.root.matrixWorld).invert().multiply(mesh.matrixWorld);
  const p = mesh.geometry.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(toBody));
}
/** Exact bounds in the body frame of every visible mesh vertex. */
function bounds(m: Model): THREE.Box3 {
  const box = new THREE.Box3();
  m.root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.userData.noBounds) return;
    for (const v of bodyVerts(m, mesh)) box.expandByPoint(v);
  });
  return box;
}
function toBody(m: Model, obj: THREE.Object3D, p = new THREE.Vector3()): THREE.Vector3 {
  m.root.updateMatrixWorld(true);
  return m.root.worldToLocal(obj.localToWorld(p.clone()));
}
function dirToBody(m: Model, obj: THREE.Object3D, d: THREE.Vector3): THREE.Vector3 {
  return toBody(m, obj, d).sub(toBody(m, obj));
}
const podName = (i: number) => (WC.propulsors[i].position.x < 0 ? V50_PART.podPort : V50_PART.podStarboard);

describe('V50 model anchors match V50_AIRCRAFT', () => {
  let m: Model;
  beforeAll(() => {
    m = createV50Model();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state());
  });
  afterAll(() => m.dispose());

  it('the drawn hull passes through the station table (keel, chines, deck edges, every ring vertex)', () => {
    const verts = bodyVerts(m, part(m, V50_PART.shell) as THREE.Mesh);
    const stations = WC.hull.stations;
    stations.forEach((s, k) => {
      const ring = verts.filter((v) => Math.abs(v.z - s.z) < 0.005);
      expect(ring.length, `ring at z=${s.z}`).toBeGreaterThan(20);
      const near = (x: number, y: number) => Math.min(...ring.map((v) => Math.hypot(v.x - x, v.y - y)));
      expect(near(0, s.keelY), `keel @${s.z}`).toBeLessThan(TOL);
      for (const side of [1, -1]) {
        expect(near(side * s.chineHalf, s.chineY), `chine @${s.z}`).toBeLessThan(TOL);
        expect(near(side * s.deckHalf, s.deckY), `deck edge @${s.z}`).toBeLessThan(TOL);
      }
      // Every skin vertex on the section outline; the stem / transom caps lie inside it.
      const end = k === 0 || k === stations.length - 1;
      for (const v of ring) {
        const off = Math.abs(v.x) - sectionHalfBreadth(s, v.y);
        if (end) expect(off, `cap @${s.z}`).toBeLessThan(TOL);
        else expect(Math.abs(off), `outline @${s.z} y=${v.y.toFixed(3)}`).toBeLessThan(TOL);
        expect(v.y).toBeGreaterThan(s.keelY - TOL);
        expect(v.y).toBeLessThan(s.deckY + TOL);
      }
    });
  });

  it('the transom is vertical at the last station and the stem at the first', () => {
    const verts = bodyVerts(m, part(m, V50_PART.shell) as THREE.Mesh);
    const zs = verts.map((v) => v.z);
    expect(Math.max(...zs)).toBeCloseTo(V50_SHAPE.zTransom, 3);
    expect(Math.min(...zs)).toBeCloseTo(V50_SHAPE.zStem, 3);
    const transom = verts.filter((v) => Math.abs(v.z - V50_SHAPE.zTransom) < 1e-3);
    const ys = transom.map((v) => v.y);
    const last = WC.hull.stations[WC.hull.stations.length - 1];
    expect(Math.min(...ys)).toBeCloseTo(last.keelY, 2);
    expect(Math.max(...ys)).toBeCloseTo(last.deckY, 2);
  });

  it('each drive has two counter-rotating props centred on the propulsor position with its diameter', () => {
    WC.propulsors.forEach((p, i) => {
      const pod = part(m, podName(i));
      const fwd = pod.getObjectByName(`${podName(i)}.propFwd`)!;
      const aft = pod.getObjectByName(`${podName(i)}.propAft`)!;
      const a = toBody(m, fwd);
      const b = toBody(m, aft);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      expect(mid.distanceTo(new THREE.Vector3(p.position.x, p.position.y, p.position.z)), `prop centre ${i}`).toBeLessThan(TOL);
      expect(a.z).toBeLessThan(b.z);
      // Blade tips: the forward prop's disc diameter is the propulsor diameter.
      const blades = fwd.getObjectByName(`${podName(i)}.propFwd.blades`) as THREE.Mesh;
      const axis = dirToBody(m, fwd, new THREE.Vector3(0, 0, 1)).normalize();
      let rMax = 0;
      for (const v of bodyVerts(m, blades)) {
        const d = v.clone().sub(a);
        rMax = Math.max(rMax, d.sub(axis.clone().multiplyScalar(d.dot(axis))).length());
      }
      expect(Math.abs(2 * rMax - p.diameter), `diameter ${i}`).toBeLessThan(0.03);
      // The drive axis lies along the hull when straight.
      expect(axis.z).toBeGreaterThan(0.999);
    });
  });

  it('+steer (bow to starboard) swings the drive pull to PORT and the leg trailing edge to starboard, about the prop centre', () => {
    for (const deg of [20, -20]) {
      apply(m, state({ vessel: vessel({}, [{ steerDeg: deg }, { steerDeg: deg }]) }));
      WC.propulsors.forEach((p, i) => {
        const pod = part(m, podName(i));
        const fwd = pod.getObjectByName(`${podName(i)}.propFwd`)!;
        const aft = pod.getObjectByName(`${podName(i)}.propAft`)!;
        const a = toBody(m, fwd);
        const b = toBody(m, aft);
        // Pull direction: from the aft prop toward the forward prop (IPS props pull).
        const pull = a.clone().sub(b).normalize();
        expect(pull.z).toBeLessThan(0);
        expect(Math.sign(pull.x)).toBe(-Math.sign(deg));
        expect(Math.asin(-pull.x) * (180 / Math.PI)).toBeCloseTo(deg, 1);
        // The thrust point stays on the propulsor position.
        const mid = a.clone().add(b).multiplyScalar(0.5);
        expect(mid.distanceTo(new THREE.Vector3(p.position.x, p.position.y, p.position.z))).toBeLessThan(TOL);
        // The leg's trailing edge (its aft-most vertex when straight) swings the other way.
        const leg = pod.getObjectByName(`${podName(i)}.leg`) as THREE.Mesh;
        const aftMost = bodyVerts(m, leg).reduce((best, v) => (v.clone().sub(mid).dot(pull) < best.clone().sub(mid).dot(pull) ? v : best));
        expect(Math.sign(aftMost.x - p.position.x)).toBe(Math.sign(deg));
      });
    }
    apply(m, state());
  });

  it('props spin with n (counter-rotating, reversing astern) and blur into discs at speed', () => {
    const fwd = part(m, `${podName(0)}.propFwd`);
    const aft = part(m, `${podName(0)}.propAft`);
    const read = () => [fwd.rotation.z, aft.rotation.z];
    const [f0, a0] = read();
    apply(m, state({ vessel: vessel({}, [{ n: 5 }, { n: 5 }]) }), 1, 0.01);
    const [f1, a1] = read();
    expect(f1 - f0).toBeCloseTo(2 * Math.PI * 5 * 0.01, 6);
    expect(a1 - a0).toBeCloseTo(-2 * Math.PI * 5 * 0.01, 6);
    apply(m, state({ vessel: vessel({}, [{ n: -3 }, { n: -3 }]) }), 1, 0.01);
    const [f2] = read();
    expect(f2 - f1).toBeCloseTo(-2 * Math.PI * 3 * 0.01, 6);
    const blades = part(m, `${podName(0)}.propFwd.blades`);
    const disc = part(m, `${podName(0)}.disc`);
    apply(m, state({ vessel: vessel({}, [{ n: 2 }, { n: 2 }]) }));
    expect(blades.visible).toBe(true);
    expect(disc.visible).toBe(false);
    apply(m, state({ vessel: vessel({}, [{ n: 25 }, { n: 25 }]) }));
    expect(blades.visible).toBe(false);
    expect(disc.visible).toBe(true);
    apply(m, state());
  });

  it('trim tabs hinge on the hull bottom at the transom at the tab positions and go trailing-edge down', () => {
    const positions = WC.trimTabs!.positions;
    for (const p of positions) {
      const name = p.x < 0 ? V50_PART.tabPort : V50_PART.tabStarboard;
      const flap = part(m, name);
      const hinge = toBody(m, flap);
      expect(Math.abs(hinge.x - p.x)).toBeLessThan(TOL);
      expect(Math.abs(hinge.z - p.z)).toBeLessThan(TOL);
      const trailing = (tabs: number) => {
        apply(m, state({ vessel: vessel({ tabs }) }));
        return toBody(m, flap, new THREE.Vector3(0, 0, 0.3));
      };
      const up = trailing(0);
      const down = trailing(1);
      expect(up.z).toBeGreaterThan(p.z + 0.25);
      expect(down.y).toBeLessThan(up.y - 0.3 * Math.sin((TAB_MAX_DEG * Math.PI) / 180) * 0.85);
      expect(trailing(0.5).y).toBeLessThan(up.y);
    }
    apply(m, state());
  });

  it('renders neutral with no vessel state (null or absent): pods straight, props still, tabs up', () => {
    for (const vs of [null, undefined]) {
      const v = state();
      if (vs === null) v.vessel = null;
      else delete v.vessel;
      expect(() => apply(m, v, 3)).not.toThrow();
      for (let i = 0; i < WC.propulsors.length; i++) expect(part(m, `${podName(i)}.pivot`).rotation.y).toBe(0);
      expect(part(m, V50_PART.tabPort).rotation.x).toBe(0);
    }
  });

  it('the helm eye is seated in the saloon: above the sole, under the hardtop, with only glass ahead', () => {
    apply(m, state({ cameraMode: 'cockpit' }));
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const world = (p: THREE.Vector3) => m.root.localToWorld(p.clone());
    const worldDir = (d: THREE.Vector3) => world(d).sub(world(new THREE.Vector3())).normalize();
    const solid: THREE.Object3D[] = [];
    const glass: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      (o.name === V50_PART.glass ? glass : solid).push(o);
    });
    const ray = new THREE.Raycaster();
    ray.near = 0.01;
    const cast = (d: THREE.Vector3, list: THREE.Object3D[], far = 40) => {
      ray.set(world(eye), worldDir(d));
      ray.far = far;
      return ray.intersectObjects(list, false);
    };
    // Down: the helm seat and then the sole, both below the eye.
    const down = cast(new THREE.Vector3(0, -1, 0), solid, 3);
    expect(down.length).toBeGreaterThan(0);
    const firstDown = m.root.worldToLocal(down[0].point.clone());
    expect(firstDown.y).toBeLessThan(eye.y - 0.4);
    expect(firstDown.y).toBeGreaterThan(V50_SHAPE.floorY - 0.01);
    expect(V50_SHAPE.floorY).toBeGreaterThanOrEqual(0.35);
    expect(V50_SHAPE.floorY).toBeLessThanOrEqual(0.45);
    // Up: the hardtop's headliner, with headroom.
    const up = cast(new THREE.Vector3(0, 1, 0), solid, 3);
    expect(up.length).toBeGreaterThan(0);
    let hardtop = false;
    up[0].object.traverseAncestors((a) => {
      if (a.name === V50_PART.superstructure) hardtop = true;
    });
    expect(hardtop).toBe(true);
    expect(m.root.worldToLocal(up[0].point.clone()).y).toBeGreaterThan(eye.y + 0.5);
    // Ahead at eye height (and a little either side / above): nothing solid within 30 m; the windscreen is there.
    for (const yaw of [-20, -10, 0, 10, 20]) {
      for (const pitch of [0, 8]) {
        const a = (yaw * Math.PI) / 180;
        const e = (pitch * Math.PI) / 180;
        const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
        const hits = cast(d, solid, 30);
        expect(hits.map((h) => h.object.name), `yaw ${yaw} pitch ${pitch}`).toEqual([]);
        expect(cast(d, glass, 30).length, `glass yaw ${yaw}`).toBeGreaterThan(0);
      }
    }
    apply(m, state());
  });

  it('overall length ≈ 15.5 m (pulpit/anchor to swim platform), beam 4.11 m, height to the radar dome top', () => {
    const b = bounds(m);
    expect(b.min.z).toBeCloseTo(V50_SHAPE.zAnchorTip, 1);
    expect(b.max.z).toBeCloseTo(V50_SHAPE.zPlatformAft, 1);
    expect(Math.abs(b.max.z - b.min.z - 15.5)).toBeLessThan(0.05);
    expect(Math.abs(b.max.x - b.min.x - V50_AIRCRAFT.wingSpan)).toBeLessThan(0.05);
    expect(Math.abs(b.max.x + b.min.x)).toBeLessThan(0.01);
    expect(Math.abs(b.max.y - G.verticalTailTop.y)).toBeLessThan(TOL);
    // The highest point is the dome over the arch position.
    const top = G.verticalTailTop;
    const dome = bodyVerts(m, part(m, V50_PART.hardtopFrame) as THREE.Mesh).filter((v) => v.y > top.y - 0.005);
    expect(dome.length).toBeGreaterThan(0);
    for (const v of dome) expect(Math.hypot(v.x - top.x, v.z - top.z), `${v.x},${v.y},${v.z}`).toBeLessThan(0.1);
    // Height from the keel to the dome ≈ geometry.height; the drives hang below the keel (draft ≈ 1.15 m to the props at the static waterline y ≈ −0.45).
    const keel = Math.min(...WC.hull.stations.map((s) => s.keelY));
    expect(Math.abs(b.max.y - keel - G.height)).toBeLessThan(0.05);
    expect(b.min.y).toBeLessThan(keel - 0.3);
    expect(b.min.y).toBeGreaterThan(-0.45 - 1.25);
  });

  it('nav lights: red to port and green to starboard near the bow, white masthead high, white stern light; off when switched off', () => {
    expect(V50_LIGHTS.port.x).toBeLessThan(-1);
    expect(V50_LIGHTS.starboard.x).toBeGreaterThan(1);
    expect(V50_LIGHTS.port.z).toBeLessThan(-4);
    expect(V50_LIGHTS.stern.z).toBeGreaterThanOrEqual(V50_SHAPE.zTransom);
    const nav = part(m, V50_PART.navLights) as THREE.Mesh;
    const glows = part(m, V50_PART.glows) as THREE.Points;
    const inten = glows.geometry.getAttribute('intensity');
    apply(m, state({ lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: false } }));
    expect(nav.visible).toBe(true);
    expect(inten.getX(0)).toBe(1);
    const col = nav.geometry.getAttribute('color');
    const pos = nav.geometry.getAttribute('position');
    let portRed = false;
    let stbdGreen = false;
    let mastWhite = false;
    for (let i = 0; i < pos.count; i++) {
      const [r, g, bl] = [col.getX(i), col.getY(i), col.getZ(i)];
      if (pos.getX(i) < -1 && r > 0.8 && g < 0.2) portRed = true;
      if (pos.getX(i) > 1 && g > 0.8 && r < 0.2) stbdGreen = true;
      if (pos.getY(i) > 2.6 && r > 0.9 && g > 0.9 && bl > 0.9) mastWhite = true;
    }
    expect([portRed, stbdGreen, mastWhite]).toEqual([true, true, true]);
    apply(m, state({ lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false } }));
    expect(nav.visible).toBe(false);
    expect(inten.getX(0)).toBe(0);
  });
});
