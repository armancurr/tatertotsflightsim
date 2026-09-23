/**
 * Boeing 747-400 model — PLACEHOLDER (blocks on the B747_AIRCRAFT geometry) until the procedural
 * model lands: fuselage with the upper-deck hump, swept wings, four engine pods, tailplane and fin.
 */
import * as THREE from 'three';
import { B747_AIRCRAFT } from '../../config';
import type { AircraftModelHandle } from '../../fleet/types';
import { attachFlightDeck } from './flightDeck'; // b747deck: the flight deck interior

export function createB747Model(): AircraftModelHandle {
  const g = B747_AIRCRAFT.geometry;
  const root = new THREE.Group();
  root.name = 'b747';
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8ecef, roughness: 0.55, metalness: 0.1 });
  const geos: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, name: string, ry = 0, rz = 0) => {
    geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(0, ry, rz, 'YXZ');
    m.name = name;
    m.castShadow = true;
    root.add(m);
    return m;
  };
  const noseZ = g.spinnerTip.z;
  const tailZ = noseZ + g.length;
  add(new THREE.BoxGeometry(6.4, 6.6, g.length - 4), 0, 0, (noseZ + tailZ) / 2 + 1, 'b747.fuselage');
  add(new THREE.BoxGeometry(4.2, 2.4, 22), 0, 3.6, noseZ + 13, 'b747.upperDeck');
  // Swept wings: a box per side along the 37.5° quarter-chord line, with 7° dihedral.
  const sweep = (37.5 * Math.PI) / 180;
  const semi = B747_AIRCRAFT.wingSpan / 2;
  for (const s of [-1, 1]) {
    const len = semi / Math.cos(sweep);
    add(new THREE.BoxGeometry(len, 0.8, 7.5), (s * semi) / 2, -0.4, -2 + (semi / 2) * Math.tan(sweep), `b747.wing.${s < 0 ? 'l' : 'r'}`, -s * sweep, s * 0.12);
    add(new THREE.BoxGeometry(g.horizontalTail.span / 2, 0.4, 5), (s * g.horizontalTail.span) / 4, g.horizontalTail.y, g.horizontalTail.z, `b747.stab.${s < 0 ? 'l' : 'r'}`);
    for (const [x, z, y] of [[11.9, -9.5, -2.4], [21.2, -1.5, -1.5]]) {
      const nac = new THREE.CylinderGeometry(1.35, 1.2, 6.5, 16).rotateX(Math.PI / 2);
      add(nac, s * x, y, z, `b747.engine.${s < 0 ? 'l' : 'r'}.${x > 15 ? 'out' : 'in'}`);
    }
  }
  add(new THREE.BoxGeometry(0.8, 12, 9), 0, 8.2, 34.5, 'b747.fin');
  return attachFlightDeck({
    root,
    setVisualState() {},
    dispose() {
      geos.forEach((x) => x.dispose());
      mat.dispose();
    },
  });
}
