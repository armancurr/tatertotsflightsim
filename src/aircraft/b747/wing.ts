/**
 * 747-400 wing: the cranked planform (40° leading edge, the trailing-edge kink at 12.8 m, 7°
 * dihedral, washout) as a fixed wing box with the trailing-edge cut-outs, the triple-slotted
 * Fowler flaps (fore + main flap on one carriage, the aft flap hinged behind it), the inboard
 * (high-speed) and outboard (low-speed) ailerons, two spoiler groups on the upper surface, the
 * Krueger / variable-camber leading-edge flaps under the leading edge, the flap-track canoe
 * fairings and the canted winglet. Built for the right wing in body coordinates; the left side is
 * the mirror image (hinge axes mirrored and reversed so + rotation still lowers a trailing edge).
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { nacaRing } from '../airfoil';
import { merge, tint } from '../materials';
import { airfoilPiece, hingeFrame, mirrorX, toLocal, V } from '../f16/geom';
import { wingUV } from './atlas';
import { WING, lerp, wingPoint, wingSurfaceH } from './shape';

export type Side = 'left' | 'right';
export type Span = 'inboard' | 'outboard';

export interface HingedPart {
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface FlapBuild {
  /** Fore + main flap on the carriage (hinged at its leading edge, lower side). */
  main: HingedPart;
  /** Aft flap, hinge expressed in the carriage's rotating frame. */
  aft: HingedPart;
  /** Unit vector (body frame) the carriage runs along, and the travel at full extension (m). */
  runDir: THREE.Vector3;
  run: number;
}

export interface WingSideBuild {
  panel: THREE.BufferGeometry;
  /** Winglet, canoe fairings, light housings (parts material). */
  parts: THREE.BufferGeometry;
  flaps: Record<Span, FlapBuild>;
  ailerons: Record<Span, HingedPart>;
  spoilers: Record<Span, HingedPart>;
  kruegers: Record<Span, HingedPart>;
  /** Wingtip light positions: nav (forward, on the winglet root leading edge), white tail light, strobe. */
  navLight: THREE.Vector3;
  tailLight: THREE.Vector3;
  strobe: THREE.Vector3;
  /** Landing light in the wing-root leading edge. */
  landingLamp: THREE.Vector3;
  /** Logo light on the stabiliser? no — the wing's is the runway turn-off light at the root. */
  turnoffLamp: THREE.Vector3;
}

const N_AIRFOIL = 20;
const P_CAMBER = 0.4;

