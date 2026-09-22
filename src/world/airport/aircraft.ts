/**
 * Parked light aircraft for the apron, one geometry per type (instanced):
 *
 * - `c172`: a fixed-gear Cessna 172 lofted from the SAME airframe curves as
 *   the player's 172RG (src/aircraft/shape.ts) at low resolution, with
 *   spring-steel main legs and wheel pants.
 * - `pa28`: a Piper PA-28 Cherokee — low "Hershey-bar" wing with 7° dihedral,
 *   stabilator, swept fin, oleo gear with pants.
 *
 * Both come with a 2-blade prop, spinner, chocks and tie-down ropes. Windows,
 * panel lines and the livery are painted by the parked-aircraft shader from
 * the object-space position (see `aircraftGlsl`), so the meshes stay light
 * (~3–5k triangles). Local frame: body frame (−Z nose, +X right wing), with
 * the ground at y = 0.
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from './builder';
import {
  arcToAngle,
  DOOR_OUTLINE,
  DOOR_WINDOW,
  FUSE_Z0,
  FUSE_Z1,
  fuselageSection,
  HTAIL,
  monotoneCurve,
  PILLAR,
  REAR_SIDE_WINDOW,
  REAR_WINDOW,
  STRUT,
  superSectionPoint,
  wingPoint,
  WING,
  type SectionParams,
} from '../../aircraft/shape';
import { nacaRing } from '../../aircraft/airfoil';

export type AircraftType = 'c172' | 'pa28';

/** aPart ids read by the parked-aircraft shader. */
export const PART = { plain: 0, fuselage: 1, wing: 2, fin: 3, pant: 4, spinner: 5, tail: 6, glassy: 7 } as const;

const WHITE = 0xf1f1ec;
const RUBBER = 0x141414;

/** Body-frame y of the tyre contact points (ground) per type. */
export const GROUND_Y: Record<AircraftType, number> = { c172: -1.2, pa28: -1.05 };

function ringFromSection(sec: SectionParams, z: number, K: number, ts: number[], ang: Float64Array): V3[] {
  arcToAngle(sec, ts, ang);
  const out: V3[] = [];
  const p = { x: 0, y: 0 };
  for (let k = 0; k < K; k++) {
    superSectionPoint(sec, ang[k], p);
    out.push([p.x, p.y, z]);
  }
  return out;
}

/** Wing/tail panel lofted through airfoil sections: `place(c, a, s)` → body point for chord c, thickness a at span fraction s. */
function airfoilPanel(b: MeshBuilder, ring: number[], spans: number[], place: (c: number, a: number, s: number) => V3, capTip = true) {
  const rings: V3[][] = [];
  for (const s of spans) {
    const r: V3[] = [];
    for (let i = 0; i < ring.length; i += 2) r.push(place(ring[i], ring[i + 1], s));
    rings.push(r);
  }
  b.loft(rings, true);
  if (capTip) {
    const last = rings[rings.length - 1];
    const c = last.reduce((acc, p) => [acc[0] + p[0] / last.length, acc[1] + p[1] / last.length, acc[2] + p[2] / last.length], [0, 0, 0]);
    const prev = rings[rings.length - 2];
    const pc = prev.reduce((acc, p) => [acc[0] + p[0] / prev.length, acc[1] + p[1] / prev.length, acc[2] + p[2] / prev.length], [0, 0, 0]);
    const n: V3 = [c[0] - pc[0], c[1] - pc[1], c[2] - pc[2]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    b.capRing(last, c as unknown as V3, [n[0] / l, n[1] / l, n[2] / l]);
  }
}

/** Wheel (tyre + hub) with its axle along X at (x, y, z). */
function wheel(b: MeshBuilder, x: number, y: number, z: number, r: number, w: number) {
  b.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x + w / 2, y, z));
  b.set({ color: RUBBER, rough: 0.92, metal: 0, part: PART.plain, accent: 0 });
  b.lathe([[r * 0.62, 0], [r * 0.9, 0.005], [r, w * 0.2], [r, w * 0.8], [r * 0.9, w - 0.005], [r * 0.62, w]], 12, 0, 0, false);
  b.set({ color: 0xb9bcbf, rough: 0.35, metal: 0.8 });
  b.lathe([[r * 0.62, 0], [r * 0.3, 0.01], [0, 0.015]], 10);
  b.lathe([[r * 0.62, w], [r * 0.3, w - 0.01], [0, w - 0.015]], 10);
  b.pop();
}

