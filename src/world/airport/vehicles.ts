/**
 * Parked cars for the car park (instanced; body colour per instance): a
 * saloon and an SUV/pick-up-ish estate. Local frame: −Z = the car's front,
 * ground at y = 0. aAccent = 1 marks the painted body (tinted by the
 * instance colour); glass, tyres and lamps keep their vertex colours.
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from './builder';

export type CarKind = 'sedan' | 'suv';

interface CarShape {
  length: number;
  halfWidth: number;
  belt: (z: number) => number;
  roof: (z: number) => number;
  /** Greenhouse inset (tumblehome) at the roof, m. */
  inset: number;
  /** Roof extent in z (the painted roof panel). */
  roofZ: [number, number];
  wheelZ: [number, number];
  wheelR: number;
  bottom: number;
}

const lerpTable = (pts: [number, number][]) => (z: number) => {
  if (z <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++)
    if (z <= pts[i][0]) {
      const t = (z - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
      const s = t * t * (3 - 2 * t);
      return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * s;
    }
  return pts[pts.length - 1][1];
};

const SHAPES: Record<CarKind, CarShape> = {
  sedan: {
    length: 4.7,
    halfWidth: 0.9,
    belt: lerpTable([[-2.35, 0.72], [-2.2, 0.8], [-1.0, 0.92], [1.4, 0.98], [2.2, 0.96], [2.35, 0.86]]),
    roof: lerpTable([[-1.0, 0.95], [-0.25, 1.43], [0.95, 1.43], [1.65, 1.0]]),
    inset: 0.16,
    roofZ: [-0.2, 0.95],
    wheelZ: [-1.38, 1.4],
    wheelR: 0.32,
    bottom: 0.25,
  },
  suv: {
    length: 4.65,
    halfWidth: 0.93,
    belt: lerpTable([[-2.32, 0.85], [-2.15, 0.98], [-1.1, 1.08], [2.2, 1.1], [2.32, 1.0]]),
    roof: lerpTable([[-1.15, 1.1], [-0.45, 1.72], [1.95, 1.72], [2.25, 1.14]]),
    inset: 0.12,
    roofZ: [-0.4, 1.95],
    wheelZ: [-1.4, 1.42],
    wheelR: 0.36,
    bottom: 0.3,
  },
};

export function buildCar(kind: CarKind): MeshBuilder {
  const s = SHAPES[kind];
  const b = new MeshBuilder();
  const half = s.length / 2;
  const zs: number[] = [];
  for (let i = 0; i <= 16; i++) zs.push(-half + (s.length * i) / 16);
  // lower body: ring from the sill up the side to the belt line and across the top (hood / deck)
  const bodyRing = (z: number): V3[] => {
    const e = Math.min(1, (half - Math.abs(z)) / 0.35); // round the ends in plan
    const hw = s.halfWidth * (0.86 + 0.14 * Math.sqrt(Math.max(0, e)));
    const top = s.belt(z);
    const bot = s.bottom + (1 - e) * 0.12;
    const pts: V3[] = [];
    const prof: [number, number][] = [
      [0, bot - 0.02],
      [hw * 0.82, bot],
      [hw, bot + 0.12],
      [hw, top - 0.2],
      [hw * 0.96, top - 0.04],
      [hw * 0.8, top],
      [0, top + 0.02],
    ];
    for (const [x, y] of prof) pts.push([x, y, z]);
    for (let i = prof.length - 2; i >= 1; i--) pts.push([-prof[i][0], prof[i][1], z]);
    return pts;
  };
  b.set({ color: 0xffffff, accent: 1, rough: 0.28, metal: 0.45, part: 0 });
  const rings = zs.map(bodyRing);
  b.loft(rings, true);
  b.capRing(rings[0], [0, (s.belt(-half) + s.bottom) / 2, -half - 0.02], [0, 0, -1]);
  b.capRing(rings[rings.length - 1], [0, (s.belt(half) + s.bottom) / 2, half + 0.02], [0, 0, 1]);
  // greenhouse: glass band from the belt line to the roof, painted roof panel on top
  const gz: number[] = [];
  const [r0, r1] = [zs.find((z) => s.roof(z) > s.belt(z) + 0.02) ?? -1, [...zs].reverse().find((z) => s.roof(z) > s.belt(z) + 0.02) ?? 1];
  for (let i = 0; i <= 10; i++) gz.push(r0 - 0.12 + ((r1 - r0 + 0.24) * i) / 10);
  const glassRings: V3[][] = gz.map((z) => {
    const belt = s.belt(z);
    const roof = Math.max(belt + 0.01, s.roof(z));
    const hw = s.halfWidth * 0.95;
    const hwTop = hw - s.inset;
    return [
      [hw, belt - 0.01, z],
      [hwTop + 0.02, roof - 0.04, z],
      [hwTop - 0.1, roof, z],
      [-hwTop + 0.1, roof, z],
      [-hwTop - 0.02, roof - 0.04, z],
      [-hw, belt - 0.01, z],
    ] as V3[];
  });
  b.set({ color: 0x0b0e11, accent: 0, rough: 0.06, metal: 0.1, part: 7 });
  b.loft(glassRings, false);
  // roof panel slightly above the glass loft's top
  b.set({ color: 0xffffff, accent: 1, rough: 0.28, metal: 0.45, part: 0 });
  const [rz0, rz1] = s.roofZ;
  const ry = (z: number) => s.roof(z) + 0.012;
  const hwTop = s.halfWidth * 0.95 - s.inset - 0.06;
  b.poly([[-hwTop, ry(rz0), rz0], [hwTop, ry(rz0), rz0], [hwTop, ry(rz1), rz1], [-hwTop, ry(rz1), rz1]], [0, 1, 0]);
  // wheels
  for (const z of s.wheelZ)
    for (const side of [-1, 1]) {
      const x = side * (s.halfWidth - 0.12);
      b.push(new THREE.Matrix4().makeRotationZ(Math.PI / 2).setPosition(x + 0.11, s.wheelR, z));
      b.set({ color: 0x121212, accent: 0, rough: 0.9, metal: 0, part: 0 });
      b.lathe([[s.wheelR * 0.65, 0], [s.wheelR, 0.02], [s.wheelR, 0.2], [s.wheelR * 0.65, 0.22]], 12);
      b.set({ color: 0x9da2a6, rough: 0.35, metal: 0.8 });
      b.lathe([[s.wheelR * 0.65, 0.22], [0, 0.225]], 10);
      b.pop();
    }
  // lamps
  b.set({ color: 0xe8ecef, accent: 0, rough: 0.15, metal: 0.2, part: 7 });
  for (const side of [-1, 1]) {
    const y = s.belt(-half) - 0.12;
    b.poly([[side * 0.5, y, -half - 0.03], [side * 0.8, y, -half - 0.01], [side * 0.8, y + 0.1, -half - 0.01], [side * 0.5, y + 0.1, -half - 0.03]], [0, 0, -1]);
  }
  b.set({ color: 0x8a0a06, part: 7 });
  for (const side of [-1, 1]) {
    const y = s.belt(half) - 0.14;
    b.poly([[side * 0.55, y, half + 0.03], [side * 0.84, y, half + 0.01], [side * 0.84, y + 0.12, half + 0.01], [side * 0.55, y + 0.12, half + 0.03]], [0, 0, 1]);
  }
  return b;
}

export function buildCarGeometry(kind: CarKind): THREE.BufferGeometry {
  return buildCar(kind).toGeometry(['color', 'accent', 'rm', 'part']);
}

/** Car body paints (sRGB): white, silver, grey, black, dark blue, red, beige, green. */
export const CAR_PAINTS = [0xe9e9e6, 0xa9adb0, 0x55595d, 0x151618, 0x1d2c4a, 0x8d1a16, 0xb9ab8e, 0x2b4234];
