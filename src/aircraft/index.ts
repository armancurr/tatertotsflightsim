/**
 * Procedural Cessna 172RG Cutlass RG: exterior, cockpit and animation.
 *
 *   const ac = createAircraft();
 *   scene.add(ac.root);                       // integrator copies physics position/quaternion onto ac.root
 *   ac.setVisualState(visualState, dt);       // every frame
 *
 * Body frame = three.js object frame (+X right wing, +Y up, −Z nose, origin = CG);
 * wheels, prop hub, wing root and tail sit exactly on CONFIG.aircraft.geometry.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { InstrumentReadings } from '../types';
import { computeAnimation, createAnimation, createPropDisc, propDiscParams, strobeRate } from './animate';
import type { BreakupPart } from '../fleet/types';
import { createBreakupRig, splitByTriangles } from './breakup';
import { buildCockpit } from './cockpit';
import { createCabinLight } from './cabinLight';
import { buildFuselage } from './fuselage';
import { buildGear, GEAR_PART } from './gear';
import { createFuselageTextures, doorOutlineDistance } from './livery';
import { addCabinFill, createMaterials, createPartsMaterial, merge, tint } from './materials';
import { PANEL } from './panel';
import { drawCessnaPanel } from './panelFace';
import { buildProp, PROP_PART } from './prop';
import { FUSE_Z0, WINDSHIELD_BASE_Z, fuselageSection, type SectionParams } from './shape';
import { buildTail } from './tail';
import { buildWells } from './wells';
import { bendBladePoint, charProgress, deformWreckGeometry, deformWreckPoint, tailSkewTransform, wingFoldTransform } from './wreck';
import { createRestReadings, type AircraftVisualState, type PanelDrawer } from './types';
import { buildWing } from './wing';

export type { AircraftVisualState, PanelDrawer } from './types';
export { createDefaultVisualState } from './types';
export { PANEL, PANEL_LAYOUT } from './panel';
export { drawCessnaPanel } from './panelFace';

/** Names of the parts the integrator / tests can look up with root.getObjectByName. */
export const PART = {
  fuselage: 'fuselage',
  glass: 'glass',
  /** The left wing mesh (PART.wing kept for older lookups). */
  wing: 'wing.left',
  wingLeft: 'wing.left',
  wingRight: 'wing.right',
  cowl: 'cowl',
  doorLeft: 'door.left',
  doorRight: 'door.right',
  flapLeft: 'flap.left',
  flapRight: 'flap.right',
  aileronLeft: 'aileron.left',
  aileronRight: 'aileron.right',
  tailplane: 'tailplane',
  elevator: 'elevator',
  trimTab: 'trimTab',
  fin: 'fin',
  rudder: 'rudder',
  propHub: PROP_PART.hub,
  spinner: PROP_PART.spinner,
  propBlades: PROP_PART.blades,
  propDisc: PROP_PART.disc,
  axleNose: GEAR_PART.axleNose,
  axleLeft: GEAR_PART.axleLeft,
  axleRight: GEAR_PART.axleRight,
  interior: 'interior',
  landingLight: 'landingLight',
} as const;

export interface AircraftModel {
  root: THREE.Group;
  setVisualState(v: AircraftVisualState, dt: number): void;
  landingLight: THREE.SpotLight;
  /**
   * The parts that separate in a crash (fuselage, engine, prop, wings with struts, tail, gear
   * legs, doors). Each object is a container at the identity while attached; the model only
   * animates its children. Same array every call.
   */
  getBreakupParts(): BreakupPart[];
  /** Re-attach every part to its original parent, child slot and local transform (on reset). */
  restoreBreakupParts(): void;
  dispose(): void;
}

const DEG = Math.PI / 180;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function tube(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, segs = 10): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), segs);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

function hingedPivot(name: string, pos: THREE.Vector3, quat: THREE.Quaternion) {
  const pivot = new THREE.Group();
  pivot.position.copy(pos);
  pivot.quaternion.copy(quat);
  const slide = new THREE.Group();
  const rot = new THREE.Group();
  rot.name = name;
  pivot.add(slide);
  slide.add(rot);
  return { pivot, slide, rot };
}

