/**
 * Parametric building geometry. PURE (no three.js).
 *
 * Every archetype is ONE small unit mesh drawn instanced; the vertex shader
 * turns it into each building from the per-instance record (instances.ts):
 *
 *   local.x = px·W·(hipK ? ridge : 1)·(chimney ? side : 1) + ox
 *   local.y = py·Hw + pr·Hr + ps·Hr/D + oy          (pr recomputed for cone roofs)
 *   local.z = pz·D + oz
 *
 * (px, py, pz) = `position`, (pr, ps, hipK) = `coef`, (ox, oy, oz) = `offset`
 * in metres (overhangs, roof thickness, chimneys and dormers keep their real
 * size whatever the building), W×D the footprint (ridge along local x, front
 * = +z), Hw the wall height, Hr the roof rise. Normals are exact for any
 * proportions: `normal` = (n0, mode) with mode 0 = fixed, 1–4 = a roof slope
 * n ∝ (n0.x·rise, n0.y·run, n0.z·rise), 5 = dome/cone (see evalVertex).
 * The local frame (x, y, z) maps to the world as x → −(width axis),
 * z → front, i.e. a proper rotation by the heading (world = centre + R·local).
 *
 * `evalVertex` is the CPU twin of the GLSL in shaders.ts (keep them in step):
 * the tests evaluate real buildings with it and check the drawn roof against
 * `roofTopAt` (what the physics collides with).
 */
import { GAMBREL_KNEE_H, GAMBREL_KNEE_T } from './placement';

/** Face types (per vertex, constant over a face): drive the facade/roof shader. */
export const FACE = {
  wallPZ: 0,
  wallNZ: 1,
  wallPX: 2,
  wallNX: 3,
  roofPZ: 4,
  roofNZ: 5,
  roofPX: 6,
  roofNX: 7,
  roofFlat: 8,
  parapetTop: 9,
  parapetIn: 10,
  soffit: 11,
  fascia: 12,
  chimney: 13,
  chimneyTop: 14,
  dormerFront: 15,
  dormerSide: 16,
  dormerRoof: 17,
  siloWall: 18,
  siloRoof: 19,
  cupola: 20,
  cupolaRoof: 21,
} as const;

/** Optional parts (per vertex); each is enabled by an instance flag. */
export const PART = { main: 0, chimney: 1, dormer: 2, cupola: 3 } as const;

/** Instance flag bits (instance record slot `flags`). */
export const FLAG = {
  chimney: 1 << 0,
  dormers: 1 << 1,
  cupola: 1 << 2,
  /** Chimney on the −x half. */
  side: 1 << 3,
  /** The street front is local +x (buildings turned end-on: ridge front-to-back); else +z. */
  doorPX: 1 << 4,
  balcony: 1 << 5,
  shopfront: 1 << 6,
  glass: 1 << 7,
  /** Silos: cone roof (grain bin) instead of a dome. */
  cone: 1 << 8,
  steeple: 1 << 9,
  garage: 1 << 10,
  shutters: 1 << 11,
  siding: 1 << 12,
  ribbon: 1 << 13,
  /** Flat roof (the mid prism draws flat roofs as a membrane, not tiles). */
  flatRoof: 1 << 14,
  whiteRoof: 1 << 15,
  brick: 1 << 16,
  /** No windows (rooftop units, penthouses, masts…). */
  blank: 1 << 17,
  /** Upper tier / rooftop piece of a larger building (no doors, no plinth). */
  upper: 1 << 18,
  harbour: 1 << 19,
} as const;

export const PART_FLAG: Record<number, number> = { [PART.chimney]: FLAG.chimney, [PART.dormer]: FLAG.dormers, [PART.cupola]: FLAG.cupola };

/** Normal modes. */
export const NMODE = { fixed: 0, slope: 1, hipEnd: 2, gambrelLower: 3, gambrelUpper: 4, dome: 5 } as const;

export type NearKind = 'gable' | 'hip' | 'flat' | 'gambrel' | 'silo';
export const NEAR_KINDS: readonly NearKind[] = ['gable', 'hip', 'flat', 'gambrel', 'silo'];
export type GeoKind = NearKind | 'mid';

