/**
 * F-16 fuselage geometry: the blended body with its strakes and aft booms (one loft with atlas
 * UVs), the ogive radome, and the ventral intake (outer cowl in the paint atlas; lip and duct with
 * vertex colours: white inside the lip, dark deep in the duct).
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { cowlUV, fuselageUV, SWATCH } from './atlas';
import { EDGE_INDEX, FUSE_END_Z, HALF_POINTS, INTAKE, RADOME, SHOULDER_INDEX, fuselageRing, fuselageStations, ogive, sampleHalf, fuselageControl } from './shape';

/** Per-station outline data for the livery painter. */
export interface FuselageStationInfo {
  z: number;
  /** Arc length (m) from the top centreline to the widest point (strake/boom edge) on one side. */
  sEdge: number;
  /** Arc length from the top centreline to the bottom centreline (half perimeter). */
  sHalf: number;
  /** Arc length where the side turns from facing up to facing sideways (the shoulder, P2). */
  sShoulder: number;
  /** Half ring points with their arc length: [x, y, s]. */
  half: [number, number, number][];
}

export interface FuselageBuild {
  skin: THREE.BufferGeometry;
  radome: THREE.BufferGeometry;
  /** Intake lip + duct interior (vertex coloured, `parts` material). */
  duct: THREE.BufferGeometry;
  stations: FuselageStationInfo[];
}


/** Arc lengths along a sampled half ring from the top centre. */
function halfWithArc(half: [number, number][]): [number, number, number][] {
  // half runs top → bottom.
  const out: [number, number, number][] = [];
  let s = 0;
  for (let k = 0; k < half.length; k++) {
    if (k > 0) s += Math.hypot(half[k][0] - half[k - 1][0], half[k][1] - half[k - 1][1]);
    out.push([half[k][0], half[k][1], s]);
  }
  return out;
}

/** Main fuselage loft (radome joint → nozzle base) with atlas UVs from (z, arc length). */
function buildBody(stations: number[], info: FuselageStationInfo[]): THREE.BufferGeometry {
  const rings = stations.map((z) => fuselageRing(z));
  const geo = loftGeometry(rings, { closed: true, capEnd: true });
  const H = HALF_POINTS;
  const N = 2 * H - 2;
  const cols = N + 1;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < stations.length; i++) {
    const z = stations[i];
    const half = halfWithArc(sampleHalf(fuselageControl(z)));
    const sHalf = half[H - 1][2];
    info.push({ z, sEdge: half[EDGE_INDEX][2], sHalf, sShoulder: half[SHOULDER_INDEX][2], half });
    for (let j = 0; j < cols; j++) {
      // Ring index r: 0 = bottom centre, H-1 = top centre, then down the left side; j = N is the seam.
      let s: number;
      if (j <= H - 1) s = half[H - 1 - j][2];
      else if (j < N) s = -half[j - (H - 1)][2];
      else s = -sHalf;
      fuselageUV(z, s, tmp);
      uv.setXY(i * cols + j, tmp[0], tmp[1]);
    }
  }
  // The end cap (hidden behind the nozzle and speed brakes).
  for (let k = stations.length * cols; k < uv.count; k++) uv.setXY(k, SWATCH.mid[0], SWATCH.mid[1]);
  return geo;
}

/** Radome: tangent ogive scaled from the joint section, same ring topology as the body. */
function buildRadome(): THREE.BufferGeometry {
  const joint = fuselageRing(RADOME.jointZ);
  const n = joint.length / 3;
  // Section centre at the joint (centroid of the ring).
  let cy = 0;
  for (let j = 0; j < n; j++) cy += joint[j * 3 + 1];
  cy /= n;
  const L = RADOME.jointZ - RADOME.tipZ;
  const rings: number[][] = [];
  const steps = 26;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = L * (1 - Math.cos((t * Math.PI) / 2)); // dense near the tip
    const z = RADOME.tipZ + x;
    const f = i === 0 ? 0 : ogive(x, L);
    const ay = RADOME.tipY + (cy - RADOME.tipY) * (x / L);
    const ring: number[] = [];
    for (let j = 0; j < n; j++) {
      ring.push(joint[j * 3] * f, ay + (joint[j * 3 + 1] - cy) * f, z);
    }
    rings.push(ring);
  }
  const g = loftGeometry(rings, { closed: true });
  // Planar UVs for the radome's own (untextured) material.
  return g;
}

// ─── Intake ──────────────────────────────────────────────────────────────────

const INTAKE_POINTS = 56;

/**
 * Closed intake outline (top centre → right side → bottom → left side), as [x, y] pairs:
 * a flat, wide top with tight corners and a rounder bottom (the F-16's "smile").
 */
