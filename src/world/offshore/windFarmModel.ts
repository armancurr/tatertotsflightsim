/**
 * Wind farm model (render): every turbine in two instanced draw calls — the static part (monopile,
 * yellow transition piece with its access platform and boat landing, white tapered tower, nacelle)
 * and the rotor (hub, spinner and three blades) — plus the offshore substation as one small mesh.
 * The instance matrices carry each turbine's yaw (into the wind) and the rotor's spin; per frame
 * only the 16 rotor matrices are rewritten (no allocation).
 *
 * Model frame (per instance): origin at the tower axis at sea level, the rotor facing −Z (the
 * nacelle's nose), +Y up. Yaw ψ (compass bearing the rotor faces) → `rotation.y = −ψ`.
 */
import * as THREE from 'three';
import { MeshBuilder, mat } from '../traffic/models/builder';
import { TURBINE, SUBSTATION, windFarmLayout, turbineYawDeg, type TurbineSite } from './windFarm';
import { createFlareUniforms, createOffshoreMaterial, type FlareLightUniforms } from './materials';

const TOWER_WHITE = mat(0xeef0ee, 0.45, 0.1);
const TP_YELLOW = mat(0xf2c200, 0.5, 0.1);
const PILE = mat(0x3d463d, 0.9, 0.1);
const GREY = mat(0x8c9196, 0.55, 0.5);
const DARK = mat(0x2a2d30, 0.7, 0.3);
const BLADE = mat(0xf1f2f0, 0.35, 0.05);
const TIP_RED = mat(0xc8281e, 0.4, 0.05);
const SUB_WHITE = mat(0xdedcd4, 0.6, 0.1);
const SUB_GREY = mat(0x9aa0a6, 0.6, 0.3);
const HELI_GREEN = mat(0x2d5a36, 0.85, 0);
const HELI_WHITE = mat(0xf0f0ea, 0.7, 0);

const DEG = Math.PI / 180;

/** Nacelle box centre along the model's z (its front 1 m behind the hub). */
const nacelleCentreZ = (): number => -TURBINE.overhang + 1 + TURBINE.nacelle.length / 2;

/** Tower + transition piece + nacelle (no rotor), model frame. */
export function buildTurbineStatic(depth: number): THREE.BufferGeometry {
  const T = TURBINE;
  const b = new MeshBuilder();
  b.cylinder([0, -depth, 0], [0, T.tpBottom, 0], T.tpR - 0.3, T.tpR - 0.3, 16, PILE, false);
  b.cylinder([0, T.tpBottom, 0], [0, T.tpTop, 0], T.tpR, T.tpR, 20, TP_YELLOW, false);
  // access platform (a ring deck) with its rail, the boat landing and ladder
  b.cylinder([0, T.tpTop - 0.4, 0], [0, T.tpTop, 0], T.tpR + 2.2, T.tpR + 2.2, 20, GREY);
  b.cylinder([0, T.tpTop + 1.1, 0], [0, T.tpTop + 1.2, 0], T.tpR + 2.1, T.tpR + 2.1, 20, TP_YELLOW, false);
  b.box(0, 3, T.tpR + 0.9, 2.2, 10, 0.6, TP_YELLOW);
  b.box(0, 3, T.tpR + 1.35, 0.8, 10, 0.3, DARK);
  // tower (tapered, white), a darker door, and the nacelle
  b.cylinder([0, T.tpTop, 0], [0, T.hubHeight - T.nacelle.height / 2, 0], T.towerBaseR, T.towerTopR, 24, TOWER_WHITE, false);
  b.box(0, T.tpTop + 1.6, T.towerBaseR - 0.02, 1.2, 2.4, 0.1, DARK);
  const N = T.nacelle;
  const zc = nacelleCentreZ();
  b.box(0, T.hubHeight, zc, N.width, N.height, N.length, TOWER_WHITE);
  // cooler on the roof and a helicopter hoist platform at the back
  b.box(0, T.hubHeight + N.height / 2 + 1, zc + N.length / 2 - 3, N.width * 0.8, 2, 3, GREY);
  b.box(0, T.hubHeight + N.height / 2 + 0.1, zc + N.length / 2 - 8, N.width, 0.2, 4, HELI_GREEN, { bottom: true });
  b.box(0, T.hubHeight + N.height / 2 + 0.22, zc + N.length / 2 - 8, 1.2, 0.04, 1.2, HELI_WHITE, { bottom: true });
  return b.build();
}

