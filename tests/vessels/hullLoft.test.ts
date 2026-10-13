/**
 * The generic hull loft (src/vessels/hullLoft.ts, src/vessels/hullSection.ts): the PCHIP section
 * interpolation passes through the station table and never overshoots it; the lofted skin has a
 * ring exactly on every station, is mirror-symmetric, closes (with transom, stem and deck caps)
 * into a watertight solid with outward normals whose volume matches the integrated sections; the
 * deck strips, skin patches and spray rails sit where they should. Uses a made-up table (not the
 * V50's) so nothing here is boat-specific.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HullStation } from '../../src/config';
import {
  buildHullDeck,
  buildHullPatch,
  buildHullShell,
  buildSprayRail,
  createHullInterpolator,
  deckHeightAt,
  hullSampleZs,
  hullSectionAt,
  sectionArea,
  sectionBottomY,
  sectionHalfBreadth,
} from '../../src/vessels/hullLoft';
import { fcParams } from '../support/fc';

const TABLE: HullStation[] = [
  { z: -12, keelY: 0.5, chineHalf: 0, chineY: 0.5, deckHalf: 0.1, deckY: 2.2 },
  { z: -10, keelY: -0.6, chineHalf: 1.0, chineY: 0.2, deckHalf: 1.6, deckY: 2.1 },
  { z: -6, keelY: -1.3, chineHalf: 2.2, chineY: -0.4, deckHalf: 2.7, deckY: 2.0 },
  { z: 0, keelY: -1.5, chineHalf: 2.5, chineY: -0.6, deckHalf: 2.9, deckY: 1.9 },
  { z: 6, keelY: -1.45, chineHalf: 2.4, chineY: -0.55, deckHalf: 2.8, deckY: 1.9 },
  { z: 8, keelY: -1.4, chineHalf: 2.3, chineY: -0.5, deckHalf: 2.7, deckY: 1.9 },
];
const FIELDS = ['keelY', 'chineHalf', 'chineY', 'deckHalf', 'deckY'] as const;

function positions(g: THREE.BufferGeometry): THREE.Vector3[] {
  const p = g.getAttribute('position');
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i));
}

/** Signed volume of a closed triangle mesh (positive when the normals point out). */
function signedVolume(g: THREE.BufferGeometry): number {
  const p = g.getAttribute('position');
  const idx = g.index!;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
}

describe('hull section interpolation', () => {
  it('hits the table exactly at every station', () => {
    for (const s of TABLE) {
      const q = hullSectionAt(TABLE, s.z);
      for (const f of FIELDS) expect(q[f]).toBeCloseTo(s[f], 12);
    }
  });

  it('never overshoots the neighbouring stations (monotone cubic) and holds the ends outside', () => {
    fc.assert(
      fc.property(fc.double({ min: -12, max: 8, noNaN: true }), (z) => {
        const q = hullSectionAt(TABLE, z);
        const k = TABLE.findIndex((s, i) => i < TABLE.length - 1 && z >= s.z && z <= TABLE[i + 1].z);
        const a = TABLE[k];
        const b = TABLE[k + 1];
        for (const f of FIELDS) {
          expect(q[f]).toBeGreaterThanOrEqual(Math.min(a[f], b[f]) - 1e-9);
          expect(q[f]).toBeLessThanOrEqual(Math.max(a[f], b[f]) + 1e-9);
        }
      }),
      fcParams(300),
    );
    expect(hullSectionAt(TABLE, -20).keelY).toBe(TABLE[0].keelY);
    expect(hullSectionAt(TABLE, 30).deckHalf).toBe(TABLE[5].deckHalf);
  });

  it('is smooth between stations (no kinks: the slope is continuous across a station)', () => {
    const h = createHullInterpolator(TABLE);
    const e = 1e-5;
    for (const s of TABLE.slice(1, -1)) {
      for (const f of FIELDS) {
        const left = (h.at(s.z)[f] - h.at(s.z - e)[f]) / e;
        const right = (h.at(s.z + e)[f] - h.at(s.z)[f]) / e;
        expect(Math.abs(left - right)).toBeLessThan(1e-3);
      }
    }
  });

  it('rejects an unordered table', () => {
    expect(() => createHullInterpolator([TABLE[1], TABLE[0]])).toThrow();
  });

  it('half-breadth, bottom height and area follow the hard-chine section', () => {
    const s = hullSectionAt(TABLE, 0);
    expect(sectionHalfBreadth(s, s.keelY)).toBe(0);
    expect(sectionHalfBreadth(s, s.chineY)).toBeCloseTo(s.chineHalf, 12);
    expect(sectionHalfBreadth(s, s.deckY)).toBeCloseTo(s.deckHalf, 12);
    expect(sectionBottomY(s, 0)).toBeCloseTo(s.keelY, 12);
    expect(sectionBottomY(s, -s.chineHalf)).toBeCloseTo(s.chineY, 12);
    expect(sectionBottomY(s, s.deckHalf + 0.1)).toBeNaN();
    const exact = s.chineHalf * (s.chineY - s.keelY) + (s.chineHalf + s.deckHalf) * (s.deckY - s.chineY);
    expect(sectionArea(s)).toBeCloseTo(exact, 10);
    expect(sectionArea(s, s.chineY)).toBeCloseTo(s.chineHalf * (s.chineY - s.keelY), 10);
    expect(sectionArea(s, s.keelY - 1)).toBe(0);
  });

  it('ring positions include every station exactly and respect the step', () => {
    const zs = hullSampleZs(TABLE, 0.3);
    for (const s of TABLE) expect(zs).toContain(s.z);
    for (let i = 1; i < zs.length; i++) {
      expect(zs[i]).toBeGreaterThan(zs[i - 1]);
      expect(zs[i] - zs[i - 1]).toBeLessThanOrEqual(0.3 + 1e-9);
    }
  });
});

