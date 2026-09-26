/**
 * USS Iowa hull and main-deck geometry: the skin lofted from the physics' station table (the mesh
 * the tests hold to the table), the teak main deck, the underwater details the two-segment sections
 * can't carry (the bulbous forefoot, the twin skegs round the inboard shafts, bilge keels, the
 * outboard shafts and their struts), the barbettes, the hull number 61 on both bows, the fantail
 * helicopter pad and its markings, and the deck fittings (anchors and cables, wildcats, bitts,
 * lifelines, jack staff and ensign staff). Everything is split at IOWA_SHAPE.zBreak into the bow and
 * stern halves (the crash breaks her in two). Returns plain geometries per material.
 */
import * as THREE from 'three';
import { tint, merge, plain } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import { splitByTriangles } from '../../aircraft/breakup';
import { buildHullDeck, buildHullShell, sectionBottomY, sectionHalfBreadth } from '../hullLoft';
import { gridGeometry, boxMinMax, type P3 } from '../geom';
import { DECK_CAMBER, IOWA_SHAPE as S, STATIONS, TURRETS, WC, by, bz, deckY, sec } from './shape';
import { IOWA_COLORS as C } from './materials';

export interface HullHalf {
  /** The lofted skin (exactly the station table) — hull material. */
  shell: THREE.BufferGeometry;
  /** Teak main deck — deck material. */
  deck: THREE.BufferGeometry;
  /** Bulb, skegs, bilge keels — hull material (null when the half has none). */
  under: THREE.BufferGeometry | null;
  /** Barbettes, shafts and struts, hull number, helipad — gray parts material. */
  gray: THREE.BufferGeometry | null;
  /** Small deck fittings (drawn only up close) — gray parts material. */
  fittings: THREE.BufferGeometry | null;
}

export interface HullGeometry {
  bow: HullHalf;
  stern: HullHalf;
}

const range = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

/** Split into [bow, stern] by triangle centroid z. */
function split(g: THREE.BufferGeometry): [THREE.BufferGeometry | null, THREE.BufferGeometry | null] {
  const [a, b] = splitByTriangles(g, 2, (_x, _y, z) => (z < S.zBreak ? 0 : 1));
  g.dispose();
  return [a, b];
}

/** The bulbous forefoot (a modest bulb, as the Iowas were built with), below the waterline. */
function bulb(): THREE.BufferGeometry {
  return plain(ellipsoid(V(0, by(-8.3), bz(8.6)), 2.1, 2.3, 7.4, 20, 12));
}

/** Twin skegs round the inboard shafts: plates from the hull bottom down to a line under the shaft. */
function skegs(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const inboard = WC.propulsors.filter((p) => Math.abs(p.position.x) < 6);
  for (const p of inboard) {
    const x0 = p.position.x;
    const zEnd = p.position.z - 1.1;
    const zStart = bz(172);
    const zs = range(zStart, zEnd, 24);
    const bottomAt = (z: number) => {
      const t = (z - zStart) / (zEnd - zStart);
      return by(-11.33) + (p.position.y - 1.3 - by(-11.33)) * t;
    };
    const topAt = (z: number) => sectionBottomY(sec(z), x0) + 0.5;
    const half = (z: number) => 0.75 - 0.35 * ((z - zStart) / (zEnd - zStart));
    for (const side of [-1, 1]) {
      const grid: P3[][] = zs.map((z) => {
        const lo = Math.min(bottomAt(z), topAt(z));
        return [[x0 + side * half(z), lo, z], [x0 + side * half(z), topAt(z), z]];
      });
      out.push(gridGeometry(grid, [side, 0, 0]));
    }
    // the skeg's keel strip and its aft face
    out.push(gridGeometry(zs.map((z) => [[x0 - half(z), Math.min(bottomAt(z), topAt(z)), z], [x0 + half(z), Math.min(bottomAt(z), topAt(z)), z]] as P3[]), [0, -1, 0]));
    const zl = zs[zs.length - 1];
    out.push(gridGeometry([[[x0 - half(zl), bottomAt(zl), zl], [x0 + half(zl), bottomAt(zl), zl]], [[x0 - half(zl), topAt(zl), zl], [x0 + half(zl), topAt(zl), zl]]], [0, 0, 1]));
  }
  return out.map(plain);
}

