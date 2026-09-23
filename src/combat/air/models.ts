/**
 * Procedural models of the enemy aircraft, in the body frame (origin = the hit box centre = CG,
 * −Z nose, +Y up, +X right wing), real proportions from CONFIG.combat.targets:
 *
 *  - MiG-29 "Fulcrum" (9.12): ogival radome and pitot, bubble canopy and dorsal spine, the big
 *    sharply swept wing-root LERX, widely spaced engine nacelles under a flat centre body with
 *    raked intakes, 42° wing, canted twin fins, all-moving stabilators, R-73s on pylons; two-tone
 *    grey camouflage, red stars on the fins and wings, a bort number on the intakes.
 *  - Su-25 "Frogfoot": long pointed nose (laser window), armoured cockpit, straight-ish shoulder
 *    wing with split-airbrake tip pods, conformal engine nacelles, tall single fin, rocket pods and
 *    bombs; four-tone desert/green camouflage, pale blue underside.
 *  - Mi-24 "Hind": tandem stepped bubble cockpits, chin turret, engine housing and rotor mast on
 *    top, anhedral stub wings with rocket pods and ATGM rails, tail boom with a swept fin and the
 *    tail rotor on the left; tan/green camouflage, yellow bort number.
 *
 * Parts (so the shoot-down can throw one away): 'body', 'wingL', 'wingR', 'tail' (jets);
 * 'body', 'tailRotor', 'blades' (the helicopter; the spinning rotors are blur discs drawn by the
 * renderer; 'blades' = the stopped, broken main rotor on a wreck). Two levels of detail.
 * The decal atlas (red star, stencil digits) is a small procedural DataTexture.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { AirKind } from '../types';
import { Geo, surf, type Station, type Surf } from './geom';

export type AirPart = 'body' | 'wingL' | 'wingR' | 'tail' | 'tailRotor' | 'blades';
export type AirLod = 0 | 1;

export interface AirModel {
  kind: AirKind;
  lod: AirLod;
  parts: Partial<Record<AirPart, THREE.BufferGeometry>>;
  /** Centroid of each separable part (body frame) — it tumbles about this. */
  pivots: Partial<Record<AirPart, THREE.Vector3>>;
  triangles: number;
}

export interface AirFixtures {
  /** Nav lights: red left, green right, white tail (body frame). */
  navRed: THREE.Vector3;
  navGreen: THREE.Vector3;
  navWhite: THREE.Vector3;
  beacons: THREE.Vector3[];
  /** Hot nozzles (glow aft). */
  nozzles: THREE.Vector3[];
  nozzleRadius: number;
  /** Rotors: hub centre (body), radius, blades, disc axis ('y' main, 'x' tail). */
  rotors: { hub: THREE.Vector3; radius: number; blades: number; axis: 'x' | 'y' }[];
  /** Where flares come out (body). */
  flareOrigin: THREE.Vector3;
}

// ── Atlas: 512 × 128 — star (0..127), white texel block (128..143), digits 0–9 (32 × 56 each from x = 160) ──
export const ATLAS_W = 512;
export const ATLAS_H = 128;
export const STAR_UV: [number, number, number, number] = [1 / ATLAS_W, 1 / ATLAS_H, 127 / ATLAS_W, 127 / ATLAS_H];
export const DIGIT_W = 32 / ATLAS_W;
/** Digit 0's cell (the shader shifts u by digit × DIGIT_W). */
export const DIGIT0_UV: [number, number, number, number] = [160 / ATLAS_W, 8 / ATLAS_H, 192 / ATLAS_W, 64 / ATLAS_H];

