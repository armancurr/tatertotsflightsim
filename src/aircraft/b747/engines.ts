/**
 * The 747-400's four RB211-524H-style pods: the long fan cowl in Tater blue with a gold band and
 * the thrust-reverser sleeve line, the polished intake lip, the dark intake duct, the fan (34
 * wide-chord blades + the spiral-marked spinner, spinning with N1; a blurred disc once it runs
 * fast), the core cowl, the core nozzle and the exhaust plug, and the strut (pylon) that carries
 * the pod forward of and below the wing with its aft fairing under the wing. All vertex coloured
 * (parts material). The fan group's origin sits on the nacelle axis at the fan face.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { merge, tint } from '../materials';
import { V } from '../f16/geom';
import { CORE_PROFILE, ENGINES, FAN, NACELLE_PROFILE, NACELLE_R, PLUG_PROFILE, WING, clamp, lerp, smooth, wingPoint, wingSurfaceH, type EnginePod } from './shape';

const SEG = 40;

export interface EngineBuild {
  pod: EnginePod;
  /** Cowl, lip, duct, core, plug, pylon (parts). */
  nacelle: THREE.BufferGeometry;
  blades: THREE.BufferGeometry;
  disc: THREE.BufferGeometry;
  /** Fan centre (body) — the fan group's origin. */
  fanCentre: THREE.Vector3;
}

const BLUE = new THREE.Color(0x1d3f8f);
const GOLD = new THREE.Color(0xd4a531);
const LIP = new THREE.Color(0xc4c9ce);
const _c = new THREE.Color();

function lathe(e: EnginePod, profile: [number, number][], segs = SEG): number[][] {
  return profile.map(([dz, r]) => {
    const ring: number[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      ring.push(e.x + Math.sin(a) * r, e.y + Math.cos(a) * r, e.lipZ + dz);
    }
    return ring;
  });
}

type Paint = (p: THREE.Vector3, dz: number) => [THREE.Color, number, number];

function paint(g: THREE.BufferGeometry, e: EnginePod, f: Paint): THREE.BufferGeometry {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const rm = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const [c, r, m] = f(p, p.z - e.lipZ);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    rm[i * 2] = r;
    rm[i * 2 + 1] = m;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  return g;
}

/** Turn a loft inside out (normals and winding) — for ducts seen from inside. */
function inward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.getIndex()!;
  const a = idx.array as Uint16Array | Uint32Array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1];
    a[i + 1] = a[i + 2];
    a[i + 2] = t;
  }
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

/** Nacelle outer radius at dz (from the lip). */
export function nacelleRadius(dz: number): number {
  const P = NACELLE_PROFILE;
  if (dz <= P[0][0]) return P[0][1];
  for (let i = 0; i < P.length - 1; i++) {
    if (dz <= P[i + 1][0]) return lerp(P[i][1], P[i + 1][1], (dz - P[i][0]) / (P[i + 1][0] - P[i][0]));
  }
  return P[P.length - 1][1];
}

function wingLowerY(x: number, z: number): number {
  const c = WING.chord(x);
  const f = clamp((z - WING.le(x)) / c, 0, 1);
  const p: [number, number, number] = [0, 0, 0];
  wingPoint(x, f, wingSurfaceH(x, f, false), p);
  return p[1];
}

function buildPylon(e: EnginePod): THREE.BufferGeometry {
  const ax = Math.abs(e.x);
  const le = WING.le(ax);
  const zFront = e.lipZ + 0.55;
  const zNoz = e.lipZ + NACELLE_PROFILE[NACELLE_PROFILE.length - 1][0];
  const zPlug = e.lipZ + PLUG_PROFILE[PLUG_PROFILE.length - 1][0];
  const zRear = le + WING.chord(ax) * 0.42;
  const yWingLE = wingLowerY(ax, le + 0.05);
  const topFront = e.y + NACELLE_R + 0.62;
  const n = 26;
  const rings: number[][] = [];
  const segs = 16;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const z = lerp(zFront, zRear, u);
    // Top: a strut rising gently to the leading edge, then buried in the wing.
    const top = z < le ? lerp(topFront, Math.min(topFront, yWingLE + 0.08), smooth(le - 3, le, z)) : wingLowerY(ax, z) + 0.12;
    // Bottom: buried in the cowl, then over the core, then the aft fairing closing up to the wing.
    let bot: number;
    const dz = z - e.lipZ;
    if (z < zNoz - 0.1) bot = e.y + nacelleRadius(dz) - 0.14;
    else if (z < zPlug) bot = e.y + 0.72 - 0.35 * smooth(zNoz, zPlug, z);
    else bot = lerp(e.y + 0.37, wingLowerY(ax, zRear) - 0.02, smooth(zPlug, zRear, z));
    bot = Math.min(bot, top - 0.04);
    const halfW = 0.3 * smooth(zFront - 0.3, zFront + 1.2, z) * (1 - 0.75 * smooth(zPlug, zRear, z)) + 0.03;
    const cy = (top + bot) / 2;
    const hh = (top - bot) / 2;
    const r: number[] = [];
    for (let k = 0; k < segs; k++) {
      const a = (k / segs) * Math.PI * 2;
      // Rounded box section.
      const sx = Math.sign(Math.sin(a)) * Math.pow(Math.abs(Math.sin(a)), 0.45);
      const sy = Math.sign(Math.cos(a)) * Math.pow(Math.abs(Math.cos(a)), 0.45);
      r.push(e.x + sx * halfW, cy + sy * hh, z);
    }
    rings.push(r);
  }
  const g = loftGeometry(rings, { closed: true, capStart: true, capEnd: true });
  return tint(g, 0xd5d9dc, 0.42, 0.08);
}