/** Bilge keels along the turn of the bilge (the "chine" of the sections), angled out and down. */
function bilgeKeels(): THREE.BufferGeometry[] {
  const zs = range(bz(78), bz(192), 40);
  const out: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const grid: P3[][] = zs.map((z) => {
      const s = sec(z);
      const t = Math.min(1, (z - zs[0]) / 12, (zs[zs.length - 1] - z) / 12);
      const w = 1.0 * t;
      const x = s.chineHalf - 0.2;
      const y = sectionBottomY(s, x) + 0.05;
      return [[side * x, y, z], [side * (x + w * 0.72), y - w * 0.72, z]];
    });
    out.push(gridGeometry(grid, [side, -1, 0]));
  }
  return out.map(plain);
}

/** Outboard shafts (bare, from where they leave the hull) with a V-strut ahead of the propeller; stubs aft of the skegs. */
function shafts(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const p of WC.propulsors) {
    const { x, y, z } = p.position;
    const hub = z - 0.9;
    if (Math.abs(x) < 6) {
      out.push(tint(tube(V(x, y, hub - 1.4), V(x, y, hub), 0.5, 0.42, 14), C.bronze, 0.4, 0.8));
      continue;
    }
    // march forward from the propeller until the hull bottom comes down to the shaft
    let zExit = hub;
    while (zExit > bz(150) && sectionBottomY(sec(zExit), x) > y + 0.4) zExit -= 0.5;
    out.push(tint(tube(V(x, y, zExit), V(x, y, hub), 0.48, 0.44, 14), C.hazeDark, 0.5, 0.6));
    // V-strut 3 m ahead of the propeller: two legs up to the hull
    const zs = z - 3.2;
    for (const dx of [-2.2, 1.6]) {
      const top = sectionBottomY(sec(zs), x + dx) + 0.4;
      out.push(tint(tube(V(x, y, zs), V(x + dx, top, zs), 0.26, 0.26, 8), C.hazeDark, 0.5, 0.5));
    }
    out.push(tint(ellipsoid(V(x, y, zs), 0.75, 0.75, 1.6, 12, 8), C.hazeDark, 0.5, 0.5));
  }
  return out;
}

/** The three barbettes: from the deck (or from inside the hull) up to each turret's floor. */
function barbettes(): THREE.BufferGeometry[] {
  return TURRETS.map((t) => {
    const top = t.position.y - 0.05;
    const bot = deckY(0, t.position.z) - 1.0;
    const g = new THREE.CylinderGeometry(S.barbetteR, S.barbetteR + 0.05, top - bot, 48, 1, true);
    g.translate(t.position.x, (top + bot) / 2, t.position.z);
    // a darker ring where the turret sits
    const ring = new THREE.CylinderGeometry(S.barbetteR + 0.08, S.barbetteR + 0.08, 0.35, 48, 1, true);
    ring.translate(t.position.x, top - 0.2, t.position.z);
    return merge([tint(g, C.haze, 0.7, 0.1), tint(ring, C.hazeDark, 0.7, 0.1)]);
  });
}

/**
 * Block digits on the hull side (white with the black drop shadow the Navy paints), following the
 * flared skin. `u` runs in the reading direction; on starboard that is toward the bow's opposite
 * (aft → forward reads left to right), so the digits mirror sides correctly.
 */
function hullNumber(): THREE.BufferGeometry[] {
  const segs: Record<string, [number, number, number, number][]> = {
    // rectangles in a 1 × 2 cell: u0, v0, u1, v1 (v up)
    '6': [[0, 1.82, 1, 2], [0, 0, 0.2, 2], [0, 0.91, 1, 1.09], [0.8, 0, 1, 1.0], [0, 0, 1, 0.18]],
    '1': [[0.55, 0, 0.8, 2], [0.3, 1.7, 0.6, 1.95]],
  };
  const hn = S.hullNumber;
  const cellH = hn.height / 2;
  const cellW = cellH * 1.05;
  const gap = cellW * 0.45;
  const out: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1] as const) {
    const text = '61';
    text.split('').forEach((ch, k) => {
      for (const [u0, v0, u1, v1] of segs[ch]) {
        for (const [off, du, dv, color] of [[0.05, 0.22, -0.22, C.black], [0.1, 0, 0, C.white]] as const) {
          const grid: P3[][] = [];
          for (const v of [v0, v1]) {
            const row: P3[] = [];
            for (const u of [u0, u1]) {
              const ur = k * (cellW + gap) + u * cellW + du;
              const s = side > 0 ? hn.s1 - ur : hn.s0 + ur;
              const z = bz(s);
              const y = by(hn.base + v * cellH + dv);
              const x = sectionHalfBreadth(sec(z), y) + off;
              row.push([side * x, y, z]);
            }
            grid.push(row);
          }
          out.push(tint(gridGeometry(grid, [side, 0, 0]), color, 0.6, 0));
        }
      }
    });
  }
  return out;
}