/** Blocky stencil-style digits on a 5 × 9 grid: segments as rectangles [x0, y0, x1, y1] (y up). */
const SEG = {
  a: [0, 8, 5, 9], b: [4, 4.5, 5, 9], c: [4, 0, 5, 4.5], d: [0, 0, 5, 1], e: [0, 0, 1, 4.5], f: [0, 4.5, 1, 9], g: [0, 4, 5, 5],
} as const;
const DIGITS: (keyof typeof SEG)[][] = [
  ['a', 'b', 'c', 'd', 'e', 'f'], ['b', 'c'], ['a', 'b', 'g', 'e', 'd'], ['a', 'b', 'g', 'c', 'd'], ['f', 'g', 'b', 'c'],
  ['a', 'f', 'g', 'c', 'd'], ['a', 'f', 'g', 'e', 'c', 'd'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['a', 'b', 'c', 'd', 'f', 'g'],
];

function inStar(x: number, y: number, R: number, r: number): boolean {
  // 5-point star, one point up, centred at the origin (x right, y up): inside the pentagon or one of the arms.
  const a = Math.atan2(x, y);
  const d = Math.hypot(x, y);
  const k = (2 * Math.PI) / 5;
  let t = ((a % k) + k) % k;
  if (t > k / 2) t = k - t;
  // edge from the point (angle 0, radius R) to the notch (angle k/2, radius r)
  const px = 0, py = R;
  const qx = r * Math.sin(k / 2), qy = r * Math.cos(k / 2);
  const ex = Math.sin(t) * d, ey = Math.cos(t) * d;
  const cross = (qx - px) * (ey - py) - (qy - py) * (ex - px);
  return cross <= 0;
}

let atlas: THREE.DataTexture | null = null;

/** The decal atlas (sRGB): red star with white and red borders, white digits with a dark outline. */
export function airAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * ATLAS_W + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  };
  // white block
  for (let y = 0; y < 16; y++) for (let x = 128; x < 144; x++) put(x, y, 255, 255, 255, 255);
  // star, 4 × 4 supersampled: outer red rim, white band, red star
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      let rim = 0, white = 0, red = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = (x + (sx + 0.5) / 4 - 64) / 60;
          const v = (y + (sy + 0.5) / 4 - 60) / 60;
          if (inStar(u, v, 1.0, 0.41)) rim++;
          if (inStar(u, v, 0.93, 0.38)) white++;
          if (inStar(u, v, 0.8, 0.33)) red++;
        }
      }
      const cover = rim / 16;
      if (cover <= 0) continue;
      const w = (white - red) / 16;
      const rr = red / 16;
      const rimOnly = (rim - white) / 16;
      const tot = Math.max(1e-6, w + rr + rimOnly);
      const r = (255 * w + 200 * rr + 190 * rimOnly) / tot;
      const g = (255 * w + 22 * rr + 20 * rimOnly) / tot;
      const b = (255 * w + 26 * rr + 24 * rimOnly) / tot;
      put(x, y, r, g, b, Math.round(cover * 255));
    }
  }
  // digits: white fill, dark outline, on a transparent cell
  for (let d = 0; d < 10; d++) {
    const x0 = 160 + d * 32;
    for (let y = 8; y < 64; y++) {
      for (let x = x0; x < x0 + 32; x++) {
        // glyph space: 5 × 9 units in a 26 × 50 px box, 3 px margin
        const gx = ((x + 0.5 - x0 - 3) / 26) * 5;
        const gy = ((y + 0.5 - 8 - 3) / 50) * 9;
        let dist = Infinity;
        for (const s of DIGITS[d]) {
          const [a0, b0, a1, b1] = SEG[s];
          const dx = Math.max(a0 - gx, 0, gx - a1);
          const dy = Math.max(b0 - gy, 0, gy - b1);
          dist = Math.min(dist, Math.hypot(dx, dy));
        }
        if (dist <= 0) put(x, y, 255, 255, 255, 255);
        else if (dist < 0.32) put(x, y, 18, 18, 18, 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  atlas = tex;
  return tex;
}

// ── Surfaces ──
const CAMO = surf(0xffffff, 1, 0.62, 0.05);
const RADOME_MIG = surf(0xb9bdb5, 0, 0.5);
const GLASS = surf(0x1d2a33, 0, 0.06, 0.6);
const GLASS_FRAME = surf(0x3a4146, 0, 0.5, 0.2);
const METAL = surf(0x6a6660, 0, 0.42, 0.85);
const METAL_DARK = surf(0x3a3632, 0, 0.5, 0.7);
const GLOW = surf(0x2a1810, 0, 0.8, 0, 1);
const INTAKE = surf(0x0c0c0d, 0, 0.9);
const MISSILE = surf(0xd6d8d2, 0, 0.45, 0.1);
const POD = surf(0x6c7258, 0, 0.6, 0.1);
const BOMB = surf(0x4e5640, 0, 0.6, 0.1);
const LASER = surf(0x2a3a44, 0, 0.05, 0.7);
const ROTOR = surf(0x2a2d30, 0, 0.55, 0.2);
const STAR = surf(0xffffff, 4, 0.55);
const digitSurf = (hex: number, which: 2 | 3): Surf => surf(hex, which, 0.55);

const DEG = Math.PI / 180;
const rotX = (deg: number) => new THREE.Matrix4().makeRotationX(deg * DEG);
const tr = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

/** A small missile/pod: pointed or blunt body with four fins (LOD0). */
function store(g: Geo, x: number, y: number, z0: number, len: number, r: number, s: Surf, pointed: boolean, fins: boolean, seg = 8): void {
  const nose = pointed ? len * 0.18 : r * 0.6;
  g.loft([
    { z: z0, y, x, w: pointed ? 0.01 : r * 0.55, ht: pointed ? 0.01 : r * 0.55, hb: pointed ? 0.01 : r * 0.55 },
    { z: z0 + nose, y, x, w: r, ht: r, hb: r },
    { z: z0 + len - r * 0.4, y, x, w: r, ht: r, hb: r },
    { z: z0 + len, y, x, w: r * 0.7, ht: r * 0.7, hb: r * 0.7 },
  ], seg, s);
  if (fins) {
    const fz = z0 + len - len * 0.18;
    for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.wing([x + ux * r, y + uy * r, fz], [x + ux * r * 3, y + uy * r * 3, fz + len * 0.08], len * 0.16, len * 0.08, [uy, ux, 0].map(Math.abs) as [number, number, number], 0.06, 0.06, s, 2);
    }
  }
}

/** Pylon under a wing: a thin fairing from the wing to the store. */
function pylon(g: Geo, x: number, yTop: number, yBot: number, z0: number, z1: number, s: Surf): void {
  g.box(x, (yTop + yBot) / 2, (z0 + z1) / 2, 0.05, (yTop - yBot) / 2, (z1 - z0) / 2, s);
}

// ── MiG-29 ──────────────────────────────────────────────────────────────────

function buildFighter(lod: AirLod): AirModel {
  const hi = lod === 0;
  const seg = hi ? 18 : 8;
  const body = new Geo();
  // Radome + nose.
  const nose: Station[] = [
    { z: -7.78, y: 0.02, w: 0.02, ht: 0.02, hb: 0.02 },
    { z: -7.35, y: 0.03, w: 0.26, ht: 0.26, hb: 0.25 },
    { z: -6.75, y: 0.05, w: 0.43, ht: 0.43, hb: 0.42 },
    { z: -6.3, y: 0.07, w: 0.51, ht: 0.5, hb: 0.48 },
  ];
  body.loft(hi ? nose : [nose[0], nose[2], nose[3]], seg, RADOME_MIG, false, false);
  if (hi) body.tube(0, 0.02, -8.68, -7.7, 0.025, 0.035, 5, METAL_DARK);
  const fus: Station[] = [
    { z: -6.3, y: 0.07, w: 0.51, ht: 0.5, hb: 0.48 },
    { z: -5.4, y: 0.1, w: 0.62, ht: 0.6, hb: 0.55, n: 2.2 },
    { z: -4.3, y: 0.14, w: 0.7, ht: 0.68, hb: 0.58, n: 2.3 },
    { z: -3.1, y: 0.16, w: 0.78, ht: 0.66, hb: 0.6, n: 2.5 },
    { z: -1.8, y: 0.2, w: 0.84, ht: 0.58, hb: 0.52, n: 2.8 },
    { z: -0.3, y: 0.24, w: 0.88, ht: 0.48, hb: 0.46, n: 3 },
    { z: 1.8, y: 0.26, w: 0.8, ht: 0.42, hb: 0.38, n: 3 },
    { z: 4.2, y: 0.26, w: 0.62, ht: 0.34, hb: 0.3, n: 3 },
    { z: 6.8, y: 0.22, w: 0.38, ht: 0.2, hb: 0.2, n: 2.6 },
    { z: 7.9, y: 0.2, w: 0.22, ht: 0.1, hb: 0.1 },
  ];
  body.loft(hi ? fus : [fus[0], fus[2], fus[4], fus[6], fus[8], fus[9]], seg, CAMO, false, true);
  // Dorsal spine behind the canopy.
  body.loft([
    { z: -4.0, y: 0.72, w: 0.3, ht: 0.3, hb: 0.25 },
    { z: -2.6, y: 0.78, w: 0.38, ht: 0.22, hb: 0.3 },
    { z: 0.5, y: 0.66, w: 0.42, ht: 0.12, hb: 0.3 },
    { z: 3.6, y: 0.48, w: 0.36, ht: 0.06, hb: 0.25 },
  ], hi ? 10 : 6, CAMO, false, false);
  // Canopy (bubble) and windscreen frame.
  body.ellipsoid(0, 0.72, -4.65, 0.42, 0.5, 1.28, GLASS, hi ? 16 : 8, hi ? 6 : 3, false);
  if (hi) body.box(0, 0.98, -5.62, 0.36, 0.03, 0.05, GLASS_FRAME);
  // Flat centre body between the nacelles.
  body.loft([
    { z: -2.4, y: 0.0, w: 1.2, ht: 0.3, hb: 0.3, n: 4 },
    { z: 0.5, y: 0.02, w: 1.6, ht: 0.32, hb: 0.3, n: 4 },
    { z: 4.0, y: 0.02, w: 1.45, ht: 0.3, hb: 0.28, n: 4 },
    { z: 6.6, y: 0.05, w: 1.1, ht: 0.22, hb: 0.22, n: 4 },
  ], hi ? 16 : 8, CAMO, true, true);
  // LERX (both sides) — thin, sharply swept, from the cockpit to the wing root.
  for (const sgn of [-1, 1]) {
    body.wing([sgn * 0.6, 0.18, -4.7], [sgn * 2.25, 0.12, -0.3], 6.6, 2.4, [0, 1, 0], 0.035, 0.05, CAMO, hi ? 6 : 2);
    // Nacelle with a raked rectangular intake under the LERX.
    const x = sgn * 1.02;
    const nac: Station[] = [
      { z: -3.3, x, y: -0.66, w: 0.46, ht: 0.34, hb: 0.36, n: 5 },
      { z: -1.6, x, y: -0.6, w: 0.5, ht: 0.42, hb: 0.42, n: 4 },
      { z: 1.0, x: sgn * 0.98, y: -0.46, w: 0.58, ht: 0.5, hb: 0.45, n: 3 },
      { z: 4.5, x: sgn * 0.95, y: -0.34, w: 0.56, ht: 0.5, hb: 0.46, n: 2.5 },
      { z: 6.9, x: sgn * 0.92, y: -0.26, w: 0.5, ht: 0.46, hb: 0.46, n: 2.2 },
    ];
    body.loft(hi ? nac : [nac[0], nac[2], nac[4]], hi ? 14 : 6, CAMO, false, false);
    body.loft([{ z: -3.28, x, y: -0.66, w: 0.4, ht: 0.29, hb: 0.3, n: 5 }, { z: -3.1, x, y: -0.66, w: 0.38, ht: 0.27, hb: 0.28, n: 5 }], hi ? 12 : 6, INTAKE, true, false);
    // Nozzle (convergent petals) with the hot interior.
    body.tube(sgn * 0.92, -0.26, 6.9, 8.08, 0.48, 0.42, hi ? 14 : 6, METAL, false, false);
    body.tube(sgn * 0.92, -0.26, 7.3, 8.02, 0.38, 0.38, hi ? 12 : 6, GLOW, false, true);
    // Stabilator (all-moving, slight anhedral).
    body.wing([sgn * 1.4, -0.2, 5.5], [sgn * 3.9, -0.34, 7.2], 2.45, 0.9, [0, 1, 0], 0.04, 0.035, CAMO, hi ? 6 : 2);
    if (hi) {
      // ventral strakes under the nacelles
      body.wing([sgn * 1.05, -0.8, 3.6], [sgn * 1.15, -1.25, 4.4], 1.5, 0.7, [sgn, 0, 0], 0.05, 0.05, CAMO, 2);
    }
  }
  // Bort number on the intakes.
  const bortHex = 0x2f5fb4;
  if (hi) {
    for (const sgn of [-1, 1]) {
      const n: [number, number, number] = [sgn, 0, 0];
      const up: [number, number, number] = [0, 1, 0];
      // text axis r = up × n
      const rz = -sgn; // r = (0,0,−sgn)
      const cx = sgn * 1.49, cy = -0.6, cz = -2.35;
      body.decal([cx, cy, cz - rz * 0.19], n, up, 0.34, 0.56, [...DIGIT0_UV], digitSurf(bortHex, 2), 0.02);
      body.decal([cx, cy, cz + rz * 0.19], n, up, 0.34, 0.56, [...DIGIT0_UV], digitSurf(bortHex, 3), 0.02);
    }
  }

  // Outer wings (separable).
  const wing = (sgn: number) => {
    const g = new Geo();
    g.wing([sgn * 2.2, 0.12, -0.3], [sgn * 5.7, 0.0, 2.85], 3.35, 1.2, [0, 1, 0], 0.05, 0.04, CAMO, hi ? 7 : 2, hi ? 2 : 1);
    if (hi) {
      // R-73 on the outer pylon, R-27 inboard
      pylon(g, sgn * 4.35, 0.02, -0.28, 1.55, 3.0, CAMO);
      store(g, sgn * 4.35, -0.4, 1.1, 2.9, 0.085, MISSILE, true, true);
      pylon(g, sgn * 3.25, 0.05, -0.28, 0.6, 2.4, CAMO);
      store(g, sgn * 3.25, -0.44, -0.2, 4.0, 0.12, MISSILE, true, true);
    }
    // Stars on top and underneath, near the tip.
    const c: [number, number, number] = [sgn * 4.55, 0.1, 2.35];
    g.decal(c, [0, 1, 0], [0, 0, -1], 1.05, 1.05, STAR_UV, STAR, 0.02);
    if (hi) g.decal([sgn * 4.55, -0.02, 2.35], [0, -1, 0], [0, 0, -1], 1.05, 1.05, STAR_UV, STAR, 0.02);
    return g;
  };
  // Twin canted fins (separable as 'tail').
  const tail = new Geo();
  for (const sgn of [-1, 1]) {
    tail.wing([sgn * 1.32, 0.3, 3.55], [sgn * 1.56, 2.36, 5.75], 3.05, 1.05, [sgn, -0.11 * sgn * sgn, 0], 0.05, 0.04, CAMO, hi ? 6 : 2);
    const u = 0.42;
    const cx = sgn * (1.32 + 0.24 * u) + sgn * 0.03, cy = 0.3 + 2.06 * u, cz = 3.55 + 2.2 * u + (3.05 - 2.0 * u) * 0.52;
    tail.decal([cx, cy, cz], [sgn, -0.11, 0], [0.11 * sgn, 0.994, 0], 0.95, 0.95, STAR_UV, STAR, 0.02);
    if (hi) {
      // fin-tip antenna fairings
      tail.tube(sgn * 1.56, 2.36, 5.6, 6.9, 0.05, 0.03, 5, CAMO);
    }
  }
  return finish('fighter', lod, { body, wingL: wing(-1), wingR: wing(1), tail });
}

// ── Su-25 ───────────────────────────────────────────────────────────────────

function buildAttack(lod: AirLod): AirModel {
  const hi = lod === 0;
  const seg = hi ? 16 : 8;
  const body = new Geo();
  body.loft([{ z: -7.66, y: -0.08, w: 0.1, ht: 0.1, hb: 0.1 }, { z: -7.45, y: -0.08, w: 0.17, ht: 0.17, hb: 0.17 }], hi ? 10 : 6, LASER, true, false);
  const fus: Station[] = [
    { z: -7.45, y: -0.08, w: 0.17, ht: 0.17, hb: 0.17 },
    { z: -6.6, y: -0.06, w: 0.36, ht: 0.34, hb: 0.38, n: 2.2 },
    { z: -5.2, y: -0.02, w: 0.58, ht: 0.52, hb: 0.6, n: 2.6 },
    { z: -3.9, y: 0.04, w: 0.68, ht: 0.66, hb: 0.68, n: 2.8 },
    { z: -2.4, y: 0.1, w: 0.72, ht: 0.6, hb: 0.72, n: 2.8 },
    { z: 0.0, y: 0.16, w: 0.7, ht: 0.6, hb: 0.74, n: 2.8 },
    { z: 2.6, y: 0.24, w: 0.64, ht: 0.56, hb: 0.64, n: 2.6 },
    { z: 4.8, y: 0.34, w: 0.46, ht: 0.44, hb: 0.42, n: 2.3 },
    { z: 6.7, y: 0.46, w: 0.24, ht: 0.24, hb: 0.2 },
    { z: 7.6, y: 0.5, w: 0.1, ht: 0.1, hb: 0.1 },
  ];
  body.loft(hi ? fus : [fus[0], fus[2], fus[4], fus[6], fus[8], fus[9]], seg, CAMO, false, true);
  // Canopy + the hump behind it.
  body.ellipsoid(0, 0.66, -3.65, 0.4, 0.4, 0.95, GLASS, hi ? 14 : 8, hi ? 5 : 3, false);
  body.loft([
    { z: -3.0, y: 0.68, w: 0.3, ht: 0.3, hb: 0.2 },
    { z: -1.6, y: 0.72, w: 0.34, ht: 0.18, hb: 0.25 },
    { z: 1.5, y: 0.66, w: 0.3, ht: 0.08, hb: 0.25 },
  ], hi ? 10 : 6, CAMO, false, false);
  for (const sgn of [-1, 1]) {
    // Conformal nacelles with tall intakes.
    const x = sgn * 1.02;
    const nac: Station[] = [
      { z: -2.3, x, y: -0.12, w: 0.4, ht: 0.48, hb: 0.5, n: 3.5 },
      { z: -0.6, x, y: -0.08, w: 0.5, ht: 0.55, hb: 0.55, n: 3 },
      { z: 3.0, x: sgn * 0.98, y: 0.0, w: 0.5, ht: 0.52, hb: 0.52, n: 2.6 },
      { z: 4.6, x: sgn * 0.93, y: 0.06, w: 0.42, ht: 0.42, hb: 0.42, n: 2 },
    ];
    body.loft(hi ? nac : [nac[0], nac[2], nac[3]], hi ? 14 : 6, CAMO, false, false);
    body.loft([{ z: -2.28, x, y: -0.12, w: 0.33, ht: 0.4, hb: 0.42, n: 3.5 }, { z: -2.1, x, y: -0.12, w: 0.31, ht: 0.38, hb: 0.4, n: 3.5 }], hi ? 12 : 6, INTAKE, true, false);
    body.tube(sgn * 0.93, 0.06, 4.6, 5.35, 0.4, 0.36, hi ? 12 : 6, METAL, false, false);
    body.tube(sgn * 0.93, 0.06, 4.9, 5.3, 0.33, 0.33, hi ? 10 : 6, GLOW, false, true);
  }
  // Bort number on the nose.
  if (hi) {
    for (const sgn of [-1, 1]) {
      const rz = -sgn;
      const cx = sgn * 0.6, cy = -0.02, cz = -5.35;
      body.decal([cx, cy, cz - rz * 0.17], [sgn, 0, 0], [0, 1, 0], 0.3, 0.48, [...DIGIT0_UV], digitSurf(0xc81e1e, 2), 0.03);
      body.decal([cx, cy, cz + rz * 0.17], [sgn, 0, 0], [0, 1, 0], 0.3, 0.48, [...DIGIT0_UV], digitSurf(0xc81e1e, 3), 0.03);
    }
  }
  const wing = (sgn: number) => {
    const g = new Geo();
    g.wing([sgn * 1.25, 0.5, -0.95], [sgn * 6.95, 0.32, 1.1], 3.35, 1.35, [0, 1, 0], 0.12, 0.1, CAMO, hi ? 7 : 2, hi ? 2 : 1);
    // Tip pod (split airbrakes).
    g.loft([
      { z: 0.1, x: sgn * 7.05, y: 0.32, w: 0.03, ht: 0.03, hb: 0.03 },
      { z: 0.6, x: sgn * 7.05, y: 0.32, w: 0.15, ht: 0.15, hb: 0.15 },
      { z: 2.4, x: sgn * 7.05, y: 0.32, w: 0.15, ht: 0.15, hb: 0.15 },
      { z: 2.9, x: sgn * 7.05, y: 0.32, w: 0.08, ht: 0.03, hb: 0.03 },
    ], hi ? 8 : 5, CAMO);
    if (hi) {
      const stations = [2.25, 3.2, 4.15, 5.1];
      stations.forEach((px, i) => {
        const x = sgn * px;
        const zLe = -0.95 + (2.05 * (px - 1.25)) / 5.7;
        pylon(g, x, 0.38, 0.0, zLe + 0.4, zLe + 1.9, CAMO);
        if (i < 2) store(g, x, -0.3, zLe - 0.4, 2.7, 0.26, POD, false, false, 10);
        else store(g, x, -0.2, zLe - 0.1, 2.1, 0.16, BOMB, true, true, 8);
      });
    }
    g.decal([sgn * 5.2, 0.43, 1.2], [0, 1, 0], [0, 0, -1], 1.1, 1.1, STAR_UV, STAR, 0.03);
    if (hi) g.decal([sgn * 5.6, 0.25, 1.2], [0, -1, 0], [0, 0, -1], 1.1, 1.1, STAR_UV, STAR, 0.03);
    return g;
  };
  const tail = new Geo();
  tail.wing([0, 0.72, 3.9], [0, 3.1, 5.95], 3.1, 1.3, [1, 0, 0], 0.09, 0.07, CAMO, hi ? 6 : 2);
  for (const sgn of [-1, 1]) {
    tail.wing([sgn * 0.3, 0.55, 4.7], [sgn * 2.45, 0.8, 5.95], 2.0, 0.9, [0, 1, 0], 0.08, 0.07, CAMO, hi ? 5 : 2);
    tail.decal([sgn * 0.1, 1.75, 5.55], [sgn, 0, 0], [0, 1, 0], 1.0, 1.0, STAR_UV, STAR, 0.03);
  }
  return finish('attack', lod, { body, wingL: wing(-1), wingR: wing(1), tail });
}

// ── Mi-24 ───────────────────────────────────────────────────────────────────

function buildHelo(lod: AirLod): AirModel {
  const hi = lod === 0;
  const seg = hi ? 16 : 8;
  const body = new Geo();
  const fus: Station[] = [
    { z: -8.5, y: -0.6, w: 0.2, ht: 0.18, hb: 0.25 },
    { z: -7.9, y: -0.58, w: 0.55, ht: 0.4, hb: 0.52, n: 2.2 },
    { z: -7.0, y: -0.46, w: 0.74, ht: 0.5, hb: 0.66, n: 2.4 },
    { z: -5.8, y: -0.3, w: 0.84, ht: 0.72, hb: 0.8, n: 2.5 },
    { z: -4.4, y: -0.16, w: 0.95, ht: 0.95, hb: 0.9, n: 2.7 },
    { z: -2.0, y: -0.1, w: 1.05, ht: 1.0, hb: 1.0, n: 2.8 },
    { z: 0.8, y: -0.05, w: 1.0, ht: 0.95, hb: 0.95, n: 2.8 },
    { z: 2.3, y: 0.12, w: 0.72, ht: 0.68, hb: 0.62, n: 2.5 },
    { z: 3.7, y: 0.28, w: 0.4, ht: 0.4, hb: 0.36 },
    { z: 7.6, y: 0.46, w: 0.22, ht: 0.26, hb: 0.22 },
    { z: 8.6, y: 0.5, w: 0.16, ht: 0.2, hb: 0.16 },
  ];
  body.loft(hi ? fus : [fus[0], fus[2], fus[4], fus[6], fus[8], fus[10]], seg, CAMO, true, true);
  // Tandem stepped canopies: the gunner in the nose, the pilot behind and higher.
  body.ellipsoid(0, -0.22, -7.45, 0.52, 0.5, 0.95, GLASS, hi ? 14 : 8, hi ? 5 : 3, false);
  body.ellipsoid(0, 0.48, -5.55, 0.56, 0.5, 0.95, GLASS, hi ? 14 : 8, hi ? 5 : 3, false);
  if (hi) {
    // canopy frames
    body.box(0, 0.26, -6.55, 0.5, 0.03, 0.04, GLASS_FRAME);
    body.box(0, 0.97, -5.55, 0.03, 0.03, 0.9, GLASS_FRAME);
    // chin turret (Yak-B) with its barrels
    body.ellipsoid(0, -1.08, -7.55, 0.26, 0.22, 0.26, METAL_DARK, 10, 4, true);
    body.tube(0, -1.12, -8.55, -7.6, 0.05, 0.05, 6, METAL_DARK);
  }
  // Engine housing on top, intakes forward, exhausts to the sides.
  body.loft([
    { z: -4.3, y: 1.05, w: 0.6, ht: 0.3, hb: 0.2, n: 3 },
    { z: -3.2, y: 1.12, w: 0.95, ht: 0.42, hb: 0.28, n: 3 },
    { z: 0.4, y: 1.12, w: 0.95, ht: 0.46, hb: 0.28, n: 3 },
    { z: 2.2, y: 0.95, w: 0.55, ht: 0.3, hb: 0.25, n: 2.5 },
  ], hi ? 12 : 6, CAMO, true, true);
  for (const sgn of [-1, 1]) {
    body.tube(sgn * 0.45, 1.12, -4.35, -4.1, 0.24, 0.24, hi ? 10 : 6, INTAKE, true, false);
    if (hi) body.with(tr(sgn * 1.0, 1.0, 1.0).multiply(new THREE.Matrix4().makeRotationY(sgn * 0.7)), () => body.tube(0, 0, 0, 0.9, 0.22, 0.26, 8, METAL_DARK, false, true, GLOW));
  }
  // Rotor mast and hub.
  body.with(tr(0, 1.45, -0.8).multiply(rotX(-90)), () => body.tube(0, 0, 0, 0.75, 0.18, 0.15, hi ? 8 : 5, METAL_DARK));
  body.ellipsoid(0, 2.25, -0.8, 0.42, 0.18, 0.42, METAL_DARK, hi ? 10 : 6, 3, true);
  // Stub wings (anhedral) with rocket pods and ATGM rails.
  for (const sgn of [-1, 1]) {
    body.wing([sgn * 0.95, -0.12, -1.45], [sgn * 3.2, -0.6, -1.3], 1.9, 1.3, [0, 1, 0], 0.12, 0.1, CAMO, hi ? 5 : 2);
    if (hi) {
      for (const px of [1.75, 2.55]) {
        const y = -0.12 - ((px - 0.95) / 2.25) * 0.48;
        pylon(body, sgn * px, y, y - 0.25, -1.3, -0.3, CAMO);
        store(body, sgn * px, y - 0.52, -2.1, 1.75, 0.26, POD, false, false, 10);
      }
      for (const dy of [-0.18, 0.18]) store(body, sgn * 3.28, -0.62 + dy, -2.1, 1.8, 0.1, BOMB, true, false, 6);
    }
  }
  // Tail fin (swept), horizontal stabiliser on the boom.
  body.wing([0, 0.55, 6.45], [0, 2.3, 7.55], 1.65, 1.05, [1, 0, 0], 0.12, 0.1, CAMO, hi ? 5 : 2);
  for (const sgn of [-1, 1]) body.wing([sgn * 0.2, 0.32, 6.2], [sgn * 1.65, 0.32, 6.5], 0.95, 0.7, [0, 1, 0], 0.1, 0.1, CAMO, hi ? 4 : 2);
  // Stars on the boom, yellow bort number on the cabin.
  for (const sgn of [-1, 1]) {
    body.decal([sgn * 0.33, 0.35, 5.2], [sgn, 0, 0], [0, 1, 0], 0.65, 0.65, STAR_UV, STAR, 0.03);
    if (hi) {
      const rz = -sgn;
      body.decal([sgn * 1.02, 0.15, -3.1 - rz * 0.24], [sgn, 0, 0], [0, 1, 0], 0.42, 0.7, [...DIGIT0_UV], digitSurf(0xe8c02a, 2), 0.03);
      body.decal([sgn * 1.02, 0.15, -3.1 + rz * 0.24], [sgn, 0, 0], [0, 1, 0], 0.42, 0.7, [...DIGIT0_UV], digitSurf(0xe8c02a, 3), 0.03);
    }
  }
  // Tail rotor assembly (separable): gearbox, hub and three blades, on the left of the fin.
  const tailRotor = new Geo();
  tailRotor.box(-0.2, 1.62, 8.15, 0.14, 0.14, 0.18, METAL_DARK);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const ty = Math.sin(a), tz = Math.cos(a);
    tailRotor.wing([-0.42, 1.62 + ty * 0.15, 8.15 + tz * 0.15 - 0.12], [-0.42, 1.62 + ty * 1.95, 8.15 + tz * 1.95 - 0.12], 0.26, 0.22, [1, 0, 0], 0.1, 0.1, ROTOR, 2);
  }
  // Broken main rotor (a wreck): five stubs, drooping.
  const blades = new Geo();
  for (let b = 0; b < 5; b++) {
    const a = (b / 5) * Math.PI * 2 + 0.3;
    const len = [3.4, 2.1, 4.6, 1.6, 2.8][b];
    const dx = Math.sin(a), dz = Math.cos(a);
    blades.wing([dx * 0.4, 2.25, -0.8 + dz * 0.4 - 0.29], [dx * len, 2.25 - len * 0.12, -0.8 + dz * len - 0.29], 0.58, 0.58, [0, 1, 0], 0.1, 0.1, ROTOR, 2);
  }
  return finish('helo', lod, { body, tailRotor, blades });
}

function finish(kind: AirKind, lod: AirLod, geos: Partial<Record<AirPart, Geo>>): AirModel {
  const parts: Partial<Record<AirPart, THREE.BufferGeometry>> = {};
  const pivots: Partial<Record<AirPart, THREE.Vector3>> = {};
  let tris = 0;
  for (const [k, g] of Object.entries(geos) as [AirPart, Geo][]) {
    const geo = g.build();
    geo.name = `air.${kind}.${k}.${lod}`;
    parts[k] = geo;
    tris += g.triangles;
    geo.computeBoundingBox();
    pivots[k] = geo.boundingBox!.getCenter(new THREE.Vector3());
  }
  return { kind, lod, parts, pivots, triangles: tris };
}

const cache = new Map<string, AirModel>();

export function buildAirModel(kind: AirKind, lod: AirLod): AirModel {
  const key = `${kind}.${lod}`;
  let m = cache.get(key);
  if (!m) {
    m = kind === 'fighter' ? buildFighter(lod) : kind === 'attack' ? buildAttack(lod) : buildHelo(lod);
    cache.set(key, m);
  }
  return m;
}

/** Light, nozzle, rotor and flare positions per class (body frame). */
export function airFixtures(kind: AirKind): AirFixtures {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  if (kind === 'fighter') {
    return {
      navRed: v(-5.72, 0.02, 3.4), navGreen: v(5.72, 0.02, 3.4), navWhite: v(0, 0.2, 7.95),
      beacons: [v(0, 0.86, 1.2), v(0, -0.62, 2.0)], nozzles: [v(-0.92, -0.26, 8.1), v(0.92, -0.26, 8.1)], nozzleRadius: 0.4,
      rotors: [], flareOrigin: v(0, -0.2, 6.6),
    };
  }
  if (kind === 'attack') {
    return {
      navRed: v(-7.05, 0.32, 0.3), navGreen: v(7.05, 0.32, 0.3), navWhite: v(0, 0.5, 7.62),
      beacons: [v(0, 0.95, -1.2), v(0, -0.72, 0.8)], nozzles: [v(-0.93, 0.06, 5.36), v(0.93, 0.06, 5.36)], nozzleRadius: 0.34,
      rotors: [], flareOrigin: v(0, 0.3, 7.2),
    };
  }
  return {
    navRed: v(-3.25, -0.62, -0.7), navGreen: v(3.25, -0.62, -0.7), navWhite: v(0, 0.55, 8.62),
    beacons: [v(0, 0.72, 4.0), v(0, -1.02, -1.2)], nozzles: [], nozzleRadius: 0,
    rotors: [
      { hub: v(0, 2.3, -0.8), radius: 8.65, blades: 5, axis: 'y' },
      { hub: v(-0.44, 1.62, 8.03), radius: 1.95, blades: 3, axis: 'x' },
    ],
    flareOrigin: v(0, -0.4, 2.2),
  };
}

/** The real sizes the models are built to (length × span × height, m). */
export const airSize = (kind: AirKind) => CONFIG.combat.targets[kind];