/** Eave / verge overhang and roof thickness of pitched roofs, parapet thickness (m). */
export const EAVE = 0.45;
export const VERGE = 0.35;
export const ROOF_T = 0.2;
export const PARAPET_T = 0.35;
const BARN_EAVE = 0.4;
const BARN_VERGE = 0.3;
/** Chimney: centre (fractions of W, D) and half size (m). */
export const CHIMNEY_PX = 0.3;
export const CHIMNEY_PZ = -0.2;
const CHIMNEY_H = 0.4;
/** Dormers need at least this much roof rise (m) to fit under the ridge. */
export const DORMER_MIN_RISE = 3.5;

export interface ArchetypeGeometry {
  kind: GeoKind;
  count: number;
  position: Float32Array;
  coef: Float32Array;
  offset: Float32Array;
  normal: Float32Array;
  face: Float32Array;
  index: Uint16Array;
}

interface PV {
  p: [number, number, number];
  r?: number;
  s?: number;
  h?: number;
  o?: [number, number, number];
}

const v = (px: number, py: number, pz: number, opt: Omit<PV, 'p'> = {}): PV => ({ p: [px, py, pz], ...opt });

class GeoBuilder {
  private pos: number[] = [];
  private coef: number[] = [];
  private off: number[] = [];
  private nrm: number[] = [];
  private fc: number[] = [];
  private idx: number[] = [];
  constructor(private kind: GeoKind) {}

  /** A convex polygon, counter-clockwise seen from outside, fan-triangulated. */
  face(vs: PV[], n0: [number, number, number], mode: number, face: number, part: number = PART.main, perVertexNormal?: [number, number, number][]): void {
    const base = this.pos.length / 3;
    vs.forEach((q, i) => {
      this.pos.push(q.p[0], q.p[1], q.p[2]);
      this.coef.push(q.r ?? 0, q.s ?? 0, q.h ?? 0);
      const o = q.o ?? [0, 0, 0];
      this.off.push(o[0], o[1], o[2]);
      const n = perVertexNormal ? perVertexNormal[i] : n0;
      this.nrm.push(n[0], n[1], n[2], mode);
      this.fc.push(face, part);
    });
    for (let i = 1; i < vs.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }

  build(): ArchetypeGeometry {
    return {
      kind: this.kind,
      count: this.pos.length / 3,
      position: Float32Array.from(this.pos),
      coef: Float32Array.from(this.coef),
      offset: Float32Array.from(this.off),
      normal: Float32Array.from(this.nrm),
      face: Float32Array.from(this.fc),
      index: Uint16Array.from(this.idx),
    };
  }
}

const norm3 = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
};

/** Four walls from the base to the wall top (py = 1) — or to the parapet top (pr = topR). */
function walls(g: GeoBuilder, topR = 0): void {
  const t = { r: topR };
  g.face([v(-0.5, 0, 0.5), v(0.5, 0, 0.5), v(0.5, 1, 0.5, t), v(-0.5, 1, 0.5, t)], [0, 0, 1], NMODE.fixed, FACE.wallPZ);
  g.face([v(0.5, 0, -0.5), v(-0.5, 0, -0.5), v(-0.5, 1, -0.5, t), v(0.5, 1, -0.5, t)], [0, 0, -1], NMODE.fixed, FACE.wallNZ);
  g.face([v(0.5, 0, 0.5), v(0.5, 0, -0.5), v(0.5, 1, -0.5, t), v(0.5, 1, 0.5, t)], [1, 0, 0], NMODE.fixed, FACE.wallPX);
  g.face([v(-0.5, 0, -0.5), v(-0.5, 0, 0.5), v(-0.5, 1, 0.5, t), v(-0.5, 1, -0.5, t)], [-1, 0, 0], NMODE.fixed, FACE.wallNX);
}

