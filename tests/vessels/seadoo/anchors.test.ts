/**
 * The Sea-Doo model agrees with the physics (SEADOO_AIRCRAFT.watercraft / .geometry) within a few
 * cm: the drawn hull passes through the station table the physics floats, the nozzle exit is on the
 * propulsor position with its diameter, the intake grate on jet.inlet, the rider's eye on
 * pilotEye (inside the helmet, whose crown is verticalTailTop), the helm eye sees ahead over the
 * bars, and the overall length / beam / height match the published ski.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createSeadooModel, SEADOO_PART, SEADOO_SHAPE, BONE, RIDER } from '../../../src/vessels/seadoo';
import { SEADOO_AIRCRAFT } from '../../../src/config';
import { sectionHalfBreadth } from '../../../src/vessels/hullSection';
import { apply, bodyVerts, bounds, part, refreshSkinnedBounds, state, toBody, type Model } from './helpers';

const G = SEADOO_AIRCRAFT.geometry;
const WC = SEADOO_AIRCRAFT.watercraft!;
const JET = WC.propulsors[0];
const TOL = 0.02;

describe('Sea-Doo model anchors match SEADOO_AIRCRAFT', () => {
  let m: Model;
  beforeAll(() => {
    m = createSeadooModel();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(10, 20, 30);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.1, 0.4, -0.2, 'YXZ'));
    apply(m, state());
  });
  afterAll(() => m.dispose());

  it('the drawn hull passes through the station table (keel, chines, deck edges, every ring vertex)', () => {
    const verts = bodyVerts(m, part(m, SEADOO_PART.shell) as THREE.Mesh);
    const stations = WC.hull.stations;
    stations.forEach((s, k) => {
      const ring = verts.filter((v) => Math.abs(v.z - s.z) < 0.004);
      expect(ring.length, `ring at z=${s.z}`).toBeGreaterThan(20);
      const near = (x: number, y: number) => Math.min(...ring.map((v) => Math.hypot(v.x - x, v.y - y)));
      expect(near(0, s.keelY), `keel @${s.z}`).toBeLessThan(TOL);
      for (const side of [1, -1]) {
        expect(near(side * s.chineHalf, s.chineY), `chine @${s.z}`).toBeLessThan(TOL);
        expect(near(side * s.deckHalf, s.deckY), `deck edge @${s.z}`).toBeLessThan(TOL);
      }
      const end = k === 0 || k === stations.length - 1;
      for (const v of ring) {
        const off = Math.abs(v.x) - sectionHalfBreadth(s, v.y);
        if (end) expect(off, `cap @${s.z}`).toBeLessThan(TOL);
        else expect(Math.abs(off), `outline @${s.z} y=${v.y.toFixed(3)}`).toBeLessThan(TOL);
        expect(v.y).toBeGreaterThan(s.keelY - TOL);
        expect(v.y).toBeLessThan(s.deckY + TOL);
      }
    });
    const zs = verts.map((v) => v.z);
    expect(Math.min(...zs)).toBeCloseTo(stations[0].z, 3);
    expect(Math.max(...zs)).toBeCloseTo(stations[stations.length - 1].z, 3);
  });

  it('the deck meets the sheer line: the deck moulding never pokes outside the hull or below the deck edge line by more than a few cm', () => {
    const deck = bodyVerts(m, part(m, SEADOO_PART.deck) as THREE.Mesh);
    const zs = WC.hull.stations.map((s) => s.z);
    for (const v of deck) {
      if (v.z < zs[0] - TOL || v.z > SEADOO_SHAPE.zAft + TOL) throw new Error(`deck vertex outside the length: ${v.z}`);
    }
    expect(Math.max(...deck.map((v) => Math.abs(v.x)))).toBeLessThan(0.63);
  });

  it('the nozzle exit is centred on the propulsor position with the propulsor diameter, pointing aft', () => {
    const nozzle = part(m, SEADOO_PART.nozzle) as THREE.Mesh;
    const verts = bodyVerts(m, nozzle);
    const zMax = Math.max(...verts.map((v) => v.z));
    expect(Math.abs(zMax - JET.position.z)).toBeLessThan(0.005);
    const rim = verts.filter((v) => v.z > zMax - 0.002);
    const c = rim.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(rim.length);
    expect(c.distanceTo(new THREE.Vector3(JET.position.x, JET.position.y, JET.position.z))).toBeLessThan(0.01);
    const rInner = Math.min(...rim.map((v) => Math.hypot(v.x - c.x, v.y - c.y)));
    expect(Math.abs(2 * rInner - JET.diameter)).toBeLessThan(0.006);
    // Steering / trim pivot just ahead of the exit, on the nozzle axis.
    const pivot = toBody(m, part(m, SEADOO_PART.nozzleSteer));
    expect(pivot.z).toBeLessThan(JET.position.z);
    expect(pivot.z).toBeGreaterThan(JET.position.z - 0.12);
    expect(Math.hypot(pivot.x - JET.position.x, pivot.y - JET.position.y)).toBeLessThan(1e-6);
  });

  it('the intake grate is on the hull bottom at jet.inlet', () => {
    const inlet = JET.jet!.inlet;
    const verts = bodyVerts(m, part(m, SEADOO_PART.hullParts) as THREE.Mesh).filter((v) => Math.abs(v.z - inlet.z) < 0.2 && Math.abs(v.x) < 0.13 && v.y < -0.3);
    expect(verts.length).toBeGreaterThan(50);
    const c = verts.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(verts.length);
    expect(Math.abs(c.x - inlet.x)).toBeLessThan(0.01);
    expect(Math.abs(c.z - inlet.z)).toBeLessThan(0.03);
    expect(Math.abs(c.y - inlet.y)).toBeLessThan(0.03);
  });

  it("pilotEye is the rider's eye, inside the helmet; the helmet crown is verticalTailTop", () => {
    const rider = part(m, SEADOO_PART.rider);
    const head = rider.getObjectByName(`${SEADOO_PART.rider}.head`)!;
    const eye = toBody(m, head, new THREE.Vector3(RIDER.eye.x, RIDER.eye.y, RIDER.eye.z));
    expect(eye.distanceTo(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z))).toBeLessThan(0.005);
    // Inside the helmet shell (an ellipsoid in the head frame).
    const H = RIDER.helmet;
    const e = RIDER.eye;
    expect(((e.x / H.rx) ** 2 + ((e.y - H.y) / H.ry) ** 2 + ((e.z - H.z) / H.rz) ** 2)).toBeLessThan(0.7);
    // Crown of the drawn rider (the highest skinned vertex) at verticalTailTop.
    const body = bodyVerts(m, part(m, SEADOO_PART.riderBody) as THREE.Mesh);
    const top = body.reduce((a, v) => (v.y > a.y ? v : a));
    expect(Math.abs(top.y - G.verticalTailTop.y)).toBeLessThan(0.03);
    expect(Math.abs(top.z - G.verticalTailTop.z)).toBeLessThan(0.08);
    expect(BONE.head).toBeGreaterThanOrEqual(0);
  });

  it('the rider sits on the seat with feet in the footwells and hands on the grips', () => {
    const rider = part(m, SEADOO_PART.rider);
    const bone = (n: string) => toBody(m, rider.getObjectByName(`${SEADOO_PART.rider}.${n}`)!);
    const pelvis = bone('pelvis');
    expect(pelvis.z).toBeGreaterThan(0.2);
    expect(pelvis.z).toBeLessThan(0.6);
    // Seat top under the pelvis (the seat mesh's highest vertex near the pelvis).
    const seat = bodyVerts(m, part(m, SEADOO_PART.seatCushion) as THREE.Mesh).filter((v) => Math.abs(v.z - pelvis.z) < 0.03 && Math.abs(v.x) < 0.05);
    const seatTop = Math.max(...seat.map((v) => v.y));
    expect(pelvis.y - seatTop).toBeGreaterThan(0.06);
    expect(pelvis.y - seatTop).toBeLessThan(0.16);
    for (const [n, side] of [['footL', -1], ['footR', 1]] as const) {
      const a = bone(n);
      expect(Math.sign(a.x)).toBe(side);
      expect(Math.abs(a.x)).toBeGreaterThan(SEADOO_SHAPE.tunnelHalf + 0.03);
      expect(Math.abs(a.x)).toBeLessThan(0.5);
      expect(a.y - SEADOO_SHAPE.floorY).toBeGreaterThan(0.05);
      expect(a.y - SEADOO_SHAPE.floorY).toBeLessThan(0.13);
    }
  });

  it('the helm eye sees ahead over the bars: nothing opaque in the forward cone; bars / dash only low down', () => {
    apply(m, state({}, { cameraMode: 'cockpit' }));
    refreshSkinnedBounds(m);
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const world = (p: THREE.Vector3) => m.root.localToWorld(p.clone());
    const solid: THREE.Object3D[] = [];
    m.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) solid.push(o);
    });
    const ray = new THREE.Raycaster();
    ray.near = 0.005;
    const cast = (d: THREE.Vector3, far: number) => {
      const o = world(eye);
      ray.set(o, world(eye.clone().add(d)).sub(o).normalize());
      ray.far = far;
      return ray.intersectObjects(solid, false);
    };
    const dir = (yaw: number, pitch: number) => {
      const a = (yaw * Math.PI) / 180;
      const e = (pitch * Math.PI) / 180;
      return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    };
    for (const yaw of [-45, -30, -15, 0, 15, 30, 45]) {
      for (const pitch of [-15, -8, 0, 10, 25]) {
        expect(cast(dir(yaw, pitch), 50).map((h) => h.object.name), `yaw ${yaw} pitch ${pitch}`).toEqual([]);
      }
    }
    // Looking down ahead: the helm (pod / display / bars) or the hood is there.
    const low = cast(dir(0, -40), 3);
    expect(low.length).toBeGreaterThan(0);
    let helmOrHood = false;
    low[0].object.traverseAncestors((a) => {
      if (a.name === SEADOO_PART.helm || a.name === SEADOO_PART.hood) helmOrHood = true;
    });
    expect(helmOrHood, low[0].object.name).toBe(true);
    // Straight up: open sky (the helmet is hidden in the helm view)…
    expect(cast(new THREE.Vector3(0, 1, 0), 10)).toEqual([]);
    // From above, down through the eye: in the helm view the helmet is gone (the first thing hit is
    // well below the eye)…
    const fromAbove = () => {
      const o = world(eye.clone().add(new THREE.Vector3(0, 1, 0)));
      ray.set(o, world(eye).sub(o).normalize());
      ray.far = 3;
      return ray.intersectObjects(solid, false);
    };
    const hitY = (h: THREE.Intersection[]) => m.root.worldToLocal(h[0].point.clone()).y;
    const hidden = fromAbove();
    if (hidden.length) expect(hitY(hidden)).toBeLessThan(eye.y - 0.1);
    // …while in the chase view the helmet crown is right over the eye (the skinned rider is raycast, posed).
    apply(m, state());
    refreshSkinnedBounds(m);
    solid.length = 0;
    m.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) solid.push(o);
    });
    const shown = fromAbove();
    expect(shown[0].object.name).toBe(SEADOO_PART.riderBody);
    expect(Math.abs(hitY(shown) - G.verticalTailTop.y)).toBeLessThan(0.04);
  });

  it('the helm view stays clear ahead in every rider pose (bars at full lock, leaning, crouched, sitting back)', () => {
    const eye = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
    const ray = new THREE.Raycaster();
    ray.near = 0.005;
    const o = () => m.root.localToWorld(eye.clone());
    for (const steerDeg of [0, 22, -22]) {
      for (const lean of [0, 1, -1]) {
        for (const foreAft of [0, 1, -1]) {
          apply(m, state({ steerDeg, rider: { lean, foreAft }, speedMs: 18 }, { cameraMode: 'cockpit' }));
          refreshSkinnedBounds(m);
          const solid: THREE.Object3D[] = [];
          m.root.traverseVisible((x) => {
            if ((x as THREE.Mesh).isMesh) solid.push(x);
          });
          for (const yaw of [-40, -20, 0, 20, 40]) {
            for (const pitch of [-15, 0, 15]) {
              const a = (yaw * Math.PI) / 180;
              const e = (pitch * Math.PI) / 180;
              const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
              ray.set(o(), m.root.localToWorld(eye.clone().add(d)).sub(o()).normalize());
              ray.far = 50;
              expect(ray.intersectObjects(solid, false).map((h) => h.object.name), `steer ${steerDeg} lean ${lean} fwd ${foreAft} yaw ${yaw} pitch ${pitch}`).toEqual([]);
            }
          }
        }
      }
    }
    apply(m, state());
  });

  it('overall length 3.33 m (stem to bumper / bucket), beam 1.25 m, height 1.12 m keel to mirrors (no rider)', () => {
    const b = bounds(m, [SEADOO_PART.rider, SEADOO_PART.swimmer]);
    expect(b.min.z).toBeCloseTo(WC.hull.stations[0].z, 1);
    expect(Math.abs(b.max.z - b.min.z - G.length)).toBeLessThan(0.03);
    expect(Math.abs(b.max.z - SEADOO_SHAPE.zAft)).toBeLessThan(0.02);
    expect(Math.abs(b.max.x - b.min.x - SEADOO_AIRCRAFT.wingSpan)).toBeLessThan(0.03);
    expect(Math.abs(b.max.x + b.min.x)).toBeLessThan(0.01);
    const keel = Math.min(...WC.hull.stations.map((s) => s.keelY));
    expect(b.min.y).toBeGreaterThan(keel - 0.03);
    expect(Math.abs(b.max.y - b.min.y - G.height)).toBeLessThan(0.03);
    // With the rider: the helmet is the top.
    const all = bounds(m, [SEADOO_PART.swimmer]);
    expect(Math.abs(all.max.y - G.verticalTailTop.y)).toBeLessThan(0.03);
  });
});
