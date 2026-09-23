/**
 * Airport facilities for the merged structures mesh (building material, per-vertex MAT ids):
 * nested T-hangar rows, a flight school, an ARFF fire station, a fuel farm, a VOR/DME, the ILS
 * localizer antenna array and the glideslope. PURE geometry (MeshBuilder only).
 *
 * Every function draws into the builder's CURRENT frame: ground at y = 0 (nothing below
 * −0.25 m), the FRONT (doors, entrance, antenna beam) toward local −Z, +X to the right of
 * someone standing in front of it looking at it. The caller places it with b.pushTR().
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from './builder';
import { MAT } from './materials';
import { mulberry32 } from '../noise';

const DEG = Math.PI / 180;

/**
 * Obstacle footprints (half extents along local X and Z, top height, m) for the default
 * arguments: flightSchool(26, 14), fireStation(36, 22, 3), fuelFarm(), vorStation(),
 * localizerArray(30)'s equipment shelter (centred at x = localizerShelterX(width), z = 0)
 * and glideslope(). T-hangar rows: ±(length/2 + 0.4) × ±TH_HALF_DEPTH(depth), top TH_RIDGE(depth).
 */
export const FACILITY_SIZE: Record<'flightSchool' | 'fireStation' | 'fuelFarm' | 'vor' | 'localizerShelter' | 'glideslope', { halfW: number; halfD: number; height: number }> = {
  flightSchool: { halfW: 14.6, halfD: 9.7, height: 9.2 },
  fireStation: { halfW: 19.3, halfD: 11.8, height: 13.6 },
  fuelFarm: { halfW: 13.4, halfD: 9.6, height: 8.2 },
  vor: { halfW: 8.7, halfD: 8.7, height: 7.4 },
  localizerShelter: { halfW: 2.0, halfD: 2.1, height: 3.0 },
  glideslope: { halfW: 3.6, halfD: 1.9, height: 12.9 },
};

/** Height of the localizer array (antenna tops), m. */
export const LOCALIZER_HEIGHT = 2.65;
/** Local x of the localizer equipment shelter's centre for an array `width` wide. */
export const localizerShelterX = (width: number): number => width / 2 + 3.6;
/** Eave height of a T-hangar row, m. */
export const TH_EAVE = 4.2;
/** Ridge height of a T-hangar row of the given depth, m. */
export const TH_RIDGE = (depth: number): number => TH_EAVE + (depth / 2) * Math.tan(4 * DEG) + 0.1;
/** Half depth of a T-hangar row's obstacle box (eaves and gutters), m. */
export const TH_HALF_DEPTH = (depth: number): number => depth / 2 + 0.7;

// ─── small helpers ────────────────────────────────────────────────────────────

/** Thin panel spanning x ∈ [x0, x1] between the (y, z) points p0 and p1 (both faces). */
function slab(b: MeshBuilder, x0: number, x1: number, p0: readonly [number, number], p1: readonly [number, number], t: number) {
  const dy = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  const l = Math.hypot(dy, dz) || 1;
  const ny = -dz / l;
  const nz = dy / l;
  for (const s of [1, -1]) {
    const oy = ny * s * (t / 2);
    const oz = nz * s * (t / 2);
    b.poly(
      [
        [x0, p0[0] + oy, p0[1] + oz],
        [x1, p0[0] + oy, p0[1] + oz],
        [x1, p1[0] + oy, p1[1] + oz],
        [x0, p1[0] + oy, p1[1] + oz],
      ],
      [0, ny * s, nz * s],
      { wallUV: true },
    );
  }
}

/** Wall quad in the plane z = z (normal ±Z). */
function wallZ(b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z: number, nz: 1 | -1) {
  b.poly([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, nz], { wallUV: true });
}
/** Wall quad in the plane x = x (normal ±X). */
function wallX(b: MeshBuilder, z0: number, z1: number, y0: number, y1: number, x: number, nx: 1 | -1) {
  b.poly([[x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0]], [nx, 0, 0], { wallUV: true });
}

/** Punched window (glass + frame + sill) on a face z = z0 facing nz. */
function windowZ(b: MeshBuilder, x0: number, x1: number, y0: number, y1: number, z0: number, nz: 1 | -1) {
  b.set({ mat: MAT.window, color: 0xffffff });
  wallZ(b, x0, x1, y0, y1, z0 + nz * 0.03, nz);
  b.set({ mat: MAT.paint, color: 0x8f8a80 });
  const zz = z0 + nz * 0.1;
  b.box(x0 - 0.08, y0 - 0.1, Math.min(z0, zz), x1 + 0.08, y0, Math.max(z0, zz), '');
}
/** Punched window on a face x = x0 facing nx. */
function windowX(b: MeshBuilder, z0: number, z1: number, y0: number, y1: number, x0: number, nx: 1 | -1) {
  b.set({ mat: MAT.window, color: 0xffffff });
  wallX(b, z0, z1, y0, y1, x0 + nx * 0.03, nx);
  b.set({ mat: MAT.paint, color: 0x8f8a80 });
  const xx = x0 + nx * 0.1;
  b.box(Math.min(x0, xx), y0 - 0.1, z0 - 0.08, Math.max(x0, xx), y0, z1 + 0.08, '');
}

/** Rooftop air-handling unit with a fan disc. */
function acUnit(b: MeshBuilder, x: number, y: number, z: number, sx: number, sy: number, sz: number) {
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.box(x - sx / 2, y, z - sz / 2, x + sx / 2, y + sy, z + sz / 2, 'b');
  b.set({ mat: MAT.dark, color: 0x1a1a1a });
  b.cylinder(x, y + sy, z, Math.min(sx, sz) * 0.32, 0.04, 12, true);
}

/** Yellow safety bollard. */
function bollard(b: MeshBuilder, x: number, z: number, h = 1.05) {
  b.set({ mat: MAT.paint, color: 0xd8b21a });
  b.cylinder(x, 0, z, 0.1, h, 8);
}

/** Flat roof inside a parapet: membrane at y, inner parapet faces up to yTop, over [x0,x1]×[z0,z1]. */
function flatRoof(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, yTop: number) {
  b.set({ mat: MAT.membrane, color: 0x5d6062 });
  b.poly([[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]], [0, 1, 0], { uAxis: [1, 0, 0] });
  b.set({ mat: MAT.paint, color: 0x6a6f73 });
  wallZ(b, x0, x1, y, yTop, z0 + 0.01, 1);
  wallZ(b, x0, x1, y, yTop, z1 - 0.01, -1);
  wallX(b, z0, z1, y, yTop, x0 + 0.01, 1);
  wallX(b, z0, z1, y, yTop, x1 - 0.01, -1);
}

/** Rectangular ring of four boxes (parapet, fascia band, coping) with outer bounds [x0,x1]×[z0,z1]. */
function ring(b: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, t: number) {
  b.box(x0, y0, z0, x1, y1, z0 + t, 'b');
  b.box(x0, y0, z1 - t, x1, y1, z1, 'b');
  b.box(x0, y0, z0 + t, x0 + t, y1, z1 - t, 'b');
  b.box(x1 - t, y0, z0 + t, x1, y1, z1 - t, 'b');
}

// ─── T-hangar row ─────────────────────────────────────────────────────────────

