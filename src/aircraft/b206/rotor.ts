/**
 * The JetRanger's rotors: the two-blade teetering main rotor (mast, swashplate, yoke and trunnion,
 * blade grips with pitch horns and links, NACA 0012 blades with −10° twist and aluminium tip caps)
 * and the two-blade tail rotor on the left of the boom, each with a translucent blur disc.
 *
 * Main rotor frames (all origins at the hub):
 *   mastFrame (tilted 5° forward) → mast, swashplate, mast nut (static)
 *     tiltFrame (tip-path plane: flapping relative to the mast) → blur disc
 *       spin (azimuth about the tilted axis) → yoke, links
 *         blade holders (0, π) → feather (pitch about the span axis) → blade mesh (span along +x,
 *         leading edge toward −z: +rotation.y spins the rotor counter-clockwise seen from above)
 * Tail rotor: trFrame at the hub with local +y = body +x (the thrust axis), same layout.
 *
 * The blade meshes are bent on the CPU (`bendBlades`): droop at rest (tips at the structural
 * points' height), straight coning in flight, centrifugally stiffened in between.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge, tint } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { ROTOR, TAIL_ROTOR, DEG } from './shape';

const _c = new THREE.Color();

interface BladeSpec {
  radius: number;
  chord: number;
  root: number;
  thickness: number;
  twistRad: number;
  /** Stations (m from the hub); a repeated station is a crease/colour edge. */
  stations: number[];
  /** Colour (hex, roughness, metalness) of the skin between station k and k+1 (by the ring's radius). */
  colour: (r: number, band: number) => [number, number, number];
  /** Chord / thickness scale near the tip (rounded tip cap). */
  tipStart: number;
  n: number;
}