/** An axis-aligned box part (4 sides + top) centred at (cx·W, cz·D) + (ox, oz), from y0 to y1 (each {py, r, oy}). */
function boxPart(
  g: GeoBuilder,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  y0: { r: number; oy: number },
  y1: { r: number; oy: number },
  side: number,
  top: number,
  part: number,
  ox = 0,
  oz = 0,
): void {
  const P = (sx: number, sz: number, y: { r: number; oy: number }) => v(cx, 1, cz, { r: y.r, o: [ox + sx * hx, y.oy, oz + sz * hz] });
  g.face([P(-1, 1, y0), P(1, 1, y0), P(1, 1, y1), P(-1, 1, y1)], [0, 0, 1], NMODE.fixed, side, part);
  g.face([P(1, -1, y0), P(-1, -1, y0), P(-1, -1, y1), P(1, -1, y1)], [0, 0, -1], NMODE.fixed, side, part);
  g.face([P(1, 1, y0), P(1, -1, y0), P(1, -1, y1), P(1, 1, y1)], [1, 0, 0], NMODE.fixed, side, part);
  g.face([P(-1, -1, y0), P(-1, 1, y0), P(-1, 1, y1), P(-1, -1, y1)], [-1, 0, 0], NMODE.fixed, side, part);
  g.face([P(-1, 1, y1), P(1, 1, y1), P(1, -1, y1), P(-1, -1, y1)], [0, 1, 0], NMODE.fixed, top, part);
}

function chimney(g: GeoBuilder): void {
  boxPart(g, CHIMNEY_PX, CHIMNEY_PZ, CHIMNEY_H, CHIMNEY_H, { r: 0.25, oy: 0 }, { r: 1, oy: ROOF_T + 0.6 }, FACE.chimney, FACE.chimneyTop, PART.chimney);
}

/** Two dormers on the front (+z) slope of a gable roof (pitch 2·Hr/D). */
function dormers(g: GeoBuilder): void {
  const dw = 0.9;
  const zf = 0.28;
  const rBase = 0.3; // bottom of the cheeks, inside the roof
  const rTop = 1 - 2 * zf; // roof surface fraction at the dormer front
  const wallTop = ROOF_T + 1.25;
  const ridgeY = wallTop + 0.6;
  const n = norm3(0.7, dw + 0.15, 0);
  for (const cx of [-0.22, 0.22]) {
    const P = (ox: number, r: number, oy: number, pz: number, oz = 0) => v(cx, 1, pz, { r, o: [ox, oy, oz] });
    // front wall + its gable
    g.face([P(-dw, rBase, 0, zf), P(dw, rBase, 0, zf), P(dw, rTop, wallTop, zf), P(-dw, rTop, wallTop, zf)], [0, 0, 1], NMODE.fixed, FACE.dormerFront, PART.dormer);
    g.face([P(-dw, rTop, wallTop, zf), P(dw, rTop, wallTop, zf), P(0, rTop, ridgeY, zf)], [0, 0, 1], NMODE.fixed, FACE.dormerFront, PART.dormer);
    // cheeks back to the ridge line
    g.face([P(dw, rBase, 0, zf), P(dw, rBase, 0, 0), P(dw, rTop, wallTop, 0), P(dw, rTop, wallTop, zf)], [1, 0, 0], NMODE.fixed, FACE.dormerSide, PART.dormer);
    g.face([P(-dw, rBase, 0, 0), P(-dw, rBase, 0, zf), P(-dw, rTop, wallTop, zf), P(-dw, rTop, wallTop, 0)], [-1, 0, 0], NMODE.fixed, FACE.dormerSide, PART.dormer);
    // little gable roof, ridge front-to-back
    const e = dw + 0.15;
    g.face([P(e, rTop, wallTop - 0.1, zf, 0.25), P(e, rTop, wallTop - 0.1, 0), P(0, rTop, ridgeY, 0), P(0, rTop, ridgeY, zf, 0.25)], [n[0], n[1], 0], NMODE.fixed, FACE.dormerRoof, PART.dormer);
    g.face([P(-e, rTop, wallTop - 0.1, 0), P(-e, rTop, wallTop - 0.1, zf, 0.25), P(0, rTop, ridgeY, zf, 0.25), P(0, rTop, ridgeY, 0)], [-n[0], n[1], 0], NMODE.fixed, FACE.dormerRoof, PART.dormer);
  }
}

/**
 * The slab of a two-slope roof (ridge along x at z = 0): top surfaces, the
 * undersides, eave fascias and verge fascias. `profile` lists the slope
 * breakpoints from the ridge to the wall line as (pz, pr) with the normal
 * mode of the segment below each; the eave overhang continues the last one.
 */