/**
 * A nested T-hangar row: `length` along X, `depth` along Z, low-pitch gable roof (ridge along X),
 * `bays` bi-fold doors on the front face (−Z) and the nested bays offset by half a bay on the
 * back face (+Z), a few doors partly folded open (dark interior), lamps over the doors.
 */
export function tHangarRow(b: MeshBuilder, length: number, depth: number, bays: number, seed = 0): void {
  const rnd = mulberry32(0x7a17 + seed * 977);
  const hx = length / 2;
  const hz = depth / 2;
  const eave = TH_EAVE;
  const pitch = 4 * DEG;
  const ridge = eave + hz * Math.tan(pitch);
  const v = ((seed % 4) + 4) % 4;
  const wallC = [0xdcd9cf, 0xc9cfcf, 0xe2ddcf, 0xbfc7cb][v];
  const doorC = [0x6f7f8c, 0x9aa3a8, 0x7a6a58, 0x5d6e7a][v];
  const roofC = [0x9aa0a4, 0x8a9296, 0xa6a9a8, 0x7f8a8e][v];
  const trimC = 0xe6e6e2;
  const n = Math.max(1, Math.round(bays));
  const period = length / n;
  const doorW = Math.min(period * 0.8, period - 1.2);
  const dh = 3.55;

  // slab edge
  b.set({ mat: MAT.concrete, color: 0xaaa69d });
  b.box(-hx - 0.35, -0.2, -hz - 0.35, hx + 0.35, 0.06, hz + 0.35, 'b');

  for (const face of [-1, 1] as const) {
    const zf = face * hz;
    // door centres: front on the bay centres, back nested half a bay over
    const centres: number[] = [];
    if (face < 0) for (let i = 0; i < n; i++) centres.push(-hx + (i + 0.5) * period);
    else for (let i = 1; i < n; i++) centres.push(-hx + i * period);
    const doors = centres.map((c) => [c - doorW / 2, c + doorW / 2] as const);
    // cladding: piers between doors, headers over them
    b.set({ mat: MAT.corrugated, color: wallC });
    let x = -hx;
    for (const [d0, d1] of doors) {
      if (d0 - x > 0.05) wallZ(b, x, d0, 0.06, eave, zf, face);
      wallZ(b, d0, d1, dh, eave, zf, face);
      x = d1;
    }
    if (hx - x > 0.05) wallZ(b, x, hx, 0.06, eave, zf, face);
    for (const [d0, d1] of doors) {
      const open = rnd() < 0.22;
      const th = (48 + rnd() * 30) * DEG;
      // jamb trims and header trim
      b.set({ mat: MAT.paint, color: trimC });
      for (const xj of [d0, d1]) b.box(xj - 0.09, 0.06, Math.min(zf, zf + face * 0.12), xj + 0.09, dh + 0.12, Math.max(zf, zf + face * 0.12), 'b');
      b.box(d0 - 0.09, dh, Math.min(zf, zf + face * 0.14), d1 + 0.09, dh + 0.14, Math.max(zf, zf + face * 0.14), '');
      b.set({ mat: MAT.door, color: doorC });
      const hp = (dh - 0.08) / 2;
      if (!open) {
        // closed bi-fold: two panels with the fold line between them
        b.box(d0 + 0.02, 0.08, Math.min(zf, zf + face * 0.07), d1 - 0.02, dh, Math.max(zf, zf + face * 0.07), 'b');
        b.set({ mat: MAT.dark, color: 0x151515 });
        b.box(d0 + 0.05, 0.08 + hp - 0.02, Math.min(zf, zf + face * 0.085), d1 - 0.05, 0.08 + hp + 0.02, Math.max(zf, zf + face * 0.085), 'b');
      } else {
        // bi-fold folded part way up: top panel swings out from the header, bottom panel rides the wall plane
        const H: [number, number] = [dh, zf + face * 0.05];
        const F: [number, number] = [dh - hp * Math.cos(th), zf + face * (0.05 + hp * Math.sin(th))];
        const B: [number, number] = [dh - 2 * hp * Math.cos(th), zf + face * 0.05];
        slab(b, d0 + 0.02, d1 - 0.02, H, F, 0.08);
        slab(b, d0 + 0.02, d1 - 0.02, F, B, 0.08);
        // dim interior: floor, back wall, sides, ceiling, one lit high-bay
        const zi = zf - face * (hz * 0.92);
        b.set({ mat: MAT.concrete, color: 0x3b3a37 });
        b.poly([[d0, 0.03, zf], [d1, 0.03, zf], [d1, 0.03, zi], [d0, 0.03, zi]], [0, 1, 0], { uAxis: [1, 0, 0] });
        b.set({ mat: MAT.paint, color: 0x2a2c2d });
        wallZ(b, d0, d1, 0, eave, zi, face);
        wallX(b, Math.min(zf, zi), Math.max(zf, zi), 0, eave, d0 + 0.01, 1);
        wallX(b, Math.min(zf, zi), Math.max(zf, zi), 0, eave, d1 - 0.01, -1);
        b.set({ mat: MAT.paint, color: 0x222426 });
        b.poly([[d0, eave - 0.05, zf], [d1, eave - 0.05, zf], [d1, eave - 0.05, zi], [d0, eave - 0.05, zi]], [0, -1, 0], { uAxis: [1, 0, 0] });
        b.set({ mat: MAT.interiorLamp, color: 0xfff1d8 });
        b.boxC((d0 + d1) / 2, eave - 0.25, (zf + zi) / 2, 0.8, 0.1, 0.8, 't');
        // a workbench and shelving against the back wall
        b.set({ mat: MAT.paint, color: rnd() < 0.5 ? 0x5a1e1a : 0x2f4d6e });
        b.box(d1 - 2.6, 0, Math.min(zi, zi + face * 0.7), d1 - 0.8, 1.0, Math.max(zi, zi + face * 0.7), 'b');
      }
      // lamp over the door
      b.set({ mat: MAT.lamp, color: 0xfff0d0 });
      b.boxC((d0 + d1) / 2, dh + 0.42, zf + face * 0.2, 0.42, 0.14, 0.3);
    }
  }
  // gable end walls (+ a personnel door on the +X end)
  b.set({ mat: MAT.corrugated, color: wallC });
  for (const sx of [-1, 1] as const) {
    b.poly([[sx * hx, 0.06, -hz], [sx * hx, 0.06, hz], [sx * hx, eave, hz], [sx * hx, ridge, 0], [sx * hx, eave, -hz]], [sx, 0, 0], { wallUV: true });
  }
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallX(b, -0.5, 0.5, 0.06, 2.15, hx + 0.03, 1);
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(hx + 0.15, 2.45, 0, 0.25, 0.14, 0.35);
  // corner trims
  b.set({ mat: MAT.paint, color: trimC });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxC(sx * hx, eave / 2, sz * hz, 0.16, eave, 0.16, 'b');
  // roof: two slopes with eave and gable overhangs, soffits, fascia, gutters, ridge cap
  const ov = 0.45;
  const ovg = 0.35;
  const yEave = eave - ov * Math.tan(pitch);
  for (const sz of [-1, 1] as const) {
    const pts: V3[] = [
      [-hx - ovg, yEave, sz * (hz + ov)],
      [hx + ovg, yEave, sz * (hz + ov)],
      [hx + ovg, ridge, 0],
      [-hx - ovg, ridge, 0],
    ];
    b.set({ mat: MAT.roofMetal, color: roofC });
    b.poly(pts, [0, Math.cos(pitch), sz * Math.sin(pitch)], { uAxis: [0, 0, 1] });
    b.set({ mat: MAT.paint, color: 0x8c9194 });
    b.poly(pts.map((p) => [p[0], p[1] - 0.1, p[2]] as V3), [0, -1, 0], { uAxis: [0, 0, 1] });
    // fascia + gutter along the eave
    b.set({ mat: MAT.paint, color: trimC });
    const ze = sz * (hz + ov);
    b.box(-hx - ovg, yEave - 0.24, Math.min(ze, ze + sz * 0.05), hx + ovg, yEave + 0.02, Math.max(ze, ze + sz * 0.05), '');
    b.set({ mat: MAT.metal, color: 0xc9cccc, rough: 0.5 });
    b.box(-hx - ovg, yEave - 0.2, Math.min(ze + sz * 0.05, ze + sz * 0.2), hx + ovg, yEave - 0.04, Math.max(ze + sz * 0.05, ze + sz * 0.2), '');
    // downspouts at the ends
    for (const sx of [-1, 1]) b.tube([sx * (hx - 0.1), 0.1, ze + sz * 0.12], [sx * (hx - 0.1), yEave - 0.15, ze + sz * 0.12], 0.05, 0.05, 6);
  }
  // barge boards on the gables
  b.set({ mat: MAT.paint, color: trimC });
  for (const sx of [-1, 1] as const)
    for (const sz of [-1, 1] as const) {
      const x = sx * (hx + ovg);
      b.poly(
        [[x, yEave - 0.24, sz * (hz + ov)], [x, ridge - 0.24, 0], [x, ridge + 0.02, 0], [x, yEave + 0.02, sz * (hz + ov)]],
        [sx, 0, 0],
        { wallUV: true },
      );
    }
  b.set({ mat: MAT.roofMetal, color: roofC });
  b.box(-hx - ovg, ridge - 0.05, -0.22, hx + ovg, ridge + 0.06, 0.22, 'b');
}