/** A blade in its own frame: span along +x, chord along z (LE at −z, quarter chord on the axis), twisted about x. */
function bladeLoft(s: BladeSpec): THREE.BufferGeometry {
  const rings: number[][] = [];
  const cols: Array<[number, number]> = [];
  let band = 0;
  for (let i = 0; i < s.stations.length; i++) {
    const r = s.stations[i];
    if (i > 0 && s.stations[i] === s.stations[i - 1]) band++;
    let chord = s.chord;
    let th = s.thickness;
    // Root: slightly thicker (doublers).
    const rootK = Math.max(0, 1 - (r - s.root) / (0.3 * s.radius));
    th *= 1 + 0.35 * rootK * rootK;
    if (r > s.tipStart) {
      const k = Math.min(1, (r - s.tipStart) / (s.radius - s.tipStart));
      chord *= Math.max(0.35, Math.sqrt(1 - k * k * 0.88));
      th *= 1 - 0.4 * k;
    }
    const twist = s.twistRad * (r / s.radius - 0.75);
    const sec = nacaRing({ m: 0, p: 0, t: th, n: s.n });
    const ring: number[] = [];
    const ct = Math.cos(twist);
    const st = Math.sin(twist);
    // Swept tip cap: the trailing part of the last stations slides aft a little.
    for (let k = 0; k < sec.length; k += 2) {
      const z0 = (sec[k] - 0.25) * chord;
      const y0 = sec[k + 1] * chord;
      ring.push(r, y0 * ct - z0 * st, y0 * st + z0 * ct);
    }
    rings.push(ring);
    cols.push([r, band]);
  }
  const g = loftGeometry(rings, { capStart: true, capEnd: true });
  const pos = g.getAttribute('position');
  const count = pos.count;
  const col = new Float32Array(count * 3);
  const rm = new Float32Array(count * 2);
  const perRing = rings[0].length / 3 + 1;
  for (let v = 0; v < count; v++) {
    const ri = Math.min(rings.length - 1, Math.floor(v / perRing));
    const [r, b] = v < rings.length * perRing ? cols[ri] : pos.getX(v) < s.radius * 0.5 ? cols[0] : cols[cols.length - 1];
    const [hex, rough, metal] = s.colour(r, b);
    _c.setHex(hex);
    col[v * 3] = _c.r;
    col[v * 3 + 1] = _c.g;
    col[v * 3 + 2] = _c.b;
    rm[v * 2] = rough;
    rm[v * 2 + 1] = metal;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  return g;
}

const R = ROTOR.radius;

/** One main-rotor blade with its grip and pitch horn (blade frame). */
export function mainBladeGeometry(): THREE.BufferGeometry {
  const tipStart = R - 0.12;
  const blade = bladeLoft({
    radius: R,
    chord: ROTOR.chord,
    root: ROTOR.bladeRoot,
    thickness: 0.12,
    twistRad: ROTOR.twist,
    stations: [ROTOR.bladeRoot, 0.66, 0.74, 0.86, 1.02, 1.3, 1.7, 2.2, 2.7, 3.2, 3.7, 4.2, 4.6, tipStart, tipStart, R - 0.07, R - 0.035, R - 0.012, R],
    tipStart,
    n: 13,
    // Dark grey painted blades, a bare aluminium root fitting and a stainless tip cap.
    colour: (r, b) => (b >= 1 ? [0xb9bcc0, 0.3, 0.85] : r < 0.75 ? [0x8d9296, 0.4, 0.7] : [0x2f3236, 0.5, 0.05]),
  });
  const c = ROTOR.chord;
  const parts = [
    // Grip: a steel housing round the blade's root, bolted to the yoke.
    tint(tube(V(0.17, 0, 0), V(0.5, 0, 0), 0.05, 0.045, 14), 0x7b8085, 0.4, 0.75),
    tint(box(0.16, 0.075, c * 0.6, V(0.56, 0, 0)), 0x70757a, 0.4, 0.7),
    // Blade bolt heads.
    tint(tube(V(0.58, 0.05, -0.03), V(0.58, -0.05, -0.03), 0.018, 0.018, 8), 0x55595e, 0.4, 0.8),
    tint(tube(V(0.58, 0.05, 0.05), V(0.58, -0.05, 0.05), 0.018, 0.018, 8), 0x55595e, 0.4, 0.8),
    // Pitch horn (toward the trailing edge) and its rod end.
    tint(box(0.04, 0.03, 0.12, V(0.22, -0.02, 0.08)), 0x6b7075, 0.4, 0.7),
    tint(ellipsoid(V(0.22, -0.03, 0.14), 0.02, 0.02, 0.02, 8, 6), 0x55595e, 0.4, 0.8),
  ];
  return merge([blade, ...parts]);
}

/** One tail-rotor blade (blade frame), red/white/red tip bands. */
export function tailBladeGeometry(): THREE.BufferGeometry {
  const r = TAIL_ROTOR.radius;
  const bands = [0.63 * r, 0.72 * r, 0.8 * r];
  const blade = bladeLoft({
    radius: r,
    chord: TAIL_ROTOR.chord,
    root: TAIL_ROTOR.bladeRoot,
    thickness: 0.11,
    twistRad: 0,
    stations: [TAIL_ROTOR.bladeRoot, 0.2, 0.3, 0.42, bands[0], bands[0], bands[1], bands[1], bands[2], bands[2], r - 0.02, r - 0.006, r],
    tipStart: r - 0.03,
    n: 9,
    colour: (_r, b) => (b === 1 || b === 3 ? [0xc0231c, 0.45, 0] : b === 2 ? [0xeeeeea, 0.45, 0] : [0xb3b6b9, 0.4, 0.6]),
  });
  const parts = [
    tint(tube(V(0.04, 0, 0), V(TAIL_ROTOR.bladeRoot + 0.01, 0, 0), 0.022, 0.02, 10), 0x7b8085, 0.4, 0.75),
    tint(box(0.03, 0.02, 0.06, V(0.07, -0.01, 0.04)), 0x6b7075, 0.4, 0.7),
  ];
  return merge([blade, ...parts]);
}

/** Main rotor static parts in the mast frame (y along the mast, origin at the hub). */
function mastGeometry(): THREE.BufferGeometry {
  const top = ROTOR.mastTop;
  return merge([
    // Mast from inside the transmission fairing up through the trunnion.
    tint(tube(V(0, -0.46, 0), V(0, 0.07, 0), 0.052, 0.05, 16), 0x8a8f94, 0.35, 0.8),
    // Mast nut (the top of the machine).
    tint(tube(V(0, 0.06, 0), V(0, top - 0.02, 0), 0.047, 0.043, 12), 0x5f6468, 0.4, 0.75),
    tint(ellipsoid(V(0, top - 0.02, 0), 0.043, 0.02, 0.043, 12, 6), 0x5f6468, 0.4, 0.75),
    // Rubber boot where the mast leaves the fairing.
    tint(tube(V(0, -0.36, 0), V(0, -0.25, 0), 0.14, 0.065, 18), 0x17181a, 0.85, 0),
    // Swashplate: stationary ring below, rotating ring above, the collective sleeve.
    tint(tube(V(0, -0.225, 0), V(0, -0.19, 0), 0.17, 0.17, 24), 0x7d8287, 0.4, 0.7),
    tint(tube(V(0, -0.19, 0), V(0, -0.16, 0), 0.155, 0.15, 24), 0x5d6166, 0.4, 0.75),
    tint(tube(V(0, -0.25, 0), V(0, -0.14, 0), 0.075, 0.075, 14), 0x8a8f94, 0.35, 0.8),
    // Swashplate drive (scissors) link.
    tint(box(0.03, 0.12, 0.025, V(0.1, -0.1, -0.02), 0, 0, 0.5), 0x55595e, 0.5, 0.7),
  ]);
}

/** Main rotor hub parts that spin (yoke, trunnion, teeter pin, pitch links). */
function hubGeometry(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [
    // Yoke (flexure plates), trunnion block and the teeter pin across it.
    tint(box(0.42, 0.06, 0.15, V(0, 0, 0)), 0x6b7075, 0.4, 0.75),
    tint(box(0.16, 0.13, 0.17, V(0, 0.005, 0)), 0x5a5f64, 0.45, 0.75),
    tint(tube(V(0, 0.01, -0.13), V(0, 0.01, 0.13), 0.025, 0.025, 10), 0x9a9ea2, 0.3, 0.9),
    // Droop-stop / flapping-stop blocks.
    tint(box(0.05, 0.04, 0.06, V(0.1, -0.06, 0)), 0x3c3f43, 0.6, 0.4),
    tint(box(0.05, 0.04, 0.06, V(-0.1, -0.06, 0)), 0x3c3f43, 0.6, 0.4),
  ];
  // Pitch links from the rotating swashplate up to the horns.
  for (const s of [1, -1]) {
    g.push(tint(tube(V(0.155 * s, -0.17, 0.12 * s), V(0.22 * s, -0.035, 0.14 * s), 0.012, 0.012, 8), 0xa4a8ac, 0.35, 0.85));
  }
  return merge(g);
}

function tailHubGeometry(): THREE.BufferGeometry {
  return merge([
    tint(box(0.1, 0.035, 0.06, V(0, 0, 0)), 0x6b7075, 0.4, 0.75),
    tint(tube(V(0, -0.04, 0), V(0, 0.05, 0), 0.03, 0.022, 12), 0x7b8085, 0.4, 0.75),
    tint(ellipsoid(V(0, 0.055, 0), 0.022, 0.012, 0.022, 10, 6), 0x7b8085, 0.4, 0.75),
    // Pitch-change links to the crosshead.
    tint(tube(V(0.02, -0.03, 0.03), V(0.07, -0.01, 0.04), 0.006, 0.006, 6), 0xa4a8ac, 0.35, 0.85),
    tint(tube(V(-0.02, -0.03, -0.03), V(-0.07, -0.01, -0.04), 0.006, 0.006, 6), 0xa4a8ac, 0.35, 0.85),
  ]);
}

/** A flat annulus in the xz plane (the blur disc), coned: y = slope · r. */
function discGeometry(inner: number, outer: number, segs: number, slope: number): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(inner, outer, segs, 3);
  g.rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) p.setY(i, Math.hypot(p.getX(i), p.getZ(i)) * slope);
  g.computeVertexNormals();
  return g;
}