describe('hull shell loft', () => {
  const shell = buildHullShell(TABLE, { deck: true, maxStep: 0.3 });

  it('has a ring on every station whose keel, chine and deck-edge vertices match the table', () => {
    const pts = positions(shell);
    for (const s of TABLE) {
      const ring = pts.filter((p) => Math.abs(p.z - s.z) < 1e-4);
      expect(ring.length).toBeGreaterThan(10);
      const has = (x: number, y: number) => ring.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-4);
      expect(has(0, s.keelY), `keel @${s.z}`).toBe(true);
      for (const side of [1, -1]) {
        expect(has(side * s.chineHalf, s.chineY), `chine @${s.z}`).toBe(true);
        expect(has(side * s.deckHalf, s.deckY), `deck @${s.z}`).toBe(true);
      }
      // Every skin vertex of the ring lies on the section outline (or on the deck above it).
      for (const p of ring) {
        const onSkin = Math.abs(Math.abs(p.x) - sectionHalfBreadth(s, p.y)) < 1e-4;
        const onDeck = Math.abs(p.y - deckHeightAt(s, p.x, 0.05)) < 1e-4;
        const inCap = Math.abs(p.x) < sectionHalfBreadth(s, p.y) + 1e-4 && p.y <= deckHeightAt(s, p.x, 0.05) + 1e-4;
        expect(onSkin || onDeck || inCap).toBe(true);
      }
    }
  });

  it('is mirror-symmetric about the centreline', () => {
    const r = (v: number) => Math.round(v * 1e4) || 0;
    const key = (p: THREE.Vector3) => `${r(p.x)},${r(p.y)},${r(p.z)}`;
    const set = new Set(positions(shell).map(key));
    for (const p of positions(shell)) expect(set.has(key(new THREE.Vector3(-p.x, p.y, p.z)))).toBe(true);
  });

  it('closes into a watertight solid (every edge shared by exactly two faces once welded)', () => {
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', shell.getAttribute('position').clone());
    bare.setIndex(shell.index!.clone());
    const w = mergeVertices(bare, 1e-5);
    const idx = w.index!;
    const pos = w.getAttribute('position');
    const edges = new Map<string, number>();
    let degenerate = 0;
    for (let i = 0; i < idx.count; i += 3) {
      const t = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) {
        degenerate++;
        continue;
      }
      for (let k = 0; k < 3; k++) {
        const a = t[k];
        const b = t[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    // Degenerate slivers at the stem (zero chine breadth) collapse when welded; the rest is closed.
    const open = [...edges.entries()].filter(([, n]) => n !== 2);
    expect(open.length, `open/non-manifold edges (degenerate tris ${degenerate}, verts ${pos.count})`).toBe(0);
  });

  it('has outward normals: positive volume matching the integrated section areas', () => {
    const vol = signedVolume(shell);
    const zs = hullSampleZs(TABLE, 0.02);
    let integral = 0;
    for (let i = 1; i < zs.length; i++) {
      const a = sectionArea(hullSectionAt(TABLE, zs[i - 1]));
      const b = sectionArea(hullSectionAt(TABLE, zs[i]));
      integral += ((a + b) / 2) * (zs[i] - zs[i - 1]);
    }
    expect(vol).toBeGreaterThan(0);
    // The deck camber adds a little on top of the sections below the sheer line.
    expect(vol).toBeGreaterThan(integral * 0.98);
    expect(vol).toBeLessThan(integral * 1.06);
  });

  it('every skin face points away from the centreline; the transom faces aft, the stem forward', () => {
    const open = buildHullShell(TABLE, { maxStep: 0.3, capBow: false, capStern: false });
    const p = open.getAttribute('position');
    const idx = open.index!;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let bad = 0;
    for (let i = 0; i < idx.count; i += 3) {
      a.fromBufferAttribute(p, idx.getX(i));
      b.fromBufferAttribute(p, idx.getX(i + 1));
      c.fromBufferAttribute(p, idx.getX(i + 2));
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.lengthSq() < 1e-12) continue;
      const cx = (a.x + b.x + c.x) / 3;
      if (Math.abs(cx) < 1e-3) continue;
      if (n.x * Math.sign(cx) <= 0) bad++;
    }
    expect(bad).toBe(0);
    // The smooth vertex normals agree with the faces (no flipped panels).
    const nor = open.getAttribute('normal');
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > 0.05) expect(nor.getX(i) * Math.sign(p.getX(i))).toBeGreaterThan(-0.05);
    }
    const capped = buildHullShell(TABLE, { maxStep: 0.3 });
    const cn = capped.getAttribute('normal');
    const cp = capped.getAttribute('position');
    let aft = 0;
    let fwd = 0;
    for (let i = 0; i < cp.count; i++) {
      if (cn.getZ(i) > 0.99) {
        aft++;
        expect(cp.getZ(i)).toBeCloseTo(8, 6);
      }
      if (cn.getZ(i) < -0.99) {
        fwd++;
        expect(cp.getZ(i)).toBeCloseTo(-12, 6);
      }
    }
    expect(aft).toBeGreaterThan(10);
    expect(fwd).toBeGreaterThan(10);
  });
});