// ─── flight school ────────────────────────────────────────────────────────────

/**
 * Two-storey flight school / office (default 26 × 14 m, 7.5 m high): curtain wall on the ramp
 * side (−Z) with an entrance canopy, punched windows elsewhere, an outdoor steel stair to a
 * first-floor door on the +X end, flat roof with parapet, rooftop units and a VHF antenna.
 * The blank composite fascia band (for a sign) spans y 6.3–7.3 m on the front at z = −d/2 − 0.12.
 */
export function flightSchool(b: MeshBuilder, w = 26, d = 14): void {
  const hw = w / 2;
  const hd = d / 2;
  const H = 7.5;
  const band0 = 6.3;
  const band1 = 7.3;
  const f2 = 3.55; // first floor level
  // plinth and stucco walls
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(-hw - 0.05, -0.2, -hd - 0.05, hw + 0.05, 0.4, hd + 0.05, 'b');
  b.set({ mat: MAT.paint, color: 0xd9d2c3 });
  b.box(-hw, 0.4, -hd, hw, band0, hd, 'tb');
  // fascia band (all round) + coping
  b.set({ mat: MAT.metal, color: 0x4f5b68, rough: 0.45 });
  ring(b, -hw - 0.12, hw + 0.12, -hd - 0.12, hd + 0.12, band0, band1, 0.4);
  b.set({ mat: MAT.paint, color: 0xbfc2c2 });
  ring(b, -hw - 0.16, hw + 0.16, -hd - 0.16, hd + 0.16, band1, H, 0.45);
  flatRoof(b, -hw, hw, -hd, hd, H - 0.45, H);
  // front curtain wall over two floors on the left two thirds, spandrel between floors
  const cw0 = -hw + 1.4;
  const cw1 = hw * 0.34;
  b.set({ mat: MAT.window, color: 0xffffff });
  wallZ(b, cw0, cw1, 0.45, band0 - 0.25, -hd - 0.05, -1);
  b.set({ mat: MAT.paint, color: 0xb9bcbc });
  b.box(cw0 - 0.1, f2 - 0.35, -hd - 0.14, cw1 + 0.1, f2 + 0.15, -hd - 0.04, '');
  for (const x of [cw0 - 0.1, cw1]) b.box(x, 0.4, -hd - 0.14, x + 0.1, band0 - 0.2, -hd - 0.04, '');
  // right third: punched windows on both floors
  for (let x0 = cw1 + 1.2; x0 + 1.8 < hw - 0.6; x0 += 2.7)
    for (const y0 of [1.0, f2 + 0.75]) windowZ(b, x0, x0 + 1.8, y0, y0 + 1.5, -hd, -1);
  // back and ends: punched windows
  for (let x0 = -hw + 1.2; x0 + 2 < hw - 1; x0 += 3.2) for (const y0 of [1.0, f2 + 0.75]) windowZ(b, x0, x0 + 2.0, y0, y0 + 1.4, hd, 1);
  for (const z0 of [-hd + 1.5, 1.2]) {
    windowX(b, z0, z0 + 2.2, 1.0, 2.4, -hw, -1);
    windowX(b, z0, z0 + 2.2, f2 + 0.75, f2 + 2.15, -hw, -1);
  }
  windowX(b, hd - 3.5, hd - 1.7, 1.0, 2.4, hw, 1); // under the stair landing
  // entrance: glass doors under a canopy on posts
  b.set({ mat: MAT.door, color: 0x3a4148 });
  wallZ(b, -3.4, -1.4, 0.4, 2.6, -hd - 0.08, -1);
  b.set({ mat: MAT.metal, color: 0x5b6166, rough: 0.4 });
  b.box(-5.2, 3.0, -hd - 2.6, 0.4, 3.28, -hd, '');
  b.set({ mat: MAT.metal, color: 0x3d4145 });
  for (const x of [-4.9, 0.1]) b.tube([x, 0.4, -hd - 2.35], [x, 3.0, -hd - 2.35], 0.08, 0.08, 8);
  b.set({ mat: MAT.lamp, color: 0xfff0d8 });
  for (const x of [-3.6, -1.2]) b.boxC(x, 2.98, -hd - 1.3, 0.5, 0.04, 0.5, 't');
  // outdoor steel stair up the +X end to a first-floor door
  const sx0 = hw + 0.05;
  const sx1 = hw + 1.45;
  const zs0 = -hd + 1.2;
  const zl0 = hd - 3.6;
  const zl1 = hd - 1.4;
  const steps = 12;
  b.set({ mat: MAT.metal, color: 0x4d5357, rough: 0.5 });
  for (let i = 0; i < steps; i++) {
    const z = zs0 + ((zl0 - zs0) * i) / steps;
    const y = 0.4 + ((f2 - 0.4) * (i + 1)) / steps;
    b.box(sx0 + 0.05, y - 0.05, z, sx1, y, z + (zl0 - zs0) / steps + 0.05, '');
  }
  b.box(sx0 + 0.05, f2 - 0.12, zl0, sx1, f2, zl1, '');
  b.tube([sx1 - 0.05, 0.0, zs0], [sx1 - 0.05, f2 - 0.05, zl0], 0.05, 0.05, 4);
  b.tube([sx0 + 0.1, 0.0, zs0], [sx0 + 0.1, f2 - 0.05, zl0], 0.05, 0.05, 4);
  for (const z of [zl0 + 0.1, zl1 - 0.1]) b.tube([sx1 - 0.05, 0, z], [sx1 - 0.05, f2, z], 0.06, 0.06, 6);
  b.set({ mat: MAT.metal, color: 0x8d9296, rough: 0.45 });
  b.tube([sx1 - 0.04, 1.3, zs0], [sx1 - 0.04, f2 + 1.0, zl0], 0.025, 0.025, 4);
  b.tube([sx1 - 0.04, f2 + 1.0, zl0], [sx1 - 0.04, f2 + 1.0, zl1], 0.025, 0.025, 4);
  b.tube([sx1 - 0.04, f2 + 1.0, zl1], [sx0, f2 + 1.0, zl1], 0.025, 0.025, 4);
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallX(b, zl0 + 0.5, zl0 + 1.5, f2, f2 + 2.1, hw + 0.03, 1);
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(hw + 0.15, f2 + 2.45, zl0 + 1.0, 0.25, 0.14, 0.35);
  // rooftop plant and a VHF antenna
  acUnit(b, -hw + 4, H - 0.45, 1.5, 2.4, 1.3, 1.8);
  acUnit(b, 3.5, H - 0.45, 2.2, 3.0, 1.2, 2.0);
  b.set({ mat: MAT.metal, color: 0xb0b4b6 });
  b.tube([hw - 2.5, H - 0.45, hd - 2], [hw - 2.5, H + 1.6, hd - 2], 0.03, 0.015, 4);
  b.tube([hw - 4.5, H - 0.45, -hd + 2], [hw - 4.5, H + 1.2, -hd + 2], 0.02, 0.01, 4);
}