/** Fuselage-mounted details, by the part they break off with: cabin (antennas, steps), engine (cowl inlets, cowl flaps, exhaust), tail (fin antennas). */
function fuselageDetails(): { fuselage: THREE.BufferGeometry[]; engine: THREE.BufferGeometry[]; tail: THREE.BufferGeometry[] } {
  const out: THREE.BufferGeometry[] = [];
  const engine: THREE.BufferGeometry[] = [];
  const tail: THREE.BufferGeometry[] = [];
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
  const faceZ = FUSE_Z0 - 0.02;
  // Twin cowl inlets beside the spinner: dark mouths with a painted lip.
  for (const s of [-1, 1]) {
    // D-shaped mouth: flat inner edge beside the spinner, round outer edge (built per side, no mirroring).
    const hw = 0.056;
    const hh = 0.075;
    const shape = new THREE.Shape();
    shape.moveTo(0, -hh);
    shape.absarc(0, 0, hh, -Math.PI / 2, Math.PI / 2, s < 0);
    shape.lineTo(-s * hw * 0.55, hh);
    shape.quadraticCurveTo(-s * hw, hh, -s * hw, hh * 0.5);
    shape.lineTo(-s * hw, -hh * 0.5);
    shape.quadraticCurveTo(-s * hw, -hh, -s * hw * 0.55, -hh);
    shape.lineTo(0, -hh);
    const mouth = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 14 });
    mouth.translate(s * 0.235, 0.0, faceZ - 0.012);
    engine.push(tint(mouth, 0x060606, 0.9, 0));
    const lip = new THREE.TorusGeometry(1, 0.13, 8, 28);
    lip.scale(0.068, 0.082, 0.05);
    lip.translate(s * 0.238, 0.0, faceZ - 0.006);
    engine.push(tint(lip, 0xefefea, 0.3, 0));
  }
  // Lower cowl air exit / cowl flaps.
  fuselageSection(-1.27, sec);
  const flap = new THREE.BoxGeometry(0.42, 0.02, 0.09);
  flap.rotateX(-0.25);
  flap.translate(0, sec.bottom + 0.012, -1.27);
  engine.push(tint(flap, 0x1a1a1b, 0.8, 0));
  // Exhaust stack (right lower cowl).
  fuselageSection(-1.4, sec);
  engine.push(tint(tube(V(0.2, sec.bottom + 0.1, -1.46), V(0.23, sec.bottom - 0.045, -1.32), 0.024, 0.026, 14), 0xc8c8c4, 0.22, 1.0));
  engine.push(tint(tube(V(0.2, sec.bottom + 0.1, -1.46), V(0.231, sec.bottom - 0.047, -1.318), 0.016, 0.016, 12), 0x201b18, 0.9, 0.2));
  // Com whips on the cabin roof (behind the wing centre section).
  for (const [z, lean] of [[0.35, 0.3], [0.8, 0.35]] as const) {
    fuselageSection(z, sec);
    const base = V(0, 1.085, z);
    out.push(tint(tube(base, V(0, 1.43, z + lean), 0.006, 0.003, 6), 0x1c1c1c, 0.6, 0.2));
    out.push(tint(tube(V(0, 1.075, z - 0.02), V(0, 1.1, z + 0.03), 0.018, 0.012, 10), 0x1c1c1c, 0.6, 0.2));
  }
  // ELT whip on the tailcone and transponder blade under the belly.
  fuselageSection(2.9, sec);
  out.push(tint(tube(V(0, sec.top - 0.01, 2.9), V(0, sec.top + 0.36, 3.05), 0.005, 0.003, 6), 0x1c1c1c, 0.6, 0.2));
  fuselageSection(1.0, sec);
  const blade = new THREE.BoxGeometry(0.008, 0.08, 0.06);
  blade.translate(0.0, sec.bottom - 0.04, 1.0);
  out.push(tint(blade, 0x1c1c1c, 0.6, 0.2));
  // Refuelling step (lower cowl side) and grab handle (upper cowl side) on each side, for
  // reaching the wing fuel caps — a high wing has no walkway.
  for (const s of [-1, 1]) {
    fuselageSection(-1.5, sec);
    const hw = sec.halfWidth;
    const pad = new THREE.BoxGeometry(0.02, 0.012, 0.09);
    pad.translate(s * (hw + 0.012), -0.2, -1.5);
    engine.push(tint(pad, 0x3c3d3f, 0.7, 0.4));
    engine.push(tint(tube(V(s * (hw - 0.01), -0.19, -1.53), V(s * (hw + 0.018), -0.205, -1.5), 0.006, 0.006, 6), 0x9ea0a2, 0.35, 0.8));
    const handle = new THREE.TorusGeometry(0.045, 0.006, 6, 14, Math.PI);
    handle.rotateY(Math.PI / 2);
    handle.rotateX(-Math.PI / 2);
    handle.translate(s * (hw - 0.03), 0.17, -1.55);
    engine.push(tint(handle, 0xb8babc, 0.3, 0.9));
  }
  // Boarding steps behind each door.
  for (const s of [-1, 1]) {
    fuselageSection(0.42, sec);
    out.push(tint(tube(V(s * 0.46, sec.bottom + 0.1, 0.42), V(s * 0.58, sec.bottom - 0.06, 0.42), 0.012, 0.012, 8), 0x9ea0a2, 0.35, 0.8));
    const pad = new THREE.BoxGeometry(0.1, 0.012, 0.08);
    pad.translate(s * 0.6, sec.bottom - 0.066, 0.42);
    out.push(tint(pad, 0x3c3d3f, 0.7, 0.4));
  }
  // Nav "cat whisker" antenna on the fin.
  for (const s of [-1, 1]) {
    tail.push(tint(tube(V(s * 0.02, 1.16, 5.12), V(s * 0.32, 1.26, 5.3), 0.004, 0.003, 6), 0x1c1c1c, 0.6, 0.3));
  }
  return { fuselage: out, engine, tail };
}