/** Streamlined wheel pant centred on the axle. */
function pant(b: MeshBuilder, x: number, y: number, z: number, len: number, h: number, wdt: number) {
  const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  m.premultiply(new THREE.Matrix4().makeScale(wdt / h, 1, 1));
  m.setPosition(x, y, z + len * 0.42);
  b.push(m);
  b.set({ color: WHITE, rough: 0.35, metal: 0, part: PART.pant });
  const prof: [number, number][] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const r = h * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.7) * (t > 0.6 ? 1 - (t - 0.6) * 0.9 : 1);
    prof.push([Math.max(0.002, r), t * len]);
  }
  prof[0] = [0, 0];
  prof[10] = [0, len];
  b.lathe(prof, 12);
  b.pop();
}

/** Two-blade prop + spinner. `hub` body point, blade angle `phi` (rad, 0 = horizontal). */
function propeller(b: MeshBuilder, hub: V3, radius: number, spinR: number, spinLen: number, phi: number) {
  // spinner along −Z
  b.push(new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(hub[0], hub[1], hub[2] + 0.04));
  b.set({ color: WHITE, rough: 0.3, metal: 0.1, part: PART.spinner, accent: 0 });
  b.lathe([[spinR, -0.02], [spinR * 0.99, 0.06], [spinR * 0.85, spinLen * 0.45], [spinR * 0.55, spinLen * 0.75], [spinR * 0.2, spinLen * 0.95], [0, spinLen]], 14);
  b.pop();
  for (const s of [1, -1]) {
    const ux = Math.cos(phi) * s, uy = Math.sin(phi) * s;
    const vx = -uy, vy = ux; // perpendicular in the disc plane
    const rings: V3[][] = [];
    const stations = [0.12, 0.3, 0.55, 0.8, 0.94, 1.0];
    for (const f of stations) {
      const r = radius * f;
      const chord = (f < 0.3 ? 0.09 : 0.13 - 0.05 * (f - 0.3)) * (f > 0.97 ? 0.7 : 1);
      const thick = 0.028 - 0.016 * f;
      const beta = (32 - 20 * f) * (Math.PI / 180);
      const ring: V3[] = [];
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const cc = (Math.cos(a) * chord) / 2;
        const tt = (Math.sin(a) * thick) / 2;
        // chord lies in the (v, −z) plane rotated by the blade angle beta
        const cx = vx * Math.cos(beta), cy = vy * Math.cos(beta), cz = -Math.sin(beta);
        const tx = vx * Math.sin(beta), ty = vy * Math.sin(beta), tz = Math.cos(beta);
        ring.push([hub[0] + ux * r + cx * cc + tx * tt, hub[1] + uy * r + cy * cc + ty * tt, hub[2] + cz * cc + tz * tt]);
      }
      rings.push(ring);
    }
    b.set({ color: 0x1c1c1c, rough: 0.55, metal: 0.2, part: PART.plain });
    b.loft(rings.slice(0, 5), true);
    b.set({ color: 0xd8d8d0, rough: 0.5, metal: 0.1 });
    b.loft(rings.slice(4), true);
    const tip = rings[5];
    const c = tip.reduce((acc, p) => [acc[0] + p[0] / 8, acc[1] + p[1] / 8, acc[2] + p[2] / 8], [0, 0, 0]);
    b.capRing(tip, c as unknown as V3, [ux, uy, 0]);
  }
}

function chocksAndRopes(b: MeshBuilder, gy: number, noseZ: number, noseR: number, wingTie: V3[], tailTie: V3) {
  b.set({ color: 0xe0b020, rough: 0.8, metal: 0, part: PART.plain, accent: 0 });
  for (const dz of [-1, 1]) {
    const z = noseZ + dz * (noseR + 0.06);
    b.push(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, gy, z));
    b.prismZ([[-0.09 * dz, 0], [0.09 * dz, 0], [0.02 * dz, 0.09]], -0.09, 0.09);
    b.pop();
  }
  b.set({ color: 0xd7c24a, rough: 0.9 });
  for (const p of wingTie) {
    const gx = p[0] * 1.06;
    b.tube(p, [gx, gy + 0.02, p[2] + 0.25], 0.006, 0.006, 3);
    b.set({ color: 0x505356, rough: 0.5, metal: 0.8 });
    b.cylinder(gx, gy, p[2] + 0.25, 0.04, 0.03, 6);
    b.set({ color: 0xd7c24a, rough: 0.9 });
  }
  b.tube(tailTie, [0, gy + 0.02, tailTie[2] + 0.45], 0.006, 0.006, 3);
}