// ─── ARFF fire station ────────────────────────────────────────────────────────

/**
 * Aircraft rescue and fire-fighting station (default 36 × 22 m): an 8 m apparatus-bay block
 * with `bays` drive-through roll-up doors (red frames; bay 0 rolled up, dim lit interior), a
 * two-storey crew wing on the +X side with a glazed watch room on its roof, a 13 m hose-drying
 * tower at the back corner, red/white trim, bollards and lamps.
 */
export function fireStation(b: MeshBuilder, w = 36, d = 22, bays = 3): void {
  const hw = w / 2;
  const hd = d / 2;
  const nb = Math.max(1, Math.round(bays));
  const bayW = 7;
  const x0 = -hw;
  const xb = Math.min(hw - 6, x0 + nb * bayW + 1.5); // end of the bay block
  const Hb = 8;
  const Hc = 6.8;
  const red = 0xb3261e;
  const white = 0xe6e3dc;
  const doorW = 5.5;
  const doorH = 5.5;
  // plinths + walls
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(x0 - 0.05, -0.2, -hd - 0.05, hw + 0.05, 0.25, hd + 0.05, 'b');
  // bay block: walls as quads around the door openings
  const doorX: number[] = [];
  for (let i = 0; i < nb; i++) doorX.push(x0 + 0.75 + (i + 0.5) * ((xb - x0 - 1.5) / nb));
  b.set({ mat: MAT.paint, color: white });
  for (const [zf, face] of [[-hd, -1], [hd, 1]] as const) {
    let x = x0;
    for (const cx of doorX) {
      wallZ(b, x, cx - doorW / 2, 0.25, Hb - 1.2, zf, face);
      wallZ(b, cx - doorW / 2, cx + doorW / 2, doorH, Hb - 1.2, zf, face);
      x = cx + doorW / 2;
    }
    wallZ(b, x, xb, 0.25, Hb - 1.2, zf, face);
  }
  wallX(b, -hd, hd, 0.25, Hb - 1.2, x0, -1);
  // red fascia band round the bay block + coping
  b.set({ mat: MAT.paint, color: red });
  ring(b, x0 - 0.1, xb, -hd - 0.1, hd + 0.1, Hb - 1.2, Hb - 0.2, 0.4);
  b.set({ mat: MAT.paint, color: 0xd9d6ce });
  ring(b, x0 - 0.14, xb, -hd - 0.14, hd + 0.14, Hb - 0.2, Hb, 0.45);
  flatRoof(b, x0, xb, -hd, hd, Hb - 0.4, Hb);
  // doors
  for (const [zf, face] of [[-hd, -1], [hd, 1]] as const)
    doorX.forEach((cx, i) => {
      const open = face < 0 && i === 0;
      const zo = zf + face * 0.12;
      // red frame
      b.set({ mat: MAT.paint, color: red });
      b.box(cx - doorW / 2 - 0.35, 0.25, Math.min(zf, zo), cx - doorW / 2, doorH + 0.35, Math.max(zf, zo), '');
      b.box(cx + doorW / 2, 0.25, Math.min(zf, zo), cx + doorW / 2 + 0.35, doorH + 0.35, Math.max(zf, zo), '');
      b.box(cx - doorW / 2, doorH, Math.min(zf, zo), cx + doorW / 2, doorH + 0.35, Math.max(zf, zo), '');
      // roll-up hood
      b.set({ mat: MAT.metal, color: 0x9ea3a6, rough: 0.5 });
      b.box(cx - doorW / 2, doorH - 0.05, Math.min(zf - face * 0.05, zf - face * 0.55), cx + doorW / 2, doorH + 0.3, Math.max(zf - face * 0.05, zf - face * 0.55), '');
      if (!open) {
        b.set({ mat: MAT.door, color: 0xdcdedd });
        wallZ(b, cx - doorW / 2, cx + doorW / 2, 0.02, doorH, zf - face * 0.06, face);
        b.set({ mat: MAT.window, color: 0xffffff });
        wallZ(b, cx - doorW / 2 + 0.3, cx + doorW / 2 - 0.3, 3.4, 3.95, zf - face * 0.03, face);
      } else {
        // rolled up: dim interior, lit bay lamps, hose reel on the side wall
        const zi = hd - 0.6;
        b.set({ mat: MAT.concrete, color: 0x3f3e3b });
        b.poly([[cx - bayW / 2 + 0.3, 0.03, zf], [cx + bayW / 2 - 0.3, 0.03, zf], [cx + bayW / 2 - 0.3, 0.03, zi], [cx - bayW / 2 + 0.3, 0.03, zi]], [0, 1, 0], { uAxis: [1, 0, 0] });
        b.set({ mat: MAT.paint, color: 0x2c2d2e });
        wallZ(b, cx - bayW / 2 + 0.3, cx + bayW / 2 - 0.3, 0, Hb - 0.5, zi, -1);
        wallX(b, zf, zi, 0, Hb - 0.5, cx - bayW / 2 + 0.3, 1);
        wallX(b, zf, zi, 0, Hb - 0.5, cx + bayW / 2 - 0.3, -1);
        b.set({ mat: MAT.paint, color: 0x252729 });
        b.poly([[cx - bayW / 2 + 0.3, Hb - 0.5, zf + 0.1], [cx + bayW / 2 - 0.3, Hb - 0.5, zf + 0.1], [cx + bayW / 2 - 0.3, Hb - 0.5, zi], [cx - bayW / 2 + 0.3, Hb - 0.5, zi]], [0, -1, 0], { uAxis: [1, 0, 0] });
        b.set({ mat: MAT.interiorLamp, color: 0xfff1d8 });
        for (let z = zf + 3; z < zi - 1; z += 4.5) b.boxC(cx, Hb - 0.7, z, 1.2, 0.1, 0.5, 't');
        b.set({ mat: MAT.paint, color: 0xb5261c });
        b.cylinder(cx + bayW / 2 - 0.8, 1.2, 2, 0.45, 0.35, 12);
        b.set({ mat: MAT.paint, color: 0x2a3a4a });
        b.box(cx - bayW / 2 + 0.35, 0, zi - 3, cx - bayW / 2 + 0.9, 1.9, zi - 0.3, 'b'); // turnout-gear lockers
      }
      // lamp over the door, bollards at the jambs
      b.set({ mat: MAT.lamp, color: 0xfff0d0 });
      b.boxC(cx, doorH + 0.75, zf + face * 0.25, 0.5, 0.18, 0.4);
      bollard(b, cx - doorW / 2 - 0.45, zf + face * 0.55, 1.2);
      bollard(b, cx + doorW / 2 + 0.45, zf + face * 0.55, 1.2);
    });

  // crew wing (+X): two storeys, windows, entrance
  const xc0 = xb;
  const xc1 = hw;
  b.set({ mat: MAT.paint, color: white });
  wallX(b, -hd, hd, Hc - 0.35, Hb - 1.2, xb, 1); // bay-block wall above the lower wing
  b.set({ mat: MAT.paint, color: white });
  b.box(xc0, 0.25, -hd, xc1, Hc - 0.9, hd, 'tbX');
  b.set({ mat: MAT.paint, color: red });
  ring(b, xc0, xc1 + 0.08, -hd - 0.08, hd + 0.08, Hc - 0.9, Hc - 0.2, 0.4);
  b.set({ mat: MAT.paint, color: 0xd9d6ce });
  ring(b, xc0, xc1 + 0.12, -hd - 0.12, hd + 0.12, Hc - 0.2, Hc, 0.45);
  flatRoof(b, xc0, xc1, -hd, hd, Hc - 0.35, Hc);
  for (let x = xc0 + 1.2; x + 1.6 < xc1 - 0.6; x += 2.6) {
    for (const y0 of [1.0, 3.9]) {
      windowZ(b, x, x + 1.6, y0, y0 + 1.3, -hd, -1);
      windowZ(b, x, x + 1.6, y0, y0 + 1.3, hd, 1);
    }
  }
  for (let z = -hd + 1.5; z + 1.8 < hd - 5; z += 3) for (const y0 of [1.0, 3.9]) windowX(b, z, z + 1.8, y0, y0 + 1.3, xc1, 1);
  b.set({ mat: MAT.door, color: 0x3a4148 });
  wallX(b, hd - 3.6, hd - 2.4, 0.25, 2.4, xc1 + 0.03, 1);
  b.set({ mat: MAT.metal, color: 0x5b6166 });
  b.box(xc1, 2.7, hd - 4.3, xc1 + 1.2, 2.9, hd - 1.7, '');
  // watch room on the crew-wing roof, front corner: glazing, mullions, roof slab
  const wx0 = xc0 + 0.8;
  const wx1 = xc0 + 5.6;
  const wz0 = -hd + 0.6;
  const wz1 = -hd + 4.8;
  const wy0 = Hc - 0.35;
  const wy1 = wy0 + 2.8;
  b.set({ mat: MAT.paint, color: 0x3c4146 });
  b.box(wx0, wy0, wz0, wx1, wy0 + 0.5, wz1, 'b');
  b.set({ mat: MAT.glass, color: 0x202a30 });
  b.box(wx0 + 0.05, wy0 + 0.5, wz0 + 0.05, wx1 - 0.05, wy1 - 0.25, wz1 - 0.05, 'tb');
  b.set({ mat: MAT.metal, color: 0x2e3236, rough: 0.5 });
  for (const x of [wx0, (wx0 + wx1) / 2, wx1]) for (const z of [wz0, wz1]) b.tube([x, wy0 + 0.5, z], [x, wy1 - 0.25, z], 0.05, 0.05, 4);
  b.set({ mat: MAT.paint, color: white });
  b.box(wx0 - 0.3, wy1 - 0.25, wz0 - 0.3, wx1 + 0.3, wy1, wz1 + 0.3, '');
  b.set({ mat: MAT.metal, color: 0xb0b4b6 });
  b.tube([wx1 - 0.4, wy1, wz1 - 0.4], [wx1 - 0.4, wy1 + 1.4, wz1 - 0.4], 0.025, 0.012, 4);
  // hose-drying tower at the back corner of the crew wing
  const tx0 = hw - 4.2;
  const tz0 = hd - 4.2;
  const Ht = 13;
  b.set({ mat: MAT.paint, color: 0xd6d1c6 });
  b.box(tx0, Hc - 0.35, tz0, hw, Ht - 0.5, hd, 'b');
  b.set({ mat: MAT.paint, color: red });
  b.box(tx0 - 0.08, Ht - 0.5, tz0 - 0.08, hw + 0.08, Ht, hd + 0.08, 'b');
  b.set({ mat: MAT.dark, color: 0x151515 });
  for (const y of [8.4, 10.6]) {
    wallZ(b, tx0 + 1.2, hw - 1.2, y, y + 1.0, tz0 - 0.03, -1);
    wallX(b, tz0 + 1.2, hd - 1.2, y, y + 1.0, hw + 0.03, 1);
  }
  b.set({ mat: MAT.lamp, color: 0xd02010 });
  b.cylinder((tx0 + hw) / 2, Ht, (tz0 + hd) / 2, 0.09, 0.18, 8);
  // rooftop plant on the bay block
  acUnit(b, x0 + 5, Hb - 0.4, 3, 3, 1.3, 2.2);
  acUnit(b, x0 + 11, Hb - 0.4, 4, 2.2, 1.1, 1.8);
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.cylinder(x0 + 16, Hb - 0.4, -3, 0.35, 1.2, 10);
}

