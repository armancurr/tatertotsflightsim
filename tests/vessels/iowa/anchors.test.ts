/**
 * The USS Iowa model agrees with the physics and the gunnery contract (IOWA_AIRCRAFT, IOWA_WEAPONS):
 * the drawn hull passes through the station table the physics floats; each turret turns about its
 * config position; the drawn muzzles sit exactly where iowaMuzzleBody() says for any train,
 * elevation and recoil; train + swings the guns to starboard, elevation + raises them, recoil slides
 * them back, the flash shows only when fired, and with no turret state they are stowed (III aft);
 * the propellers sit on the propulsor positions with their diameters and spin with n; the rudders hang
 * behind the inboard shafts centred on their foil centres and swing their trailing edges to
 * starboard for + steer; the helm eye stands in the pilot house with only glass between it and the
 * bow; and the overall dimensions are the real ship's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createIowaModel, IOWA_PART, iowaMuzzleBody, IOWA_RECOIL_M, RUDDER } from '../../../src/vessels/iowa';
import { createDefaultVisualState, type AircraftVisualState } from '../../../src/aircraft/types';
import { IOWA_AIRCRAFT, IOWA_WEAPONS } from '../../../src/config';
import type { TurretStatus } from '../../../src/combat/types';
import type { PropulsorState, VesselState } from '../../../src/types';
import { hullSectionAt, sectionBottomY, sectionHalfBreadth } from '../../../src/vessels/hullSection';

const G = IOWA_AIRCRAFT.geometry;
const WC = IOWA_AIRCRAFT.watercraft!;
const T = IOWA_WEAPONS.naval!.turrets;
const TOL = 0.03;
type Model = ReturnType<typeof createIowaModel>;

function vessel(props: Partial<PropulsorState>[] = [{}, {}, {}, {}]): VesselState {
  return {
    seaTime: 0, propulsors: props.map((p) => ({ rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...p })), tabs: 0, mooring: null,
    speedMs: 0, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 0, wettedArea: 0, displacedVolume: 0, resistance: 0, depthUnderKeel: Infinity,
    aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
}
function turrets(train: number[], elev: number[], recoil = 0, flash = 0): TurretStatus[] {
  return T.map((t, i) => ({ trainDeg: train[i], elevDeg: elev[i], recoil: new Array(t.barrels).fill(recoil), flash: new Array(t.barrels).fill(flash), ready: new Array(t.barrels).fill(true) }));
}
function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'chase', vessel: vessel(), turrets: null, ...patch };
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
const muzzle = (m: Model, i: number, k: number) => toBody(m, part(m, `${IOWA_PART.turret(i)}.muzzle${k}`));

describe('Iowa model anchors match IOWA_AIRCRAFT and IOWA_WEAPONS', () => {
  let m: Model;
  beforeAll(() => {
    m = createIowaModel();
    // Anchors are body-frame: test through an arbitrary root transform.
    m.root.position.set(-5000, 3, 10800);
    m.root.quaternion.setFromEuler(new THREE.Euler(0.05, 2.1, -0.08, 'YXZ'));
    apply(m, state());
  });
  afterAll(() => m.dispose());

  it('the drawn hull (bow + stern halves) passes through the station table', () => {
    const verts = [...bodyVerts(m, part(m, IOWA_PART.shellBow) as THREE.Mesh), ...bodyVerts(m, part(m, IOWA_PART.shellStern) as THREE.Mesh)];
    const stations = WC.hull.stations;
    stations.forEach((s, k) => {
      const ring = verts.filter((v) => Math.abs(v.z - s.z) < 0.005);
      expect(ring.length, `ring at z=${s.z}`).toBeGreaterThan(20);
      const nearest = (x: number, y: number) => Math.min(...ring.map((v) => Math.hypot(v.x - x, v.y - y)));
      expect(nearest(0, s.keelY), `keel @${s.z}`).toBeLessThan(TOL);
      for (const side of [1, -1]) {
        if (s.chineHalf > 0) expect(nearest(side * s.chineHalf, s.chineY), `chine @${s.z}`).toBeLessThan(TOL);
        expect(nearest(side * s.deckHalf, s.deckY), `deck edge @${s.z}`).toBeLessThan(TOL);
      }
      const end = k === 0 || k === stations.length - 1;
      for (const v of ring) {
        const off = Math.abs(v.x) - sectionHalfBreadth(s, v.y);
        if (end) expect(off).toBeLessThan(TOL);
        else expect(Math.abs(off), `outline @${s.z} y=${v.y.toFixed(2)}`).toBeLessThan(TOL);
      }
    });
    // stem to fantail: 270.43 m overall
    const zs = verts.map((v) => v.z);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(270.43, 2);
  });

  it('overall: 270.4 m long, 33 m beam, masthead ~62 m above the keel', () => {
    const box = new THREE.Box3();
    m.root.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || o.userData.noBounds) return;
      for (const v of bodyVerts(m, mesh)) box.expandByPoint(v);
    });
    expect(box.max.z - box.min.z).toBeGreaterThan(270.3);
    expect(box.max.z - box.min.z).toBeLessThan(271.5); // (jack staff / ensign staff within a metre)
    const hullBeam = 2 * Math.max(...WC.hull.stations.map((s) => s.deckHalf));
    expect(hullBeam).toBeCloseTo(32.96, 1);
    expect(box.max.x - box.min.x).toBeLessThan(34.5); // nothing sticks far outboard (anchors, bridge wings)
    expect(box.max.y - G.noseWheel.y).toBeGreaterThan(58); // keel → masthead
    expect(box.max.y - G.noseWheel.y).toBeLessThan(66);
  });

  it('each turret turns about its config position; stowed with no turret state (I, II ahead; III aft)', () => {
    T.forEach((t, i) => {
      const train = part(m, `${IOWA_PART.turret(i)}.train`);
      expect(toBody(m, train).distanceTo(new THREE.Vector3(t.position.x, t.position.y, t.position.z)), t.name).toBeLessThan(1e-6);
      const mz = muzzle(m, i, 1);
      const want = iowaMuzzleBody(t, t.stowDeg, 0, 1);
      expect(mz.distanceTo(new THREE.Vector3(want.x, want.y, want.z)), t.name).toBeLessThan(1e-3);
    });
    expect(muzzle(m, 2, 1).z).toBeGreaterThan(T[2].position.z + 15);
    expect(muzzle(m, 0, 1).z).toBeLessThan(T[0].position.z - 15);
  });

  it('the drawn muzzles are exactly where iowaMuzzleBody() puts them, for any train, elevation and recoil', () => {
    const cases: [number[], number[], number][] = [
      [[0, 0, 180], [0, 0, 0], 0],
      [[35, -40, 150], [12, 30, 45], 0.5],
      [[-120, 90, 250], [-2, 45, 5], 1],
    ];
    for (const [train, elev, recoil] of cases) {
      apply(m, state({ turrets: turrets(train, elev, recoil) }));
      T.forEach((t, i) => {
        for (let k = 0; k < t.barrels; k++) {
          const want = iowaMuzzleBody(t, train[i], elev[i], k, recoil);
          expect(muzzle(m, i, k).distanceTo(new THREE.Vector3(want.x, want.y, want.z)), `${t.name} gun ${k}`).toBeLessThan(1e-3);
        }
      });
    }
    apply(m, state());
  });

  it('train + swings the guns to starboard; elevation + raises the muzzles; recoil slides the barrels back', () => {
    apply(m, state({ turrets: turrets([60, 60, 120], [0, 0, 0]) }));
    for (let i = 0; i < 3; i++) expect(muzzle(m, i, 1).x, T[i].name).toBeGreaterThan(10);
    apply(m, state({ turrets: turrets([-60, -60, 240], [0, 0, 0]) }));
    for (let i = 0; i < 3; i++) expect(muzzle(m, i, 1).x, T[i].name).toBeLessThan(-10);
    apply(m, state({ turrets: turrets([0, 0, 180], [0, 0, 0]) }));
    const level = [0, 1, 2].map((i) => muzzle(m, i, 1).y);
    apply(m, state({ turrets: turrets([0, 0, 180], [30, 30, 30]) }));
    for (let i = 0; i < 3; i++) expect(muzzle(m, i, 1).y - level[i]).toBeCloseTo(T[i].barrelLength * Math.sin(Math.PI / 6), 2);
    const barrel = part(m, `${IOWA_PART.turret(0)}.barrel0`);
    const before = toBody(m, barrel);
    apply(m, state({ turrets: turrets([0, 0, 180], [30, 30, 30], 1) }));
    const after = toBody(m, barrel);
    expect(before.distanceTo(after)).toBeCloseTo(IOWA_RECOIL_M, 3);
    expect(after.z).toBeGreaterThan(before.z); // back (aft) for a turret trained ahead
    expect(after.y).toBeLessThan(before.y); // and down the inclined bore
    apply(m, state());
  });

  it('out-of-arc and garbage turret states are clamped / stowed, never NaN', () => {
    apply(m, state({ turrets: turrets([Number.NaN, 400, -30], [99, -50, Number.POSITIVE_INFINITY]) }));
    for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) expect(Number.isFinite(muzzle(m, i, k).lengthSq())).toBe(true);
    const e = part(m, `${IOWA_PART.turret(0)}.elev`);
    expect(e.rotation.x).toBeLessThanOrEqual((T[0].elevMaxDeg * Math.PI) / 180 + 1e-9);
    apply(m, state({ turrets: [] as unknown as TurretStatus[] }));
    apply(m, state({ turrets: null }));
    expect(muzzle(m, 2, 1).z).toBeGreaterThan(T[2].position.z + 15);
  });

  it('the muzzle flash shows only when a gun fires', () => {
    const flash = part(m, `${IOWA_PART.turret(1)}.flash`);
    apply(m, state({ turrets: turrets([0, 0, 180], [10, 10, 10], 1, 1) }));
    expect(flash.visible).toBe(true);
    apply(m, state({ turrets: turrets([0, 0, 180], [10, 10, 10], 0.5, 0) }));
    expect(flash.visible).toBe(false);
    apply(m, state());
    expect(flash.visible).toBe(false);
  });

  it('each propeller is centred on its propulsor position with its diameter, and spins with n (outboard pair turning outward)', () => {
    WC.propulsors.forEach((p, i) => {
      const spin = part(m, IOWA_PART.prop(i));
      expect(toBody(m, spin).distanceTo(new THREE.Vector3(p.position.x, p.position.y, p.position.z))).toBeLessThan(1e-6);
      const blades = part(m, `${IOWA_PART.prop(i)}.blades`) as THREE.Mesh;
      let rMax = 0;
      const c = toBody(m, spin);
      for (const v of bodyVerts(m, blades)) rMax = Math.max(rMax, Math.hypot(v.x - c.x, v.y - c.y));
      expect(Math.abs(2 * rMax - p.diameter), `diameter ${i}`).toBeLessThan(0.06);
    });
    const r0 = part(m, IOWA_PART.prop(0)).rotation.z;
    const r3 = part(m, IOWA_PART.prop(3)).rotation.z;
    apply(m, state({ vessel: vessel([{ n: 3 }, { n: 3 }, { n: 3 }, { n: 3 }]) }), 1, 0.01);
    const d0 = part(m, IOWA_PART.prop(0)).rotation.z - r0;
    const d3 = part(m, IOWA_PART.prop(3)).rotation.z - r3;
    expect(Math.abs(d0)).toBeCloseTo(2 * Math.PI * 3 * 0.01, 6);
    expect(Math.sign(d0)).toBe(-Math.sign(d3)); // port and starboard shafts turn opposite ways
    apply(m, state());
  });

  it('the propeller discs clear the hull (no blade inside the skin)', () => {
    WC.propulsors.forEach((p, i) => {
      const blades = part(m, `${IOWA_PART.prop(i)}.blades`) as THREE.Mesh;
      for (const v of bodyVerts(m, blades)) {
        // the hull bottom above this blade point
        const top = bottomAt(v.x, v.z);
        expect(v.y, `prop ${i} blade at x=${v.x.toFixed(1)} z=${v.z.toFixed(1)}`).toBeLessThan(top + 0.05);
      }
    });
  });

  it('rudders hang behind the inboard shafts only, centred on their foil centres, trailing edge to starboard for + steer', () => {
    WC.propulsors.forEach((p, i) => {
      const r = m.root.getObjectByName(IOWA_PART.rudder(i));
      if (p.foilArea < 5) {
        expect(r, `no rudder on shaft ${i}`).toBeUndefined();
        return;
      }
      expect(r).toBeDefined();
      const blade = part(m, `${IOWA_PART.rudder(i)}.blade`) as THREE.Mesh;
      const vs = bodyVerts(m, blade).filter((v) => v.y < toBody(m, r!).y + 1e-3); // the blade, not the stock above it
      const box = new THREE.Box3().setFromPoints(vs);
      const c = box.getCenter(new THREE.Vector3());
      expect(c.distanceTo(new THREE.Vector3(p.foilCentre.x, p.foilCentre.y, p.foilCentre.z)), `rudder ${i} centre`).toBeLessThan(0.35);
      expect(box.max.y - box.min.y).toBeCloseTo(RUDDER.span, 1);
      expect(box.min.z).toBeGreaterThan(p.position.z + 1); // aft of its propeller
    });
    for (const deg of [20, -20]) {
      apply(m, state({ vessel: vessel(WC.propulsors.map(() => ({ steerDeg: deg }))) }));
      WC.propulsors.forEach((p, i) => {
        if (p.foilArea < 5) return;
        const blade = part(m, `${IOWA_PART.rudder(i)}.blade`) as THREE.Mesh;
        const te = bodyVerts(m, blade).reduce((a, v) => (v.z > a.z ? v : a));
        expect(Math.sign(te.x - p.foilCentre.x), `rudder ${i} at ${deg}°`).toBe(Math.sign(deg));
      });
    }
    apply(m, state());
  });

  it('the helm eye stands in the pilot house, floor below, deckhead above, and only glass between it and the bow', () => {
    apply(m, state({ cameraMode: 'cockpit' }));
    const meshes: THREE.Mesh[] = [];
    m.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh && !o.userData.noBounds) meshes.push(o as THREE.Mesh);
    });
    const eye = m.root.localToWorld(new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z));
    const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).transformDirection(m.root.matrixWorld);
    const cast = (d: THREE.Vector3, far: number) => new THREE.Raycaster(eye, d, 0, far).intersectObjects(meshes, false);
    // the horizon ahead and a little down: nothing but the pilot-house glass for the first 40 m
    for (const down of [0, 3, 6]) {
      const r = (down * Math.PI) / 180;
      const hits = cast(dir(0, -Math.sin(r), -Math.cos(r)), 40);
      expect(hits.length, `ahead, ${down}° down`).toBeGreaterThan(0);
      expect(hits.every((h) => h.object.name === IOWA_PART.glass), `${down}° down: ${hits.map((h) => h.object.name).join(',')}`).toBe(true);
    }
    // standing: a floor 1.4–2 m below, a deckhead above
    const floor = cast(dir(0, -1, 0), 3)[0];
    expect(floor?.distance).toBeGreaterThan(1.4);
    expect(floor?.distance).toBeLessThan(2.0);
    const roof = cast(dir(0, 1, 0), 3)[0];
    expect(roof?.distance).toBeGreaterThan(0.3);
    expect(roof?.distance).toBeLessThan(1.5);
    apply(m, state());
  });
});

/** Height of the hull skin (body y) above body (x, z): the section's bottom (Infinity outboard of the deck edge). */
function bottomAt(x: number, z: number): number {
  const s = hullSectionAt(WC.hull.stations, z);
  const y = sectionBottomY(s, x);
  return Number.isFinite(y) ? y : Infinity;
}
