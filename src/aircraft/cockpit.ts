/**
 * Cabin interior: trimmed inner shell with the window openings, instrument
 * panel (canvas texture), glareshield, wet compass, two yokes, rudder pedals,
 * engine controls, gear lever and lights, flap lever, trim wheel, seats.
 * Everything static merges into one mesh; each moving control is one mesh.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { InstrumentReadings } from '../types';
import type { AircraftAnimation } from './animate';
import { loftGeometry } from './loft';
import { merge, tint, type AircraftMaterials } from './materials';
import { PANEL, PANEL_BOTTOM_Y } from './panel';
import { fuselageSection, monotoneCurve, type SectionParams } from './shape';

export interface CockpitRig {
  group: THREE.Group;
  /** Meshes only worth drawing from the pilot's seat. */
  details: THREE.Object3D[];
  panelMesh: THREE.Mesh;
  update(anim: AircraftAnimation, r: InstrumentReadings | null, cockpit: boolean): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Heights of the controls relative to the panel's bottom edge. */
const KNOB_Y = PANEL_BOTTOM_Y + 0.035;
const YOKE_Y = PANEL_BOTTOM_Y + 0.085;
const GEAR_Y = PANEL_BOTTOM_Y + 0.1;
const FLAP_Y = PANEL_BOTTOM_Y + 0.07;

function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, segs = 10): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, d.length(), segs);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, rot?: THREE.Euler): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(x, y, z);
  return g;
}
function rbox(w: number, h: number, d: number, r: number, x: number, y: number, z: number, rot?: THREE.Euler): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(w, h, d, 3, r);
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(x, y, z);
  return g;
}

const _sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
/** Height of the cabin's inner upper surface above (x, z). */
function innerTopY(x: number, z: number, inset: number): number {
  fuselageSection(z, _sec);
  const W = _sec.halfWidth - inset;
  const r = Math.min(0.999, Math.abs(x) / W);
  return _sec.widthY + (_sec.top - inset - _sec.widthY) * Math.pow(1 - Math.pow(r, _sec.nTop), 1 / _sec.nTop);
}

/**
 * Glareshield: padded shroud from the panel lip down to the windshield base,
 * kept under the pilot's sightline to the cowling (eye → windshield base).
 */
function glareshield(): THREE.BufferGeometry {
  const rings: number[][] = [];
  const nx = 24;
  const lipZ = PANEL.z + 0.012;
  const lipY = PANEL.topY + 0.022;
  const profile = monotoneCurve([
    [-1.25, 0.245],
    [-1.1, 0.283],
    [-0.95, 0.318],
    [-0.8, lipY - 0.012],
    [lipZ, lipY],
  ]);
  const zs = [-1.24, -1.15, -1.05, -0.95, -0.85, -0.78, lipZ - 0.012, lipZ - 0.004, lipZ, lipZ + 0.004];
  const drops = [0, 0, 0, 0, 0, 0, 0, 0.006, 0.018, 0.034];
  zs.forEach((z, i) => {
    const ring: number[] = [];
    for (let j = 0; j <= nx; j++) {
      const x = -0.5 + (j / nx) * 1.0;
      const y = Math.min(profile(z) - 0.03 * (x / 0.5) ** 2, innerTopY(x, z, 0.047));
      ring.push(x, y - drops[i], z);
    }
    rings.push(ring);
  });
  return loftGeometry(rings, { closed: false });
}

function yokeGeometry(): THREE.BufferGeometry {
  const handle = new THREE.CatmullRomCurve3([
    V(-0.16, 0.075, 0.02),
    V(-0.155, 0.015, 0.012),
    V(-0.11, -0.03, 0.004),
    V(-0.04, -0.045, 0),
    V(0.04, -0.045, 0),
    V(0.11, -0.03, 0.004),
    V(0.155, 0.015, 0.012),
    V(0.16, 0.075, 0.02),
  ]);
  const parts = [
    tint(new THREE.TubeGeometry(handle, 40, 0.013, 10, false), 0x1d1e20, 0.55, 0.1),
    tint(tube(V(-0.163, 0.0, 0.017), V(-0.168, 0.1, 0.022), 0.019, 12), 0x2a2b2d, 0.8, 0),
    tint(tube(V(0.163, 0.0, 0.017), V(0.168, 0.1, 0.022), 0.019, 12), 0x2a2b2d, 0.8, 0),
    tint(rbox(0.075, 0.06, 0.05, 0.012, 0, -0.03, 0), 0x202124, 0.5, 0.1),
    tint(box(0.04, 0.02, 0.004, 0, -0.03, 0.026), 0x9a8c5a, 0.35, 0.8), // logo plate
    tint(tube(V(0, -0.03, -0.35), V(0, -0.03, -0.02), 0.012, 12), 0xb8babc, 0.25, 0.9), // shaft
    tint(box(0.012, 0.01, 0.01, -0.158, 0.09, 0.03), 0xb02020, 0.5, 0), // PTT button
  ];
  return merge(parts);
}