/** A patch lying on the cambered main deck: x0…x1 across, z0…z1 along, `lift` above the planks. */
function onDeck(x0: number, x1: number, z0: number, z1: number, lift: number, nx = 6, nz = 6): THREE.BufferGeometry {
  const grid: P3[][] = [];
  for (let i = 0; i <= nz; i++) {
    const z = z0 + ((z1 - z0) * i) / nz;
    const row: P3[] = [];
    for (let j = 0; j <= nx; j++) {
      const x = x0 + ((x1 - x0) * j) / nx;
      row.push([x, deckY(x, z) + lift, z]);
    }
    grid.push(row);
  }
  return gridGeometry(grid, [0, 1, 0]);
}

/** The fantail helicopter pad: non-skid square, white edge lines, a yellow touchdown circle and a dashed line-up line. */
function helipad(): THREE.BufferGeometry[] {
  const h = S.helipad;
  const zc = bz(h.s);
  const a = h.half;
  const out: THREE.BufferGeometry[] = [tint(onDeck(-a, a, zc - a, zc + a, 0.03, 12, 12), C.nonSkid, 0.95, 0)];
  const w = 0.35;
  const line = (x0: number, x1: number, z0: number, z1: number, color: number) => out.push(tint(onDeck(x0, x1, z0, z1, 0.06, 2, Math.max(1, Math.round(Math.abs(z1 - z0) / 2))), color, 0.7, 0));
  line(-a, a, zc - a, zc - a + w, C.white);
  line(-a, a, zc + a - w, zc + a, C.white);
  line(-a, -a + w, zc - a, zc + a, C.white);
  line(a - w, a, zc - a, zc + a, C.white);
  for (let k = -5; k <= 5; k += 2) line(-w / 2, w / 2, zc + k * 1.9 - 0.9, zc + k * 1.9 + 0.9, C.white);
  // touchdown circle: a ring of short segments on the cambered deck
  const n = 64;
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) * Math.PI * 2;
    const t1 = ((i + 1) / n) * Math.PI * 2;
    const grid: P3[][] = [];
    for (const r of [h.circleR - 0.25, h.circleR + 0.25]) {
      const row: P3[] = [];
      for (const t of [t0, t1]) {
        const x = r * Math.cos(t);
        const z = zc + r * Math.sin(t);
        row.push([x, deckY(x, z) + 0.07, z]);
      }
      grid.push(row);
    }
    out.push(tint(gridGeometry(grid, [0, 1, 0]), C.yellow, 0.7, 0));
  }
  return out;
}

/** A stockless anchor housed in its hawse at the bow: the shank up into the hawse pipe, the crown and two flukes against the flare. */
function anchor(side: 1 | -1, s: number): THREE.BufferGeometry[] {
  const z = bz(s);
  const y = by(8.6);
  const x = sectionHalfBreadth(sec(z), y) + 0.3;
  const k = C.black;
  const out: THREE.BufferGeometry[] = [
    // hawse pipe lip
    tint(ellipsoid(V(side * (x - 0.15), y + 0.9, z), 0.25, 0.7, 0.75, 12, 8), C.hazeDark, 0.7, 0.3),
    // shank
    tint(boxMinMax(side * x - 0.22, y - 2.2, z - 0.22, side * x + 0.22, y + 0.9, z + 0.22), k, 0.6, 0.5),
    // crown
    tint(boxMinMax(side * x - 0.3, y - 2.6, z - 0.55, side * x + 0.3, y - 2.0, z + 0.55), k, 0.6, 0.5),
  ];
  for (const dz of [-1, 1]) {
    // flukes: tapered plates from the crown up and out, fore and aft
    out.push(tint(tube(V(side * x, y - 2.3, z + dz * 0.45), V(side * x, y - 0.9, z + dz * 1.25), 0.34, 0.12, 4), k, 0.6, 0.5));
  }
  // the cable from the hawse pipe's deck end aft to the wildcat
  out.push(tint(tube(V(side * (x - 0.6), deckY(side * (x - 0.6), z) + 0.1, z), V(side * (x - 1.4), deckY(side * (x - 1.4), z) + 0.1, z + 0.6), 0.4, 0.4, 10), C.hazeDark, 0.6, 0.4));
  return out;
}

