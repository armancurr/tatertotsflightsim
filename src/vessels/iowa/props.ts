/**
 * The Iowa's four propellers and two rudders. Outboard shafts: four-bladed 5.56 m (18 ft 3 in);
 * inboard shafts: five-bladed 5.18 m (17 ft), each centred on its PropulsorConfig.position with its
 * diameter, spinning about the shaft (local z) by the propeller speed; the outboard pair turn
 * outward. The twin semi-balanced rudders (21 ft tall, 340 ft²) hang behind the inboard propellers,
 * turning about a vertical stock at 28 % of the chord; the centre of the blade's area is the
 * propulsor's foilCentre (where the physics applies the rudder force).
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { gridGeometry, type P3 } from '../geom';
import { propellerGeometry } from '../v50/pods';
import type { PropulsorConfig } from '../../config';
import { IOWA_COLORS as C } from './materials';

/** Rudder: span (m), chord (m), thickness ratio, stock position (fraction of the chord from the leading edge). */
export const RUDDER = { span: 6.4, chord: 4.9, thickness: 0.18, stock: 0.28 } as const;

export interface PropRig {
  spinner: THREE.Group;
  mesh: THREE.Mesh;
  /** +1 = turns clockwise seen from aft at positive n (the starboard shafts), −1 counter-clockwise. */
  hand: 1 | -1;
}

/** A propeller of `blades` blades and diameter D (the V50's blade generator, scaled from its 0.25 m reference radius). */
export function iowaPropGeometry(blades: number, diameter: number, hand: 1 | -1): THREE.BufferGeometry {
  const g = propellerGeometry(blades, 0.25, hand);
  const k = diameter / 2 / 0.25;
  g.scale(k, k, k * 0.8);
  // re-tint in manganese bronze
  const col = g.getAttribute('color');
  const c = new THREE.Color(C.bronze);
  for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
  return g;
}

export function buildProp(p: PropulsorConfig, name: string, mat: THREE.Material): PropRig {
  const hand: 1 | -1 = p.position.x >= 0 ? 1 : -1;
  const spinner = new THREE.Group();
  spinner.name = name;
  spinner.position.set(p.position.x, p.position.y, p.position.z);
  const blades = Math.abs(p.position.x) > 6 ? 4 : 5;
  const mesh = new THREE.Mesh(iowaPropGeometry(blades, p.diameter, hand), mat);
  mesh.name = `${name}.blades`;
  mesh.castShadow = false;
  spinner.add(mesh);
  return { spinner, mesh, hand };
}

/** A symmetric foil ring (NACA 00xx), chord along z from zLe, at height y. */
function foilRing(chord: number, t: number, zLe: number, y: number, n = 12): P3[] {
  const pts: P3[] = [];
  for (let k = 0; k <= 2 * n; k++) {
    const s = k <= n ? k / n : (2 * n - k) / n;
    const x = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const half = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const side = k <= n ? 1 : -1;
    pts.push([side * half * chord, y, zLe + x * chord]);
  }
  return pts;
}

export interface RudderRig {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
}

/** The rudder behind propulsor p: the pivot at the stock's top (where it meets the hull), turning about +Y. */
export function buildRudder(p: PropulsorConfig, name: string, mat: THREE.Material): RudderRig {
  const pivot = new THREE.Group();
  pivot.name = name;
  const zLe = -RUDDER.stock * RUDDER.chord;
  // centre of area (half span down, mid-chord) on the foil centre
  const zStock = p.foilCentre.z - (zLe + RUDDER.chord / 2);
  pivot.position.set(p.foilCentre.x, p.foilCentre.y + RUDDER.span / 2, zStock);
  const rings = [0, 1, 2, 3].map((k) => foilRing(RUDDER.chord * (1 - 0.04 * k), RUDDER.thickness, zLe, -RUDDER.span * (k / 3)));
  const skin = gridGeometry(rings, (x) => [x, 0, 0]);
  const stock = new THREE.CylinderGeometry(0.4, 0.4, 1.6, 12);
  stock.translate(0, 0.8, 0);
  const mesh = new THREE.Mesh(merge([tint(skin, C.red, 0.8, 0), tint(stock, C.red, 0.8, 0.1)]), mat);
  mesh.name = `${name}.blade`;
  mesh.castShadow = false;
  pivot.add(mesh);
  return { pivot, mesh };
}
