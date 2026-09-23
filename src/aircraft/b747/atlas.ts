/**
 * PURE layout of the 747's paint atlas (one 4096 × 2048 canvas for every painted part; a second
 * canvas of the same layout carries the panel-line bump in R and the roughness in G) and the UV
 * mappings the geometry builders and the livery painter share.
 *
 *   v 0.5…1        fuselage: u = station z, v = signed arc length s from the top centreline
 *                  (s > 0 on the right side, so the right side shows the canvas rotated 180°)
 *   v 0…0.5, u 0…0.5  wings: right upper | left upper (top row), right lower | left lower;
 *                  u = span |x|, v = chord fraction (0 = leading edge)
 *   v 0.125…0.5, u 0.5…1  fin: left face | right face, u = z (aft →), v = y
 *   v 0…0.125, u 0.5…1    stabiliser: upper | lower, u = |x|, v = chord fraction
 */

export const ATLAS_W = 4096;
export const ATLAS_H = 2048;

export interface Cell {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export const CELL = {
  fuselage: { u0: 0, v0: 0.5, u1: 1, v1: 1 },
  wingRightUpper: { u0: 0, v0: 0.25, u1: 0.25, v1: 0.5 },
  wingLeftUpper: { u0: 0.25, v0: 0.25, u1: 0.5, v1: 0.5 },
  wingRightLower: { u0: 0, v0: 0, u1: 0.25, v1: 0.25 },
  wingLeftLower: { u0: 0.25, v0: 0, u1: 0.5, v1: 0.25 },
  finLeft: { u0: 0.5, v0: 0.125, u1: 0.75, v1: 0.5 },
  finRight: { u0: 0.75, v0: 0.125, u1: 1, v1: 0.5 },
  stabUpper: { u0: 0.5, v0: 0, u1: 0.75, v1: 0.125 },
  stabLower: { u0: 0.75, v0: 0, u1: 1, v1: 0.125 },
} as const satisfies Record<string, Cell>;

/** Ranges mapped into each cell (metres). */
export const RANGE = {
  fuseZ: [-32.2, 36.8] as const,
  fuseS: [-12.8, 12.8] as const,
  wingX: [2.4, 32.4] as const,
  finZ: [23.6, 39.2] as const,
  finY: [2.0, 14.6] as const,
  stabX: [0, 11.2] as const,
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (r: readonly [number, number], x: number) => (x - r[0]) / (r[1] - r[0]);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function cellUV(c: Cell, fu: number, fv: number, out: [number, number] = [0, 0]): [number, number] {
  out[0] = lerp(c.u0, c.u1, clamp01(fu));
  out[1] = lerp(c.v0, c.v1, clamp01(fv));
  return out;
}

export function fuselageUV(z: number, s: number, out?: [number, number]) {
  return cellUV(CELL.fuselage, frac(RANGE.fuseZ, z), frac(RANGE.fuseS, s), out);
}

export function wingUV(x: number, f: number, upper: boolean, out?: [number, number]) {
  const right = x >= 0;
  const c = upper ? (right ? CELL.wingRightUpper : CELL.wingLeftUpper) : right ? CELL.wingRightLower : CELL.wingLeftLower;
  return cellUV(c, frac(RANGE.wingX, Math.abs(x)), f, out);
}

export function finUV(z: number, y: number, rightFace: boolean, out?: [number, number]) {
  return cellUV(rightFace ? CELL.finRight : CELL.finLeft, frac(RANGE.finZ, z), frac(RANGE.finY, y), out);
}

export function stabUV(x: number, f: number, upper: boolean, out?: [number, number]) {
  return cellUV(upper ? CELL.stabUpper : CELL.stabLower, frac(RANGE.stabX, Math.abs(x)), f, out);
}

/** Canvas pixel of a UV (canvas y runs down; textures are uploaded with flipY). */
export function uvToPx(u: number, v: number): [number, number] {
  return [u * ATLAS_W, (1 - v) * ATLAS_H];
}

/** Pixel rectangle [x, y, w, h] of a cell. */
export function cellRect(c: Cell): [number, number, number, number] {
  const [x0, y1] = uvToPx(c.u0, c.v0);
  const [x1, y0] = uvToPx(c.u1, c.v1);
  return [x0, y0, x1 - x0, y1 - y0];
}