function pitchedSlab(g: GeoBuilder, profile: { pz: number; r: number; mode: number }[], eave: number, verge: number, eaveS: number): void {
  const T = ROOF_T;
  for (const sgn of [1, -1]) {
    // points from ridge to eave edge
    const pts = profile.map((p, i) => ({ pz: p.pz * sgn, r: p.r, oz: 0, s: 0, mode: i === 0 ? -1 : p.mode }));
    const last = profile[profile.length - 1];
    pts.push({ pz: last.pz * sgn, r: last.r, oz: eave * sgn, s: eaveS, mode: last.mode });
    for (let i = 0; i + 1 < pts.length; i++) {
      const hi = pts[i];
      const lo = pts[i + 1];
      const mode = lo.mode;
      const V = (x: number, q: typeof hi, oy: number) => v(x, 1, q.pz, { r: q.r, s: q.s, o: [x * 2 * verge, oy, q.oz] });
      if (sgn > 0) {
        g.face([V(-0.5, lo, T), V(0.5, lo, T), V(0.5, hi, T), V(-0.5, hi, T)], [0, 1, 1], mode, FACE.roofPZ);
        g.face([V(-0.5, hi, 0), V(0.5, hi, 0), V(0.5, lo, 0), V(-0.5, lo, 0)], [0, -1, -1], mode, FACE.soffit);
        // verges: +x then −x
        g.face([V(0.5, lo, 0), V(0.5, hi, 0), V(0.5, hi, T), V(0.5, lo, T)], [1, 0, 0], NMODE.fixed, FACE.fascia);
        g.face([V(-0.5, hi, 0), V(-0.5, lo, 0), V(-0.5, lo, T), V(-0.5, hi, T)], [-1, 0, 0], NMODE.fixed, FACE.fascia);
      } else {
        g.face([V(0.5, lo, T), V(-0.5, lo, T), V(-0.5, hi, T), V(0.5, hi, T)], [0, 1, -1], mode, FACE.roofNZ);
        g.face([V(0.5, hi, 0), V(-0.5, hi, 0), V(-0.5, lo, 0), V(0.5, lo, 0)], [0, -1, 1], mode, FACE.soffit);
        g.face([V(0.5, hi, 0), V(0.5, lo, 0), V(0.5, lo, T), V(0.5, hi, T)], [1, 0, 0], NMODE.fixed, FACE.fascia);
        g.face([V(-0.5, lo, 0), V(-0.5, hi, 0), V(-0.5, hi, T), V(-0.5, lo, T)], [-1, 0, 0], NMODE.fixed, FACE.fascia);
      }
    }
    // eave fascia
    const e = pts[pts.length - 1];
    const F = (x: number, oy: number) => v(x, 1, e.pz, { r: e.r, s: e.s, o: [x * 2 * verge, oy, e.oz] });
    if (sgn > 0) g.face([F(-0.5, 0), F(0.5, 0), F(0.5, T), F(-0.5, T)], [0, 0, 1], NMODE.fixed, FACE.fascia);
    else g.face([F(0.5, 0), F(-0.5, 0), F(-0.5, T), F(0.5, T)], [0, 0, -1], NMODE.fixed, FACE.fascia);
  }
}

function buildGable(): ArchetypeGeometry {
  const g = new GeoBuilder('gable');
  walls(g);
  g.face([v(0.5, 1, 0.5), v(0.5, 1, -0.5), v(0.5, 1, 0, { r: 1 })], [1, 0, 0], NMODE.fixed, FACE.wallPX);
  g.face([v(-0.5, 1, -0.5), v(-0.5, 1, 0.5), v(-0.5, 1, 0, { r: 1 })], [-1, 0, 0], NMODE.fixed, FACE.wallNX);
  pitchedSlab(g, [{ pz: 0, r: 1, mode: NMODE.slope }, { pz: 0.5, r: 0, mode: NMODE.slope }], EAVE, VERGE, -2 * EAVE);
  chimney(g);
  dormers(g);
  return g.build();
}