export function intakeOutline(a: number, yTop: number, yBot: number, nTop = 5, nBot = 2.3, count = INTAKE_POINTS): [number, number][] {
  const cy = yTop - (yTop - yBot) * 0.42;
  const bt = yTop - cy;
  const bb = cy - yBot;
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const t = (k / count) * Math.PI * 2; // 0 = top centre, clockwise seen from the front (toward +x first)
    const s = Math.sin(t);
    const c = Math.cos(t);
    const n = c >= 0 ? nTop : nBot;
    const x = a * Math.sign(s) * Math.abs(s) ** (2 / n);
    const y = cy + (c >= 0 ? bt : bb) * Math.sign(c) * Math.abs(c) ** (2 / n);
    out.push([x, y]);
  }
  return out;
}

/** Outline offset outward along its 2D normals by d (negative = inward). */
function offsetOutline(pts: [number, number][], d: number): [number, number][] {
  const n = pts.length;
  return pts.map((p, k) => {
    const a = pts[(k - 1 + n) % n];
    const b = pts[(k + 1) % n];
    let nx = b[1] - a[1];
    let ny = -(b[0] - a[0]);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // Make it point away from the outline's centre.
    const cx = 0;
    const cyy = pts.reduce((s, q) => s + q[1], 0) / n;
    if (nx * (p[0] - cx) + ny * (p[1] - cyy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [p[0] + nx * d, p[1] + ny * d] as [number, number];
  });
}

/** z of the slanted lip plane at height y (upper lip forward). */
function lipZ(y: number): number {
  const t = Math.max(0, Math.min(1, (INTAKE.topY - y) / (INTAKE.topY - INTAKE.bottomY)));
  return INTAKE.upperLipZ + (INTAKE.lowerLipZ - INTAKE.upperLipZ) * t;
}

/** Outer cowl shape parameters along the cowl (d = metres aft of the lip). */
const COWL_KEYS = [
  { d: 0, a: 0.54, top: -0.335, bot: -0.965 },
  { d: 0.35, a: 0.56, top: -0.33, bot: -0.955 },
  { d: 1.2, a: 0.585, top: -0.29, bot: -0.935 },
  { d: 2.0, a: 0.595, top: -0.22, bot: -0.915 },
  { d: 3.2, a: 0.6, top: -0.2, bot: -0.89 },
  { d: 4.5, a: 0.585, top: -0.22, bot: -0.86 },
  { d: 5.25, a: 0.55, top: -0.25, bot: -0.83 },
  { d: 5.75, a: 0.49, top: -0.28, bot: -0.78 },
];

function cowlAt(d: number) {
  const k = COWL_KEYS;
  if (d <= k[0].d) return k[0];
  for (let i = 0; i < k.length - 1; i++) {
    if (d <= k[i + 1].d) {
      const t = (d - k[i].d) / (k[i + 1].d - k[i].d);
      const s = t * t * (3 - 2 * t);
      return { d, a: k[i].a + (k[i + 1].a - k[i].a) * s, top: k[i].top + (k[i + 1].top - k[i].top) * s, bot: k[i].bot + (k[i + 1].bot - k[i].bot) * s };
    }
  }
  return k[k.length - 1];
}

const MOUTH = { a: 0.475, top: -0.395, bot: -0.905 };

/** Outer cowl (paint atlas) + lip/duct (vertex colours). */
function buildIntake(): { cowl: THREE.BufferGeometry; duct: THREE.BufferGeometry } {
  const mouth = intakeOutline(MOUTH.a, MOUTH.top, MOUTH.bot);
  const lipR = 0.034;
  // Lip: half-torus from the mouth (inside) round the front to the outer cowl start.
  const outer0 = intakeOutline(COWL_KEYS[0].a, COWL_KEYS[0].top, COWL_KEYS[0].bot);
  const lipRings: number[][] = [];
  const lipSteps = 8;
  for (let i = 0; i <= lipSteps; i++) {
    const th = (i / lipSteps) * Math.PI; // 0 = inner … π = outer
    const f = 0.5 - 0.5 * Math.cos(th);
    const dz = -lipR * Math.sin(th);
    const ring: number[] = [];
    for (let k = 0; k < mouth.length; k++) {
      const x = mouth[k][0] + (outer0[k][0] - mouth[k][0]) * f;
      const y = mouth[k][1] + (outer0[k][1] - mouth[k][1]) * f;
      ring.push(x, y, lipZ(mouth[k][1]) + dz);
    }
    lipRings.push(ring);
  }
  // Duct: from deep inside forward to the mouth (it climbs and narrows toward the engine face).
  const ductRings: number[][] = [];
  const ductSteps = 10;
  const ductLen = 2.4;
  for (let i = ductSteps; i >= 1; i--) {
    const depth = (i / ductSteps) * ductLen;
    const rise = 0.3 * smooth(0.2, 2.2, depth);
    const shrink = 1 - 0.12 * smooth(0.3, 2.4, depth);
    const ring: number[] = [];
    for (let k = 0; k < mouth.length; k++) ring.push(mouth[k][0] * shrink, (mouth[k][1] + 0.65) * shrink - 0.65 + rise, lipZ(mouth[k][1]) + depth);
    ductRings.push(ring);
  }
  const inner = [...ductRings, ...lipRings.slice(0, lipSteps / 2 + 1)];
  const duct = loftGeometry(inner, { closed: true, capStart: true, orient: 'keep' });
  // Face the duct walls toward its axis: flip if the lower wall's normal points down.
  fixOrientation(duct, (p) => p.y < -0.8 && p.z > -3.6 && Math.abs(p.x) < 0.1, (n) => n.y > 0);
  // Colours (linear): the painted lip, then the duct walls darkening quickly into the dark.
  const pos = duct.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const rm = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const depth = pos.getZ(i) - lipZ(pos.getY(i));
    const k = 1 - smooth(-0.02, 0.9, depth);
    const c = 0.004 + 0.17 * k * k;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
    rm[i * 2] = 0.55;
    rm[i * 2 + 1] = 0;
  }
  duct.setAttribute('color', new THREE.BufferAttribute(col, 3));
  duct.setAttribute('rm', new THREE.BufferAttribute(rm, 2));

  // Outer cowl: from the lip's mid-point ring aft; the lip slant fades into planar stations.
  const cowlRings: number[][] = lipRings.slice(lipSteps / 2);
  const dSteps = [0.02, 0.08, 0.18, 0.32, 0.5, 0.75, 1.0, 1.3, 1.65, 2.0, 2.4, 2.8, 3.2, 3.6, 4.0, 4.4, 4.8, 5.1, 5.35, 5.55, 5.75];
  for (const d of dSteps) {
    const c = cowlAt(d);
    const ring = intakeOutline(c.a, c.top, c.bot);
    const flat = smooth(0.3, 1.6, d);
    const r: number[] = [];
    for (let k = 0; k < ring.length; k++) {
      const zs = lipZ(ring[k][1]) + d;
      const zp = INTAKE.lowerLipZ - 0.25 + d;
      r.push(ring[k][0], ring[k][1], zs + (zp - zs) * flat);
    }
    cowlRings.push(r);
  }
  const cowl = loftGeometry(cowlRings, { closed: true, orient: 'keep' });
  fixOrientation(cowl, (p) => p.y < -0.85 && p.z > -3 && Math.abs(p.x) < 0.1, (n) => n.y < 0);
  const uv = cowl.getAttribute('uv') as THREE.BufferAttribute;
  const cp = cowl.getAttribute('position');
  const tmp: [number, number] = [0, 0];
  for (let i = 0; i < cp.count; i++) {
    cowlUV(cp.getZ(i), cp.getY(i), tmp);
    uv.setXY(i, tmp[0], tmp[1]);
  }
  return { cowl, duct };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Flip a loft's winding + normals if the probe vertex's normal fails `ok`. */
function fixOrientation(g: THREE.BufferGeometry, probe: (p: THREE.Vector3) => boolean, ok: (n: THREE.Vector3) => boolean) {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    if (!probe(p)) continue;
    n.fromBufferAttribute(nor, i);
    if (ok(n)) return;
    // Flip.
    for (let k = 0; k < nor.count; k++) nor.setXYZ(k, -nor.getX(k), -nor.getY(k), -nor.getZ(k));
    const idx = g.getIndex()!;
    const a = idx.array as Uint16Array | Uint32Array;
    for (let t = 0; t < a.length; t += 3) {
      const tmp = a[t + 1];
      a[t + 1] = a[t + 2];
      a[t + 2] = tmp;
    }
    return;
  }
}

export function buildFuselage(): FuselageBuild {
  const stations = fuselageStations();
  const info: FuselageStationInfo[] = [];
  const body = buildBody(stations, info);
  const radome = buildRadome();
  const intake = buildIntake();
  const skin = mergeKeep([body, intake.cowl]);
  return { skin, radome, duct: intake.duct, stations: info };
}

/** Merge position/normal/uv geometries (keeps the inputs' attributes that all share). */
export function mergeKeep(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0;
  let iCount = 0;
  for (const g of list) {
    vCount += g.getAttribute('position').count;
    iCount += g.getIndex()!.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i);
      nor[(vo + i) * 3 + 1] = n.getY(i);
      nor[(vo + i) * 3 + 2] = n.getZ(i);
      uv[(vo + i) * 2] = t ? t.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = t ? t.getY(i) : 0;
    }
    const ix = g.getIndex()!;
    for (let k = 0; k < ix.count; k++) idx[io + k] = ix.getX(k) + vo;
    vo += p.count;
    io += ix.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export { FUSE_END_Z };