/** Hub, spinner and three blades, model frame centred on the hub, the rotor plane = XY, facing −Z. */
export function buildRotor(): THREE.BufferGeometry {
  const T = TURBINE;
  const b = new MeshBuilder();
  b.cylinder([0, 0, 0.5], [0, 0, -3.5], 3.2, 2.2, 16, TOWER_WHITE);
  b.cylinder([0, 0, -3.5], [0, 0, -6.8], 2.2, 0.1, 16, TOWER_WHITE, false);
  const R = T.rotorRadius;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    b.with([0, 0, -1.5], [0, 0, (a * 180) / Math.PI], () => {
      // blade along +Y: a lofted aerofoil-ish section, chord 6 m near the root tapering to 0.8 m, twisted
      const rings: [number, number, number][][] = [];
      const stations = [2.8, 6, 14, 24, 40, 60, 80, 96, 104, R - 1.5];
      for (const r of stations) {
        const t = r / R;
        const chord = r < 6 ? 3.4 + (r - 2.8) * 0.8 : 6.2 * (1 - t) ** 0.9 + 0.8;
        const thick = r < 6 ? 3.2 - (r - 2.8) * 0.3 : chord * (0.34 - 0.24 * t);
        const tw = (14 * (1 - t)) * DEG;
        const ring: [number, number, number][] = [];
        const n = 8;
        for (let j = 0; j < n; j++) {
          const th = (j / n) * Math.PI * 2;
          // an ellipse offset toward the leading edge
          const cx = Math.cos(th) * chord * 0.5 + chord * 0.12;
          const cz = Math.sin(th) * thick * 0.5;
          ring.push([cx * Math.cos(tw) - cz * Math.sin(tw), r, cx * Math.sin(tw) + cz * Math.cos(tw)]);
        }
        rings.push(ring);
      }
      b.loft(rings, (i) => (i >= rings.length - 2 ? TIP_RED : BLADE), true, true);
    });
  }
  return b.build();
}

/** The offshore substation: a jacket, a two-deck topside with a small helideck, model frame (centre at sea level). */
export function buildSubstation(depth: number): THREE.BufferGeometry {
  const S = SUBSTATION;
  const b = new MeshBuilder();
  const hw = S.legSpread / 2;
  const hd = hw * 0.62;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      b.cylinder([sx * hw * 0.62 * 1.25, -depth, sz * hd * 1.25], [sx * hw * 0.62, S.deckY - 2, sz * hd], 0.9, 0.9, 10, TP_YELLOW, false);
    }
  for (const y of [-depth * 0.5, 6]) {
    const k = y < 0 ? 1.12 : 1.0;
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) b.cylinder([ax * hw * 0.62 * k, y, az * hd * k], [bx * hw * 0.62 * k, y, bz * hd * k], 0.35, 0.35, 6, y < 0 ? PILE : GREY, false);
  }
  b.box(0, S.deckY + 3.5, 0, S.w, 7, S.d, SUB_WHITE);
  b.box(0, S.deckY - 0.6, 0, S.w + 1, 1.2, S.d + 1, SUB_GREY);
  b.box(-4, S.deckY + 7 + 4, 0, S.w - 12, 8, S.d - 4, SUB_WHITE, { bottom: true });
  b.box(-4, S.deckY + 15.2, 0, S.w - 11, 0.4, S.d - 3, SUB_GREY);
  // transformer bays (darker), a crane and the small helideck
  for (let i = 0; i < 3; i++) b.box(-12 + i * 8, S.deckY + 3.5, S.d / 2 + 0.05, 6, 5, 0.1, DARK);
  b.cylinder([S.w / 2 - 4, S.deckY + 7, -S.d / 2 + 3], [S.w / 2 - 4, S.deckY + 13, -S.d / 2 + 3], 0.8, 0.7, 10, TP_YELLOW);
  b.box(S.w / 2 - 4 - 7, S.deckY + 13, -S.d / 2 + 3, 14, 0.8, 0.8, TP_YELLOW);
  b.cylinder([-4, S.deckY + 15.4, 0], [-4, S.deckY + 15.6, 0], 9, 9, 16, HELI_GREEN);
  b.box(-4, S.deckY + 15.65, 0, 1, 0.04, 5, HELI_WHITE, { bottom: true });
  b.box(-4 - 1.6, S.deckY + 15.65, 0, 0.8, 0.04, 5, HELI_WHITE, { bottom: true });
  b.box(-4 + 1.6, S.deckY + 15.65, 0, 0.8, 0.04, 5, HELI_WHITE, { bottom: true });
  return b.build();
}

export interface WindFarmModel {
  group: THREE.Group;
  turbines: TurbineSite[];
  uniforms: FlareLightUniforms;
  /** Current yaw (deg, the bearing the rotors face) and rotor angle (rad). */
  readonly yawDeg: number;
  readonly rotorAngle: number;
  /** Aim every nacelle into the wind (deg FROM). */
  setWind(fromDeg: number): void;
  /** Advance the rotors by `dt` s at `rpm`. */
  update(dt: number, rpm: number, night: number): void;
  /** World position of turbine i's nacelle-top lights (out = [x, y, z]). */
  nacelleLight(i: number, side: -1 | 1, out: THREE.Vector3): THREE.Vector3;
  triangles(): number;
  dispose(): void;
}