function buildGambrel(): ArchetypeGeometry {
  const g = new GeoBuilder('gambrel');
  const kz = GAMBREL_KNEE_T / 2;
  const kr = GAMBREL_KNEE_H;
  g.face([v(-0.5, 0, 0.5), v(0.5, 0, 0.5), v(0.5, 1, 0.5), v(-0.5, 1, 0.5)], [0, 0, 1], NMODE.fixed, FACE.wallPZ);
  g.face([v(0.5, 0, -0.5), v(-0.5, 0, -0.5), v(-0.5, 1, -0.5), v(0.5, 1, -0.5)], [0, 0, -1], NMODE.fixed, FACE.wallNZ);
  g.face([v(0.5, 0, 0.5), v(0.5, 0, -0.5), v(0.5, 1, -0.5), v(0.5, 1, -kz, { r: kr }), v(0.5, 1, 0, { r: 1 }), v(0.5, 1, kz, { r: kr }), v(0.5, 1, 0.5)], [1, 0, 0], NMODE.fixed, FACE.wallPX);
  g.face([v(-0.5, 0, -0.5), v(-0.5, 0, 0.5), v(-0.5, 1, 0.5), v(-0.5, 1, kz, { r: kr }), v(-0.5, 1, 0, { r: 1 }), v(-0.5, 1, -kz, { r: kr }), v(-0.5, 1, -0.5)], [-1, 0, 0], NMODE.fixed, FACE.wallNX);
  const lowerSlope = kr / ((1 - GAMBREL_KNEE_T) / 2); // rise per unit of D
  pitchedSlab(
    g,
    [
      { pz: 0, r: 1, mode: NMODE.gambrelUpper },
      { pz: kz, r: kr, mode: NMODE.gambrelUpper },
      { pz: 0.5, r: 0, mode: NMODE.gambrelLower },
    ],
    BARN_EAVE,
    BARN_VERGE,
    -BARN_EAVE * lowerSlope,
  );
  // cupola on the ridge: box + pyramid cap
  const c = 0.8;
  boxPart(g, 0, 0, c, c, { r: 0.85, oy: 0 }, { r: 1, oy: ROOF_T + 1.3 }, FACE.cupola, FACE.cupolaRoof, PART.cupola);
  const top = ROOF_T + 1.3;
  const e = c + 0.15;
  const n = norm3(1.0, e, 0);
  const P = (x: number, z: number, oy: number) => v(0, 1, 0, { r: 1, o: [x, oy, z] });
  g.face([P(-e, e, top), P(e, e, top), P(0, 0, top + 1)], [0, n[1], n[0]], NMODE.fixed, FACE.cupolaRoof, PART.cupola);
  g.face([P(e, -e, top), P(-e, -e, top), P(0, 0, top + 1)], [0, n[1], -n[0]], NMODE.fixed, FACE.cupolaRoof, PART.cupola);
  g.face([P(e, e, top), P(e, -e, top), P(0, 0, top + 1)], [n[0], n[1], 0], NMODE.fixed, FACE.cupolaRoof, PART.cupola);
  g.face([P(-e, -e, top), P(-e, e, top), P(0, 0, top + 1)], [-n[0], n[1], 0], NMODE.fixed, FACE.cupolaRoof, PART.cupola);
  return g.build();
}

function buildHip(): ArchetypeGeometry {
  const g = new GeoBuilder('hip');
  walls(g);
  const E = EAVE;
  const T = ROOF_T;
  const s = -2 * E;
  const eaveV = (sx: number, sz: number, oy: number) => v(0.5 * sx, 1, 0.5 * sz, { s, o: [E * sx, oy, E * sz] });
  const ridgeV = (sx: number, oy: number) => v(0.5 * sx, 1, 0, { r: 1, h: 1, o: [0, oy, 0] });
  // tops
  g.face([eaveV(-1, 1, T), eaveV(1, 1, T), ridgeV(1, T), ridgeV(-1, T)], [0, 1, 1], NMODE.slope, FACE.roofPZ);
  g.face([eaveV(1, -1, T), eaveV(-1, -1, T), ridgeV(-1, T), ridgeV(1, T)], [0, 1, -1], NMODE.slope, FACE.roofNZ);
  g.face([eaveV(1, 1, T), eaveV(1, -1, T), ridgeV(1, T)], [1, 1, 0], NMODE.hipEnd, FACE.roofPX);
  g.face([eaveV(-1, -1, T), eaveV(-1, 1, T), ridgeV(-1, T)], [-1, 1, 0], NMODE.hipEnd, FACE.roofNX);
  // undersides
  g.face([ridgeV(-1, 0), ridgeV(1, 0), eaveV(1, 1, 0), eaveV(-1, 1, 0)], [0, -1, -1], NMODE.slope, FACE.soffit);
  g.face([ridgeV(1, 0), ridgeV(-1, 0), eaveV(-1, -1, 0), eaveV(1, -1, 0)], [0, -1, 1], NMODE.slope, FACE.soffit);
  g.face([ridgeV(1, 0), eaveV(1, -1, 0), eaveV(1, 1, 0)], [-1, -1, 0], NMODE.hipEnd, FACE.soffit);
  g.face([ridgeV(-1, 0), eaveV(-1, 1, 0), eaveV(-1, -1, 0)], [1, -1, 0], NMODE.hipEnd, FACE.soffit);
  // fascia ring
  g.face([eaveV(-1, 1, 0), eaveV(1, 1, 0), eaveV(1, 1, T), eaveV(-1, 1, T)], [0, 0, 1], NMODE.fixed, FACE.fascia);
  g.face([eaveV(1, -1, 0), eaveV(-1, -1, 0), eaveV(-1, -1, T), eaveV(1, -1, T)], [0, 0, -1], NMODE.fixed, FACE.fascia);
  g.face([eaveV(1, 1, 0), eaveV(1, -1, 0), eaveV(1, -1, T), eaveV(1, 1, T)], [1, 0, 0], NMODE.fixed, FACE.fascia);
  g.face([eaveV(-1, -1, 0), eaveV(-1, 1, 0), eaveV(-1, 1, T), eaveV(-1, -1, T)], [-1, 0, 0], NMODE.fixed, FACE.fascia);
  chimney(g);
  return g.build();
}