export interface BladeRig {
  holder: THREE.Group;
  feather: THREE.Group;
  mesh: THREE.Mesh;
}

export interface MainRotorRig {
  /** Break-up container (identity). */
  group: THREE.Group;
  mastFrame: THREE.Group;
  mast: THREE.Mesh;
  tiltFrame: THREE.Group;
  spin: THREE.Group;
  hub: THREE.Mesh;
  blades: BladeRig[];
  disc: THREE.Mesh;
  /** The intact blade geometry (bent in place) and its unbent positions. */
  bladeGeo: THREE.BufferGeometry;
  bladeBase: Float32Array;
}

export interface TailRotorRig {
  group: THREE.Group;
  /** Wreck bend (the tail boom's skew) is applied here. */
  bend: THREE.Group;
  frame: THREE.Group;
  spin: THREE.Group;
  hub: THREE.Mesh;
  blades: BladeRig[];
  disc: THREE.Mesh;
  bladeGeo: THREE.BufferGeometry;
}

export const ROTOR_PART = {
  mainRotor: 'b206.mainRotor',
  mastFrame: 'b206.mainRotor.mast',
  tiltFrame: 'b206.mainRotor.tpp',
  spin: 'b206.mainRotor.spin',
  blade0: 'b206.mainRotor.blade0',
  blade1: 'b206.mainRotor.blade1',
  feather0: 'b206.mainRotor.feather0',
  feather1: 'b206.mainRotor.feather1',
  disc: 'b206.mainRotor.disc',
  tailRotor: 'b206.tailRotor',
  tailSpin: 'b206.tailRotor.spin',
  tailBlade0: 'b206.tailRotor.blade0',
  tailBlade1: 'b206.tailRotor.blade1',
  tailFeather0: 'b206.tailRotor.feather0',
  tailFeather1: 'b206.tailRotor.feather1',
  tailDisc: 'b206.tailRotor.disc',
} as const;

function named<T extends THREE.Object3D>(o: T, name: string, parent?: THREE.Object3D): T {
  o.name = name;
  parent?.add(o);
  return o;
}