// ─── Cessna 172 ─────────────────────────────────────────────────────────────

export function buildC172(): MeshBuilder {
  const b = new MeshBuilder();
  const gy = GROUND_Y.c172;
  b.pushTR(0, -gy, 0, 0);
  // fuselage
  const K = 22;
  const ts = Array.from({ length: K }, (_, k) => k / K);
  const ang = new Float64Array(K);
  const zs: number[] = [];
  const add = (z0: number, z1: number, n: number) => {
    for (let i = zs.length ? 1 : 0; i <= n; i++) zs.push(z0 + ((z1 - z0) * i) / n);
  };
  add(FUSE_Z0, -1.25, 6);
  add(-1.25, -0.45, 9);
  add(-0.45, 1.0, 5);
  add(1.0, 2.2, 8);
  add(2.2, FUSE_Z1, 9);
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
  const rings = zs.map((z) => ringFromSection(fuselageSection(z, sec), z, K, ts, ang));
  b.set({ color: WHITE, rough: 0.32, metal: 0, part: PART.fuselage, accent: 0 });
  b.loft(rings, true);
  // nose bowl + tail closure
  const s0 = fuselageSection(FUSE_Z0, sec);
  b.capRing(rings[0], [0, (s0.top + s0.bottom) / 2, FUSE_Z0 - 0.02], [0, 0, -1]);
  const s1 = fuselageSection(FUSE_Z1, sec);
  b.capRing(rings[rings.length - 1], [0, (s1.top + s1.bottom) / 2, FUSE_Z1 + 0.05], [0, 0, 1]);
  // cowl inlets
  b.set({ color: 0x0d0d0d, rough: 0.9, part: PART.plain });
  for (const x of [-0.21, 0.21]) {
    const pts: V3[] = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      pts.push([x + 0.1 * Math.cos(a), 0.07 + 0.06 * Math.sin(a), FUSE_Z0 - 0.025]);
    }
    b.poly(pts, [0, 0, -1]);
  }
  // wings
  const airfoil = nacaRing({ m: WING.m, p: WING.p, t: WING.t, n: 9 });
  const P = { x: 0, y: 0, z: 0 };
  for (const side of [-1, 1]) {
    const spans = [0, 0.6, 1.6, 2.5, 3.4, 4.3, 4.97, 5.25, WING.tipEnd];
    b.set({ color: WHITE, rough: 0.35, metal: 0, part: PART.wing });
    airfoilPanel(b, airfoil, spans, (c, a, ax) => {
      const thin = ax > 5.0 ? 1 - ((ax - 5.0) / (WING.tipEnd - 5.0)) * 0.55 : 1;
      wingPoint(side, ax, c, a * thin, P);
      return [P.x, P.y, P.z];
    });
    // strut (streamlined tube)
    const f = STRUT.fuselage;
    b.set({ color: WHITE, rough: 0.35, part: PART.plain });
    wingPoint(side, STRUT.wing.x, 0.28, -0.05, P);
    b.tube([side * f.x, f.y, f.z], [P.x, P.y, P.z], 0.045, 0.04, 6);
    // nav light
    wingPoint(side, WING.tipEnd, 0.12, 0, P);
    b.set({ color: side < 0 ? 0xc01010 : 0x10b030, rough: 0.2, part: PART.glassy });
    b.boxC(P.x, P.y, P.z, 0.04, 0.05, 0.1);
  }
  // horizontal tail
  const sym = nacaRing({ m: 0, p: 0, t: HTAIL.t, n: 7 });
  for (const side of [-1, 1]) {
    b.set({ color: WHITE, rough: 0.35, part: PART.tail });
    airfoilPanel(b, sym, [0, 0.9, HTAIL.semiSpan], (c, a, s) => {
      const f = s / HTAIL.semiSpan;
      const le = HTAIL.rootLE + (HTAIL.tipLE - HTAIL.rootLE) * f;
      const te = HTAIL.rootTE + (HTAIL.tipTE - HTAIL.rootTE) * f;
      const ch = te - le;
      return [side * s, HTAIL.y + a * ch, le + c * ch];
    });
  }
  // fin + rudder
  const finSym = nacaRing({ m: 0, p: 0, t: 0.1, n: 7 });
  const finSt = [
    { y: 0.18, le: 4.28, te: 5.97 },
    { y: 0.8, le: 4.6, te: 5.98 },
    { y: 1.37, le: 5.22, te: 6.0 },
    { y: 1.44, le: 5.3, te: 5.95 },
  ];
  b.set({ color: WHITE, rough: 0.35, part: PART.fin });
  airfoilPanel(b, finSym, [0, 1, 2, 3], (c, a, i) => {
    const s = finSt[i];
    const ch = s.te - s.le;
    return [a * ch, s.y, s.le + c * ch];
  });
  // dorsal fillet
  b.push(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const topAt = (z: number) => fuselageSection(z, sec).top;
  b.prismZ([[-2.15, topAt(2.15) - 0.02], [-4.6, 0.8], [-4.6, topAt(4.6) - 0.02]], -0.03, 0.03);
  b.pop();
  // beacon on the fin, antenna on the roof
  b.set({ color: 0xb01010, rough: 0.2, part: PART.glassy });
  b.boxC(0, 1.47, 5.55, 0.05, 0.06, 0.1);
  b.set({ color: 0x2a2a2a, rough: 0.5, part: PART.plain });
  b.tube([0, 0.95, 0.9], [0, 1.22, 1.05], 0.008, 0.004, 3);
  b.tube([0, 0.93, -0.2], [0, 1.1, -0.1], 0.006, 0.003, 3);
  // gear
  const mainY = gy + 0.19;
  for (const side of [-1, 1]) {
    b.set({ color: 0xd0d0cc, rough: 0.4, metal: 0.3, part: PART.plain });
    b.tube([side * 0.42, -0.45, 0.42], [side * 1.18, mainY + 0.02, 0.45], 0.035, 0.03, 5);
    wheel(b, side * 1.27, mainY, 0.45, 0.19, 0.13);
    pant(b, side * 1.27, mainY + 0.03, 0.45, 0.9, 0.18, 0.14);
  }
  const noseY = gy + 0.17;
  b.set({ color: 0xc8c8c4, rough: 0.35, metal: 0.6, part: PART.plain });
  b.tube([0, -0.36, -1.28], [0, noseY + 0.05, -1.25], 0.04, 0.035, 6);
  wheel(b, 0, noseY, -1.25, 0.17, 0.11);
  pant(b, 0, noseY + 0.03, -1.25, 0.7, 0.16, 0.12);
  propeller(b, [0, 0.05, -2.05], 0.96, 0.17, 0.26, 0.45);
  chocksAndRopes(b, gy, -1.25, 0.17, [[-2.9, 0.9, 0.05], [2.9, 0.9, 0.05]], [0, -0.05, 5.35]);
  b.pop();
  return b;
}

