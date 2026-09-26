/**
 * Sea-Doo materials. Few materials = few draw calls: every painted moulding (hull, deck, hood,
 * stripes) is one vertex-coloured gloss "paint" material with a clear coat; seat vinyl, rubber
 * mats, the pod, bars, pump and metal share the per-vertex colour / roughness / metalness parts
 * material of the aircraft (src/aircraft/materials.ts `tint`); the rider has their own (skinned)
 * copy; the dash display is unlit. After a crash the soot spreads over paint and parts (`char`).
 */
import * as THREE from 'three';
import { addSoot, createPartsMaterial } from '../../aircraft/materials';

/** Livery: white topsides, charcoal deck and bottom, "Tater" orange hood and swoosh. */
export const SEADOO_COLORS = {
  white: 0xf2f2ef,
  deck: 0x33373c,
  bottom: 0x2a2d32,
  orange: 0xff6a14,
  black: 0x141618,
  rubber: 0x1c1e21,
  mat: 0x4a4f55,
  metal: 0x9aa1a8,
  darkMetal: 0x4a4f55,
  smoke: 0x151a20,
  vest: 0xd4f214,
  suit: 0x1a1c20,
  glove: 0x2a2c30,
  helmet: 0xf4f4f2,
  visor: 0x1a2430,
  boot: 0x2d3034,
} as const;

export interface SeadooMaterials {
  paint: THREE.MeshPhysicalMaterial;
  parts: THREE.MeshStandardMaterial;
  rider: THREE.MeshStandardMaterial;
  screen: THREE.MeshBasicMaterial;
  char: { value: number };
  all: THREE.Material[];
}

export function createSeadooMaterials(): SeadooMaterials {
  const char = { value: 0 };
  const paint = new THREE.MeshPhysicalMaterial({
    name: 'seadoo.paint',
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.3,
    metalness: 0,
    clearcoat: 0.9,
    clearcoatRoughness: 0.12,
    side: THREE.DoubleSide,
  });
  const parts = createPartsMaterial('seadoo-parts');
  parts.side = THREE.DoubleSide;
  const rider = createPartsMaterial('seadoo-rider');
  const screen = new THREE.MeshBasicMaterial({ name: 'seadoo.screen', vertexColors: true });
  addSoot(paint, char);
  addSoot(parts, char);
  return { paint, parts, rider, screen, char, all: [paint, parts, rider, screen] };
}