/** Builds the farm; `depthAt(x, z)` = water depth there (m, for the monopiles). */
export function createWindFarmModel(depthAt: (x: number, z: number) => number, windFromDeg: number): WindFarmModel {
  const { turbines, substation } = windFarmLayout();
  const group = new THREE.Group();
  group.name = 'offshore.windFarm';
  const uniforms = createFlareUniforms();
  const material = createOffshoreMaterial(uniforms, { flare: false, name: 'offshore.turbine' });
  const rotorMat = createOffshoreMaterial(uniforms, { flare: false, name: 'offshore.rotor', doubleSide: true });
  let maxDepth = 0;
  for (const t of turbines) maxDepth = Math.max(maxDepth, depthAt(t.x, t.z));
  const staticGeo = buildTurbineStatic(maxDepth + 2);
  const rotorGeo = buildRotor();
  const towers = new THREE.InstancedMesh(staticGeo, material, turbines.length);
  towers.name = 'offshore.turbines';
  const rotors = new THREE.InstancedMesh(rotorGeo, rotorMat, turbines.length);
  rotors.name = 'offshore.rotors';
  towers.castShadow = true;
  rotors.castShadow = true;
  towers.receiveShadow = true;
  rotors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(towers, rotors);
  const subDepth = depthAt(substation.x, substation.z);
  const subGeo = buildSubstation(subDepth + 2);
  const sub = new THREE.Mesh(subGeo, material);
  sub.name = 'offshore.substation';
  sub.position.set(substation.x, 0, substation.z);
  sub.rotation.y = 0.2;
  sub.castShadow = true;
  sub.receiveShadow = true;
  group.add(sub);

  const T = TURBINE;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const hubLocal = new THREE.Vector3(0, T.hubHeight, -T.overhang);
  let yawDeg = turbineYawDeg(windFromDeg);
  let angle = 0;
  // per-turbine phase so the rotors aren't in lock-step
  const phase = turbines.map((t) => ((t.x * 0.013 + t.z * 0.029) % (Math.PI * 2)));

  const writeStatic = () => {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, -yawDeg * DEG);
    for (let i = 0; i < turbines.length; i++) {
      p.set(turbines[i].x, 0, turbines[i].z);
      towers.setMatrixAt(i, m.compose(p, q, s));
    }
    towers.instanceMatrix.needsUpdate = true;
    towers.computeBoundingSphere();
  };
  const writeRotors = () => {
    for (let i = 0; i < turbines.length; i++) {
      // yaw, then the 6° tilt (rotor axis up at the front), then the spin about the axis
      e.set(T.tiltDeg * DEG, -yawDeg * DEG, angle + phase[i], 'YXZ');
      q.setFromEuler(e);
      p.copy(hubLocal).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -yawDeg * DEG);
      p.x += turbines[i].x;
      p.z += turbines[i].z;
      rotors.setMatrixAt(i, m.compose(p, q, s));
    }
    rotors.instanceMatrix.needsUpdate = true;
  };
  writeStatic();
  writeRotors();
  rotors.computeBoundingSphere();

  return {
    group,
    turbines,
    uniforms,
    get yawDeg() {
      return yawDeg;
    },
    get rotorAngle() {
      return angle;
    },
    setWind(fromDeg) {
      const y = turbineYawDeg(fromDeg);
      if (y === yawDeg) return;
      yawDeg = y;
      writeStatic();
      writeRotors();
    },
    update(dt, rpm, night) {
      uniforms.uNight.value = night;
      if (!(dt > 0) || !(rpm > 0)) return;
      // clockwise seen from upwind (the standard): about the model's −Z axis
      angle = (angle - rpm * (Math.PI / 30) * dt) % (Math.PI * 2);
      writeRotors();
    },
    nacelleLight(i, side, out) {
      const t = turbines[i];
      const zc = nacelleCentreZ();
      out.set(side * (T.nacelle.width / 2 - 0.6), T.hubHeight + T.nacelle.height / 2 + 1.2, zc + T.nacelle.length / 2 - 1.5);
      out.applyAxisAngle(THREE.Object3D.DEFAULT_UP, -yawDeg * DEG);
      out.x += t.x;
      out.z += t.z;
      return out;
    },
    triangles: () => (staticGeo.index!.count / 3 + rotorGeo.index!.count / 3) * turbines.length + subGeo.index!.count / 3,
    dispose() {
      staticGeo.dispose();
      rotorGeo.dispose();
      subGeo.dispose();
      material.dispose();
      rotorMat.dispose();
      towers.dispose();
      rotors.dispose();
    },
  };
}