/** Span stations x0..x1, at most `step` apart, including both ends. */
function stations(x0: number, x1: number, step: number): number[] {
  const n = Math.max(1, Math.ceil((x1 - x0) / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(x0 + ((x1 - x0) * i) / n);
  return out;
}

/** Loft 2D chord rings ([f, h] pairs) placed at each span station (right wing, body frame). */
function loftPiece(xs: number[], ringAt: (x: number) => number[], caps = true): THREE.BufferGeometry {
  const p: [number, number, number] = [0, 0, 0];
  const rings = xs.map((x) => {
    const r2 = ringAt(x);
    const out: number[] = [];
    for (let k = 0; k < r2.length; k += 2) {
      wingPoint(x, r2[k], r2[k + 1], p);
      out.push(p[0], p[1], p[2]);
    }
    return out;
  });
  return loftGeometry(rings, { closed: true, capStart: caps, capEnd: caps });
}

/** Wing-cell UVs from the planform position; upper/lower from the vertex normal. */
export function applyWingUV(g: THREE.BufferGeometry) {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const t: [number, number] = [0, 0];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const ax = Math.min(WING.tipX, Math.max(WING.rootX, Math.abs(x)));
    const f = (pos.getZ(i) - WING.le(ax)) / WING.chord(ax);
    wingUV(x, f, nor.getY(i) >= 0, t);
    uv.setXY(i, t[0], t[1]);
  }
}

const piece = (x: number, a: number, b: number, n = N_AIRFOIL) => airfoilPiece(WING.thickness(x), WING.camber(x), P_CAMBER, a, b, n);

/** Hinged part from a right-wing body geometry and its hinge line a → b. */
function hinge(geo: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3): HingedPart {
  const q = hingeFrame(b.clone().sub(a));
  toLocal(geo, a, q);
  return { geometry: geo, position: a.clone(), quaternion: q };
}

/** Mirror a right-side hinged part to the left (hinge axis mirrored and reversed). */
export function mirrorHinge(h: HingedPart, uv?: (g: THREE.BufferGeometry) => void): HingedPart {
  const body = h.geometry.clone().applyQuaternion(h.quaternion).translate(h.position.x, h.position.y, h.position.z);
  const m = mirrorX(body);
  body.dispose();
  uv?.(m);
  const axisR = V(1, 0, 0).applyQuaternion(h.quaternion);
  const axisL = V(axisR.x, -axisR.y, -axisR.z);
  const pos = V(-h.position.x, h.position.y, h.position.z);
  const q = hingeFrame(axisL);
  toLocal(m, pos, q);
  return { geometry: m, position: pos, quaternion: q };
}

/** Point on the right wing surface at (x, f), upper or lower, pushed `off` metres along the local up. */
function surf(x: number, f: number, upper: boolean, off = 0): THREE.Vector3 {
  const c = WING.chord(x);
  const p: [number, number, number] = [0, 0, 0];
  wingPoint(x, f, wingSurfaceH(x, f, upper) + off / c, p);
  return V(p[0], p[1], p[2]);
}

function buildFlap(x0: number, x1: number): FlapBuild {
  const F = WING.flapF;
  const S = WING.flapSplitF;
  const xs = stations(x0, x1, 1.6);
  const main = loftPiece(xs, (x) => piece(x, F, S + 0.004, 12));
  applyWingUV(main);
  const aft = loftPiece(xs, (x) => piece(x, S - 0.004, 1, 8));
  applyWingUV(aft);
  const mainA = surf(x0, F, false);
  const mainB = surf(x1, F, false);
  const m = hinge(main, mainA, mainB);
  // Aft flap hinge at the main flap's trailing edge (lower side), in the carriage frame.
  const aftA = surf(x0, S, false);
  const aftB = surf(x1, S, false);
  const qa = hingeFrame(aftB.clone().sub(aftA));
  toLocal(aft, aftA, qa);
  const inv = m.quaternion.clone().invert();
  const localPos = aftA.clone().sub(m.position).applyQuaternion(inv);
  const localQ = inv.clone().multiply(qa);
  const cMean = (WING.chord(x0) + WING.chord(x1)) / 2;
  return {
    main: m,
    aft: { geometry: aft, position: localPos, quaternion: localQ },
    runDir: V(0, -0.2, 1).normalize(),
    run: cMean * (1 - F) * 0.95,
  };
}

function mirrorFlap(f: FlapBuild): FlapBuild {
  const main = mirrorHinge(f.main, applyWingUV);
  // Aft flap: back to body coordinates through the right carriage, mirror, into the left carriage.
  const aftBodyQ = f.main.quaternion.clone().multiply(f.aft.quaternion);
  const aftBodyP = f.aft.position.clone().applyQuaternion(f.main.quaternion).add(f.main.position);
  const aftL = mirrorHinge({ geometry: f.aft.geometry, position: aftBodyP, quaternion: aftBodyQ }, applyWingUV);
  const inv = main.quaternion.clone().invert();
  return {
    main,
    aft: { geometry: aftL.geometry, position: aftL.position.clone().sub(main.position).applyQuaternion(inv), quaternion: inv.clone().multiply(aftL.quaternion) },
    runDir: f.runDir.clone(),
    run: f.run,
  };
}

function buildAileron(x0: number, x1: number): HingedPart {
  const F = WING.aileronF;
  const xs = stations(x0, x1, 1.8);
  const g = loftPiece(xs, (x) => nacaRing({ m: WING.camber(x), p: P_CAMBER, t: WING.thickness(x), n: 10, from: F + 0.004 }));
  applyWingUV(g);
  const a = V(...wingPoint(x0, F, wingSurfaceH(x0, F, true) * 0.5 + wingSurfaceH(x0, F, false) * 0.5));
  const b = V(...wingPoint(x1, F, wingSurfaceH(x1, F, true) * 0.5 + wingSurfaceH(x1, F, false) * 0.5));
  return hinge(g, a, b);
}

/** A thin plate on the upper (spoiler) or lower (Krueger) surface between chord fractions f0..f1. */
function plate(x0: number, x1: number, f0: number, f1: number, upper: boolean, step: number): THREE.BufferGeometry {
  const xs = stations(x0, x1, step);
  const n = 6;
  const g = loftPiece(xs, (x) => {
    const c = WING.chord(x);
    const off = 0.012 / c;
    const th = 0.035 / c;
    const out: number[] = [];
    const sgn = upper ? 1 : -1;
    for (let k = 0; k < n; k++) {
      const f = lerp(f0, f1, k / (n - 1));
      out.push(f, wingSurfaceH(x, f, upper) + sgn * off);
    }
    for (let k = n - 1; k >= 0; k--) {
      const f = lerp(f0, f1, k / (n - 1));
      out.push(f, wingSurfaceH(x, f, upper) + sgn * off - sgn * th);
    }
    return out;
  });
  applyWingUV(g);
  return g;
}

function buildSpoiler(x0: number, x1: number): HingedPart {
  const [f0, f1] = WING.spoilerF;
  const g = plate(x0, x1, f0, f1, true, 1.8);
  return hinge(g, surf(x0, f0, true, 0.012), surf(x1, f0, true, 0.012));
}

function buildKrueger(x0: number, x1: number): HingedPart {
  const g = plate(x0, x1, 0.015, WING.kruegerF, false, 1.8);
  return hinge(g, surf(x0, 0.015, false, -0.012), surf(x1, 0.015, false, -0.012));
}

/** The fixed wing box with the trailing-edge cut-outs (right wing). */
function buildPanel(): THREE.BufferGeometry {
  const segs: [number, number, number][] = [
    [WING.rootX, WING.flapInboard[0], 1],
    [WING.flapInboard[0], WING.aileronInboard[0], WING.flapF],
    [WING.aileronInboard[0], WING.flapOutboard[0], WING.aileronF],
    [WING.flapOutboard[0], WING.aileronOutboard[0], WING.flapF],
    [WING.aileronOutboard[0], WING.aileronOutboard[1], WING.aileronF],
    [WING.aileronOutboard[1], WING.tipX, 1],
  ];
  const parts: THREE.BufferGeometry[] = [];
  for (const [x0, x1, b] of segs) {
    const xs = stations(x0, x1, 1.0);
    // The kink needs a station exactly at 12.8 m.
    if (x0 < WING.kinkX && x1 > WING.kinkX) {
      xs.push(WING.kinkX);
      xs.sort((a, c) => a - c);
    }
    const g = loftPiece(xs, (x) => (b >= 1 ? piece(x, 0, 1, 26) : piece(x, 0, b, 24)));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    parts.push(g);
  }
  // Pieces differ in ring size: merge as separate groups (same attribute layout).
  const g = merge(parts);
  applyWingUV(g);
  return g;
}

const BLUE = 0x1d3f8f;
const GOLD = 0xd4a531;
const FAIRING = 0xc9ced3;

/** Canted winglet on the tip (right side), with a gold tip cap. */
function buildWinglet(): { geo: THREE.BufferGeometry; top: THREE.Vector3 } {
  const W = WING.winglet;
  const tip = WING.tipX;
  const rootChord = WING.chord(tip) * 0.72;
  const rootLE = WING.te(tip) - rootChord;
  const baseY = WING.yLE(tip) + 0.02;
  const t = 0.085;
  // Cant solved so the outermost point of the top section sits exactly on the span station.
  let cant = (W.cantDeg * Math.PI) / 180;
  for (let i = 0; i < 20; i++) {
    const topHalf = (t * W.tipChord * 0.5) * Math.cos(cant);
    cant = Math.asin(Math.min(0.9, (WING.spanX - tip - topHalf) / W.height));
  }
  const sweep = Math.tan((W.sweepDeg * Math.PI) / 180);
  const sections = 7;
  const rings: number[][] = [];
  const ring2 = nacaRing({ m: 0.0, p: 0.4, t, n: 14 });
  const nrm = V(Math.cos(cant), -Math.sin(cant), 0); // outward face normal (thickness direction)
  let top = V(0, 0, 0);
  for (let i = 0; i <= sections; i++) {
    const u = i / sections;
    // Curved root: the first 20 % bends up from the tip plane.
    const h = W.height * u;
    const c = lerp(rootChord, W.tipChord, Math.pow(u, 0.85));
    const le = rootLE + h * sweep * Math.cos(cant);
    const cx = tip + h * Math.sin(cant);
    const cy = baseY + h * Math.cos(cant);
    const out: number[] = [];
    for (let k = 0; k < ring2.length; k += 2) {
      const f = ring2[k];
      const th = ring2[k + 1] * c;
      out.push(cx + nrm.x * th, cy + nrm.y * th, le + f * c);
    }
    rings.push(out);
    if (i === sections) top = V(cx, cy, le + c * 0.5);
  }
  const geo = loftGeometry(rings, { closed: true, capEnd: true, capStart: true });
  // Blue winglet with a gold band near the top.
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const rm = new Float32Array(pos.count * 2);
  const blue = new THREE.Color(BLUE);
  const gold = new THREE.Color(GOLD);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getY(i) - baseY) / (W.height * Math.cos(cant));
    c.copy(u > 0.8 && u < 0.9 ? gold : blue);
    col.set([c.r, c.g, c.b], i * 3);
    rm.set([0.32, 0.05], i * 2);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  return { geo, top };
}