function buildFlat(): ArchetypeGeometry {
  const g = new GeoBuilder('flat');
  walls(g, 1);
  const P = PARAPET_T;
  const t = { r: 1 };
  // parapet inner faces (Hw → Hw + Hr), facing inward
  g.face([v(0.5, 1, 0.5, { o: [-P, 0, -P] }), v(-0.5, 1, 0.5, { o: [P, 0, -P] }), v(-0.5, 1, 0.5, { ...t, o: [P, 0, -P] }), v(0.5, 1, 0.5, { ...t, o: [-P, 0, -P] })], [0, 0, -1], NMODE.fixed, FACE.parapetIn);
  g.face([v(-0.5, 1, -0.5, { o: [P, 0, P] }), v(0.5, 1, -0.5, { o: [-P, 0, P] }), v(0.5, 1, -0.5, { ...t, o: [-P, 0, P] }), v(-0.5, 1, -0.5, { ...t, o: [P, 0, P] })], [0, 0, 1], NMODE.fixed, FACE.parapetIn);
  g.face([v(0.5, 1, -0.5, { o: [-P, 0, P] }), v(0.5, 1, 0.5, { o: [-P, 0, -P] }), v(0.5, 1, 0.5, { ...t, o: [-P, 0, -P] }), v(0.5, 1, -0.5, { ...t, o: [-P, 0, P] })], [-1, 0, 0], NMODE.fixed, FACE.parapetIn);
  g.face([v(-0.5, 1, 0.5, { o: [P, 0, -P] }), v(-0.5, 1, -0.5, { o: [P, 0, P] }), v(-0.5, 1, -0.5, { ...t, o: [P, 0, P] }), v(-0.5, 1, 0.5, { ...t, o: [P, 0, -P] })], [1, 0, 0], NMODE.fixed, FACE.parapetIn);
  // coping ring
  const up: [number, number, number] = [0, 1, 0];
  g.face([v(-0.5, 1, 0.5, t), v(0.5, 1, 0.5, t), v(0.5, 1, 0.5, { ...t, o: [0, 0, -P] }), v(-0.5, 1, 0.5, { ...t, o: [0, 0, -P] })], up, NMODE.fixed, FACE.parapetTop);
  g.face([v(-0.5, 1, -0.5, { ...t, o: [0, 0, P] }), v(0.5, 1, -0.5, { ...t, o: [0, 0, P] }), v(0.5, 1, -0.5, t), v(-0.5, 1, -0.5, t)], up, NMODE.fixed, FACE.parapetTop);
  g.face([v(0.5, 1, 0.5, { ...t, o: [-P, 0, -P] }), v(0.5, 1, 0.5, { ...t, o: [0, 0, -P] }), v(0.5, 1, -0.5, { ...t, o: [0, 0, P] }), v(0.5, 1, -0.5, { ...t, o: [-P, 0, P] })], up, NMODE.fixed, FACE.parapetTop);
  g.face([v(-0.5, 1, 0.5, { ...t, o: [0, 0, -P] }), v(-0.5, 1, 0.5, { ...t, o: [P, 0, -P] }), v(-0.5, 1, -0.5, { ...t, o: [P, 0, P] }), v(-0.5, 1, -0.5, { ...t, o: [0, 0, P] })], up, NMODE.fixed, FACE.parapetTop);
  // roof deck
  g.face([v(-0.5, 1, 0.5, { o: [P, 0, -P] }), v(0.5, 1, 0.5, { o: [-P, 0, -P] }), v(0.5, 1, -0.5, { o: [-P, 0, P] }), v(-0.5, 1, -0.5, { o: [P, 0, P] })], up, NMODE.fixed, FACE.roofFlat);
  return g.build();
}