// ─── fuel farm ────────────────────────────────────────────────────────────────

/** Horizontal tank on saddles along Z, centre (x, z), radius r, length len; band colour. */
function horizontalTank(b: MeshBuilder, x: number, z: number, r: number, len: number, band: number) {
  b.set({ mat: MAT.concrete, color: 0xb7b2a7 });
  for (const s of [-1, 1]) b.box(x - r * 0.8, 0, z + s * len * 0.28 - 0.25, x + r * 0.8, 0.5, z + s * len * 0.28 + 0.25, 'b');
  const y = 0.5 + r;
  const h = len / 2;
  b.set({ mat: MAT.paint, color: 0xecebe6 });
  b.push(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(x, y, z));
  b.lathe([[0.0, -h], [r * 0.75, -h + 0.05], [r * 0.97, -h + 0.2], [r, -h + 0.4], [r, h - 0.4], [r * 0.97, h - 0.2], [r * 0.75, h - 0.05], [0, h]], 20);
  b.set({ mat: MAT.paint, color: band });
  b.lathe([[r + 0.01, -0.5], [r + 0.01, 0.5]], 20);
  b.pop();
  b.set({ mat: MAT.metal, color: 0x8b9093 });
  b.tube([x, y + r, z - h * 0.5], [x, y + r + 0.7, z - h * 0.5], 0.05, 0.05, 6);
  b.cylinder(x, y + r - 0.05, z + h * 0.3, 0.3, 0.2, 10, true);
}