/**
 * Move every vertex of `geo` that lies inside the fuselage's upper cabin section (between the
 * windshield and the rear window) up to just under the skin, so nothing of it shows inside the cabin.
 */
export function tuckInsideFuselage(geo: THREE.BufferGeometry): number {
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  let moved = 0;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const y = p.getY(i);
    if (z < -0.75 || z > 1.3 || y < 0.5) continue;
    fuselageSection(z, sec);
    const r = Math.abs(p.getX(i)) / sec.halfWidth;
    if (r >= 1 || y <= sec.widthY) continue;
    const top = sec.widthY + (sec.top - sec.widthY) * Math.pow(1 - Math.pow(r, sec.nTop), 1 / sec.nTop) - 0.003;
    if (y < top) {
      p.setY(i, top);
      moved++;
    }
  }
  if (moved) {
    p.needsUpdate = true;
    geo.computeBoundingSphere();
  }
  return moved;
}

export function createAircraft(opts: { quality?: 'high' | 'low' } = {}): AircraftModel {
  const quality = opts.quality ?? 'high';
  const hasDom = typeof document !== 'undefined';
  const textures = createFuselageTextures(quality);
  const mats = createMaterials(textures);
  const interiorParts = createPartsMaterial('ac-interior');
  mats.all.push(interiorParts);

  const root = new THREE.Group();
  root.name = 'aircraft';
  const exterior = new THREE.Group();
  exterior.name = 'exterior';
  root.add(exterior);

  const shadowed = (m: THREE.Mesh) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // Break-up part containers (identity transforms; only their children are ever animated).
  const partGroup = (name: string) => {
    const g = new THREE.Group();
    g.name = `part.${name}`;
    exterior.add(g);
    return g;
  };
  const P = {
    fuselage: partGroup('fuselage'),
    engine: partGroup('engine'),
    prop: partGroup('prop'),
    leftWing: partGroup('leftWing'),
    rightWing: partGroup('rightWing'),
    tail: partGroup('tail'),
    leftDoor: partGroup('leftDoor'),
    rightDoor: partGroup('rightDoor'),
  };

  // Fuselage skin, split by where it goes in a crash: cabin + tailcone, cowling (ahead of the
  // firewall), and the two cabin doors (inside the painted door outline). Same material, same
  // UVs, so the pieces are seamless while attached.
  const fus = buildFuselage(quality);
  const doorOf = (x: number, y: number, z: number) => (Math.abs(x) > 0.25 && doorOutlineDistance(z, y) < 0 ? (x < 0 ? 0 : 1) : -1);
  const skinParts = splitByTriangles(fus.skin, 4, (x, y, z) => {
    if (z < WINDSHIELD_BASE_Z) return 1;
    const d = doorOf(x, y, z);
    return d < 0 ? 0 : 2 + d;
  });
  fus.skin.dispose();
  const skinMesh = (g: THREE.BufferGeometry | null, name: string, parent: THREE.Group) => {
    const m = shadowed(new THREE.Mesh(g ?? new THREE.BufferGeometry(), mats.skin));
    m.name = name;
    parent.add(m);
    return m;
  };
  const skin = skinMesh(skinParts[0], PART.fuselage, P.fuselage);
  const cowl = skinMesh(skinParts[1], PART.cowl, P.engine);
  const doorSkins = [skinMesh(skinParts[2], PART.doorLeft, P.leftDoor), skinMesh(skinParts[3], PART.doorRight, P.rightDoor)];
  const glassParts = splitByTriangles(fus.glass, 3, (x, y, z) => 1 + doorOf(x, y, z));
  fus.glass.dispose();
  const glassMesh = (g: THREE.BufferGeometry | null, name: string, parent: THREE.Group) => {
    const m = new THREE.Mesh(g ?? new THREE.BufferGeometry(), mats.glass);
    m.name = name;
    m.renderOrder = 1;
    parent.add(m);
    return m;
  };
  const glass = glassMesh(glassParts[0], PART.glass, P.fuselage);
  const glassMeshes = [glass, glassMesh(glassParts[1], 'glass.door.left', P.leftDoor), glassMesh(glassParts[2], 'glass.door.right', P.rightDoor)];

  // Wing (each side with half the centre section and its strut), flaps and ailerons. The centre
  // section's underside dips inside the fuselage (hidden by the skin from outside, but in the cabin
  // it would hang below the headliner): tuck those vertices up under the skin.
  const wing = buildWing(quality);
  tuckInsideFuselage(wing.paint.left);
  tuckInsideFuselage(wing.paint.right);
  const wingMeshes = [
    shadowed(new THREE.Mesh(wing.paint.left, mats.paint)),
    shadowed(new THREE.Mesh(wing.paint.right, mats.paint)),
  ];
  wingMeshes[0].name = PART.wingLeft;
  wingMeshes[1].name = PART.wingRight;
  P.leftWing.add(wingMeshes[0]);
  P.rightWing.add(wingMeshes[1]);
  const sideGroup = (side: number) => (side < 0 ? P.leftWing : P.rightWing);
  const flapRig = wing.flaps.map((f) => {
    const h = hingedPivot(f.side < 0 ? PART.flapLeft : PART.flapRight, f.position, f.quaternion);
    h.rot.add(shadowed(new THREE.Mesh(f.geometry, mats.paint)));
    sideGroup(f.side).add(h.pivot);
    return h;
  });
  const aileronRig = wing.ailerons.map((a) => {
    const h = hingedPivot(a.side < 0 ? PART.aileronLeft : PART.aileronRight, a.position, a.quaternion);
    h.rot.add(shadowed(new THREE.Mesh(a.geometry, mats.paint)));
    sideGroup(a.side).add(h.pivot);
    return h;
  });

  // Tail.
  const tail = buildTail(quality);
  const tailplane = new THREE.Group();
  tailplane.name = PART.tailplane;
  P.tail.add(tailplane);
  tailplane.add(shadowed(new THREE.Mesh(tail.stab, mats.paint)));
  const elev = hingedPivot(PART.elevator, tail.elevator.position, new THREE.Quaternion());
  elev.rot.add(shadowed(new THREE.Mesh(tail.elevator.geometry, mats.paint)));
  tailplane.add(elev.pivot);
  const tab = hingedPivot(PART.trimTab, tail.trimTab.position, tail.trimTab.quaternion);
  tab.rot.add(shadowed(new THREE.Mesh(tail.trimTab.geometry, mats.paint)));
  elev.rot.add(tab.pivot);

  const finGroup = new THREE.Group();
  finGroup.name = PART.fin;
  P.tail.add(finGroup);
  const finMesh = shadowed(new THREE.Mesh(tail.fin, mats.fin));
  finGroup.add(finMesh);
  const rud = hingedPivot(PART.rudder, tail.rudder.position, tail.rudder.quaternion);
  rud.rot.add(shadowed(new THREE.Mesh(tail.rudder.geometry, mats.fin)));
  finGroup.add(rud.pivot);

  // Propeller.
  const prop = buildProp(mats, quality);
  P.prop.add(prop.hub);

  // Gear (nose and each main leg in its own container), and the well liners behind the belly openings.
  const gear = buildGear(mats, quality);
  exterior.add(gear.group);
  const wellMat = createPartsMaterial('ac-wells');
  wellMat.side = THREE.DoubleSide;
  mats.all.push(wellMat);
  const wells = new THREE.Mesh(buildWells(quality), wellMat);
  wells.name = 'gearWells';
  wells.receiveShadow = true;
  P.fuselage.add(wells);

  // Static details, one merged mesh per part: cabin (antennas, steps), engine (inlets, cowl flaps,
  // exhaust), tail (fin antennas, beacon pod), each wing (fuel cap, pitot, strut cuffs).
  const bb = tail.beaconBase;
  const pod = new THREE.SphereGeometry(1, 16, 10);
  pod.scale(0.035, 0.03, 0.09);
  pod.translate(bb.x, bb.y + 0.012, bb.z);
  const fd = fuselageDetails();
  const detailMesh = (name: string, list: THREE.BufferGeometry[], parent: THREE.Group) => {
    const m = shadowed(new THREE.Mesh(merge(list), mats.parts));
    m.name = name;
    parent.add(m);
    return m;
  };
  const details = detailMesh('details', fd.fuselage, P.fuselage);
  const detailMeshes = [
    details,
    detailMesh('details.engine', fd.engine, P.engine),
    detailMesh('details.tail', [...fd.tail, tint(pod, 0xf0f0ec, 0.3, 0)], P.tail),
    detailMesh('details.wing.left', wing.parts.left, P.leftWing),
    detailMesh('details.wing.right', wing.parts.right, P.rightWing),
  ];
  // Inlets, cuffs, pitot, caps and fin whiskers are too small to cast a visible shadow.
  for (const m of detailMeshes.slice(1)) m.castShadow = false;

  // ── Lights ────────────────────────────────────────────────────────────────
  const lensGeo = (pos: THREE.Vector3, sx: number, sy: number, sz: number, hex: number) => {
    const g = new THREE.SphereGeometry(1, 14, 10);
    g.scale(sx, sy, sz);
    g.translate(pos.x, pos.y, pos.z);
    return tint(g, hex, 0.2, 0);
  };
  const L = wing.tipLight.left;
  const R = wing.tipLight.right;
  const navMesh = new THREE.Mesh(
    merge([lensGeo(L, 0.02, 0.024, 0.045, 0xff2a1a), lensGeo(R, 0.02, 0.024, 0.045, 0x20ff60)]),
    mats.nav,
  );
  navMesh.name = 'navLights';
  exterior.add(navMesh);
  const tailLightMesh = new THREE.Mesh(
    lensGeo(tail.tailLight.clone().sub(tail.rudder.position).applyQuaternion(tail.rudder.quaternion.clone().invert()), 0.014, 0.018, 0.016, 0xffffff),
    mats.nav,
  );
  rud.rot.add(tailLightMesh);
  const strobeOff = V(0, 0, 0.075);
  const strobeMesh = new THREE.Mesh(
    merge([lensGeo(L.clone().add(strobeOff), 0.016, 0.02, 0.03, 0xffffff), lensGeo(R.clone().add(strobeOff), 0.016, 0.02, 0.03, 0xffffff)]),
    mats.strobe,
  );
  strobeMesh.name = 'strobes';
  exterior.add(strobeMesh);
  const beaconPos = V(bb.x, bb.y + 0.045, bb.z);
  const beaconGeo = new THREE.SphereGeometry(1, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  beaconGeo.scale(0.028, 0.075, 0.028);
  beaconGeo.translate(beaconPos.x, beaconPos.y, beaconPos.z);
  const beaconMesh = new THREE.Mesh(beaconGeo, mats.beacon);
  beaconMesh.name = 'beacon';
  finGroup.add(beaconMesh);
  const lampDisc = (p: THREE.Vector3) => {
    const g = new THREE.CircleGeometry(0.045, 20);
    g.rotateY(Math.PI);
    g.scale(1, 0.8, 1);
    g.translate(p.x, p.y, p.z - 0.002);
    return g;
  };
  const lampMesh = new THREE.Mesh(merge([tint(lampDisc(wing.lamps.landing), 0xffffff, 0.2), tint(lampDisc(wing.lamps.taxi), 0xffffff, 0.2)]), mats.lamp);
  lampMesh.name = 'landingLamps';
  P.leftWing.add(lampMesh);

  // Glow sprites for every light in one Points draw.
  const glowPos = [
    L.clone().add(V(-0.03, 0, 0)),
    R.clone().add(V(0.03, 0, 0)),
    tail.tailLight.clone().add(V(0, 0, 0.02)),
    L.clone().add(strobeOff).add(V(-0.02, 0, 0)),
    R.clone().add(strobeOff).add(V(0.02, 0, 0)),
    beaconPos.clone().add(V(0, 0.03, 0)),
    wing.lamps.landing.clone().add(V(0, 0, -0.02)),
    wing.lamps.taxi.clone().add(V(0, 0, -0.02)),
  ];
  const glowCol = [
    [1.6, 0.08, 0.04], [0.1, 1.5, 0.35], [1.1, 1.1, 1.05], [8, 8, 8.5], [8, 8, 8.5], [3.2, 0.2, 0.08], [5, 4.7, 4.3], [3.5, 3.3, 3],
  ];
  const glowSize = [0.16, 0.16, 0.14, 0.9, 0.9, 0.42, 0.45, 0.35];
  const glowDir = [
    [-0.8, 0, -0.6], [0.8, 0, -0.6], [0, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, -0.05, -1], [0, -0.1, -1],
  ];
  const gpos = new Float32Array(glowPos.length * 3);
  glowPos.forEach((p, i) => p.toArray(gpos, i * 3));
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array(glowCol.flat()), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(glowSize), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array(glowDir.flat()), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(glowPos.length), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 0.5, 1.5), 7);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = 'lightGlows';
  glows.frustumCulled = false;
  glows.renderOrder = 3;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  exterior.add(glows);

  // Landing light (the only real light).
  const LL = CONFIG.aircraft.model.landingLight;
  const landingLight = new THREE.SpotLight(0xfff4e6, 0, LL.range, LL.angleDeg * DEG, LL.penumbra, LL.decay);
  landingLight.name = PART.landingLight;
  landingLight.position.set(LL.x, LL.y, LL.z);
  landingLight.target.position.set(LL.x, LL.y - Math.tan(LL.aimDownDeg * DEG) * 50, LL.z - 50);
  landingLight.castShadow = false;
  landingLight.visible = false;
  root.add(landingLight, landingLight.target);

  // ── Cockpit ───────────────────────────────────────────────────────────────
  let panelCanvas: HTMLCanvasElement | null = null;
  let panelCtx: CanvasRenderingContext2D | null = null;
  let panelTex: THREE.CanvasTexture | null = null;
  if (hasDom) {
    panelCanvas = document.createElement('canvas');
    panelCanvas.width = PANEL.width;
    panelCanvas.height = PANEL.height;
    panelCtx = panelCanvas.getContext('2d');
    if (panelCtx) {
      panelTex = new THREE.CanvasTexture(panelCanvas);
      panelTex.colorSpace = THREE.SRGBColorSpace;
      panelTex.anisotropy = 8;
    }
  }
  const cockpit = buildCockpit(mats, fus.cabin, panelTex, interiorParts);
  P.fuselage.add(cockpit.group);

  // Cabin fill light, following the scene's sun (found once per scene, updated every frame).
  const cabinFill = { value: new THREE.Color(0, 0, 0) };
  addCabinFill(mats.cabin, cabinFill);
  addCabinFill(interiorParts, cabinFill);
  // Daylight through the glass only: sun and sky light enter the cabin by the windows (cabinLight.ts).
  const cabinLight = createCabinLight();
  for (const m of [mats.cabin, interiorParts, mats.panel]) cabinLight.apply(m);
  const syncCabinLight = () => cabinLight.update(root);
  cockpit.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && o.name !== 'cabinShell') m.onBeforeRender = syncCabinLight;
  });
  let fillScene: THREE.Object3D | null = null;
  const _sunTarget = new THREE.Vector3();
  let fillSun: THREE.DirectionalLight | null = null;
  const shell = cockpit.group.getObjectByName('cabinShell');
  if (shell) {
    shell.onBeforeRender = (_r, scene) => {
      syncCabinLight();
      if (scene !== fillScene) {
        fillScene = scene;
        fillSun = null;
        scene.traverse((o) => {
          if (!fillSun && (o as THREE.DirectionalLight).isDirectionalLight) fillSun = o as THREE.DirectionalLight;
        });
      }
      const sun = fillSun as THREE.DirectionalLight | null;
      if (sun) {
        cabinFill.value.copy(sun.color).multiplyScalar(sun.intensity * CONFIG.aircraft.model.cabinFill);
        cockpit.glint.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
        sun.getWorldPosition(cockpit.glint.sunDir.value).sub(sun.target.getWorldPosition(_sunTarget));
        if (cockpit.glint.sunDir.value.lengthSq() < 1e-12) cockpit.glint.sunDir.value.set(0, 1, 0);
      } else {
        cabinFill.value.setRGB(0, 0, 0);
        cockpit.glint.sunColor.value.setRGB(0, 0, 0);
      }
    };
  }

  const drawer: PanelDrawer = drawCessnaPanel;
  const rest = createRestReadings();
  let panelClock = Infinity;
  const redrawPanel = (r: InstrumentReadings) => {
    if (!panelCtx || !panelTex) return;
    drawer(panelCtx, PANEL.width, PANEL.height, r);
    panelTex.needsUpdate = true;
  };
  redrawPanel(rest);

  // ── Wreck (after a crash) ─────────────────────────────────────────────────
  // Deformed clones of the static geometry (built on the first crash, then cached) and the
  // matching rigid transforms of the hinged/separate parts; everything restores exactly.
  interface Saved { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; m: THREE.Matrix4 }
  const tailXf = tailSkewTransform();
  const foldXf = wingFoldTransform();
  const leftAileron = aileronRig[Math.max(0, wing.ailerons.findIndex((a) => a.side < 0))];
  const rigid: Saved[] = [
    [tailplane, tailXf],
    [rud.pivot, tailXf],
    [beaconMesh, tailXf],
    [leftAileron.pivot, foldXf],
  ].map(([o, m]) => ({ o: o as THREE.Object3D, p: (o as THREE.Object3D).position.clone(), q: (o as THREE.Object3D).quaternion.clone(), m: m as THREE.Matrix4 }));
  const hubRest = { p: prop.hub.position.clone(), q: prop.hub.quaternion.clone() };
  const hubWreck = { p: deformWreckPoint(hubRest.p.clone(), new THREE.Vector3()), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.17, 0.07, 0.12)) };
  const swaps = [skin, cowl, ...doorSkins, ...wingMeshes, ...detailMeshes, finMesh]
    .map((mesh) => ({ mesh, intact: mesh.geometry, wreck: null as THREE.BufferGeometry | null, fn: deformWreckPoint }))
    .concat([{ mesh: prop.blades, intact: prop.blades.geometry, wreck: null as THREE.BufferGeometry | null, fn: bendBladePoint }]);
  let wrecked = false;
  const _wm = new THREE.Matrix4();
  const _ws = new THREE.Vector3();
  const ONE = new THREE.Vector3(1, 1, 1);
  function setWrecked(on: boolean) {
    if (on === wrecked) return;
    wrecked = on;
    for (const sw of swaps) {
      if (on && !sw.wreck) sw.wreck = deformWreckGeometry(sw.intact.clone(), sw.fn);
      sw.mesh.geometry = on && sw.wreck ? sw.wreck : sw.intact;
    }
    for (const r of rigid) {
      if (on) _wm.compose(r.p, r.q, ONE).premultiply(r.m).decompose(r.o.position, r.o.quaternion, _ws);
      else {
        r.o.position.copy(r.p);
        r.o.quaternion.copy(r.q);
      }
    }
    prop.hub.position.copy(on ? hubWreck.p : hubRest.p);
    prop.hub.quaternion.copy(on ? hubWreck.q : hubRest.q);
    for (const g of glassMeshes) g.visible = !on;
    glows.visible = !on;
    strobeMesh.visible = !on;
  }

  // ── Animation state ───────────────────────────────────────────────────────
  const anim = createAnimation();
  let propAngle = 0;
  let ghostAngle = 0;
  const pd = createPropDisc();
  let lastMode: string | null = null;
  const fullColor = new THREE.Color(0xffffff);
  const dimInterior = new THREE.Color(0x6a6a6a);
  const cabinPlain = new THREE.Color(0x8f877a);
  const panelPlain = new THREE.Color(0x333538);
  const strobeOffColor = new THREE.Color(0xbfc4c8);
  const strobeOnColor = new THREE.Color(0xffffff).multiplyScalar(6);
  const beaconOff = new THREE.Color(0x5a0808);
  const beaconOn = new THREE.Color(0xff2a18).multiplyScalar(4);
  const lampOff = new THREE.Color(0x9aa0a4);
  const lampOn = new THREE.Color(0xfff6e8).multiplyScalar(5);
  const gi = glowIntensity.array as Float32Array;

  function setVisualState(v: AircraftVisualState, dt: number) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    computeAnimation(v, anim);
    const crashed = v.crashed === true;
    setWrecked(crashed);
    mats.char.value = crashed ? charProgress(Number(v.crashAge ?? 0)) : 0;

    // Control surfaces.
    elev.rot.rotation.x = anim.elevatorRad;
    tab.rot.rotation.x = anim.trimTabRad;
    rud.rot.rotation.y = anim.rudderRad;
    aileronRig[0].rot.rotation.x = anim.aileronLeftRad;
    aileronRig[1].rot.rotation.x = anim.aileronRightRad;
    for (const f of flapRig) {
      f.slide.position.set(0, -anim.flapDrop, anim.flapSlide);
      f.rot.rotation.x = anim.flapRad;
    }

    gear.update(anim, v, step, crashed);

    // Propeller: clockwise from the cockpit = negative about +Z. Above the blur threshold the
    // blades are drawn at a slowly drifting aliased angle (the stroboscopic look of a real prop).
    // A wreck's prop is stopped (and bent) whatever the engine model still reports.
    const rpm = crashed ? 0 : Number.isFinite(v.propRpm) ? Math.max(0, v.propRpm) : 0;
    const inCockpitView = v.cameraMode === 'cockpit';
    propDiscParams(rpm, inCockpitView, pd);
    propAngle = (propAngle + (rpm / 60) * Math.PI * 2 * step) % (Math.PI * 2);
    ghostAngle = (ghostAngle + strobeRate(rpm) * step) % (Math.PI * 2);
    prop.spin.rotation.z = pd.strobe ? -ghostAngle : -propAngle;
    const blend = pd.blend;
    prop.blades.visible = pd.bladeOpacity > 0.001;
    const bladesTransparent = blend > 0.001;
    if (mats.blades.transparent !== bladesTransparent) {
      mats.blades.transparent = bladesTransparent;
      mats.blades.depthWrite = !bladesTransparent;
      mats.blades.needsUpdate = true;
    }
    mats.blades.opacity = pd.bladeOpacity;
    prop.blades.castShadow = blend < 0.5;
    prop.disc.visible = blend > 0.001;
    const du = mats.disc.uniforms;
    du.uAlpha.value = pd.discAlpha;
    du.uTip.value = pd.tipAlpha;
    du.uTint.value = pd.tipTint;
    du.uGhost.value = pd.ghost;
    du.uAngle.value = -ghostAngle;

    // Lights (a wreck's electrics are dead).
    if (crashed) anim.nav = anim.strobe = anim.beacon = anim.landing = anim.taxi = 0;
    navMesh.visible = anim.nav > 0;
    tailLightMesh.visible = anim.nav > 0;
    mats.strobe.color.copy(strobeOffColor).lerp(strobeOnColor, anim.strobe);
    mats.beacon.color.copy(beaconOff).lerp(beaconOn, anim.beacon);
    const lampLevel = Math.max(anim.landing, anim.taxi * 0.7);
    mats.lamp.color.copy(lampOff).lerp(lampOn, lampLevel);
    gi[0] = gi[1] = gi[2] = anim.nav;
    gi[3] = gi[4] = anim.strobe;
    gi[5] = anim.beacon;
    gi[6] = anim.landing;
    gi[7] = anim.taxi;
    glowIntensity.needsUpdate = true;
    landingLight.visible = lampLevel > 0;
    landingLight.intensity = LL.intensity * (anim.landing > 0 ? 1 : anim.taxi * 0.45);
    landingLight.angle = (anim.landing > 0 ? LL.angleDeg : LL.angleDeg * 2.2) * DEG;

    // Cockpit / exterior presentation.
    const inCockpit = v.cameraMode === 'cockpit';
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      for (const d of cockpit.details) d.visible = inCockpit;
      // From the seat the gear and wells are always hidden by the doors and cowling: skip them.
      gear.group.visible = !inCockpit;
      wells.visible = !inCockpit;
      mats.glass.opacity = inCockpit ? 0.1 : 0.3;
      mats.glass.envMapIntensity = inCockpit ? 0.6 : 1.2;
      const tintColor = inCockpit ? fullColor : dimInterior;
      if (textures) mats.cabin.color.copy(tintColor);
      else mats.cabin.color.copy(cabinPlain).multiply(tintColor);
      interiorParts.color.copy(tintColor);
      mats.panel.emissiveIntensity = inCockpit ? 0.3 : 0.05;
      if (panelTex) mats.panel.color.copy(tintColor);
      else mats.panel.color.copy(panelPlain);
      panelClock = Infinity;
    }
    const readings = v.instruments ?? rest;
    cockpit.update(anim, readings, inCockpit);
    const hz = inCockpit ? CONFIG.aircraft.model.panelRedrawHz : CONFIG.aircraft.model.panelRedrawHzExterior;
    panelClock += step;
    if (panelClock >= 1 / hz) {
      panelClock = 0;
      redrawPanel(readings);
    }
  }

  setVisualState(
    {
      elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
      wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
      propRpm: 0, engineRunning: false,
      lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false },
      time: 0, cameraMode: 'chase', instruments: null,
    },
    0,
  );

  // ── Crash break-up ────────────────────────────────────────────────────────
  const breakup = createBreakupRig([
    { name: 'fuselage', object: P.fuselage, mass: 430 },
    { name: 'engine', object: P.engine, mass: 160, burning: true },
    { name: 'prop', object: P.prop, mass: 30 },
    { name: 'leftWing', object: P.leftWing, mass: 110, burning: true },
    { name: 'rightWing', object: P.rightWing, mass: 110, burning: true },
    { name: 'tail', object: P.tail, mass: 40 },
    { name: 'noseGear', object: gear.nose, mass: 14 },
    { name: 'leftMainGear', object: gear.mainLeft, mass: 22 },
    { name: 'rightMainGear', object: gear.mainRight, mass: 22 },
    { name: 'leftDoor', object: P.leftDoor, mass: 12 },
    { name: 'rightDoor', object: P.rightDoor, mass: 12 },
  ]);

  return {
    root,
    setVisualState,
    landingLight,
    getBreakupParts: () => breakup.parts,
    restoreBreakupParts: () => breakup.restore(),
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
        if (!root.getObjectById(p.object.id)) p.object.removeFromParent();
      }
      for (const sw of swaps) {
        geos.add(sw.intact);
        if (sw.wreck) geos.add(sw.wreck);
      }
      for (const g of geos) g.dispose();
      for (const m of mats.all) m.dispose();
      if (textures) {
        textures.map.dispose();
        textures.orm.dispose();
        textures.normal.dispose();
        textures.cabin.dispose();
        textures.fin.dispose();
      }
      panelTex?.dispose();
      landingLight.dispose();
      root.removeFromParent();
    },
  };
}
