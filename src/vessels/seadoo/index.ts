/**
 * Procedural Sea-Doo RXP-X 325 (TATER JET) with its rider: a T3-R-style deep-V hull lofted from
 * the very station table the physics floats (SEADOO_AIRCRAFT.watercraft.hull.stations, via
 * src/vessels/hullLoft.ts) with chine flats and sponsons; the racy deck — pointed bow dome under an
 * orange hood with a race stripe and vents, the steering pod with its smoked visor, dash display
 * and mirrors, footwells with mats either side of the tunnel, the narrow sculpted seat, the rear
 * deck / boarding platform over the pump; at the stern the ride plate, the pump venturi, the
 * steerable / trimmable nozzle and the iBR reverse bucket; the intake grate under the hull. The
 * rider (one skinned mesh) grips the bars, leans into turns, crouches at speed and swims beside the
 * craft after a spill.
 *
 *   const ski = createSeadooModel();
 *   scene.add(ski.root);          // the loop copies the physics pose onto ski.root
 *   ski.setVisualState(v, dt);    // every frame (v.vessel = VesselState, may be null)
 *
 * Body frame = three.js object frame (+X starboard, +Y up, −Z bow, origin = CG). tests/vessels/seadoo
 * hold the hull to the station table, the nozzle and grate to the jet, the rider's eye to pilotEye,
 * the moving parts' senses and the draw-call budget (≤ 12 visible meshes in every state).
 */