/** Vertical tank (x, z), radius r, height h, cone roof; band colour; returns the roof height. */
function verticalTank(b: MeshBuilder, x: number, z: number, r: number, h: number, band: number): number {
  b.set({ mat: MAT.concrete, color: 0xb7b2a7 });
  b.cylinder(x, -0.1, z, r + 0.3, 0.3, 20);
  b.set({ mat: MAT.paint, color: 0xecebe6 });
  b.lathe([[r, 0.2], [r, h], [r * 0.98, h + 0.05], [0.4, h + 0.45], [0, h + 0.47]], 24, x, z);
  b.set({ mat: MAT.paint, color: band });
  b.lathe([[r + 0.012, h * 0.62], [r + 0.012, h * 0.62 + 0.9]], 24, x, z);
  b.set({ mat: MAT.metal, color: 0x8b9093 });
  b.tube([x, h + 0.4, z], [x, h + 1.1, z], 0.06, 0.06, 6);
  b.cylinder(x, h + 1.1, z, 0.14, 0.1, 8);
  return h + 0.47;
}

/**
 * Fuel farm (footprint ±13.4 × ±9.6 m): two vertical Jet-A tanks (blue band) and a horizontal
 * 100LL tank (red band) inside a concrete containment wall, a catwalk between the tank roofs
 * with a stair, piping to a truck-loading rack under a canopy at the front (−Z), a pump shed,
 * bollards and lamps.
 */
export function fuelFarm(b: MeshBuilder): void {
  const blue = 0x1f4f9a;
  const red = 0xb5261c;
  // containment: slab + wall
  const cx0 = -13, cx1 = 7, cz0 = 0, cz1 = 9.2;
  b.set({ mat: MAT.concrete, color: 0xb4afa4 });
  b.box(cx0, -0.2, cz0, cx1, 0.05, cz1, 'b');
  const t = 0.25, hw = 0.95;
  b.box(cx0, 0.05, cz0, cx1, hw, cz0 + t, 'b');
  b.box(cx0, 0.05, cz1 - t, cx1, hw, cz1, 'b');
  b.box(cx0, 0.05, cz0 + t, cx0 + t, hw, cz1 - t, 'b');
  b.box(cx1 - t, 0.05, cz0 + t, cx1, hw, cz1 - t, 'b');
  // tanks
  const r = 2.3;
  const tA = verticalTank(b, -9.6, 4.6, r, 6.3, blue);
  verticalTank(b, -4.1, 4.6, r, 6.3, blue);
  horizontalTank(b, 3.2, 4.6, 1.3, 7.2, red);
  // catwalk between the vertical tank roofs + railings, stair down the west side
  const yc = tA - 0.25;
  b.set({ mat: MAT.metal, color: 0x7f8488, rough: 0.5 });
  b.box(-9.6, yc - 0.08, 4.1, -4.1, yc, 5.1, '');
  b.set({ mat: MAT.metal, color: 0xc9a21b, rough: 0.5 });
  for (const zz of [4.1, 5.1]) {
    b.tube([-9.6, yc + 1.0, zz], [-4.1, yc + 1.0, zz], 0.025, 0.025, 4);
    for (const xx of [-8.2, -6.85, -5.5]) b.tube([xx, yc, zz], [xx, yc + 1.0, zz], 0.02, 0.02, 4);
  }
  // external stair: from outside the wall (z < 0) up to the first tank's roof
  b.set({ mat: MAT.metal, color: 0x7f8488, rough: 0.5 });
  const n = 16;
  for (let i = 0; i < n; i++) {
    const f = (i + 1) / n;
    const z = -1.6 + f * 3.4;
    const y = f * yc;
    b.box(-11.9, y - 0.05, z - 0.02, -11.1, y, z + 0.22, '');
  }
  b.tube([-11.9, 0, -1.6], [-11.9, yc, 1.8], 0.04, 0.04, 4);
  b.tube([-11.1, 0, -1.6], [-11.1, yc, 1.8], 0.04, 0.04, 4);
  b.box(-11.9, yc - 0.08, 1.8, -9.6 + r * 0.4, yc, 2.8, '');
  b.set({ mat: MAT.metal, color: 0xc9a21b, rough: 0.5 });
  b.tube([-11.1, 1.0, -1.6], [-11.1, yc + 1.0, 1.8], 0.025, 0.025, 4);
  // piping: manifold along the front of the tanks, over the wall, to the loading rack
  b.set({ mat: MAT.metal, color: 0x9a9fa2, rough: 0.4 });
  b.tube([-9.6, 0.6, 2.2], [3.2, 0.6, 2.2], 0.1, 0.1, 8);
  for (const x of [-9.6, -4.1]) b.tube([x, 0.6, 2.2], [x, 0.6, 4.6 - r], 0.08, 0.08, 6);
  b.tube([3.2, 0.6, 2.2], [3.2, 0.6, 4.6 - 3.6], 0.08, 0.08, 6);
  b.tube([-1, 0.6, 2.2], [-1, 1.3, 0.1], 0.1, 0.1, 8);
  b.tube([-1, 1.3, 0.1], [-1, 1.3, -1.2], 0.1, 0.1, 8);
  b.tube([-1, 1.3, -1.2], [-1, 0.5, -4.2], 0.1, 0.1, 8);
  for (const x of [-7, -1, 5]) b.box(x - 0.15, 0.05, 2.05, x + 0.15, 0.5, 2.35, 'b');
  // truck-loading rack: canopy on four posts, meter cabinet, loading arm, lamps
  const rz0 = -8.2, rz1 = -3.2, rx0 = -4.5, rx1 = 3.5, rh = 5.2;
  b.set({ mat: MAT.concrete, color: 0xbdb8ad });
  b.box(rx0 - 0.5, -0.1, rz0 - 0.4, rx1 + 0.5, 0.12, rz1 + 0.4, 'b');
  b.set({ mat: MAT.metal, color: 0x6a7075, rough: 0.5 });
  for (const x of [rx0, rx1]) for (const z of [rz0, rz1]) b.tube([x, 0.1, z], [x, rh, z], 0.12, 0.12, 8);
  b.set({ mat: MAT.paint, color: 0xe6e6e2 });
  b.box(rx0 - 0.9, rh, rz0 - 0.6, rx1 + 0.9, rh + 0.45, rz1 + 0.6, '');
  b.set({ mat: MAT.paint, color: blue });
  b.box(rx0 - 0.92, rh + 0.1, rz0 - 0.62, rx1 + 0.92, rh + 0.35, rz1 + 0.62, 'tb');
  b.set({ mat: MAT.lamp, color: 0xfff0d8 });
  for (const x of [rx0 + 2, rx1 - 2]) b.boxC(x, rh - 0.03, (rz0 + rz1) / 2, 1.0, 0.05, 0.4, 't');
  b.set({ mat: MAT.paint, color: 0xe8e6e0 });
  b.box(-1.5, 0.12, -4.4, -0.5, 1.9, -3.6, 'b');
  b.set({ mat: MAT.dark, color: 0x151515 });
  b.box(-1.35, 1.1, -4.42, -0.65, 1.6, -4.4, '');
  b.set({ mat: MAT.metal, color: 0x2a2a2a });
  b.tube([-1, 1.3, -4.2], [-1, 3.6, -4.2], 0.09, 0.09, 6);
  b.tube([-1, 3.6, -4.2], [1.6, 3.6, -5.6], 0.07, 0.07, 6);
  b.set({ mat: MAT.rubber, color: 0x111111 });
  b.tube([1.6, 3.6, -5.6], [1.9, 1.2, -6.2], 0.05, 0.05, 6);
  for (const [x, z] of [[rx0 - 0.3, rz0 - 0.2], [rx1 + 0.3, rz0 - 0.2], [rx0 - 0.3, rz1 + 0.2], [rx1 + 0.3, rz1 + 0.2]] as const) bollard(b, x, z);
  // pump shed east of the containment
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(8.3, -0.1, 2.6, 11.6, 0.2, 6.2, 'b');
  b.set({ mat: MAT.corrugated, color: 0xd9d6cc });
  b.box(8.5, 0.2, 2.8, 11.4, 2.6, 6.0, 'tb');
  b.set({ mat: MAT.roofMetal, color: 0x8e9396 });
  b.box(8.3, 2.6, 2.6, 11.6, 2.75, 6.2, 'b');
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallZ(b, 9.4, 10.5, 0.2, 2.2, 2.77, -1);
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(9.95, 2.4, 2.65, 0.3, 0.12, 0.25);
  b.set({ mat: MAT.metal, color: 0x9a9fa2, rough: 0.4 });
  b.tube([7, 0.6, 4.4], [8.5, 0.6, 4.4], 0.08, 0.08, 6);
  // warning bollards at the wall corners facing the road
  for (const x of [cx0 - 0.3, cx1 + 0.3]) bollard(b, x, cz0 - 0.4);
}

