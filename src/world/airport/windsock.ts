/**
 * Windsock: an FAA L-807 fabric cone (orange/white bands) whose shape is
 * computed in the vertex shader from the wind (materials.ts
 * createWindsockMaterial). The geometry is only a (s, θ) parameter grid.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { WINDSOCK } from './materials';

export const WINDSOCK_MAST = { height: 6.0, arm: 0.12 };

/** Unit direction (x, z) the sock streams toward, and its extension 0..1, from the config wind. */
export function windsockWind(): { x: number; z: number; strength: number } {
  const w = CONFIG.world.airportRender.wind;
  const toward = ((w.fromDeg + 180) * Math.PI) / 180;
  // a 12 ft sock is fully extended at 15 kt
  return { x: Math.sin(toward), z: -Math.cos(toward), strength: Math.max(0, Math.min(1, w.speedKt / 15)) };
}

/** Parameter grid: aSock = (s along 0..1, θ around). `position` holds the rest pose for bounds. */
export function buildWindsockGeometry(rings = 14, seg = 16): THREE.BufferGeometry {
  const pos: number[] = [];
  const sock: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const s = i / rings;
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const r = WINDSOCK.throat + (WINDSOCK.tail - WINDSOCK.throat) * s;
      pos.push(s * WINDSOCK.length, r * Math.sin(th), r * Math.cos(th));
      sock.push(s, th);
    }
  }
  for (let i = 0; i < rings; i++)
    for (let k = 0; k < seg; k++) {
      const a = i * (seg + 1) + k;
      const b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSock', new THREE.Float32BufferAttribute(sock, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -1, 0), WINDSOCK.length + 1);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-4.5, -4.5, -4.5), new THREE.Vector3(4.5, 1, 4.5));
  return g;
}