function pedal(x: number): THREE.BufferGeometry {
  const y = -0.31;
  const z = -1.0;
  return merge([
    tint(box(0.08, 0.12, 0.014, x, y, z, new THREE.Euler(-0.45, 0, 0)), 0x2b2c2e, 0.7, 0.2),
    tint(tube(V(x, y + 0.04, z - 0.02), V(x, -0.12, z + 0.06), 0.01, 8), 0x8a8c8e, 0.4, 0.8),
  ]);
}

export function buildCockpit(
  mats: AircraftMaterials,
  cabinGeo: THREE.BufferGeometry,
  panelTexture: THREE.Texture | null,
  interiorParts: THREE.MeshStandardMaterial,
): CockpitRig {
  const group = new THREE.Group();
  group.name = 'interior';
  const details: THREE.Object3D[] = [];

  const shell = new THREE.Mesh(cabinGeo, mats.cabin);
  shell.name = 'cabinShell';
  group.add(shell);

  // Panel face.
  if (panelTexture) {
    mats.panel.map = panelTexture;
    mats.panel.emissiveMap = panelTexture;
    mats.panel.needsUpdate = true;
  } else {
    mats.panel.color.setHex(0x333538);
  }
  const panelMesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL.widthM, PANEL.heightM), mats.panel);
  panelMesh.position.set(0, PANEL.centerY, PANEL.z);
  panelMesh.name = 'panel';
  group.add(panelMesh);

  // Static furniture (one merged mesh).
  const seatCloth = 0x3f4756;
  const staticParts: THREE.BufferGeometry[] = [
    tint(glareshield(), 0x161718, 0.9, 0),
    // Panel surround and lower edge.
    tint(box(PANEL.widthM + 0.02, 0.014, 0.05, 0, PANEL.centerY - PANEL.heightM / 2 - 0.007, PANEL.z + 0.005), 0x1f2022, 0.8, 0),
    tint(box(PANEL.widthM - 0.04, 0.16, 0.012, 0, PANEL.centerY - PANEL.heightM / 2 - 0.09, PANEL.z - 0.07, new THREE.Euler(0.5, 0, 0)), 0x232426, 0.9, 0),
    // Pedestal under the centre of the panel.
    tint(box(0.15, PANEL_BOTTOM_Y + 0.4, 0.2, 0, (PANEL_BOTTOM_Y - 0.4) / 2, PANEL.z - 0.02), 0x242527, 0.85, 0),
    // Floor / carpet.
    tint(box(0.98, 0.02, 2.4, 0, -0.41, 0.0), 0x3a3733, 1.0, 0),
    // Front seats: cushion + back + headrest-less C172 seat.
    ...[-0.28, 0.28].flatMap((x) => [
      tint(rbox(0.46, 0.12, 0.5, 0.04, x, -0.25, -0.32), seatCloth, 0.95, 0),
      tint(rbox(0.46, 0.66, 0.1, 0.04, x, 0.16, 0.12, new THREE.Euler(-0.2, 0, 0)), seatCloth, 0.95, 0),
      tint(box(0.04, 0.05, 0.4, x - 0.2, -0.33, -0.3), 0x6d6f72, 0.4, 0.8),
      tint(box(0.04, 0.05, 0.4, x + 0.2, -0.33, -0.3), 0x6d6f72, 0.4, 0.8),
    ]),
    // Rear bench.
    tint(rbox(0.92, 0.12, 0.46, 0.04, 0, -0.26, 0.72), seatCloth, 0.95, 0),
    tint(rbox(0.92, 0.6, 0.1, 0.04, 0, 0.12, 1.02, new THREE.Euler(-0.18, 0, 0)), seatCloth, 0.95, 0),
    // Door armrests and handles.
    ...[-1, 1].flatMap((s) => [
      tint(rbox(0.06, 0.05, 0.62, 0.015, s * 0.49, 0.12, -0.05), 0x5b554d, 0.8, 0),
      tint(box(0.02, 0.02, 0.1, s * 0.5, 0.2, 0.18), 0x9a9c9e, 0.35, 0.8),
    ]),
    // Wet compass hanging from the windshield frame.
    tint(rbox(0.08, 0.065, 0.07, 0.012, 0.0, 0.765, -0.6), 0x111213, 0.5, 0),
    tint(box(0.05, 0.03, 0.004, 0.0, 0.765, -0.563), 0xd8d4c0, 0.3, 0),
    tint(tube(V(0, 0.795, -0.6), V(0, 0.84, -0.62), 0.008, 8), 0x111213, 0.5, 0),
    // Prop (blue) and mixture (red) controls, pushed in.
    tint(tube(V(0.045, KNOB_Y, PANEL.z), V(0.045, KNOB_Y, PANEL.z + 0.03), 0.006), 0xc8cacc, 0.25, 0.9),
    tint(tube(V(0.045, KNOB_Y, PANEL.z + 0.03), V(0.045, KNOB_Y, PANEL.z + 0.055), 0.018, 16), 0x1e3f9a, 0.45, 0),
    tint(tube(V(0.11, KNOB_Y, PANEL.z), V(0.11, KNOB_Y, PANEL.z + 0.03), 0.006), 0xc8cacc, 0.25, 0.9),
    tint(tube(V(0.11, KNOB_Y, PANEL.z + 0.03), V(0.11, KNOB_Y, PANEL.z + 0.055), 0.018, 16), 0xb02020, 0.45, 0),
    // Yoke shaft collars in the panel.
    tint(tube(V(-0.28, YOKE_Y - 0.03, PANEL.z - 0.01), V(-0.28, YOKE_Y - 0.03, PANEL.z + 0.012), 0.03, 16), 0x1a1b1c, 0.6, 0.3),
    tint(tube(V(0.28, YOKE_Y - 0.03, PANEL.z - 0.01), V(0.28, YOKE_Y - 0.03, PANEL.z + 0.012), 0.03, 16), 0x1a1b1c, 0.6, 0.3),
    // Gear lever slot plate.
    tint(box(0.03, 0.1, 0.006, -0.09, GEAR_Y, PANEL.z + 0.004), 0x0d0d0e, 0.6, 0),
  ];
  const furniture = new THREE.Mesh(merge(staticParts), interiorParts);
  furniture.name = 'cabinFurniture';
  group.add(furniture);

  // Yokes.
  const yokeGeo = yokeGeometry();
  const yokes: THREE.Group[] = [];
  for (const x of [-0.28, 0.28]) {
    const g = new THREE.Group();
    g.position.set(x, YOKE_Y, PANEL.z + 0.23);
    g.add(new THREE.Mesh(x < 0 ? yokeGeo : yokeGeo.clone(), interiorParts));
    group.add(g);
    yokes.push(g);
  }

  // Rudder pedals: all "left" pedals move together, as do all "right" pedals.
  const pedalsL = new THREE.Group();
  pedalsL.add(new THREE.Mesh(merge([pedal(-0.37), pedal(0.19)]), interiorParts));
  const pedalsR = new THREE.Group();
  pedalsR.add(new THREE.Mesh(merge([pedal(-0.19), pedal(0.37)]), interiorParts));
  group.add(pedalsL, pedalsR);
  details.push(pedalsL, pedalsR);

  // Throttle (black knob on a chrome shaft).
  const throttle = new THREE.Group();
  throttle.position.set(-0.02, KNOB_Y, PANEL.z);
  throttle.add(
    new THREE.Mesh(
      merge([
        tint(tube(V(0, 0, -0.1), V(0, 0, 0.0), 0.006), 0xc8cacc, 0.25, 0.9),
        tint(tube(V(0, 0, 0.0), V(0, 0, 0.03), 0.022, 18), 0x121213, 0.5, 0),
      ]),
      interiorParts,
    ),
  );
  group.add(throttle);
  details.push(throttle);

  // Gear lever: a wheel-shaped knob on a short arm that pivots up/down.
  const gearLever = new THREE.Group();
  gearLever.position.set(-0.09, GEAR_Y, PANEL.z + 0.005);
  const knob = new THREE.CylinderGeometry(0.02, 0.02, 0.014, 18);
  knob.rotateX(Math.PI / 2);
  knob.translate(0, 0, 0.055);
  gearLever.add(
    new THREE.Mesh(
      merge([tint(tube(V(0, 0, 0), V(0, 0, 0.05), 0.005), 0xb0b2b4, 0.3, 0.9), tint(knob, 0xeeeeea, 0.4, 0)]),
      interiorParts,
    ),
  );
  group.add(gearLever);
  details.push(gearLever);

  // Gear position lights (green = down and locked, red = in transit).
  const lampGeo = (y: number) => {
    const g = new THREE.CylinderGeometry(0.009, 0.009, 0.008, 14);
    g.rotateX(Math.PI / 2);
    g.translate(-0.045, GEAR_Y + y, PANEL.z + 0.004);
    return g;
  };
  const greenMat = mats.gearLights;
  const redMat = mats.gearLights.clone();
  mats.all.push(redMat);
  const greenLamp = new THREE.Mesh(lampGeo(0.045), greenMat);
  const redLamp = new THREE.Mesh(lampGeo(0.015), redMat);
  group.add(greenLamp, redLamp);
  details.push(greenLamp, redLamp);

  // Flap lever with detents 0/10/20/30.
  const flapLever = new THREE.Group();
  flapLever.position.set(0.2, FLAP_Y, PANEL.z + 0.005);
  flapLever.add(
    new THREE.Mesh(
      merge([
        tint(tube(V(0, 0, 0), V(0, 0, 0.035), 0.004), 0xb0b2b4, 0.3, 0.9),
        tint(box(0.036, 0.012, 0.018, 0, 0, 0.04), 0xe6e6e0, 0.45, 0),
      ]),
      interiorParts,
    ),
  );
  group.add(flapLever);
  details.push(flapLever);

  // Elevator trim wheel on the pedestal.
  const trimWheel = new THREE.Group();
  trimWheel.position.set(0.08, -0.26, PANEL.z + 0.02);
  const tw = new THREE.CylinderGeometry(0.075, 0.075, 0.018, 28);
  tw.rotateZ(Math.PI / 2);
  const ribs: THREE.BufferGeometry[] = [tint(tw, 0x1a1a1b, 0.7, 0)];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    ribs.push(tint(box(0.022, 0.012, 0.012, 0, Math.cos(a) * 0.075, Math.sin(a) * 0.075), 0x2c2c2e, 0.7, 0));
  }
  trimWheel.add(new THREE.Mesh(merge(ribs), interiorParts));
  group.add(trimWheel);
  details.push(trimWheel);

  const dimColor = new THREE.Color(0x0f2a14);
  const litGreen = new THREE.Color(0x3cff5a);
  const dimRed = new THREE.Color(0x2a0c0a);
  const litRed = new THREE.Color(0xff3a26);

  return {
    group,
    details,
    panelMesh,
    update(anim, r, cockpit) {
      for (const y of yokes) {
        y.position.z = PANEL.z + 0.23 + anim.yokePull;
        y.rotation.z = -anim.yokeRollRad;
      }
      pedalsR.position.z = -anim.pedalRight;
      pedalsL.position.z = anim.pedalRight;
      trimWheel.rotation.x = 0;
      if (!cockpit) return;
      const thr = r ? Math.max(0, Math.min(100, r.throttlePct)) / 100 : 0;
      throttle.position.z = PANEL.z + 0.012 + (1 - thr) * 0.075;
      const gearUp = r ? r.gear === 'up' : false;
      gearLever.rotation.x = gearUp ? -0.45 : 0.45;
      const light = r ? r.gearLight : 'off';
      greenMat.color.copy(light === 'green' ? litGreen : dimColor);
      redMat.color.copy(light === 'red' ? litRed : dimRed);
      const flapT = r ? Math.max(0, Math.min(30, r.flapsTargetDeg)) : 0;
      flapLever.position.y = FLAP_Y - (flapT / 30) * 0.05;
      trimWheel.rotation.x = r ? (r.trimPct / 100) * Math.PI * 3 : 0;
    },
  };
}