// ─── VOR/DME ──────────────────────────────────────────────────────────────────

/**
 * Conventional VOR with co-located DME (footprint radius ≤ 8.7 m): a round white equipment
 * building under a 7 m-radius metal counterpoise on legs at 3.5 m, the white "salt shaker"
 * antenna radome in the middle on top with the DME antenna above it, a separate 6 m DME
 * monitor mast and a small equipment hut at the back.
 */
export function vorStation(b: MeshBuilder): void {
  const yC = 3.5;
  const R = 7;
  // central building
  b.set({ mat: MAT.concrete, color: 0xb3aea4 });
  b.cylinder(0, -0.15, 0, 2.6, 0.35, 20);
  b.set({ mat: MAT.paint, color: 0xecebe6 });
  b.cylinder(0, 0.2, 0, 2.3, yC - 0.2, 20, false);
  b.set({ mat: MAT.door, color: 0x5b6670 });
  b.poly([[-0.5, 0.2, -2.32], [0.5, 0.2, -2.32], [0.5, 2.3, -2.32], [-0.5, 2.3, -2.32]], [0, 0, -1], { wallUV: true });
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(0, 2.6, -2.4, 0.3, 0.12, 0.25);
  // counterpoise: flat disc with a rim, on eight legs with braces
  b.set({ mat: MAT.metal, color: 0xb8bcbe, rough: 0.35 });
  b.cylinder(0, yC, 0, R, 0.12, 32, true);
  b.set({ mat: MAT.metal, color: 0x8d9296, rough: 0.45 });
  b.lathe([[R + 0.02, yC], [R + 0.02, yC + 0.18]], 32);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.sin(a) * (R - 0.6);
    const z = -Math.cos(a) * (R - 0.6);
    b.tube([x, 0, z], [x, yC, z], 0.08, 0.08, 6);
    b.set({ mat: MAT.concrete, color: 0xa9a59c });
    b.cylinder(x, -0.1, z, 0.3, 0.25, 8);
    b.set({ mat: MAT.metal, color: 0x8d9296, rough: 0.45 });
    const a2 = a + Math.PI / 8;
    b.tube([x, 0.3, z], [Math.sin(a2) * 2.35, yC - 0.1, -Math.cos(a2) * 2.35], 0.04, 0.04, 4);
  }
  // radome ("salt shaker") and the DME antenna above it
  b.set({ mat: MAT.paint, color: 0xf0efea });
  b.lathe([[1.0, yC + 0.12], [1.0, yC + 1.5], [0.85, yC + 1.8], [0.45, yC + 2.02], [0, yC + 2.08]], 20);
  b.set({ mat: MAT.paint, color: 0xd9d8d2 });
  b.lathe([[1.08, yC + 0.12], [1.08, yC + 0.3]], 20);
  b.set({ mat: MAT.paint, color: 0xf2f1ec });
  b.cylinder(0, yC + 2.05, 0, 0.14, 1.3, 10);
  b.set({ mat: MAT.lamp, color: 0xd02010 });
  b.cylinder(0, yC + 3.35, 0, 0.08, 0.14, 8);
  // DME monitor mast (front left)
  const mx = -7.4, mz = -3.6;
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.cylinder(mx, -0.1, mz, 0.4, 0.3, 10);
  b.set({ mat: MAT.metal, color: 0x9ea3a6 });
  b.tube([mx, 0.2, mz], [mx, 6.0, mz], 0.07, 0.05, 6);
  b.set({ mat: MAT.paint, color: 0xf0efea });
  b.cylinder(mx, 6.0, mz, 0.16, 1.1, 10);
  // equipment hut at the back
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(-1.35, -0.1, 6.3, 1.35, 0.15, 8.5, 'b');
  b.set({ mat: MAT.paint, color: 0xd8d4c8 });
  b.box(-1.2, 0.15, 6.45, 1.2, 2.45, 8.35, 'tb');
  b.set({ mat: MAT.roofMetal, color: 0x8e9396 });
  b.box(-1.3, 2.45, 6.35, 1.3, 2.6, 8.45, 'b');
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallX(b, 7.0, 7.9, 0.15, 2.2, 1.23, 1);
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.box(-1.9, 0.15, 7.0, -1.22, 1.0, 7.8, 'b');
}

// ─── ILS localizer ───────────────────────────────────────────────────────────

/**
 * ILS localizer antenna array: 14 log-periodic dipole antennas across `width` (along X) on
 * poles, booms pointing toward −Z (the runway), horizontal elements; a support frame and
 * feeder tray behind; the equipment shelter at x = localizerShelterX(width), z = 0.
 */