import * as THREE from 'three';
import { SEADOO_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import type { AircraftVisualState } from '../../aircraft/types';
import { createBreakupRig } from '../../aircraft/breakup';
import { computeSeadooAnim, createSeadooAnim } from './animate';
import { buildHelm } from './helm';
import { buildBucket, buildHood, buildHull, buildNozzle, buildSeat } from './hull';
import { createSeadooMaterials } from './materials';
import { applyRiderPose, buildRider, buildSwimmer, solveRiderPose } from './rider';
import { JET, SEADOO_SHAPE as S } from './shape';

export { computeSeadooAnim, createSeadooAnim, type SeadooAnim } from './animate';
export { SEADOO_SHAPE } from './shape';
export { gripPosition } from './helm';
export { BONE, RIDER, createRiderPose, solveRiderPose, riderHipBase, type RiderPose } from './rider';

const DEG = Math.PI / 180;

/** Names of the parts (root.getObjectByName). */
export const SEADOO_PART = {
  root: 'seadoo',
  hull: 'seadoo.hull',
  shell: 'seadoo.hull.shell',
  deck: 'seadoo.hull.deck',
  hullParts: 'seadoo.hull.parts',
  nozzleSteer: 'seadoo.nozzle.steer',
  nozzleTrim: 'seadoo.nozzle.trim',
  nozzle: 'seadoo.nozzle',
  bucketHinge: 'seadoo.bucket.hinge',
  bucket: 'seadoo.bucket',
  hood: 'seadoo.hood',
  hoodShell: 'seadoo.hood.shell',
  seat: 'seadoo.seat',
  seatCushion: 'seadoo.seat.cushion',
  helm: 'seadoo.helm',
  pod: 'seadoo.helm.pod',
  display: 'seadoo.helm.display',
  barPivot: 'seadoo.helm.barPivot',
  barSteer: 'seadoo.helm.barSteer',
  bars: 'seadoo.helm.bars',
  rider: 'seadoo.rider',
  riderBody: 'seadoo.rider.body',
  swimmer: 'seadoo.swimmer',
  swimmerBody: 'seadoo.swimmer.body',
} as const;

/** Break-up masses, kg (the hull takes the rest of the craft: engine, pump, fuel). */
export const SEADOO_MASS = { rider: 85, hood: 9, seat: 11, handlebars: 22 } as const;

function group(name: string, parent?: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  parent?.add(g);
  return g;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = shadows;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export function createSeadooModel(): AircraftModelHandle {
  const mats = createSeadooMaterials();
  const root = group(SEADOO_PART.root);
  const E = JET.position;

  // ── Hull (break-up part): skin, deck, hardware, nozzle and bucket ──
  const hullGroup = group(SEADOO_PART.hull, root);
  const hg = buildHull();
  mesh(hg.shell, mats.paint, SEADOO_PART.shell, hullGroup);
  mesh(hg.deck, mats.paint, SEADOO_PART.deck, hullGroup);
  mesh(hg.parts, mats.parts, SEADOO_PART.hullParts, hullGroup);
  const nozzleSteer = group(SEADOO_PART.nozzleSteer, hullGroup);
  nozzleSteer.position.set(E.x, E.y, E.z - S.nozzleLength);
  const nozzleTrim = group(SEADOO_PART.nozzleTrim, nozzleSteer);
  mesh(buildNozzle(), mats.parts, SEADOO_PART.nozzle, nozzleTrim);
  const bucketHinge = group(SEADOO_PART.bucketHinge, hullGroup);
  bucketHinge.position.set(E.x, E.y, E.z - S.bucketHingeAhead);
  mesh(buildBucket(), mats.parts, SEADOO_PART.bucket, bucketHinge);

  // ── Hood, seat (break-up parts) ──
  const hoodGroup = group(SEADOO_PART.hood, root);
  mesh(buildHood(), mats.paint, SEADOO_PART.hoodShell, hoodGroup);
  const seatGroup = group(SEADOO_PART.seat, root);
  mesh(buildSeat(), mats.parts, SEADOO_PART.seatCushion, seatGroup);

  // ── Helm (break-up part): pod, display, bars on the tilted column ──
  const helmGroup = group(SEADOO_PART.helm, root);
  const helm = buildHelm();
  mesh(helm.pod, mats.parts, SEADOO_PART.pod, helmGroup);
  mesh(helm.display, mats.screen, SEADOO_PART.display, helmGroup, false);
  const barPivot = group(SEADOO_PART.barPivot, helmGroup);
  barPivot.position.set(S.barPivot.x, S.barPivot.y, S.barPivot.z);
  barPivot.rotation.x = S.columnTiltDeg * DEG;
  const barSteer = group(SEADOO_PART.barSteer, barPivot);
  mesh(helm.bars, mats.parts, SEADOO_PART.bars, barSteer);

  // ── Rider (break-up part) and the swimmer (shown beside the craft when the rider is off) ──
  const riderGroup = group(SEADOO_PART.rider, root);
  const rider = buildRider(riderGroup, mats.rider, SEADOO_PART.rider);
  const swimmer = group(SEADOO_PART.swimmer, root);
  mesh(buildSwimmer(), mats.parts, SEADOO_PART.swimmerBody, swimmer);
  swimmer.visible = false;

  // ── Break-up: masses sum to the craft + rider ──
  const M = SEADOO_MASS;
  const parts: BreakupPart[] = [
    { name: 'hull', object: hullGroup, mass: SEADOO_AIRCRAFT.mass - M.rider - M.hood - M.seat - M.handlebars, burning: true },
    { name: 'hood', object: hoodGroup, mass: M.hood },
    { name: 'seat', object: seatGroup, mass: M.seat },
    { name: 'handlebars', object: helmGroup, mass: M.handlebars },
    { name: 'rider', object: riderGroup, mass: M.rider },
  ];
  const breakup = createBreakupRig(parts);

  // ── Per-frame state (no allocations below) ──
  const anim = createSeadooAnim();
  const _rp = new THREE.Vector3();
  const _rq = new THREE.Quaternion();
  const _rs = new THREE.Vector3();
  const _f = new THREE.Vector3();
  const _wp = new THREE.Vector3();
  const _wq = new THREE.Quaternion();
  const _one = new THREE.Vector3(1, 1, 1);
  const _up = new THREE.Vector3(0, 1, 0);
  const _mw = new THREE.Matrix4();
  const _mi = new THREE.Matrix4();

  /** Upright in the world, at the sea surface, 1.5 m off the craft's port side, facing it. */
  function placeSwimmer(v: AircraftVisualState) {
    root.updateWorldMatrix(true, false);
    root.matrixWorld.decompose(_rp, _rq, _rs);
    _f.set(0, 0, -1).applyQuaternion(_rq);
    _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, -1);
    _f.normalize();
    // Port = up × forward.
    const px = _f.z;
    const pz = -_f.x;
    const sy = v.vessel?.surfaceY;
    const surface = typeof sy === 'number' && Number.isFinite(sy) && Math.abs(sy - _rp.y) < 5 ? sy : _rp.y + S.waterlineY;
    const t = Number.isFinite(v.time) ? v.time : 0;
    _wp.set(_rp.x + px * 1.5 - _f.x * 0.3, surface + 0.03 * Math.sin(t * 2.1), _rp.z + pz * 1.5 - _f.z * 0.3);
    // Facing the craft (local −Z toward starboard of the swimmer's spot).
    _wq.setFromAxisAngle(_up, Math.atan2(px, pz));
    _mw.compose(_wp, _wq, _one);
    _mi.copy(root.matrixWorld).invert();
    _mw.premultiply(_mi);
    _mw.decompose(swimmer.position, swimmer.quaternion, swimmer.scale);
  }

  function setVisualState(v: AircraftVisualState, _dt: number) {
    computeSeadooAnim(v, anim);
    mats.char.value = anim.crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0) || 0) / 6) : 0;

    barSteer.rotation.y = -anim.bars;
    nozzleSteer.rotation.y = anim.nozzleYaw;
    nozzleTrim.rotation.x = anim.nozzleTrim;
    bucketHinge.rotation.x = anim.bucketAngle;

    rider.mesh.visible = anim.aboard;
    if (anim.aboard) {
      solveRiderPose(anim.lean, anim.fwd, anim.bars, rider.pose);
      applyRiderPose(rider, rider.pose, anim.headVisible ? 1 : 1e-4);
    }
    swimmer.visible = anim.swimmer;
    if (anim.swimmer) placeSwimmer(v);
  }

  setVisualState(
    {
      elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
      wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
      propRpm: 0, engineRunning: false,
      lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false },
      time: 0, cameraMode: 'chase', instruments: null, vessel: null,
    },
    0,
  );

  return {
    root,
    setVisualState,
    getBreakupParts: () => breakup.parts,
    restoreBreakupParts() {
      breakup.restore();
      root.updateMatrixWorld(true);
    },
    dispose() {
      const geos = new Set<THREE.BufferGeometry>();
      const collect = (o: THREE.Object3D) =>
        o.traverse((c) => {
          const m = c as THREE.Mesh;
          if (m.geometry) geos.add(m.geometry);
        });
      collect(root);
      for (const p of breakup.parts) {
        collect(p.object);
        p.object.removeFromParent();
      }
      for (const g of geos) g.dispose();
      rider.mesh.skeleton.dispose();
      for (const m of mats.all) m.dispose();
      root.removeFromParent();
    },
  };
}