export const SILO_SEGMENTS = 16;
const SILO_RINGS = 4;

function buildSilo(): ArchetypeGeometry {
  const g = new GeoBuilder('silo');
  const N = SILO_SEGMENTS;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    g.face(
      [v(0.5 * c1, 0, 0.5 * s1), v(0.5 * c0, 0, 0.5 * s0), v(0.5 * c0, 1, 0.5 * s0), v(0.5 * c1, 1, 0.5 * s1)],
      [0, 0, 0],
      NMODE.fixed,
      FACE.siloWall,
      PART.main,
      [
        [c1, 0, s1],
        [c0, 0, s0],
        [c0, 0, s0],
        [c1, 0, s1],
      ],
    );
    // dome/cone rings: θ from the vertical, 90° at the eave
    const ring = (k: number, c: number, s: number) => {
      const th = (Math.PI / 2) * (1 - k / SILO_RINGS);
      const st = Math.sin(th);
      const ct = Math.cos(th);
      return { pv: v(0.5 * st * c, 1, 0.5 * st * s, { r: ct }), n: [st * c, ct, st * s] as [number, number, number] };
    };
    for (let k = 0; k < SILO_RINGS; k++) {
      if (k === SILO_RINGS - 1) {
        const a = ring(k, c1, s1);
        const b = ring(k, c0, s0);
        g.face([a.pv, b.pv, v(0, 1, 0, { r: 1 })], [0, 0, 0], NMODE.dome, FACE.siloRoof, PART.main, [a.n, b.n, [0, 1, 0]]);
      } else {
        const a = ring(k, c1, s1);
        const b = ring(k, c0, s0);
        const c = ring(k + 1, c0, s0);
        const d = ring(k + 1, c1, s1);
        g.face([a.pv, b.pv, c.pv, d.pv], [0, 0, 0], NMODE.dome, FACE.siloRoof, PART.main, [a.n, b.n, c.n, d.n]);
      }
    }
  }
  return g.build();
}

/** Mid-distance prism: walls + a hip roof without overhangs (ridge 1 = gable ends, Hr 0 = flat). */
function buildMid(): ArchetypeGeometry {
  const g = new GeoBuilder('mid');
  walls(g);
  const e = (sx: number, sz: number) => v(0.5 * sx, 1, 0.5 * sz);
  const r = (sx: number) => v(0.5 * sx, 1, 0, { r: 1, h: 1 });
  g.face([e(-1, 1), e(1, 1), r(1), r(-1)], [0, 1, 1], NMODE.slope, FACE.roofPZ);
  g.face([e(1, -1), e(-1, -1), r(-1), r(1)], [0, 1, -1], NMODE.slope, FACE.roofNZ);
  g.face([e(1, 1), e(1, -1), r(1)], [1, 1, 0], NMODE.hipEnd, FACE.roofPX);
  g.face([e(-1, -1), e(-1, 1), r(-1)], [-1, 1, 0], NMODE.hipEnd, FACE.roofNX);
  return g.build();
}

export const ARCH_GEOMETRIES: Record<GeoKind, ArchetypeGeometry> = {
  gable: buildGable(),
  hip: buildHip(),
  flat: buildFlat(),
  gambrel: buildGambrel(),
  silo: buildSilo(),
  mid: buildMid(),
};

// ─── Instance record layout (shared with instances.ts and the shaders) ───────

/** Floats per instance: iA (x, y, z, heading) iB (W, D, Hw, Hr) iC (wall, roof, rand, style) iD (ridge, floorH, flags, plinth) iE (chunk, aux…). */
export const INST_STRIDE = 20;
export const I = {
  x: 0,
  y: 1,
  z: 2,
  heading: 3,
  W: 4,
  D: 5,
  Hw: 6,
  Hr: 7,
  wall: 8,
  roof: 9,
  rand: 10,
  style: 11,
  ridge: 12,
  floorH: 13,
  flags: 14,
  plinth: 15,
  chunk: 16,
  aux0: 17,
  aux1: 18,
  aux2: 19,
} as const;