export function localizerArray(b: MeshBuilder, width = 30): void {
  const N = 14;
  const hw = width / 2;
  const yb = 2.55; // boom height
  // support frame: two rails, feeder tray, legs
  b.set({ mat: MAT.metal, color: 0x9aa0a3, rough: 0.45 });
  b.tube([-hw - 0.3, 2.1, 0.35], [hw + 0.3, 2.1, 0.35], 0.05, 0.05, 6);
  b.set({ mat: MAT.metal, color: 0x7d8286, rough: 0.5 });
  b.box(-hw - 0.3, 0.45, 0.55, hw + 0.3, 0.53, 0.75, '');
  for (let i = 0; i < N; i++) {
    const x = -hw + (width * i) / (N - 1);
    // footing, pole, boom
    b.set({ mat: MAT.concrete, color: 0xa9a59c });
    b.box(x - 0.3, -0.1, 0.05, x + 0.3, 0.12, 0.65, 'b');
    b.set({ mat: MAT.metal, color: 0x9aa0a3, rough: 0.45 });
    b.tube([x, 0.12, 0.35], [x, yb, 0.35], 0.05, 0.045, 6);
    b.tube([x, yb, 0.4], [x, yb, -2.3], 0.035, 0.03, 4);
    b.tube([x, yb - 0.03, -0.8], [x, 2.05, 0.33], 0.02, 0.02, 3);
    // horizontal dipole elements, longest at the back
    b.set({ mat: MAT.metal, color: 0xd0d3d4, rough: 0.35 });
    for (let k = 0; k < 9; k++) {
      const z = 0.3 - k * 0.29;
      const half = 1.0 * Math.pow(0.85, k);
      b.tube([x - half, yb, z], [x + half, yb, z], 0.012, 0.012, 3);
    }
    // radome cap at the tip and feeder cable to the tray
    b.set({ mat: MAT.paint, color: 0xe9e7e2 });
    b.tube([x, yb, -2.3], [x, yb, -2.45], 0.05, 0.02, 6);
    b.set({ mat: MAT.rubber, color: 0x151515 });
    b.tube([x + 0.06, yb - 0.05, 0.4], [x + 0.06, 0.53, 0.62], 0.012, 0.012, 3);
  }
  // equipment shelter beyond the +X end
  const sx = localizerShelterX(width);
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(sx - 1.7, -0.1, -1.45, sx + 1.7, 0.15, 1.45, 'b');
  b.set({ mat: MAT.paint, color: 0xd8d4c8 });
  b.box(sx - 1.5, 0.15, -1.25, sx + 1.5, 2.6, 1.25, 'tb');
  b.set({ mat: MAT.roofMetal, color: 0x8e9396 });
  b.box(sx - 1.62, 2.6, -1.37, sx + 1.62, 2.78, 1.37, 'b');
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallZ(b, sx - 0.45, sx + 0.45, 0.15, 2.2, -1.28, -1);
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(sx, 2.45, -1.36, 0.3, 0.12, 0.2);
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.box(sx + 1.52, 0.4, -0.5, sx + 1.95, 1.2, 0.5, 'b');
  b.set({ mat: MAT.rubber, color: 0x151515 });
  b.box(hw + 0.3, 0.45, 0.55, sx - 1.5, 0.53, 0.75, '');
  // a monitor/field-detector pole in front of the array
  b.set({ mat: MAT.metal, color: 0x9aa0a3 });
  b.tube([sx + 0.2, 0, -1.9], [sx + 0.2, 2.2, -1.9], 0.04, 0.04, 4);
  b.set({ mat: MAT.paint, color: 0xe9e7e2 });
  b.boxC(sx + 0.2, 2.35, -1.9, 0.3, 0.3, 0.3);
}

// ─── ILS glideslope ───────────────────────────────────────────────────────────

/**
 * ILS glideslope: a 12 m triangular lattice mast (x = −1.8) with three antenna panels facing
 * −Z at 3.7, 7.4 and 11 m, an obstruction light on top, a cable tray to the equipment shelter
 * (x ≈ +1.7) with its air-conditioner. Footprint ±3.5 × ±1.9 m.
 */
export function glideslope(b: MeshBuilder): void {
  const mx = -1.8, mz = 0;
  const H = 12.2;
  const r = 0.38;
  // footing
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(mx - 0.9, -0.15, mz - 0.9, mx + 0.9, 0.2, mz + 0.9, 'b');
  // three legs + zig-zag bracing
  const leg = (k: number, y: number): V3 => {
    const a = (k / 3) * Math.PI * 2;
    return [mx + Math.sin(a) * r, y, mz + Math.cos(a) * r];
  };
  b.set({ mat: MAT.metal, color: 0xb7bcbe, rough: 0.4 });
  for (let k = 0; k < 3; k++) b.tube(leg(k, 0.2), leg(k, H), 0.035, 0.035, 5);
  const step = 0.9;
  for (let y = 0.2, i = 0; y + step <= H + 1e-6; y += step, i++)
    for (let k = 0; k < 3; k++) {
      const k1 = (k + 1) % 3;
      if (i % 2 === 0) b.tube(leg(k, y), leg(k1, y + step), 0.014, 0.014, 3);
      else b.tube(leg(k1, y), leg(k, y + step), 0.014, 0.014, 3);
      if (i % 3 === 0) b.tube(leg(k, y), leg(k1, y), 0.016, 0.016, 3);
    }
  // antenna panels facing −Z
  for (const y of [3.7, 7.4, 11.0]) {
    b.set({ mat: MAT.metal, color: 0x6d7275 });
    b.box(mx - 0.08, y - 0.08, mz - r - 0.35, mx + 0.08, y + 0.08, mz - r * 0.3, '');
    b.set({ mat: MAT.paint, color: 0xe9e7e2 });
    b.box(mx - 0.75, y - 0.35, mz - r - 0.55, mx + 0.75, y + 0.35, mz - r - 0.35, '');
    b.set({ mat: MAT.rubber, color: 0x151515 });
    b.tube([mx + 0.1, y - 0.1, mz - r - 0.3], [mx + 0.12, y - 0.3, mz], 0.015, 0.015, 3);
  }
  b.set({ mat: MAT.metal, color: 0xb7bcbe });
  b.tube([mx, H, mz], [mx, H + 0.4, mz], 0.03, 0.03, 4);
  b.set({ mat: MAT.lamp, color: 0xd02010 });
  b.cylinder(mx, H + 0.4, mz, 0.09, 0.16, 8);
  // shelter
  const sx = 1.7, sz = 0.35;
  b.set({ mat: MAT.concrete, color: 0xa9a59c });
  b.box(sx - 1.65, -0.1, sz - 1.4, sx + 1.65, 0.15, sz + 1.4, 'b');
  b.set({ mat: MAT.paint, color: 0xd8d4c8 });
  b.box(sx - 1.5, 0.15, sz - 1.25, sx + 1.5, 2.6, sz + 1.25, 'tb');
  b.set({ mat: MAT.roofMetal, color: 0x8e9396 });
  b.box(sx - 1.62, 2.6, sz - 1.37, sx + 1.62, 2.78, sz + 1.37, 'b');
  b.set({ mat: MAT.door, color: 0x5b6670 });
  wallZ(b, sx - 0.45, sx + 0.45, 0.15, 2.2, sz - 1.28, -1);
  b.set({ mat: MAT.lamp, color: 0xfff0d0 });
  b.boxC(sx, 2.45, sz - 1.36, 0.3, 0.12, 0.2);
  b.set({ mat: MAT.metal, color: 0xa7abab, rough: 0.5 });
  b.box(sx + 1.5, 0.4, sz - 0.5, sx + 1.85, 1.2, sz + 0.5, 'b');
  // cable tray from the shelter to the mast
  b.set({ mat: MAT.metal, color: 0x6d7275, rough: 0.5 });
  b.box(mx + 0.4, 0.4, mz - 0.12, sx - 1.5, 0.5, mz + 0.12, '');
}