describe('decks, patches and spray rails', () => {
  it('a deck with an opening leaves the middle clear and meets the sheer line at the edges', () => {
    const g = buildHullDeck(TABLE, { z0: -6, z1: 6, inner: () => 1.5, camber: 0.04 });
    for (const p of positions(g)) {
      expect(Math.abs(p.x)).toBeGreaterThanOrEqual(1.5 - 1e-5);
      const s = hullSectionAt(TABLE, p.z);
      expect(Math.abs(p.x)).toBeLessThanOrEqual(s.deckHalf + 1e-5);
      expect(p.y).toBeCloseTo(deckHeightAt(s, p.x, 0.04), 5);
    }
    const n = g.getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBeGreaterThan(0.9);
  });

  it('a skin patch lies just outboard of the skin between its heights', () => {
    const g = buildHullPatch(TABLE, { z0: -4, z1: 4, yLo: () => 0.5, yHi: () => 1.0, side: -1, offset: 0.01 });
    for (const p of positions(g)) {
      const s = hullSectionAt(TABLE, p.z);
      expect(p.x).toBeLessThan(0);
      expect(p.y).toBeGreaterThan(0.49);
      expect(p.y).toBeLessThan(1.01);
      const d = -p.x - sectionHalfBreadth(s, p.y);
      expect(d).toBeGreaterThan(0.005);
      expect(d).toBeLessThan(0.015);
    }
  });

  it('a spray rail hangs under the bottom with a horizontal underside', () => {
    const g = buildSprayRail(TABLE, { z0: -9, z1: 4, t: 0.5, width: 0.06 });
    const n = g.getAttribute('normal');
    let down = 0;
    for (const p of positions(g)) {
      const s = hullSectionAt(TABLE, p.z);
      // Never above the skin, never more than a few cm off it.
      expect(p.y).toBeLessThanOrEqual(sectionBottomY(s, Math.min(Math.abs(p.x), s.deckHalf)) + 1e-4);
      expect(p.y).toBeGreaterThan(sectionBottomY(s, Math.min(Math.abs(p.x), s.chineHalf)) - 0.08);
    }
    for (let i = 0; i < n.count; i++) if (n.getY(i) < -0.99) down++;
    expect(down).toBeGreaterThan(20);
  });
});