/** Small fittings: anchors and their cables to the wildcats, capstans, bitts, lifelines, staffs. */
function fittings(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const dark = C.hazeDark;
  for (const side of [-1, 1] as const) {
    out.push(...anchor(side, 17));
    // anchor cables along the deck from the hawse to the wildcats (a chain of links as a flat strip)
    const z0 = bz(19);
    const z1 = bz(33);
    const xh = sectionHalfBreadth(sec(z0), sec(z0).deckY) - 1.3;
    const pts: THREE.Vector3[] = range(0, 1, 14).map((t) => {
      const z = z0 + (z1 - z0) * t;
      const x = side * (xh + (2.6 - xh) * t);
      return V(x, deckY(x, z) + 0.12, z);
    });
    for (let i = 0; i < pts.length - 1; i++) out.push(tint(tube(pts[i], pts[i + 1], 0.14, 0.14, 6), C.black, 0.8, 0.4));
    // wildcats and capstans
    for (const [s, r, h] of [[33.5, 1.1, 0.9], [40, 0.9, 1.1]] as const) {
      const z = bz(s);
      const g = new THREE.CylinderGeometry(r, r * 1.1, h, 16);
      g.translate(side * 2.8, deckY(2.8, z) + h / 2, z);
      out.push(tint(g, dark, 0.6, 0.4));
    }
    // mooring bitts along the deck edge
    for (const s of [28, 52, 140, 180, 214, 232, 258]) {
      const z = bz(s);
      const x = side * (sec(z).deckHalf - 1.6);
      for (const dz of [-0.6, 0.6]) {
        const g = new THREE.CylinderGeometry(0.28, 0.3, 0.9, 10);
        g.translate(x, deckY(x, z + dz) + 0.45, z + dz);
        out.push(tint(g, dark, 0.6, 0.3));
      }
    }
    // lifelines: stanchions every 3 m and two wires along the deck edge
    const zs = range(bz(3), bz(269), 88);
    const edge = (z: number) => sec(z).deckHalf - 0.12;
    for (const z of zs) {
      const x = side * edge(z);
      const y0 = sec(z).deckY;
      out.push(tint(boxMinMax(x - 0.03, y0, z - 0.03, x + 0.03, y0 + 1.0, z + 0.03), dark, 0.6, 0.3));
    }
    for (const hgt of [0.5, 0.98]) {
      for (let i = 0; i < zs.length - 1; i++) {
        const a = V(side * edge(zs[i]), sec(zs[i]).deckY + hgt, zs[i]);
        const b = V(side * edge(zs[i + 1]), sec(zs[i + 1]).deckY + hgt, zs[i + 1]);
        out.push(tint(tube(a, b, 0.025, 0.025, 4, true), dark, 0.6, 0.3));
      }
    }
  }
  // jack staff at the stem head, ensign staff at the fantail
  const stem = STATIONS[0];
  out.push(tint(tube(V(0, stem.deckY, stem.z + 0.6), V(0, stem.deckY + 5.5, stem.z + 0.6), 0.08, 0.05, 6), C.hazeDark, 0.6, 0.3));
  const tr = STATIONS[STATIONS.length - 1];
  out.push(tint(tube(V(0, tr.deckY, tr.z - 0.8), V(0, tr.deckY + 6.5, tr.z - 0.8), 0.09, 0.05, 6), C.hazeDark, 0.6, 0.3));
  // mushroom ventilators on the forecastle and the quarterdeck
  for (const [s, x] of [[46, 5], [46, -5], [205, 8], [205, -8], [214, 3.5], [214, -3.5]] as const) {
    const z = bz(s);
    const y = deckY(x, z);
    out.push(tint(tube(V(x, y, z), V(x, y + 1.1, z), 0.35, 0.35, 10), C.haze, 0.7, 0.1));
    out.push(tint(ellipsoid(V(x, y + 1.15, z), 0.6, 0.25, 0.6, 12, 6), C.haze, 0.7, 0.1));
  }
  return out;
}

export function buildHull(): HullGeometry {
  const [shellBow, shellStern] = split(buildHullShell(STATIONS, { maxStep: 1.5, bottomSegments: 6, sideSegments: 8, capBow: true, capStern: true }));
  const [deckBow, deckStern] = split(plain(buildHullDeck(STATIONS, { z0: STATIONS[0].z + 0.05, z1: STATIONS[STATIONS.length - 1].z, camber: DECK_CAMBER, segments: 14, maxStep: 1.5 })));
  const [underBow, underStern] = split(merge([bulb(), ...skegs(), ...bilgeKeels()]));
  const [grayBow, grayStern] = split(merge([...barbettes(), ...shafts(), ...hullNumber(), ...helipad()]));
  const [fitBow, fitStern] = split(merge(fittings()));
  if (!shellBow || !shellStern || !deckBow || !deckStern) throw new Error('iowa hull: split failed');
  return {
    bow: { shell: shellBow, deck: deckBow, under: underBow, gray: grayBow, fittings: fitBow },
    stern: { shell: shellStern, deck: deckStern, under: underStern, gray: grayStern, fittings: fitStern },
  };
}
