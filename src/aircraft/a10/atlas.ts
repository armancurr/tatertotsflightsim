/**
 * PURE layout of the A-10's paint atlas (one 2048² canvas shared by every painted part) and the UV
 * mappings the geometry builders and the livery painter both use.
 *
 *   v 0.5…1      fuselage: u = station z, v = signed arc length s from the top centreline (s > 0
 *                right side). The nose-tip corners hold flat swatches for small parts.
 *   v 0.25…0.5   wings (1024 × 256 px each): right upper | right lower (top row), left upper |
 *                left lower; u = |x| (span), v = z. The gear pods are projected onto the lower cells.
 *   v 0…0.25     fins (4 × 256 × 512 px): left outer | left inner | right inner | right outer,
 *                u = z (reversed on the faces that look left so lettering reads forward), v = y ·
 *                nacelles (u = z, v = angle round the nacelle) · stabiliser upper | lower (u = x, v = z)
 */

export const ATLAS_SIZE = 2048;

export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export const CELL = {
  fuselage: { u0: 0, v0: 0.5, u1: 1, v1: 1 },
  wingRightUpper: { u0: 0, v0: 0.375, u1: 0.5, v1: 0.5 },
  wingRightLower: { u0: 0.5, v0: 0.375, u1: 1, v1: 0.5 },
  wingLeftUpper: { u0: 0, v0: 0.25, u1: 0.5, v1: 0.375 },
  wingLeftLower: { u0: 0.5, v0: 0.25, u1: 1, v1: 0.375 },
  finLeftOuter: { u0: 0, v0: 0, u1: 0.125, v1: 0.25 },
  finLeftInner: { u0: 0.125, v0: 0, u1: 0.25, v1: 0.25 },
  finRightInner: { u0: 0.25, v0: 0, u1: 0.375, v1: 0.25 },
  finRightOuter: { u0: 0.375, v0: 0, u1: 0.5, v1: 0.25 },
  nacelle: { u0: 0.5, v0: 0.125, u1: 1, v1: 0.25 },
  stabUpper: { u0: 0.5, v0: 0, u1: 0.75, v1: 0.125 },
  stabLower: { u0: 0.75, v0: 0, u1: 1, v1: 0.125 },
} as const satisfies Record<string, Cell>;

/** Ranges mapped into each cell (metres / radians). */
export const RANGE = {
  fuseZ: [-7.0, 9.0] as const,
  fuseS: [-3.4, 3.4] as const,
  wingX: [0.5, 8.8] as const,
  wingZ: [-1.9, 2.4] as const,
  finZ: [7.0, 9.1] as const,
  finY: [-0.45, 2.6] as const,
  nacelleZ: [3.0, 6.5] as const,
  stabX: [-2.95, 2.95] as const,
  stabZ: [7.1, 9.05] as const,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (r: readonly [number, number], x: number) => (x - r[0]) / (r[1] - r[0]);

export function cellUV(c: Cell, fu: number, fv: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = lerp(c.u0, c.u1, fu);
  out[1] = lerp(c.v0, c.v1, fv);
  return out;
}

export function fuselageUV(z: number, s: number, out?: [number, number]) {
  return cellUV(CELL.fuselage, frac(RANGE.fuseZ, z), frac(RANGE.fuseS, s), out);
}

/** Flat colour swatches in the unused nose-tip corners of the fuselage cell. */
export const SWATCH = {
  /** FS 36270 neutral grey (pods, pylons, undersides). */
  light: fuselageUV(-6.93, 3.2),
  /** FS 36118 gunship grey (nacelle pylons, fairings). */
  dark: fuselageUV(-6.93, -3.2),
} as const;

export function wingUV(x: number, z: number, upper: boolean, out?: [number, number]) {
  const right = x >= 0;
  const c = right ? (upper ? CELL.wingRightUpper : CELL.wingRightLower) : upper ? CELL.wingLeftUpper : CELL.wingLeftLower;
  return cellUV(c, frac(RANGE.wingX, Math.abs(x)), frac(RANGE.wingZ, z), out);
}

/** Fin faces: `outer` = the face looking away from the aircraft centreline. */
export function finCell(rightFin: boolean, outer: boolean): Cell {
  if (rightFin) return outer ? CELL.finRightOuter : CELL.finRightInner;
  return outer ? CELL.finLeftOuter : CELL.finLeftInner;
}
export function finUV(z: number, y: number, rightFin: boolean, outer: boolean, out?: [number, number]) {
  // Lettering reads nose-first: on faces looking right (+x) u runs forward.
  const looksRight = rightFin === outer;
  const fz = frac(RANGE.finZ, z);
  return cellUV(finCell(rightFin, outer), looksRight ? 1 - fz : fz, frac(RANGE.finY, y), out);
}

export function nacelleUV(z: number, angle: number, out?: [number, number]) {
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return cellUV(CELL.nacelle, frac(RANGE.nacelleZ, z), a / (2 * Math.PI), out);
}

export function stabUV(x: number, z: number, upper: boolean, out?: [number, number]) {
  return cellUV(upper ? CELL.stabUpper : CELL.stabLower, frac(RANGE.stabX, x), frac(RANGE.stabZ, z), out);
}

/** Canvas pixel of a UV (canvas y runs down; textures are uploaded with flipY). */
export function uvToPx(u: number, v: number, size = ATLAS_SIZE): [number, number] {
  return [u * size, (1 - v) * size];
}
