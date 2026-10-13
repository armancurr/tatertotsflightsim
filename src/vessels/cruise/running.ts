/**
 * MS Tater Star running gear: the two four-bladed propellers on the shaft propulsors' positions
 * (turned by `n`; outward-turning: the starboard screw clockwise seen from astern), the semi-
 * balanced rudders behind them on the foil centres (turned by `steerDeg`: + swings the trailing edge
 * to starboard, which turns the bow to starboard), and the static shafts with their A-brackets.
 */
import * as THREE from 'three';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid, tube } from '../../aircraft/f16/geom';
import type { PropulsorConfig } from '../../config';
import { hullSectionAt, sectionBottomY } from '../hullSection';
import { fanCap, gridGeometry, type P3 } from '../geom';
import { STATIONS, WCR } from './shape';

export interface ScrewRig {
  /** Identity container (a break-up part) holding the propeller and the rudder. */
  container: THREE.Group;
  /** The propeller: positioned on the propulsor, spun about its z axis. */
  prop: THREE.Group;
  blades: THREE.Mesh;
  /** The rudder stock: rotation.y = steer (rad). */
  rudder: THREE.Group;
  /** +1 starboard (clockwise from astern, ahead), −1 port. */
  hand: number;
}

/** Rudder dimensions from the foil config: area, a span from the hull down, chord = area / span, the stock at 30 % chord. */
export function rudderDims(p: PropulsorConfig): { yTop: number; yBot: number; chord: number; stockZ: number } {
  const fc = p.foilCentre;
  const hullY = sectionBottomY(hullSectionAt(STATIONS, fc.z), Math.abs(fc.x));
  const yTop = (Number.isFinite(hullY) ? hullY : fc.y + 3) + 0.3;
  const span = 2 * (yTop - fc.y);
  const chord = p.foilArea / span;
  // the foil's area centre (mid-chord) is on foilCentre: the stock 20 % of the chord ahead of it
  return { yTop, yBot: fc.y - (yTop - fc.y), chord, stockZ: fc.z - 0.2 * chord };
}

/** A symmetric (NACA 00xx) rudder section, closed, in the stock's frame: chord along +z from −0.3c to +0.7c. */
function foilRing(chord: number, y: number, t = 0.18, n = 14): P3[] {
  const half = (u: number) => 5 * t * chord * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const pts: P3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = 1 - (1 - Math.cos((i / n) * Math.PI)) / 2; // TE → LE
    pts.push([half(u), y, (u - 0.3) * chord]);
  }
  for (let i = 1; i < n; i++) {
    const u = (1 - Math.cos((i / n) * Math.PI)) / 2; // LE → TE
    pts.push([-half(u), y, (u - 0.3) * chord]);
  }
  pts.push(pts[0]);
  return pts;
}

function rudderGeometry(p: PropulsorConfig): THREE.BufferGeometry {
  const d = rudderDims(p);
  const y0 = d.yBot - p.foilCentre.y;
  const y1 = d.yTop - p.foilCentre.y;
  const rows = [foilRing(d.chord, y0), foilRing(d.chord, (y0 + y1) / 2), foilRing(d.chord, y1)];
  const side = gridGeometry(rows, (x, _y, z) => [x, 0, z > 0.6 * d.chord ? 0.3 : 0]);
  const cap = (y: number, up: number) => fanCap(foilRing(d.chord, y).slice(0, -1), [0, up, 0]);
  return merge([tint(side, 0x5d2a22, 0.6), tint(cap(y0, -1), 0x5d2a22, 0.6), tint(cap(y1, 1), 0x5d2a22, 0.6)]);
}

function bladesGeometry(p: PropulsorConfig, hand: number): THREE.BufferGeometry {
  const R = p.diameter / 2;
  const rHub = 0.55;
  const parts: THREE.BufferGeometry[] = [];
  for (let k = 0; k < 4; k++) {
    const b = new THREE.SphereGeometry(1, 16, 10);
    b.scale(0.8, (R - rHub) / 2, 0.08);
    b.translate(0, rHub + (R - rHub) / 2, 0);
    // pitch (a twist about the blade's own radial axis) and a little skew
    b.rotateY(hand * 0.62);
    b.rotateZ(hand * 0.12);
    b.rotateZ((k * Math.PI) / 2);
    parts.push(tint(b, 0xb58a4a, 0.28, 0.9));
  }
  parts.push(tint(ellipsoid(V(0, 0, 0.2), 0.62, 0.62, 1.3, 16, 10), 0xa47c42, 0.3, 0.9));
  return merge(parts);
}

/** The shaft lines and A-brackets (static; merged into the hull's details). */
export function shaftGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const p of WCR.propulsors) {
    if (p.type !== 'shaft') continue;
    const { x, y, z } = p.position;
    // forward along the shaft line until it is well inside the hull
    let zIn = z - 4;
    while (zIn > z - 80) {
      const hy = sectionBottomY(hullSectionAt(STATIONS, zIn), Math.abs(x));
      if (Number.isFinite(hy) && hy < y - 0.8) break;
      zIn -= 2;
    }
    parts.push(tint(tube(V(x, y, z - 0.8), V(x, y, zIn), 0.42, 0.42, 12), 0x6b6f73, 0.4, 0.8));
    // the bossing where it leaves the hull, and the A-bracket ahead of the propeller
    parts.push(tint(ellipsoid(V(x, y + 0.2, zIn + 3), 0.9, 1.1, 5, 12, 8), 0xf2f2ee, 0.5));
    const zb = z - 3.2;
    for (const dx of [-2.2, 2.2]) {
      const hx = x + dx;
      const hy = sectionBottomY(hullSectionAt(STATIONS, zb), Math.abs(hx));
      if (Number.isFinite(hy)) parts.push(tint(tube(V(x, y, zb), V(hx, hy + 0.3, zb), 0.22, 0.22, 8), 0x6b6f73, 0.5, 0.6));
    }
    parts.push(tint(ellipsoid(V(x, y, zb), 0.7, 0.7, 1.4, 12, 8), 0x6b6f73, 0.5, 0.6));
  }
  return merge(parts);
}

export function buildScrews(parts: THREE.Material): ScrewRig[] {
  const rigs: ScrewRig[] = [];
  WCR.propulsors.forEach((p) => {
    if (p.type !== 'shaft') return;
    const side = p.position.x < 0 ? 'port' : 'starboard';
    const hand = p.position.x < 0 ? -1 : 1;
    const container = new THREE.Group();
    container.name = `cruise.screw.${side}`;
    const prop = new THREE.Group();
    prop.name = `cruise.screw.${side}.prop`;
    prop.position.set(p.position.x, p.position.y, p.position.z);
    const blades = new THREE.Mesh(bladesGeometry(p, hand), parts);
    blades.name = `cruise.screw.${side}.blades`;
    blades.castShadow = true;
    prop.add(blades);
    container.add(prop);
    const d = rudderDims(p);
    const rudder = new THREE.Group();
    rudder.name = `cruise.rudder.${side}`;
    rudder.position.set(p.foilCentre.x, p.foilCentre.y, d.stockZ);
    const blade = new THREE.Mesh(rudderGeometry(p), parts);
    blade.name = `cruise.rudder.${side}.blade`;
    blade.castShadow = true;
    rudder.add(blade);
    container.add(rudder);
    rigs.push({ container, prop, blades, rudder, hand });
  });
  return rigs;
}