/** Flap-track canoe fairings under the trailing edge. */
function buildCanoes(): THREE.BufferGeometry {
  const list: THREE.BufferGeometry[] = [];
  for (const x of [6.4, 9.9, 15.6, 19.4]) {
    const c = WING.chord(x);
    const z0 = WING.le(x) + 0.52 * c;
    const z1 = WING.te(x) + 1.3;
    const yTop = surf(x, 0.6, false).y + 0.05;
    const len = z1 - z0;
    const rings: number[][] = [];
    const n = 9;
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      const z = z0 + u * len;
      // Deep in the middle, pointed at both ends, drooping aft.
      const depth = 0.62 * Math.sin(Math.PI * Math.pow(u, 0.8)) + 0.02;
      const w = 0.24 * Math.sin(Math.PI * Math.pow(u, 0.7)) + 0.01;
      const yc = yTop - depth * 0.5 - u * 0.1;
      const r: number[] = [];
      for (let k = 0; k < n * 2; k++) {
        const a = (k / (n * 2)) * Math.PI * 2;
        r.push(x + Math.sin(a) * w, yc + Math.cos(a) * depth * 0.5 + (Math.cos(a) > 0 ? 0.06 : 0), z);
      }
      rings.push(r);
    }
    list.push(tint(loftGeometry(rings, { closed: true }), FAIRING, 0.4, 0.05));
  }
  return merge(list);
}