export interface EvalOut {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** False when the vertex belongs to a disabled part (collapsed). */
  on: boolean;
}

export const newEvalOut = (): EvalOut => ({ x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, on: true });

/** World position + normal of vertex `vi` for the instance record at `inst[io…]`. Mirrors the vertex shader. */
export function evalVertex(g: ArchetypeGeometry, vi: number, inst: Float32Array, io: number, out: EvalOut): EvalOut {
  const W = inst[io + I.W];
  const D = inst[io + I.D];
  const Hw = inst[io + I.Hw];
  const Hr = inst[io + I.Hr];
  const ridge = inst[io + I.ridge];
  const flags = inst[io + I.flags] | 0;
  const part = g.face[vi * 2 + 1];
  const pf = PART_FLAG[part];
  const on = part === PART.main || (pf !== undefined && (flags & pf) !== 0);
  const px = g.position[vi * 3];
  const py = g.position[vi * 3 + 1];
  const pz = g.position[vi * 3 + 2];
  let pr = g.coef[vi * 3];
  const ps = g.coef[vi * 3 + 1];
  const hk = g.coef[vi * 3 + 2];
  const mode = g.normal[vi * 4 + 3];
  let n0x = g.normal[vi * 4];
  let n0y = g.normal[vi * 4 + 1];
  let n0z = g.normal[vi * 4 + 2];
  const side = part === PART.chimney && flags & FLAG.side ? -1 : 1;
  const cone = (flags & FLAG.cone) !== 0;
  const rr = 2 * Math.hypot(px, pz);
  if (mode === NMODE.dome && cone) pr = 1 - rr;
  let lx = px * W * (hk > 0.5 ? ridge : 1) * side + g.offset[vi * 3];
  let ly = py * Hw + pr * Hr + (ps * Hr) / D + g.offset[vi * 3 + 1];
  let lz = pz * D + g.offset[vi * 3 + 2];
  if (!on) lx = ly = lz = 0;
  // normal
  let nx = n0x;
  let ny = n0y;
  let nz = n0z;
  if (mode >= NMODE.slope && mode <= NMODE.gambrelUpper) {
    let rise = Hr;
    let run = 0.5 * D;
    if (mode === NMODE.hipEnd) run = (1 - ridge) * 0.5 * W;
    else if (mode === NMODE.gambrelLower) {
      rise = GAMBREL_KNEE_H * Hr;
      run = ((1 - GAMBREL_KNEE_T) / 2) * D;
    } else if (mode === NMODE.gambrelUpper) {
      rise = (1 - GAMBREL_KNEE_H) * Hr;
      run = (GAMBREL_KNEE_T / 2) * D;
    }
    nx = n0x * rise;
    ny = n0y * run + 1e-6 * n0y;
    nz = n0z * rise;
  } else if (mode === NMODE.dome) {
    const R = 0.5 * W;
    if (cone) {
      const hl = Math.hypot(px, pz);
      const hx = hl > 1e-6 ? px / hl : 0;
      const hz = hl > 1e-6 ? pz / hl : 0;
      nx = hx * Hr;
      ny = R;
      nz = hz * Hr;
    } else {
      nx = n0x / R;
      ny = n0y / Math.max(Hr, 1e-3);
      nz = n0z / R;
    }
  }
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  void n0x;
  void n0y;
  void n0z;
  // proper rotation: local x → −(width axis), local z → front
  const h = inst[io + I.heading];
  const c = Math.cos(h);
  const s = Math.sin(h);
  out.x = inst[io + I.x] - c * lx + s * lz;
  out.y = inst[io + I.y] + ly;
  out.z = inst[io + I.z] - s * lx - c * lz;
  out.nx = -c * nx + s * nz;
  out.ny = ny;
  out.nz = -s * nx - c * nz;
  out.on = on;
  if (!on) {
    // collapsed parts: all at the instance origin
    out.x = inst[io + I.x];
    out.y = inst[io + I.y];
    out.z = inst[io + I.z];
  }
  return out;
}