// ─── Piper PA-28 Cherokee ────────────────────────────────────────────────────

const PA28 = {
  z0: -2.25,
  z1: 4.95,
  top: monotoneCurve([[-2.25, 0.18], [-1.6, 0.25], [-1.25, 0.27], [-0.9, 0.48], [-0.55, 0.64], [-0.3, 0.68], [0.9, 0.68], [1.3, 0.61], [1.8, 0.5], [2.6, 0.38], [3.8, 0.28], [4.95, 0.22]]),
  bottom: monotoneCurve([[-2.25, -0.24], [-1.8, -0.37], [-1.2, -0.46], [-0.5, -0.5], [0.8, -0.48], [1.6, -0.4], [2.6, -0.22], [3.8, -0.06], [4.95, 0.04]]),
  halfWidth: monotoneCurve([[-2.25, 0.3], [-1.8, 0.42], [-1.2, 0.5], [-0.5, 0.56], [0.6, 0.56], [1.4, 0.5], [2.4, 0.36], [3.6, 0.2], [4.95, 0.09]]),
  widthY: monotoneCurve([[-2.25, -0.03], [-1.2, 0.0], [0, 0.05], [2.4, 0.08], [4.95, 0.12]]),
  nTop: monotoneCurve([[-2.25, 2.4], [-1.25, 2.8], [-0.5, 3.6], [1.0, 3.6], [2.5, 2.6], [4.95, 2.3]]),
  nBot: monotoneCurve([[-2.25, 2.5], [-1.0, 3.2], [1, 3.2], [3, 2.5], [4.95, 2.3]]),
  wing: { rootLE: -0.62, chord: 1.6, y: -0.43, dihedral: 7 * (Math.PI / 180), semiSpan: 4.57 },
  stab: { y: 0.1, le: 4.18, chord: 0.76, semiSpan: 1.95 },
};