export function buildEngine(e: EnginePod): EngineBuild {
  const geos: THREE.BufferGeometry[] = [];
  // ── Fan cowl: lip inside → round the lip → barrel → fan nozzle; the reverser line at dz 2.45. ──
  const outer: [number, number][] = [[0.1, 1.1], [0.03, 1.13], [0, 1.17], ...NACELLE_PROFILE];
  const withLine: [number, number][] = [];
  for (const q of outer) {
    if (q[0] > 2.4 && q[0] <= 3.0 && !withLine.some((w) => w[0] === 2.43)) withLine.push([2.43, NACELLE_R], [2.445, NACELLE_R - 0.004], [2.46, NACELLE_R - 0.004], [2.475, NACELLE_R]);
    withLine.push(q);
  }
  const last = outer[outer.length - 1];
  withLine.push([last[0] + 0.004, last[1] - 0.03], [last[0] - 0.4, last[1] - 0.06]);
  const cowl = loftGeometry(lathe(e, withLine), { closed: true, orient: 'keep' });
  // Lathe rings run clockwise seen from the front: make the shell face outward.
  fixOutward(cowl, e);
  geos.push(
    paint(cowl, e, (p, dz) => {
      const r = Math.hypot(p.x - e.x, p.y - e.y);
      if (dz < 0.22 || r < 1.15) return [LIP, 0.22, 0.9];
      if (dz > 2.44 && dz < 2.465) return [_c.setHex(0x0f1a33), 0.6, 0];
      if (dz > 0.62 && dz < 0.82) return [GOLD, 0.3, 0.3];
      if (dz > 4.2) return [_c.setHex(0x1a3576), 0.4, 0];
      return [BLUE, 0.3, 0.02];
    }),
  );
  // ── Intake duct: lip → fan face, darkening inside. ──
  const duct = loftGeometry(lathe(e, [[0.09, 1.105], [0.3, FAN.radius + 0.03], [FAN.dz + 0.05, FAN.radius + 0.01]]), { closed: true, orient: 'keep' });
  fixOutward(duct, e);
  inward(duct);
  geos.push(paint(duct, e, (_p, dz) => [_c.setScalar(lerp(0.5, 0.08, clamp(dz / 0.6, 0, 1))), 0.55, 0.3]));
  // Bypass duct behind the fan (dark, seen through the blades) and the fan frame.
  const bypass = loftGeometry(lathe(e, [[FAN.dz + 0.25, FAN.radius], [2.5, 1.12], [4.9, 1.05]]), { closed: true, orient: 'keep' });
  fixOutward(bypass, e);
  inward(bypass);
  geos.push(paint(bypass, e, () => [_c.setScalar(0.04), 0.7, 0.2]));
  // ── Core cowl, core nozzle, plug ──
  const core = loftGeometry(lathe(e, [[FAN.dz + 0.3, 0.45], [2.0, 0.78], ...CORE_PROFILE]), { closed: true, capStart: true, orient: 'keep' });
  fixOutward(core, e);
  geos.push(paint(core, e, (_p, dz) => (dz > 5.55 ? [_c.setHex(0x55504a), 0.5, 0.7] : [_c.setHex(0x7b8187), 0.4, 0.75])));
  const hole = loftGeometry(lathe(e, [[5.9, 0.6], [5.88, 0.56], [5.7, 0.52]]), { closed: true, orient: 'keep' });
  fixOutward(hole, e);
  inward(hole);
  geos.push(paint(hole, e, () => [_c.setScalar(0.02), 0.9, 0.1]));
  const plug = loftGeometry(lathe(e, PLUG_PROFILE), { closed: true, orient: 'keep' });
  fixOutward(plug, e);
  geos.push(paint(plug, e, (_p, dz) => [_c.setHex(dz > 6.5 ? 0x3d3530 : 0x6e6259), 0.5, 0.6]));
  // ── Pylon ──
  geos.push(buildPylon(e));
  const nacelle = merge(geos);

  // ── Fan: blades + spinner (group-local: origin on the axis at the fan face) ──
  const blades: THREE.BufferGeometry[] = [];
  const NB = 34;
  for (let i = 0; i < NB; i++) {
    const a = (i / NB) * Math.PI * 2;
    const b = new THREE.BoxGeometry(0.018, FAN.radius - 0.36, 0.26, 1, 3, 1);
    // Twist: blades rotate ~40° about their own radial axis, more at the root.
    const pos = b.getAttribute('position');
    for (let k = 0; k < pos.count; k++) {
      const y = pos.getY(k);
      const u = (y + (FAN.radius - 0.36) / 2) / (FAN.radius - 0.36);
      const tw = (55 - 25 * u) * (Math.PI / 180);
      const x = pos.getX(k);
      const z = pos.getZ(k) * (0.85 + 0.35 * u);
      pos.setXYZ(k, x * Math.cos(tw) - z * Math.sin(tw), y, x * Math.sin(tw) + z * Math.cos(tw));
    }
    b.computeVertexNormals();
    b.translate(0, 0.36 + (FAN.radius - 0.36) / 2, 0);
    b.rotateZ(-a);
    blades.push(tint(b, 0x9da3a9, 0.3, 0.85));
  }
  const spinner = new THREE.LatheGeometry(
    [new THREE.Vector2(0.001, -FAN.spinnerLen), new THREE.Vector2(0.14, -0.46), new THREE.Vector2(0.28, -0.26), new THREE.Vector2(0.38, -0.1), new THREE.Vector2(FAN.spinnerR, 0.05), new THREE.Vector2(FAN.spinnerR, 0.2)],
    24,
  ).rotateX(-Math.PI / 2);
  // Lathe axis +Y → after the rotation the spinner points along −Z (forward). Paint the spiral.
  const sp = spinner.getAttribute('position');
  const scol = new Float32Array(sp.count * 3);
  const srm = new Float32Array(sp.count * 2);
  for (let k = 0; k < sp.count; k++) {
    const ang = Math.atan2(sp.getY(k), sp.getX(k));
    const t = (ang + sp.getZ(k) * 7 + Math.PI * 4) % (Math.PI);
    const white = t < 0.35 && sp.getZ(k) < -0.08;
    const v = white ? 0.92 : 0.12;
    scol.set([v, v, v], k * 3);
    srm.set([0.35, white ? 0 : 0.6], k * 2);
  }
  spinner.setAttribute('color', new THREE.BufferAttribute(scol, 3));
  spinner.setAttribute('rm', new THREE.BufferAttribute(srm, 2));
  const spinner2 = spinner.clone();
  const bladesGeo = merge([...blades, spinner]);
  // Blurred fan: a metallic disc, lighter mid-span where the wide-chord blades overlap most.
  const ring = tint(new THREE.RingGeometry(0.36, FAN.radius, 48, 4).rotateY(Math.PI).translate(0, 0, 0.02), 0x7a8086, 0.32, 0.8);
  {
    const p = ring.getAttribute('position');
    const c = ring.getAttribute('color');
    for (let k = 0; k < p.count; k++) {
      const r = Math.hypot(p.getX(k), p.getY(k));
      const u = (r - 0.36) / (FAN.radius - 0.36);
      const v = 0.34 + 0.16 * Math.sin(Math.PI * u) - 0.1 * u * u;
      c.setXYZ(k, v, v * 1.02, v * 1.05);
    }
  }
  const disc = merge([ring, spinner2]);
  return { pod: e, nacelle, blades: bladesGeo, disc, fanCentre: V(e.x, e.y, e.lipZ + FAN.dz) };
}

/** Make a lathe shell's normals point away from the nacelle axis. */
function fixOutward(g: THREE.BufferGeometry, e: EnginePod) {
  const p = g.getAttribute('position');
  const n = g.getAttribute('normal');
  let s = 0;
  for (let i = 0; i < p.count; i++) s += n.getX(i) * (p.getX(i) - e.x) + n.getY(i) * (p.getY(i) - e.y);
  if (s < 0) inward(g);
}

export function buildEngines(): EngineBuild[] {
  return ENGINES.map((e) => buildEngine(e));
}
