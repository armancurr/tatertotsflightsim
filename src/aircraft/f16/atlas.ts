/**
 * PURE layout of the F-16's paint atlas (one 2048² canvas texture shared by every painted part)
 * and the UV mappings the geometry builders and the livery painter both use.
 *
 *   v 0.5…1   fuselage: u = station z, v = signed arc length s from the top centreline
 *             (s > 0 right side). Unused corners hold flat swatches for small parts.
 *   v 0.25…0.5  wings: right upper | right lower | left upper | left lower (u = z, v = |x|)
 *   v 0…0.25   fin right side | fin left side (u = z, reversed on the right so lettering reads
 *              forward on both sides; v = y) · cowl side (u = z, v = y, both sides share it)
 *              · stabilators upper | lower (u = z, v = |x|)
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
  wingRightUpper: { u0: 0, v0: 0.25, u1: 0.25, v1: 0.5 },
  wingRightLower: { u0: 0.25, v0: 0.25, u1: 0.5, v1: 0.5 },
  wingLeftUpper: { u0: 0.5, v0: 0.25, u1: 0.75, v1: 0.5 },
  wingLeftLower: { u0: 0.75, v0: 0.25, u1: 1, v1: 0.5 },
  finRight: { u0: 0, v0: 0, u1: 0.25, v1: 0.25 },
  finLeft: { u0: 0.25, v0: 0, u1: 0.5, v1: 0.25 },
  cowl: { u0: 0.5, v0: 0.125, u1: 1, v1: 0.25 },
  stabUpper: { u0: 0.5, v0: 0, u1: 0.75, v1: 0.125 },
  stabLower: { u0: 0.75, v0: 0, u1: 1, v1: 0.125 },
} as const satisfies Record<string, Cell>;

/** Ranges mapped into each cell (metres). */
export const RANGE = {
  fuseZ: [-6.8, 5.0] as const,
  fuseS: [-3.3, 3.3] as const,
  wingX: [0.85, 4.62] as const,
  wingZ: [-1.25, 3.25] as const,
  finZ: [2.2, 6.0] as const,
  finY: [0.35, 3.2] as const,
  cowlZ: [-4.75, 1.75] as const,
  cowlY: [-1.0, -0.15] as const,
  stabX: [0.95, 2.9] as const,
  stabZ: [3.5, 5.95] as const,
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

/** Flat colour swatches painted in unused corners of the fuselage cell (for small parts). */
export const SWATCH = {
  /** FS 36375 light ghost grey (undersides, ventral fins, lower speed brakes). */
  light: fuselageUV(-6.7, 3.15),
  /** FS 36270 medium grey (upper speed brakes, fairings). */
  mid: fuselageUV(-6.7, -3.15),
} as const;

export function wingUV(x: number, z: number, upper: boolean, out?: [number, number]) {
  const right = x >= 0;
  const c = right ? (upper ? CELL.wingRightUpper : CELL.wingRightLower) : upper ? CELL.wingLeftUpper : CELL.wingLeftLower;
  return cellUV(c, frac(RANGE.wingZ, z), frac(RANGE.wingX, Math.abs(x)), out);
}

export function finUV(z: number, y: number, rightSide: boolean, out?: [number, number]) {
  const fz = frac(RANGE.finZ, z);
  return cellUV(rightSide ? CELL.finRight : CELL.finLeft, rightSide ? 1 - fz : fz, frac(RANGE.finY, y), out);
}

export function cowlUV(z: number, y: number, out?: [number, number]) {
  return cellUV(CELL.cowl, frac(RANGE.cowlZ, z), frac(RANGE.cowlY, y), out);
}

export function stabUV(x: number, z: number, upper: boolean, out?: [number, number]) {
  return cellUV(upper ? CELL.stabUpper : CELL.stabLower, frac(RANGE.stabZ, z), frac(RANGE.stabX, Math.abs(x)), out);
}

/** Canvas pixel of a UV (canvas y runs down; textures are uploaded with flipY). */
export function uvToPx(u: number, v: number, size = ATLAS_SIZE): [number, number] {
  return [u * size, (1 - v) * size];
}