function bladePair(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, names: [string, string, string, string]): BladeRig[] {
  return [0, 1].map((k) => {
    const holder = named(new THREE.Group(), `${names[k]}.holder`, parent);
    holder.rotation.y = k * Math.PI;
    const feather = named(new THREE.Group(), names[2 + k], holder);
    const mesh = named(new THREE.Mesh(geo, mat), names[k], feather);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return { holder, feather, mesh };
  });
}

export function buildMainRotor(mats: { parts: THREE.Material; blades: THREE.Material; disc: THREE.Material }): MainRotorRig {
  const group = named(new THREE.Group(), ROTOR_PART.mainRotor);
  const mastFrame = named(new THREE.Group(), ROTOR_PART.mastFrame, group);
  mastFrame.position.set(ROTOR.hub.x, ROTOR.hub.y, ROTOR.hub.z);
  mastFrame.rotation.x = -ROTOR.mastTilt;
  const mast = named(new THREE.Mesh(mastGeometry(), mats.parts), 'b206.mainRotor.mastParts', mastFrame);
  mast.castShadow = true;
  const tiltFrame = named(new THREE.Group(), ROTOR_PART.tiltFrame, mastFrame);
  const spin = named(new THREE.Group(), ROTOR_PART.spin, tiltFrame);
  const hub = named(new THREE.Mesh(hubGeometry(), mats.parts), 'b206.mainRotor.hub', spin);
  hub.castShadow = true;
  const bladeGeo = mainBladeGeometry();
  const bladeBase = new Float32Array(bladeGeo.getAttribute('position').array as Float32Array);
  // The bend moves the tips by up to ~0.5 m: a generous bounding sphere once, no per-frame recompute.
  bladeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(R / 2, 0, 0), R / 2 + 0.8);
  const blades = bladePair(bladeGeo, mats.blades, spin, [ROTOR_PART.blade0, ROTOR_PART.blade1, ROTOR_PART.feather0, ROTOR_PART.feather1]);
  const disc = named(new THREE.Mesh(discGeometry(ROTOR.bladeRoot, R, 128, Math.tan(ROTOR.precone)), mats.disc), ROTOR_PART.disc, tiltFrame);
  disc.renderOrder = 2;
  disc.visible = false;
  // The disc shows how the rotor looks; the crash director measures parts by their meshes (the blades).
  disc.userData.noBounds = true;
  return { group, mastFrame, mast, tiltFrame, spin, hub, blades, disc, bladeGeo, bladeBase };
}

export function buildTailRotor(mats: { parts: THREE.Material; blades: THREE.Material; disc: THREE.Material }): TailRotorRig {
  const group = named(new THREE.Group(), ROTOR_PART.tailRotor);
  const bend = named(new THREE.Group(), 'b206.tailRotor.bend', group);
  const frame = named(new THREE.Group(), 'b206.tailRotor.frame', bend);
  const h = TAIL_ROTOR.hub;
  frame.position.set(h.x, h.y, h.z);
  // Local +y = the thrust axis (body +x, toward the fin): rotate +y onto the configured axis.
  const ax = new THREE.Vector3(TAIL_ROTOR.axis.x, TAIL_ROTOR.axis.y, TAIL_ROTOR.axis.z).normalize();
  frame.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ax);
  const spin = named(new THREE.Group(), ROTOR_PART.tailSpin, frame);
  const hub = named(new THREE.Mesh(tailHubGeometry(), mats.parts), 'b206.tailRotor.hub', spin);
  const bladeGeo = tailBladeGeometry();
  const blades = bladePair(bladeGeo, mats.blades, spin, [ROTOR_PART.tailBlade0, ROTOR_PART.tailBlade1, ROTOR_PART.tailFeather0, ROTOR_PART.tailFeather1]);
  const disc = named(new THREE.Mesh(discGeometry(TAIL_ROTOR.bladeRoot, TAIL_ROTOR.radius, 64, 0), mats.disc), ROTOR_PART.tailDisc, frame);
  disc.renderOrder = 2;
  disc.visible = false;
  disc.userData.noBounds = true;
  return { group, bend, frame, spin, hub, blades, disc, bladeGeo };
}

/**
 * Bend the (shared) main-blade geometry: y += slope·r + droop·(r/R)² (blade frame, r = x). The
 * grips (r < the blade root) stay straight.
 */
export function bendBlades(geo: THREE.BufferGeometry, base: Float32Array, slope: number, droop: number): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const a = p.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) {
    const r = base[i];
    const rr = Math.max(0, r - 0.2);
    a[i] = r;
    a[i + 1] = base[i + 1] + slope * rr + droop * (rr / (R - 0.2)) * (rr / (R - 0.2));
    a[i + 2] = base[i + 2];
  }
  p.needsUpdate = true;
}

export { DEG };