export function buildWingRight(): WingSideBuild {
  const panel = buildPanel();
  const winglet = buildWinglet();
  const tipLE = surf(WING.tipX, 0.02, true);
  const tipTE = surf(WING.tipX - 0.15, 0.97, true);
  const housing = (p: THREE.Vector3, r: number) => tint(new THREE.SphereGeometry(r, 10, 6).scale(1, 0.55, 1.6).translate(p.x, p.y, p.z), 0xd9dde0, 0.3, 0.1);
  const navLight = V(WING.tipX + 0.06, tipLE.y - 0.02, tipLE.z + 0.35);
  const tailLight = V(WING.tipX - 0.05, tipTE.y, WING.te(WING.tipX) + 0.05);
  const strobe = V(WING.tipX + 0.08, tipLE.y - 0.05, tipLE.z + 0.75);
  const landingLamp = surf(4.4, 0.012, false, -0.02);
  const turnoffLamp = surf(3.5, 0.01, false, -0.02);
  const parts = merge([winglet.geo, buildCanoes(), housing(navLight, 0.09), housing(strobe, 0.08), housing(tailLight, 0.07)]);
  return {
    panel,
    parts,
    flaps: { inboard: buildFlap(...WING.flapInboard), outboard: buildFlap(...WING.flapOutboard) },
    ailerons: { inboard: buildAileron(...WING.aileronInboard), outboard: buildAileron(...WING.aileronOutboard) },
    spoilers: { inboard: buildSpoiler(...WING.spoilerInboard), outboard: buildSpoiler(...WING.spoilerOutboard) },
    kruegers: { inboard: buildKrueger(...WING.kruegerInboard), outboard: buildKrueger(...WING.kruegerOutboard) },
    navLight,
    tailLight,
    strobe,
    landingLamp,
    turnoffLamp,
  };
}

const mirrorV = (v: THREE.Vector3) => V(-v.x, v.y, v.z);

export function mirrorWing(r: WingSideBuild): WingSideBuild {
  const panel = mirrorX(r.panel);
  applyWingUV(panel);
  const parts = mirrorX(r.parts);
  const mh = (h: HingedPart) => mirrorHinge(h, applyWingUV);
  const mf = (f: FlapBuild) => mirrorFlap(f);
  return {
    panel,
    parts,
    flaps: { inboard: mf(r.flaps.inboard), outboard: mf(r.flaps.outboard) },
    ailerons: { inboard: mh(r.ailerons.inboard), outboard: mh(r.ailerons.outboard) },
    spoilers: { inboard: mh(r.spoilers.inboard), outboard: mh(r.spoilers.outboard) },
    kruegers: { inboard: mh(r.kruegers.inboard), outboard: mh(r.kruegers.outboard) },
    navLight: mirrorV(r.navLight),
    tailLight: mirrorV(r.tailLight),
    strobe: mirrorV(r.strobe),
    landingLamp: mirrorV(r.landingLamp),
    turnoffLamp: mirrorV(r.turnoffLamp),
  };
}

export { BLUE, GOLD };