function pa28Section(z: number, out: SectionParams): SectionParams {
  out.top = PA28.top(z);
  out.bottom = PA28.bottom(z);
  out.halfWidth = PA28.halfWidth(z);
  out.widthY = PA28.widthY(z);
  out.nTop = PA28.nTop(z);
  out.nBot = PA28.nBot(z);
  return out;
}

export function buildPA28(): MeshBuilder {
  const b = new MeshBuilder();
  const gy = GROUND_Y.pa28;
  b.pushTR(0, -gy, 0, 0);
  const K = 22;
  const ts = Array.from({ length: K }, (_, k) => k / K);
  const ang = new Float64Array(K);
  const zs: number[] = [];
  const add = (z0: number, z1: number, n: number) => {
    for (let i = zs.length ? 1 : 0; i <= n; i++) zs.push(z0 + ((z1 - z0) * i) / n);
  };
  add(PA28.z0, -1.25, 6);
  add(-1.25, -0.4, 8);
  add(-0.4, 1.0, 5);
  add(1.0, 2.2, 7);
  add(2.2, PA28.z1, 9);
  const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
  const rings = zs.map((z) => ringFromSection(pa28Section(z, sec), z, K, ts, ang));
  b.set({ color: WHITE, rough: 0.32, metal: 0, part: PART.fuselage, accent: 0 });
  b.loft(rings, true);
  const s0 = pa28Section(PA28.z0, sec);
  b.capRing(rings[0], [0, (s0.top + s0.bottom) / 2, PA28.z0 - 0.02], [0, 0, -1]);
  const s1 = pa28Section(PA28.z1, sec);
  b.capRing(rings[rings.length - 1], [0, (s1.top + s1.bottom) / 2, PA28.z1 + 0.05], [0, 0, 1]);
  // chin inlets
  b.set({ color: 0x0d0d0d, rough: 0.9, part: PART.plain });
  for (const x of [-0.17, 0.17]) {
    const pts: V3[] = [];
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      pts.push([x + 0.1 * Math.cos(a), -0.1 + 0.05 * Math.sin(a), PA28.z0 - 0.025]);
    }
    b.poly(pts, [0, 0, -1]);
  }
  // low constant-chord wing
  const airfoil = nacaRing({ m: 0.02, p: 0.4, t: 0.15, n: 9 });
  const W = PA28.wing;
  for (const side of [-1, 1]) {
    b.set({ color: WHITE, rough: 0.35, part: PART.wing });
    airfoilPanel(b, airfoil, [0, 0.55, 1.5, 2.6, 3.6, 4.35, W.semiSpan], (c, a, ax) => {
      const thin = ax > 4.35 ? 0.6 : 1;
      const y0 = W.y + ax * Math.tan(W.dihedral);
      const inc = 2 * (Math.PI / 180);
      return [side * ax, y0 + W.chord * (a * thin * Math.cos(inc) - c * Math.sin(inc)), W.rootLE + W.chord * c];
    });
    const tipY = W.y + W.semiSpan * Math.tan(W.dihedral);
    b.set({ color: side < 0 ? 0xc01010 : 0x10b030, rough: 0.2, part: PART.glassy });
    b.boxC(side * (W.semiSpan + 0.02), tipY + 0.03, W.rootLE + 0.2, 0.05, 0.05, 0.12);
    // wing walk (dark non-slip) on the left root
    if (side < 0) {
      b.set({ color: 0x1a1a1a, rough: 0.95, part: PART.plain });
      b.poly(
        [[-0.55, W.y + 0.55 * Math.tan(W.dihedral) + 0.105, W.rootLE + 0.3], [-1.0, W.y + 1.0 * Math.tan(W.dihedral) + 0.105, W.rootLE + 0.3], [-1.0, W.y + 1.0 * Math.tan(W.dihedral) + 0.06, W.rootLE + 1.25], [-0.55, W.y + 0.55 * Math.tan(W.dihedral) + 0.06, W.rootLE + 1.25]],
        [0, 1, 0],
      );
    }
  }
  // stabilator
  const sym = nacaRing({ m: 0, p: 0, t: 0.1, n: 7 });
  const S = PA28.stab;
  for (const side of [-1, 1]) {
    b.set({ color: WHITE, rough: 0.35, part: PART.tail });
    airfoilPanel(b, sym, [0, 1.0, S.semiSpan], (c, a, s) => [side * s, S.y + a * S.chord, S.le + c * S.chord]);
  }
  // swept fin
  const finSym = nacaRing({ m: 0, p: 0, t: 0.1, n: 7 });
  const finSt = [
    { y: 0.12, le: 3.55, te: 4.96 },
    { y: 0.6, le: 4.0, te: 4.98 },
    { y: 1.15, le: 4.45, te: 5.0 },
    { y: 1.22, le: 4.52, te: 4.97 },
  ];
  b.set({ color: WHITE, rough: 0.35, part: PART.fin });
  airfoilPanel(b, finSym, [0, 1, 2, 3], (c, a, i) => {
    const s = finSt[i];
    const ch = s.te - s.le;
    return [a * ch, s.y, s.le + c * ch];
  });
  b.set({ color: 0x2a2a2a, rough: 0.5, part: PART.plain });
  b.tube([0, 0.67, 0.6], [0, 0.95, 0.75], 0.008, 0.004, 3);
  // oleo gear with pants
  const mainY = gy + 0.19;
  for (const side of [-1, 1]) {
    const x = side * 1.55;
    const wy = W.y + 1.55 * Math.tan(W.dihedral) - 0.06;
    b.set({ color: 0xc8c8c4, rough: 0.35, metal: 0.6, part: PART.plain });
    b.tube([x, wy, 0.22], [x, mainY + 0.05, 0.25], 0.04, 0.035, 6);
    wheel(b, x, mainY, 0.25, 0.19, 0.13);
    pant(b, x, mainY + 0.02, 0.25, 0.78, 0.165, 0.12);
  }
  const noseY = gy + 0.17;
  b.set({ color: 0xc8c8c4, rough: 0.35, metal: 0.6, part: PART.plain });
  b.tube([0, -0.4, -1.6], [0, noseY + 0.05, -1.55], 0.04, 0.035, 6);
  wheel(b, 0, noseY, -1.55, 0.17, 0.11);
  pant(b, 0, noseY + 0.02, -1.55, 0.62, 0.15, 0.11);
  propeller(b, [0, 0.0, -2.28], 0.94, 0.16, 0.27, 1.1);
  const tieY = W.y + 2.9 * Math.tan(W.dihedral) - 0.1;
  chocksAndRopes(b, gy, -1.55, 0.17, [[-2.9, tieY, 0.2], [2.9, tieY, 0.2]], [0, 0.0, 4.7]);
  b.pop();
  return b;
}

