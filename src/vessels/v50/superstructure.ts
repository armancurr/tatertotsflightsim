/**
 * Princess V50 hardtop: the raked wrap-around windscreen and the side glazing (tinted glass), the
 * crowned roof with its big dark sliding sunroof panel, black A- and B-pillars and windscreen
 * header, the flying C-pillars down to the cockpit gunwales, the glass aft bulkhead, and the swept
 * radar pylon with its dome (whose top is geometry.verticalTailTop). Returns plain geometries per
 * material (vertex-coloured GRP, glass); index.ts makes the meshes.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V } from '../../aircraft/f16/geom';
import { beam, gridGeometry, type P3 } from '../geom';
import { V50_COLORS } from './hull';
import {
  G50,
  V50_SHAPE as S,
  cockpitHalf,
  coachTopY,
  houseHalf,
  houseTopHalf,
  roofAftZ,
  roofBottomY,
  roofFrontZ,
  roofHalf,
  roofTopY,
  sec,
  sillY,
  wsBaseZ,
  wsTopZ,
} from './shape';

const range = (a: number, b: number, n: number) => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);

/** Windscreen base / top edge points at u ∈ [−1, 1]. */
export function windscreenBase(u: number): THREE.Vector3 {
  const z = wsBaseZ(u);
  const x = u * houseHalf(z);
  return V(x, coachTopY(x, z) + 0.004, z);
}
export function windscreenTop(u: number): THREE.Vector3 {
  const z = wsTopZ(u);
  const x = u * houseTopHalf(z);
  return V(x, roofBottomY(x, z), z);
}
/** A point on the side glazing: s ∈ [0, 1] from the A-pillar to the aft bulkhead, v ∈ [0, 1] sill → roof. */
export function sideGlassPoint(side: number, s: number, v: number): THREE.Vector3 {
  const zf = wsBaseZ(1) + (wsTopZ(1) - wsBaseZ(1)) * v;
  const z = zf + (S.zAftBulkhead - zf) * s;
  const x = side * (houseHalf(z) + (houseTopHalf(z) - houseHalf(z)) * v);
  const y = sillY(z) + (roofBottomY(x, z) - sillY(z)) * v;
  return V(x, y, z);
}

/**
 * The radar pylon's plan section at t ∈ [0, 1] (roof → dome plinth): height, centre z, half-length
 * along z (a) and half-width (b). A long, wide swept fin on the roof narrowing into the dome.
 */
export function pylonSection(t: number): { y: number; zc: number; a: number; b: number } {
  const top = G50.verticalTailTop;
  const y0 = roofTopY(0, S.pylonBaseZ) - 0.03;
  const y1 = top.y - S.domeHeight + 0.02;
  return {
    y: y0 + (y1 - y0) * t,
    zc: S.pylonBaseZ + (top.z - S.pylonBaseZ) * t,
    a: 0.85 - 0.6 * Math.sqrt(t),
    b: 0.36 - 0.24 * Math.sqrt(t),
  };
}

/** The white masthead light: on the pylon's leading edge, high up. */
export function mastheadLight(): THREE.Vector3 {
  const s = pylonSection(0.72);
  return V(0, s.y, s.zc - 0.8 * s.a - 0.02);
}

export interface HardtopGeometry {
  grp: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
}

