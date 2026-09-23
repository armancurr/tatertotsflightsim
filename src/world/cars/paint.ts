/**
 * Paint colours (PURE), from the real mix of new-car colours on North American
 * roads (Axalta/PPG surveys, 2020s): white ≈ 29 %, black ≈ 21 %, grey ≈ 18 %,
 * silver ≈ 10 %, blue ≈ 9 %, red ≈ 8 %, green / brown / beige / other the
 * rest. Each entry is sRGB + a finish (0 solid, 1 pearl, 2 metallic).
 * Packed paint: rgb in the low 24 bits, finish in bits 24–25.
 */
import { VT } from './specs';

type Swatch = readonly [rgb: number, finish: number, weight: number];

const CAR: readonly Swatch[] = [
  // white
  [0xf1f1ee, 0, 17],
  [0xe6e4dc, 1, 12],
  // black
  [0x0b0c0e, 0, 10],
  [0x15171a, 2, 11],
  // grey
  [0x3f4247, 2, 7],
  [0x62666b, 2, 6],
  [0x8a8d90, 0, 5],
  // silver
  [0xa9adb1, 2, 6],
  [0xc3c6c8, 2, 4],
  // blue
  [0x17233f, 2, 4],
  [0x27477e, 2, 3],
  [0x587a9e, 1, 2],
  // red
  [0x7a1214, 2, 4],
  [0xa2171a, 0, 3],
  [0x561019, 2, 1],
  // green, brown, beige
  [0x283f30, 2, 1],
  [0x4d5a3d, 0, 1],
  [0x62503f, 2, 1],
  [0xb3a78c, 1, 1],
  // other
  [0xc79b2c, 2, 0.6],
  [0xc0561d, 0, 0.5],
  [0x3a6468, 2, 0.5],
];

const TRUCK: readonly Swatch[] = [
  [0xf0f0ec, 0, 30],
  [0xa51c1c, 0, 12],
  [0x1b3a78, 0, 10],
  [0x0e0f11, 0, 10],
  [0x5b5f63, 2, 8],
  [0x2e5a34, 0, 5],
  [0xd7a21b, 0, 4],
  [0x8f9396, 2, 6],
  [0x6b1c24, 2, 4],
];

const TRAILER: readonly Swatch[] = [
  [0xecece8, 0, 60],
  [0xc9cbcc, 2, 25],
  [0xa7aaac, 2, 10],
  [0xd9d2c0, 0, 5],
];

const BUS: readonly Swatch[] = [
  [0xf2a900, 0, 55], // school bus yellow
  [0xe9eae6, 0, 45],
];

const TRACTOR: readonly Swatch[] = [
  [0x2c6a2a, 0, 40],
  [0xa81c1c, 0, 40],
  [0x1f4c96, 0, 20],
];

const pick = (list: readonly Swatch[], h: number): Swatch => {
  let total = 0;
  for (const s of list) total += s[2];
  let x = h * total;
  for (const s of list) {
    x -= s[2];
    if (x < 0) return s;
  }
  return list[list.length - 1];
};

const pack = (s: Swatch): number => (s[0] | (s[1] << 24)) >>> 0;

/** The paint of a vehicle of this type for a hash h ∈ [0, 1). */
export function paintFor(type: number, h: number): number {
  if (type === VT.box || type === VT.semi) return pack(pick(TRUCK, h));
  if (type === VT.bus) return pack(pick(BUS, h));
  if (type === VT.tractor) return pack(pick(TRACTOR, h));
  if (type === VT.van) return h < 0.55 ? pack([0xf1f1ee, 0, 1]) : pack(pick(CAR, (h - 0.55) / 0.45));
  return pack(pick(CAR, h));
}

/** A semi trailer's paint. */
export function trailerPaint(h: number): number {
  return pack(pick(TRAILER, h));
}

export const paintRGB = (p: number): number => p & 0xffffff;
export const paintFinish = (p: number): number => (p >>> 24) & 3;

/** The car palette with weights (for the distribution test). */
export const CAR_SWATCHES = CAR;
