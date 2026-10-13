/**
 * MS Tater Star hull geometry: the shell lofted from the physics' station table (src/vessels/
 * hullLoft.ts), the main deck, the bulwarks round the bow and the stern, the anchors and hawse
 * pipes, the bow and stern tunnel-thruster openings (on the propulsor positions) and the bow name.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { tint, merge } from '../../aircraft/materials';
import { V, box, ellipsoid } from '../../aircraft/f16/geom';
import { buildHullDeck, buildHullPatch, buildHullShell, hullSampleZs } from '../hullLoft';
import { hullSectionAt, sectionHalfBreadth } from '../hullSection';
import { gridGeometry, type P3 } from '../geom';
import { CRUISE_SHAPE, STATIONS, WCR } from './shape';

export interface CruiseHullGeometry {
  /** Hull material: the skin and the bulwarks. */
  shell: THREE.BufferGeometry;
  /** Parts material: the deck, anchors, hawse pipes, thruster tunnels. */
  details: THREE.BufferGeometry;
  /** The bow name boards (both sides), UV 0..1 across each. */
  name: THREE.BufferGeometry;
}

/** The outward unit normal (x, y) of a hull section at height y (starboard side). */
function sectionNormal(z: number, y: number): { nx: number; ny: number } {
  const s = hullSectionAt(STATIONS, z);
  const [ax, ay, bx, by] = y <= s.chineY ? [0, s.keelY, s.chineHalf, s.chineY] : [s.chineHalf, s.chineY, s.deckHalf, s.deckY];
  const len = Math.hypot(bx - ax, by - ay) || 1;
  return { nx: (by - ay) / len, ny: -(bx - ax) / len };
}

/** Where each tunnel thruster opens on the skin (starboard side; mirror x for port). */
export function tunnelOpenings(): { index: number; x: number; y: number; z: number; r: number }[] {
  const out: { index: number; x: number; y: number; z: number; r: number }[] = [];
  WCR.propulsors.forEach((p, index) => {
    if (p.type !== 'thruster') return;
    const s = hullSectionAt(STATIONS, p.position.z);
    out.push({ index, x: sectionHalfBreadth(s, p.position.y), y: p.position.y, z: p.position.z, r: p.diameter / 2 });
  });
  return out;
}

/** A bulwark (1.2 m) along the deck edge between two z, both sides. */
function bulwark(z0: number, z1: number, h: number): THREE.BufferGeometry[] {
  const zs = hullSampleZs(STATIONS, 1.5, z0, z1);
  const out: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const grid: P3[][] = zs.map((z) => {
      const s = hullSectionAt(STATIONS, z);
      return [[side * s.deckHalf, s.deckY, z], [side * s.deckHalf * 0.995, s.deckY + h, z]];
    });
    out.push(gridGeometry(grid, [side, 0, 0]));
  }
  return out;
}

export function buildCruiseHull(): CruiseHullGeometry {
  const S = CRUISE_SHAPE;
  const skin = buildHullShell(STATIONS, { maxStep: 2, bottomSegments: 6, sideSegments: 8, capStern: true, capBow: true });
  // bulwarks round the foredeck and the stern (the deck in between is under the superstructure)
  const shell = merge([skin, ...bulwark(S.zBow + 0.4, -78, 1.25), ...bulwark(104, S.zStern - 0.2, 1.1)]);

  const parts: THREE.BufferGeometry[] = [];
  parts.push(tint(buildHullDeck(STATIONS, { z0: S.zBow, z1: S.zStern, camber: 0.25, segments: 8, maxStep: 3, lift: 0.02 }), 0xa7aba5, 0.85));
  // anchors in their pockets, hawse pipes and the windlass on the foredeck
  const zA = S.zBow + 9;
  for (const side of [1, -1]) {
    const s = hullSectionAt(STATIONS, zA);
    const y = s.deckY - 2.2;
    const x = sectionHalfBreadth(s, y);
    const n = sectionNormal(zA, y);
    const pocket = tint(ellipsoid(V(side * (x + 0.02), y, zA), 0.3, 0.8, 1.0, 12, 8), 0x2a2e33, 0.7);
    parts.push(pocket);
    parts.push(tint(box(0.5, 1.6, 1.3, V(side * (x + 0.18 * n.nx), y - 0.2, zA)), 0x2a2d31, 0.6, 0.4));
    const deckS = hullSectionAt(STATIONS, zA + 4);
    parts.push(tint(box(2.2, 1.0, 2.6, V(side * 3.2, deckS.deckY + 0.5, zA + 4)), 0x3b4148, 0.6, 0.3));
  }
  // mooring bollards along the foredeck and the stern
  for (const z of [S.zBow + 16, S.zBow + 24, S.zStern - 10, S.zStern - 18]) {
    const s = hullSectionAt(STATIONS, z);
    for (const side of [1, -1]) parts.push(tint(new THREE.CylinderGeometry(0.35, 0.35, 0.8, 10).translate(side * (s.deckHalf - 1.4), s.deckY + 0.4, z), 0x2c3035, 0.5, 0.4));
  }
  // tunnel thruster openings: dark bores with a grille, both sides
  for (const t of tunnelOpenings()) {
    for (const side of [1, -1]) {
      const n = sectionNormal(t.z, t.y);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(side * n.nx, n.ny, 0).normalize());
      const disc = new THREE.CircleGeometry(t.r, 24).applyQuaternion(q).translate(side * (t.x + 0.03), t.y, t.z);
      parts.push(tint(disc, 0x0b0d10, 0.9));
      const ring = new THREE.RingGeometry(t.r, t.r + 0.18, 24).applyQuaternion(q).translate(side * (t.x + 0.035), t.y, t.z);
      parts.push(tint(ring, 0x9aa0a6, 0.5, 0.3));
      for (const dy of [-0.4, 0.4]) {
        const bar = new THREE.BoxGeometry(0.1, 0.12, 2 * t.r).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(side * n.nx, n.ny, 0).normalize()));
        parts.push(tint(bar.translate(side * (t.x + 0.06), t.y + dy * t.r, t.z), 0x6a7076, 0.5, 0.3));
      }
    }
  }
  const details = merge(parts);

  // the name on both bows
  const zn0 = S.zBow + 10;
  const zn1 = zn0 + 19;
  const names: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    const g = buildHullPatch(STATIONS, { z0: zn0, z1: zn1, yLo: (z) => hullSectionAt(STATIONS, z).deckY - 3.4, yHi: (z) => hullSectionAt(STATIONS, z).deckY - 1.0, side, offset: 0.05, nz: 24, ny: 2 });
    // read bow → stern on starboard, stern → bow on port: flip u on starboard so the text reads from the bow
    if (side === 1) {
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    }
    names.push(g);
  }
  const name = mergeGeometries(names, false)!;
  for (const g of names) g.dispose();
  return { shell, details, name };
}