export function buildHardtop(): HardtopGeometry {
  const grp: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const W = V50_COLORS.white;
  const K = V50_COLORS.black;

  // ── Windscreen (ruled between the base curve and the top edge) ──
  {
    const us = range(-1, 1, 28);
    const grid: P3[][] = range(0, 1, 6).map((v) =>
      us.map((u) => {
        const b = windscreenBase(u);
        const t = windscreenTop(u);
        return [b.x + (t.x - b.x) * v, b.y + (t.y - b.y) * v, b.z + (t.z - b.z) * v] as P3;
      }),
    );
    glass.push(gridGeometry(grid, [0, 0.6, -1]));
  }
  // ── Side glazing ──
  for (const side of [1, -1]) {
    const grid: P3[][] = range(0, 1, 30).map((s) => range(0, 1, 4).map((v) => sideGlassPoint(side, s, v).toArray() as P3));
    glass.push(gridGeometry(grid, [side, 0, 0]));
  }
  // ── Aft bulkhead (glass doors) ──
  {
    const z = S.zAftBulkhead;
    const grid: P3[][] = range(-1, 1, 8).map((u) => {
      const xb = u * houseHalf(z);
      const xt = u * houseTopHalf(z);
      return [[xb, S.floorY, z], [xt, roofBottomY(xt, z), z]] as P3[];
    });
    glass.push(gridGeometry(grid, [0, 0, 1]));
  }

  // ── Roof: top, headliner, edge band (the front lip dark, like the windscreen header) ──
  {
    const nu = 22;
    const nt = 30;
    const at = (u: number, t: number, top: boolean): P3 => {
      const z = roofFrontZ(u) + (roofAftZ(u) - roofFrontZ(u)) * t;
      const x = u * roofHalf(z);
      return [x, top ? roofTopY(x, z) : roofBottomY(x, z), z];
    };
    const topGrid: P3[][] = range(0, 1, nt).map((t) => range(-1, 1, nu).map((u) => at(u, t, true)));
    const botGrid: P3[][] = range(0, 1, nt).map((t) => range(-1, 1, nu).map((u) => at(u, t, false)));
    grp.push(tint(gridGeometry(topGrid, [0, 1, 0]), W, 0.28));
    grp.push(tint(gridGeometry(botGrid, [0, -1, 0]), 0xe8e3d8, 0.8));
    // Perimeter: front lip (dark), sides and aft edge (white).
    const front = range(-1, 1, nu).map((u) => [at(u, 0, true), at(u, 0, false)] as P3[]);
    grp.push(tint(gridGeometry(front, [0, 0, -1]), K, 0.25));
    const rest: P3[][] = [
      ...range(0, 1, nt).map((t) => [at(1, t, true), at(1, t, false)] as P3[]),
      ...range(1, -1, nu).slice(1).map((u) => [at(u, 1, true), at(u, 1, false)] as P3[]),
      ...range(1, 0, nt).slice(1).map((t) => [at(-1, t, true), at(-1, t, false)] as P3[]),
    ];
    grp.push(tint(gridGeometry(rest, (x, _y, z) => [x, 0, z - 0.3]), W, 0.3));
    // Sunroof: a big dark glass panel set into the roof, rounded at its ends.
    const sz0 = -1.35;
    const sz1 = 0.95;
    const sun: P3[][] = range(0, 1, 16).map((t) => {
      const z = sz0 + (sz1 - sz0) * t;
      const e = Math.min(1, Math.sin(Math.PI * t) * 3.2);
      const hw = 0.92 * Math.sqrt(Math.max(0, e));
      return range(-1, 1, 8).map((u) => [u * hw, roofTopY(u * hw, z) + 0.007, z] as P3);
    });
    grp.push(tint(gridGeometry(sun, [0, 1, 0]), 0x101418, 0.06, 0.2));
  }

  // ── Pillars: A (along the windscreen corners), B (splits the side glass), C (flying, to the gunwale) ──
  for (const side of [1, -1]) {
    const b = windscreenBase(side);
    const t = windscreenTop(side);
    grp.push(tint(beam(b.clone().add(V(-side * 0.01, 0, 0)), t.clone().add(V(-side * 0.01, 0.02, 0)), 0.09, 0.05), K, 0.3));
    const pb = sideGlassPoint(side, 0.56, 0);
    const pt = sideGlassPoint(side, 0.52, 1);
    grp.push(tint(beam(pb.add(V(side * 0.012, 0, 0)), pt.add(V(side * 0.012, 0.02, 0)), 0.1, 0.03), K, 0.3));
    // Sill trim under the side glass (dark, reads as one band with the glass).
    const sill = range(0, 1, 30).map((s) => {
      const p = sideGlassPoint(side, s, 0);
      return [[p.x + side * 0.004, p.y - 0.05, p.z], [p.x + side * 0.004, p.y + 0.004, p.z]] as P3[];
    });
    grp.push(tint(gridGeometry(sill, [side, 0, 0]), K, 0.3));
    // Aft bulkhead door frames.
    for (const x of [0.55, -0.55]) {
      const z = S.zAftBulkhead + 0.01;
      grp.push(tint(beam(V(x, S.floorY, z), V(x, roofBottomY(x, z), z), 0.05, 0.04, new THREE.Vector3(0, 0, 1)), K, 0.3));
    }
    // C-pillar: from the cockpit gunwale up and forward to the roof's aft corner.
    const zb = 2.85;
    const base = V(side * (cockpitHalf(zb) + 0.05), sec(zb).deckY, zb);
    const zt = 2.0;
    const xt = side * (roofHalf(zt) - 0.07);
    const top = V(xt, roofBottomY(xt, zt) + 0.02, zt);
    grp.push(tint(beam(base, top, 0.2, 0.07, new THREE.Vector3(side, 0, 0)), W, 0.3));
  }

  // ── Radar pylon (swept) and dome; its top is geometry.verticalTailTop ──
  {
    const top = G50.verticalTailTop;
    const domeBase = top.y - S.domeHeight;
    const rings = range(0, 1, 8).map((t) => {
      const { y, zc, a, b } = pylonSection(t);
      return range(0, 1, 24).map((k) => {
        const th = k * Math.PI * 2;
        const c = Math.cos(th);
        // Teardrop plan: blunt forward, sharper aft.
        const zOff = -a * c * (c > 0 ? 0.8 : 1.0);
        return [b * Math.sin(th), y, zc + zOff] as P3;
      });
    });
    grp.push(tint(gridGeometry(rings, (x, y, z) => [x, 0, z - (S.pylonBaseZ + top.z) / 2]), W, 0.28));
    const cyl = new THREE.CylinderGeometry(S.domeRadius, S.domeRadius * 0.97, S.domeHeight - 0.07, 32, 1, true);
    cyl.translate(top.x, domeBase + (S.domeHeight - 0.07) / 2, top.z);
    grp.push(tint(cyl, W, 0.3));
    const cap = new THREE.SphereGeometry(1, 32, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(S.domeRadius, 0.07, S.domeRadius);
    cap.translate(top.x, top.y - 0.07, top.z);
    grp.push(tint(cap, W, 0.3));
    const under = new THREE.CircleGeometry(S.domeRadius * 0.97, 32);
    under.rotateX(Math.PI / 2);
    under.translate(top.x, domeBase, top.z);
    grp.push(tint(under, 0xd8d8d4, 0.4));
  }

  return { grp: merge(grp), glass: mergeGlass(glass) };
}

/** Glass carries only position / normal / uv. */
function mergeGlass(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return merge(list.map((g) => tint(g, 0xffffff, 0.05)));
}
