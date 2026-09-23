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
import { PANEL, PANEL_BOTTOM_Y, PANEL_LAYOUT as PL } from './panel';
import { fuselageSection, monotoneCurve, type SectionParams } from './shape';
import { WELL, sectionHalfWidthAt } from './gearKinematics';
import { compass, doorPanels, fuelSelector, headliner, seat, sunVisors, visorHinges } from './interior';

export interface CockpitRig {
  group: THREE.Group;
  /** Meshes only worth drawing from the pilot's seat. */
  details: THREE.Object3D[];
  panelMesh: THREE.Mesh;
  update(anim: AircraftAnimation, r: InstrumentReadings | null, cockpit: boolean): void;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** Yoke shaft height (both yokes) and how far aft of the panel face the yoke wheel sits at neutral. */
export const YOKE_Y = PL.yokeShafts[0].y;
export const YOKE_AFT = 0.24;
/** Gear handle knob height with the handle up / down. */
export const GEAR_HANDLE_UP_Y = PL.gearHandle.top - 0.008;
export const GEAR_HANDLE_DOWN_Y = PL.gearHandle.bottom + 0.008;

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

/** Front seats: cushion top, seat-back placement and recline (+ = top leans aft). */
export const COCKPIT = {
  seatX: 0.3,
  cushionY: -0.25,
  cushionTopY: -0.19,
  cushionZ: -0.32,
  backY: 0.16,
  backZ: 0.12,
  backHeight: 0.66,
  backDepth: 0.1,
  reclineRad: 0.2,
  /** z of the seat back's front face at height y. */
  seatBackFrontZ(y: number): number {
    const a = COCKPIT.reclineRad;
    const ly = (y - COCKPIT.backY + (COCKPIT.backDepth / 2) * Math.sin(a)) / Math.cos(a);
    return COCKPIT.backZ + ly * Math.sin(a) - (COCKPIT.backDepth / 2) * Math.cos(a);
  },
};

const _sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
/** Height of the cabin's inner upper surface above (x, z). */
function innerTopY(x: number, z: number, inset: number): number {
  fuselageSection(z, _sec);
  const W = _sec.halfWidth - inset;
  const r = Math.min(0.999, Math.abs(x) / W);
  return _sec.widthY + (_sec.top - inset - _sec.widthY) * Math.pow(1 - Math.pow(r, _sec.nTop), 1 / _sec.nTop);
}

/** The padded glareshield overhangs the panel face by LIP_OVERHANG; its top edge is at LIP_Y. */
export const LIP_OVERHANG = 0.022;
const LIP_Z = PANEL.z + LIP_OVERHANG;
export const LIP_Y = PANEL.topY + 0.016;
const glareProfile = monotoneCurve([
  [-1.25, 0.245],
  [-1.14, 0.318],
  [-1.0, 0.39],
  [-0.86, LIP_Y - 0.022],
  [-0.76, LIP_Y - 0.006],
  [LIP_Z, LIP_Y],
]);

/** Top of the glareshield at (x, z): the padded shroud from the panel lip down to the windshield base. */
export function glareshieldTopY(x: number, z: number): number {
  return Math.min(glareProfile(z) - 0.012 * (x / 0.5) ** 2, innerTopY(x, z, 0.047));
}

/**
 * Glareshield: padded shroud from the panel lip down to the windshield base,
 * kept under the pilot's sightline to the cowling (eye → windshield base).
 */
function glareshield(): THREE.BufferGeometry {
  const rings: number[][] = [];
  const nx = 24;
  const lipZ = LIP_Z;
  const zs = [-1.24, -1.15, -1.05, -0.95, -0.85, -0.78, lipZ - 0.012, lipZ - 0.004, lipZ, lipZ + 0.002, lipZ, lipZ - 0.008, PANEL.z];
  const drops = [0, 0, 0, 0, 0, 0, 0, 0.004, 0.012, 0.022, 0.03, 0.032, 0.032];
  zs.forEach((z, i) => {
    const ring: number[] = [];
    for (let j = 0; j <= nx; j++) {
      const x = -0.5 + (j / nx) * 1.0;
      ring.push(x, glareshieldTopY(x, z) - drops[i], z);
    }
    rings.push(ring);
  });
  return loftGeometry(rings, { closed: false });
}

/** Flat carpet strip between x0(z) and x1(z) at height y, facing up. */
function strip(z0: number, z1: number, x0: (z: number) => number, x1: (z: number) => number, y: number, n = 12): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n;
    pos.push(x0(z), y, z, x1(z), y, z);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Cabin floor at y = −0.41, kept clear of the gear wells: two footwell strips beside
 * the nose-well hump, then the full width up to the front seats (the main-gear leg
 * slots run under the rear seats, where the shell's own carpet shows).
 */
function floor(): THREE.BufferGeometry[] {
  const y = -0.41;
  const edge = (z: number) => sectionHalfWidthAt(y, z) - 0.045;
  const nose = WELL.nose.halfWidth + 0.012;
  const zMid = WELL.nose.z1 + 0.012;
  const carpet = 0x3a3733;
  return [
    tint(strip(-1.2, zMid, (z) => -edge(z), () => -nose, y), carpet, 1, 0),
    tint(strip(-1.2, zMid, () => nose, (z) => edge(z), y), carpet, 1, 0),
    tint(strip(zMid, 0.1, (z) => -edge(z), (z) => edge(z), y), carpet, 1, 0),
  ];
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

/** Cylinder along z (a knob or bezel facing the pilot). */
function cylZ(r: number, len: number, x: number, y: number, z: number, segs = 16): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, segs);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
}
/** Fluted push-pull knob (prop / mixture): a crenellated disc on the end of its shaft. */
function flutedKnob(x: number, y: number, z: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const n = 12;
  for (let i = 0; i <= n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 0.016 : 0.0135;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.0015, bevelSegments: 1 });
  g.translate(x, y, z);
  return g;
}
/** Rocker switch paddles over the painted switch row (split master red, the rest black). */
function rockers(): THREE.BufferGeometry[] {
  const sw = PL.switches;
  const n = 9;
  const sp = sw.w / n;
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const x = sw.x + i * sp + sp / 2;
    out.push(tint(rbox(sp * 0.7, sw.h * 0.46, 0.008, 0.002, x, sw.y - sw.h * 0.26, PANEL.z + 0.004, new THREE.Euler(-0.18, 0, 0)), i < 2 ? 0xa51c1c : 0x19191a, 0.5, 0));
  }
  return out;
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

  // Static furniture seen from outside too (one merged mesh): glareshield, panel trim, pedestal,
  // floor, seats, door trim.
  const seatCloth = 0x3f4756;
  const panelBottom = PANEL_BOTTOM_Y;
  const staticParts: THREE.BufferGeometry[] = [
    tint(glareshield(), 0x1b1c1e, 0.95, 0),
    // Padded roll along the glareshield lip.
    tint(tube(V(-0.49, LIP_Y - 0.01, LIP_Z + 0.004), V(0.49, LIP_Y - 0.01, LIP_Z + 0.004), 0.01, 12), 0x202123, 0.9, 0),
    // Panel bottom edge trim and the angled lower skirt under it.
    tint(box(PANEL.widthM + 0.01, 0.012, 0.03, 0, panelBottom - 0.004, PANEL.z + 0.008), 0x1d1e20, 0.8, 0),
    tint(box(PANEL.widthM - 0.06, 0.13, 0.012, 0, panelBottom - 0.07, PANEL.z - 0.06, new THREE.Euler(0.55, 0, 0)), 0x222325, 0.9, 0),
    // Pedestal under the centre of the panel (standing on the nose-well roof).
    tint(box(0.14, panelBottom - WELL.nose.roofY, 0.18, 0.02, (panelBottom + WELL.nose.roofY) / 2, PANEL.z - 0.03), 0x242527, 0.85, 0),
    // Floor / carpet: footwells either side of the nose-well hump, then full width to the front seats.
    ...floor(),
    // Front seats: pleated fabric inserts in vinyl frames, belts; rails under the cushions.
    ...[-1, 1].flatMap((side) => {
      const x = side * COCKPIT.seatX;
      return [
        ...seat({ x, cushionY: COCKPIT.cushionY, cushionZ: COCKPIT.cushionZ, backY: COCKPIT.backY, backZ: COCKPIT.backZ, backHeight: COCKPIT.backHeight, reclineRad: COCKPIT.reclineRad, outboard: side as -1 | 1 }),
        tint(box(0.03, 0.05, 0.4, x - 0.16, -0.33, -0.3), 0x6d6f72, 0.4, 0.8),
        tint(box(0.03, 0.05, 0.4, x + 0.16, -0.33, -0.3), 0x6d6f72, 0.4, 0.8),
      ];
    }),
    // Rear bench (sits above the main gear leg slots).
    tint(rbox(0.9, 0.12, 0.46, 0.04, 0, -0.19, 0.72), seatCloth, 0.95, 0),
    tint(rbox(0.9, 0.58, 0.1, 0.04, 0, 0.16, 1.02, new THREE.Euler(0.18, 0, 0)), seatCloth, 0.95, 0),
    // Door trim panels with armrests and handles.
    ...doorPanels(),
    // Wet compass on the windshield's top frame.
    ...compass(),
  ];
  const furniture = new THREE.Mesh(merge(staticParts), interiorParts);
  furniture.name = 'cabinFurniture';
  group.add(furniture);

  // Cockpit-only static detail (one merged mesh, drawn only from the seat): fuel selector,
  // headliner furniture, visor hinges, knob shafts, yoke collars, gear-handle slot, magneto key,
  // rocker switch paddles, breaker buttons.
  const knobShaft = (p: { x: number; y: number }) => tint(tube(V(p.x, p.y, PANEL.z - 0.01), V(p.x, p.y, PANEL.z + 0.012), 0.004), 0xc8cacc, 0.25, 0.9);
  const detailParts: THREE.BufferGeometry[] = [
    ...fuelSelector(),
    ...headliner(),
    ...visorHinges(),
    knobShaft(PL.prop),
    knobShaft(PL.mixture),
    // Prop (blue, fluted) and mixture (red, fluted) knobs, pushed in.
    tint(flutedKnob(PL.prop.x, PL.prop.y, PANEL.z + 0.012), 0x1f3f93, 0.5, 0),
    tint(flutedKnob(PL.mixture.x, PL.mixture.y, PANEL.z + 0.012), 0xa81c1c, 0.5, 0),
    // Yoke shaft collars (rubber boots) in the panel.
    ...PL.yokeShafts.map((p) => tint(tube(V(p.x, p.y, PANEL.z - 0.005), V(p.x, p.y, PANEL.z + 0.018), 0.025, 18), 0x151516, 0.85, 0)),
    // Gear handle slot plate and the light bezels.
    tint(box(0.022, PL.gearHandle.top - PL.gearHandle.bottom + 0.022, 0.004, PL.gearHandle.x, (PL.gearHandle.top + PL.gearHandle.bottom) / 2, PANEL.z + 0.002), 0x0b0b0c, 0.6, 0.2),
    ...[PL.gearLightUp, PL.gearLightDown].map((p) => {
      const g = new THREE.CylinderGeometry(0.0095, 0.0105, 0.008, 16);
      g.rotateX(Math.PI / 2);
      g.translate(p.x, p.y, PANEL.z + 0.004);
      return tint(g, 0x2a2b2d, 0.35, 0.8);
    }),
    // Flap lever slot plate.
    tint(box(0.016, PL.flapLever.top - PL.flapLever.bottom + 0.016, 0.004, PL.flapLever.x, (PL.flapLever.top + PL.flapLever.bottom) / 2, PANEL.z + 0.002), 0x0b0b0c, 0.6, 0.2),
    // Magneto/start key switch: chrome bezel and the key.
    tint(cylZ(0.013, 0.006, PL.magneto.x, PL.magneto.y, PANEL.z + 0.003, 20), 0xb9bbbd, 0.3, 0.9),
    tint(box(0.006, 0.02, 0.014, PL.magneto.x, PL.magneto.y + 0.004, PANEL.z + 0.012, new THREE.Euler(0, 0, 0.9)), 0x9a9c9e, 0.3, 0.9),
    tint(rbox(0.016, 0.012, 0.004, 0.002, PL.magneto.x + 0.01, PL.magneto.y + 0.012, PANEL.z + 0.02, new THREE.Euler(0, 0, 0.9)), 0x1a1a1a, 0.6, 0),
    // Rocker switch paddles (raised a few mm off the painted row).
    ...rockers(),
    // Primer and cabin heat/air knobs.
    tint(cylZ(0.007, 0.018, PL.magneto.x + 0.045, PL.magneto.y, PANEL.z + 0.009, 14), 0xb8babc, 0.3, 0.9),
    ...[0, 1].map((i) => tint(cylZ(0.0085, 0.014, PL.rightUpper.x + 0.045 + i * 0.08, PL.rightUpper.y - 0.13, PANEL.z + 0.007, 16), 0x19191a, 0.6, 0)),
  ];
  const detail = new THREE.Mesh(merge(detailParts), interiorParts);
  detail.name = 'cockpitDetail';
  group.add(detail);
  details.push(detail);

  // Sun visors: smoky tinted plastic (only worth drawing from the seat).
  const visorMat = new THREE.MeshPhysicalMaterial({
    color: 0x2a2622,
    roughness: 0.18,
    metalness: 0,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    side: THREE.DoubleSide,
    name: 'ac.visor',
  });
  mats.all.push(visorMat);
  const visors = new THREE.Mesh(sunVisors(), visorMat);
  visors.name = 'sunVisors';
  visors.renderOrder = 2;
  group.add(visors);
  details.push(visors);

  // Yokes: the shaft slides in and out of the panel, the wheel turns about it.
  const yokeGeo = yokeGeometry();
  const yokes: THREE.Group[] = [];
  for (const p of PL.yokeShafts) {
    const g = new THREE.Group();
    g.name = p.x < 0 ? 'yoke.left' : 'yoke.right';
    g.position.set(p.x, p.y, PANEL.z + YOKE_AFT);
    g.add(new THREE.Mesh(p.x < 0 ? yokeGeo : yokeGeo.clone(), interiorParts));
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

  // Throttle: a big black knob on a chrome shaft that slides out toward idle.
  const throttle = new THREE.Group();
  throttle.name = 'throttle';
  throttle.position.set(PL.throttle.x, PL.throttle.y, PANEL.z);
  const tk = new THREE.SphereGeometry(0.019, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  tk.scale(1, 1, 0.9);
  tk.rotateX(Math.PI / 2);
  tk.translate(0, 0, 0.034);
  throttle.add(
    new THREE.Mesh(
      merge([
        tint(tube(V(0, 0, -0.1), V(0, 0, 0.018), 0.0045), 0xc8cacc, 0.25, 0.9),
        tint(tube(V(0, 0, 0.012), V(0, 0, 0.034), 0.019, 20), 0x121213, 0.5, 0),
        tint(tk, 0x121213, 0.45, 0),
      ]),
      interiorParts,
    ),
  );
  group.add(throttle);
  details.push(throttle);

  // Gear handle: a short chrome arm with the little wheel-shaped knob; it sits at the top of its
  // slot for UP and at the bottom for DOWN.
  const gearLever = new THREE.Group();
  gearLever.name = 'gearHandle';
  gearLever.position.set(PL.gearHandle.x, GEAR_HANDLE_DOWN_Y, PANEL.z);
  const tyre = new THREE.TorusGeometry(0.0115, 0.0055, 10, 20);
  tyre.rotateY(Math.PI / 2);
  tyre.translate(0, 0, 0.05);
  const hubG = new THREE.CylinderGeometry(0.009, 0.009, 0.009, 16);
  hubG.rotateZ(Math.PI / 2);
  hubG.translate(0, 0, 0.05);
  gearLever.add(
    new THREE.Mesh(
      merge([
        tint(tube(V(0, 0, 0), V(0, 0, 0.046), 0.004), 0xb8babc, 0.3, 0.9),
        tint(tyre, 0xf0efe8, 0.5, 0),
        tint(hubG, 0x9c9ea0, 0.3, 0.8),
      ]),
      interiorParts,
    ),
  );
  group.add(gearLever);
  details.push(gearLever);

  // Gear position lights: amber GEAR UP (above), green GEAR DOWN (below).
  const lampGeo = (p: { x: number; y: number }) => {
    const g = new THREE.SphereGeometry(0.0072, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    g.rotateX(Math.PI / 2);
    g.translate(p.x, p.y, PANEL.z + 0.007);
    return g;
  };
  const greenMat = mats.gearLights;
  const redMat = mats.gearLights.clone();
  redMat.name = 'ac.gearLightUp';
  mats.all.push(redMat);
  const greenLamp = new THREE.Mesh(lampGeo(PL.gearLightDown), greenMat);
  greenLamp.name = 'gearLight.down';
  const redLamp = new THREE.Mesh(lampGeo(PL.gearLightUp), redMat);
  redLamp.name = 'gearLight.up';
  group.add(greenLamp, redLamp);
  details.push(greenLamp, redLamp);

  // Flap lever: a small white flap-shaped paddle on a chrome stem, riding down its slot with the selection.
  const flapLever = new THREE.Group();
  flapLever.name = 'flapLever';
  flapLever.position.set(PL.flapLever.x, PL.flapLever.top - 0.006, PANEL.z);
  flapLever.add(
    new THREE.Mesh(
      merge([
        tint(tube(V(0, 0, 0), V(0, 0, 0.032), 0.0035), 0xb0b2b4, 0.3, 0.9),
        tint(rbox(0.03, 0.01, 0.018, 0.003, 0, 0, 0.038), 0xe6e4dc, 0.45, 0),
      ]),
      interiorParts,
    ),
  );
  group.add(flapLever);
  details.push(flapLever);

  // Elevator trim wheel on the pedestal.
  const trimWheel = new THREE.Group();
  trimWheel.name = 'trimWheel';
  trimWheel.position.set(0.02, panelBottom - 0.16, PANEL.z + 0.07);
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
  const dimAmber = new THREE.Color(0x2a1a06);
  const litAmber = new THREE.Color(0xffa020);

  let handleDown = true;
  let lastRetract = 0;
  return {
    group,
    details,
    panelMesh,
    update(anim, r, cockpit) {
      for (const y of yokes) {
        y.position.z = PANEL.z + YOKE_AFT + anim.yokePull;
        y.rotation.z = -anim.yokeRollRad;
      }
      pedalsR.position.z = -anim.pedalRight;
      pedalsL.position.z = anim.pedalRight;
      // The gear handle follows the selection: settled states say it directly, in transit the
      // way the legs are moving does.
      const retract = Number.isFinite(anim.mainGearRetract) ? anim.mainGearRetract : 0;
      if (r && r.gear === 'down') handleDown = true;
      else if (r && r.gear === 'up') handleDown = false;
      else if (retract > lastRetract + 1e-6) handleDown = false;
      else if (retract < lastRetract - 1e-6) handleDown = true;
      lastRetract = retract;
      if (!cockpit) return;
      const thr = r ? clamp01(r.throttlePct / 100) : 0;
      throttle.position.z = PANEL.z + (1 - thr) * 0.07;
      gearLever.position.y = handleDown ? GEAR_HANDLE_DOWN_Y : GEAR_HANDLE_UP_Y;
      const light = r ? r.gearLight : 'off';
      greenMat.color.copy(light === 'green' ? litGreen : dimColor);
      redMat.color.copy(r && r.gear === 'up' ? litAmber : dimAmber);
      const flapT = r ? clamp01(r.flapsTargetDeg / 30) : 0;
      flapLever.position.y = PL.flapLever.top - 0.006 - flapT * (PL.flapLever.top - PL.flapLever.bottom - 0.012);
      trimWheel.rotation.x = r && Number.isFinite(r.trimPct) ? (r.trimPct / 100) * Math.PI * 3 : 0;
    },
  };
}

const clamp01 = (x: number) => (Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0);