// ─── shader snippets: windows, panel lines and liveries ──────────────────────

type Poly = ReadonlyArray<readonly [number, number]>;

/** GLSL expression: signed distance (approx., <0 inside) of p (vec2 z,y) to a convex polygon. */
function convexSdf(poly: Poly): string {
  const cz = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
  const terms: string[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const bb = poly[(i + 1) % poly.length];
    let nz = bb[1] - a[1];
    let ny = -(bb[0] - a[0]);
    const l = Math.hypot(nz, ny) || 1;
    nz /= l;
    ny /= l;
    if ((cz - a[0]) * nz + (cy - a[1]) * ny > 0) {
      nz = -nz;
      ny = -ny;
    }
    terms.push(`dot(p - vec2(${a[0].toFixed(4)}, ${a[1].toFixed(4)}), vec2(${nz.toFixed(5)}, ${ny.toFixed(5)}))`);
  }
  return terms.reduce((acc, t) => (acc ? `max(${acc}, ${t})` : t), '');
}

const f4 = (v: number) => v.toFixed(4);

/**
 * GLSL defining `float apGlass(vec3 p, vec3 n)` (1 = window glass), `float apPanel(vec3 p, vec3 n)`
 * (1 = panel line) and `float apLivery(vec3 p, vec3 n, float part, float variant)` (1 = accent colour)
 * for one aircraft type, in the type's body frame with the ground at y = 0.
 */
export function aircraftGlsl(type: AircraftType): string {
  const gy = GROUND_Y[type];
  const head = `
float apAA(float d) { float w = max(fwidth(d), 1e-4); return 1.0 - smoothstep(-w, w, d); }
`;
  if (type === 'c172') {
    const pz0 = PILLAR.z0, py0 = PILLAR.y0, pz1 = PILLAR.z1, py1 = PILLAR.y1;
    return `${head}
float apGlass(vec3 q, vec3 n) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  float ax = abs(b.x);
  vec2 p = vec2(b.z, b.y);
  float side = step(0.35, abs(n.x));
  float sd1 = ${convexSdf(DOOR_WINDOW)};
  float sd2 = ${convexSdf(REAR_SIDE_WINDOW)};
  float g = side * apAA(min(sd1, sd2) + 0.012);
  // windshield: ahead of the A-pillar line, above the cowling, forward/up facing
  float pillarZ = ${f4(pz0)} + (b.y - ${f4(py0)}) * ${f4((pz1 - pz0) / (py1 - py0))};
  float baseZ = -1.25 + 0.1 * min(1.0, ax / 0.5) * min(1.0, ax / 0.5);
  float ws = step(b.z, pillarZ - 0.035) * step(baseZ + 0.03, b.z) * step(${f4(py0 + 0.04)}, b.y) * step(n.z, 0.15) * step(0.012, ax);
  // rear "Omni-Vision" window behind the wing
  float lowY = ${f4(REAR_WINDOW.yFront)} + (b.z - ${f4(REAR_WINDOW.z0)}) * ${f4((REAR_WINDOW.yBack - REAR_WINDOW.yFront) / (REAR_WINDOW.z1 - REAR_WINDOW.z0))};
  float rw = step(${f4(REAR_WINDOW.z0 + 0.05)}, b.z) * step(b.z, ${f4(REAR_WINDOW.z1 - 0.04)}) * step(lowY + 0.03, b.y) * step(0.2, n.y + abs(n.x) * 0.5);
  return max(g, max(ws, rw));
}
float apPanel(vec3 q, vec3 n) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  vec2 p = vec2(b.z, b.y);
  float sd = ${convexSdf(DOOR_OUTLINE)};
  float side = step(0.35, abs(n.x));
  float door = side * (1.0 - smoothstep(0.004, 0.012, abs(sd)));
  float cowl = (1.0 - smoothstep(0.004, 0.012, abs(b.z + 1.3))) * step(b.y, 0.3);
  return max(door, cowl * 0.8);
}
float apLivery(vec3 q, vec3 n, float part, float v) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  float m = 0.0;
  if (part == 1.0) {
    // cheat line sweeping up toward the tail
    float rise = max(0.0, b.z - 1.4) * 0.19;
    float y0 = -0.1 + rise;
    if (v < 0.5) {
      m = step(y0, b.y) * step(b.y, y0 + 0.09) + step(y0 + 0.13, b.y) * step(b.y, y0 + 0.16);
    } else if (v < 1.5) {
      m = step(b.y, -0.33 + max(0.0, b.z - 0.5) * 0.11) + step(-0.2, b.y) * step(b.y, -0.15) * step(b.z, 1.5);
    } else if (v < 2.5) {
      float y1 = -0.02 + max(0.0, b.z - 2.0) * 0.14;
      m = step(y1, b.y) * step(b.y, y1 + 0.05) + step(b.z, -1.35) * step(0.02, b.y) * step(b.y, 0.17);
    } else if (v < 3.5) {
      m = step(b.y, -0.18) * step(b.z, 3.0) + step(y0 + 0.05, b.y) * step(b.y, y0 + 0.08);
    } else {
      m = step(b.z, -1.3) + step(y0, b.y) * step(b.y, y0 + 0.06);
    }
    m *= step(b.z, 5.2);
  } else if (part == 3.0) {
    float yy = b.y - (b.z - 5.0) * 0.5;
    m = v < 2.5 ? step(0.55, yy) * step(yy, 0.8) : step(0.95, b.y);
  } else if (part == 2.0) {
    m = step(4.95, abs(b.x)) * step(0.5, fract(v * 0.5 + 0.25));
  } else if (part == 4.0 || part == 5.0) {
    m = step(0.5, v) * step(v, 1.5);
  }
  return clamp(m, 0.0, 1.0);
}
`;
  }
  const front: Poly = [[-0.62, 0.23], [-0.5, 0.58], [0.35, 0.62], [0.35, 0.23]];
  const mid: Poly = [[0.45, 0.23], [0.45, 0.61], [1.02, 0.57], [1.02, 0.23]];
  const rear: Poly = [[1.12, 0.25], [1.12, 0.55], [1.55, 0.45], [1.55, 0.27]];
  const door: Poly = [[-0.66, -0.3], [-0.66, 0.66], [0.4, 0.66], [0.4, -0.3]];
  return `${head}
float apGlass(vec3 q, vec3 n) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  float ax = abs(b.x);
  vec2 p = vec2(b.z, b.y);
  float side = step(0.35, abs(n.x));
  float sd = min(min(${convexSdf(front)}, ${convexSdf(mid)}), ${convexSdf(rear)});
  float g = side * apAA(sd + 0.012);
  float pillarZ = -1.2 + (b.y - 0.25) * ${f4((-0.55 + 1.2) / (0.66 - 0.25))};
  float ws = step(b.z, pillarZ - 0.03) * step(-1.22, b.z) * step(0.29, b.y) * step(n.z, 0.15) * step(0.012, ax);
  return max(g, ws);
}
float apPanel(vec3 q, vec3 n) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  vec2 p = vec2(b.z, b.y);
  float sd = ${convexSdf(door)};
  float door = step(0.0, b.x) * step(0.35, abs(n.x)) * (1.0 - smoothstep(0.004, 0.012, abs(sd)));
  float cowl = (1.0 - smoothstep(0.004, 0.012, abs(b.z + 1.28))) * step(b.y, 0.28);
  return max(door, cowl * 0.8);
}
float apLivery(vec3 q, vec3 n, float part, float v) {
  vec3 b = vec3(q.x, q.y + (${f4(gy)}), q.z);
  float m = 0.0;
  if (part == 1.0) {
    float rise = max(0.0, b.z - 2.2) * 0.2;
    if (v < 0.5) {
      m = step(0.02 + rise, b.y) * step(b.y, 0.14 + rise) + step(0.17 + rise, b.y) * step(b.y, 0.2 + rise);
    } else if (v < 1.5) {
      m = step(b.y, -0.2 + max(0.0, b.z - 1.0) * 0.1) + step(0.0, b.y) * step(b.y, 0.05);
    } else if (v < 2.5) {
      m = step(-0.06 + rise, b.y) * step(b.y, 0.18 + rise) * step(-1.6, b.z);
    } else if (v < 3.5) {
      m = step(b.z, -1.25) + step(0.05 + rise, b.y) * step(b.y, 0.11 + rise);
    } else {
      m = step(b.y, -0.1) * step(-1.9, b.z) + step(b.z, -1.9);
    }
  } else if (part == 3.0) {
    m = step(0.72, b.y) * step(b.y, 0.95);
  } else if (part == 2.0) {
    m = step(4.2, abs(b.x)) * step(0.5, fract(v * 0.5 + 0.25));
  } else if (part == 4.0 || part == 5.0) {
    m = step(0.5, v) * step(v, 1.5);
  }
  return clamp(m, 0.0, 1.0);
}
`;
}

export function buildAircraftGeometry(type: AircraftType): THREE.BufferGeometry {
  const b = type === 'c172' ? buildC172() : buildPA28();
  return b.toGeometry(['color', 'rm', 'part']);
}
