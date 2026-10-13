/**
 * The naval gunnery range on screen (src/combat/navalRange.ts is the pure runtime): procedural
 * models with vertex colours (no textures) —
 *
 *   raft    twin orange pontoons under a grated deck, a white-and-red target screen, a lattice mast
 *           with an octahedral radar reflector on top, a red range flag
 *   hulk    a rust-streaked 96 m general-cargo freighter hulk: raked bow, sheer, hatch coamings,
 *           king posts, the bridge block and funnel aft, a big white X painted on each side
 *   sled    a steel target sled on twin skids with a slatted screen and a reflector
 *   tug     the (untargetable) tug towing the sled: black hull, white wheelhouse, buff funnel
 *   buoy    yellow special-mark pillar buoys with an X topmark (the range box)
 *
 * Each target is one mesh with its own material (so damage can char it); it rides the runtime's
 * pose (heave / pitch / roll from the drawn sea) and sinks with it. Model frame = the target's hull
 * frame: +X starboard, +Y up (y = 0 the still waterline), −Z the bow.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { SeaKind } from '../types';
import type { GunneryRange } from '../navalRange';
import { DRAFT } from '../navalRange';

type Rgb = readonly [number, number, number];

/** Paints are written as sRGB (as picked from photos) and stored linear (vertex colours are linear). */
const lin = (c: Rgb): Rgb => [Math.pow(c[0], 2.2), Math.pow(c[1], 2.2), Math.pow(c[2], 2.2)];

const PAINT_SRGB = {
  orange: [0.88, 0.36, 0.08] as Rgb,
  red: [0.78, 0.12, 0.1] as Rgb,
  white: [0.9, 0.9, 0.88] as Rgb,
  grey: [0.62, 0.63, 0.64] as Rgb,
  dark: [0.18, 0.18, 0.2] as Rgb,
  steel: [0.5, 0.51, 0.52] as Rgb,
  rust: [0.36, 0.19, 0.12] as Rgb,
  rustDark: [0.24, 0.13, 0.09] as Rgb,
  black: [0.12, 0.12, 0.13] as Rgb,
  antifoul: [0.55, 0.16, 0.12] as Rgb,
  buff: [0.8, 0.68, 0.46] as Rgb,
  yellow: [0.98, 0.8, 0.1] as Rgb,
  deck: [0.42, 0.36, 0.3] as Rgb,
};
const PAINT = Object.fromEntries(Object.entries(PAINT_SRGB).map(([k, v]) => [k, lin(v)])) as Record<keyof typeof PAINT_SRGB, Rgb>;

class Build {
  private parts: THREE.BufferGeometry[] = [];

  add(g: THREE.BufferGeometry, c: Rgb, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, jitter = 0, seed = 1): void {
    const geo = g.index ? g.toNonIndexed() : g;
    g !== geo && g.dispose();
    geo.deleteAttribute('uv');
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(m);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    let s = seed * 9301 + 49297;
    for (let i = 0; i < n; i += 3) {
      s = (s * 9301 + 49297) % 233280;
      const j = 1 + jitter * ((s / 233280) * 2 - 1);
      for (let k = 0; k < 3 && i + k < n; k++) {
        col[(i + k) * 3] = c[0] * j;
        col[(i + k) * 3 + 1] = c[1] * j;
        col[(i + k) * 3 + 2] = c[2] * j;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(geo);
  }

  box(w: number, h: number, d: number, c: Rgb, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, jitter = 0.06): void {
    this.add(new THREE.BoxGeometry(w, h, d), c, x, y, z, rx, ry, rz, jitter, Math.round(x * 13 + y * 7 + z * 3));
  }

  /** A bar between two points (square section). */
  bar(a: THREE.Vector3Like, b: THREE.Vector3Like, t: number, c: Rgb): void {
    const A = new THREE.Vector3(a.x, a.y, a.z);
    const B = new THREE.Vector3(b.x, b.y, b.z);
    const L = A.distanceTo(B);
    const g = new THREE.BoxGeometry(t, L, t);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    g.applyQuaternion(q);
    const mid = A.clone().add(B).multiplyScalar(0.5);
    this.add(g, c, mid.x, mid.y, mid.z, 0, 0, 0, 0.04);
  }

  cylZ(r: number, len: number, c: Rgb, x: number, y: number, z: number, seg = 12): void {
    this.add(new THREE.CylinderGeometry(r, r, len, seg), c, x, y, z, Math.PI / 2, 0, 0, 0.05);
  }

  cylY(rt: number, rb: number, h: number, c: Rgb, x: number, y: number, z: number, seg = 12): void {
    this.add(new THREE.CylinderGeometry(rt, rb, h, seg), c, x, y + h / 2, z, 0, 0, 0, 0.05);
  }

  /** A lofted hull: stations bow → stern (z, half-beam at the deck, deck y, keel y), colour by height. */
  loft(st: readonly { z: number; half: number; deck: number; keel: number }[], colorAt: (y: number, z: number, side: number) => Rgb, seed = 3): void {
    const pos: number[] = [];
    const col: number[] = [];
    let s = seed * 7919;
    const push = (x: number, y: number, z: number, side: number) => {
      pos.push(x, y, z);
      s = (s * 9301 + 49297) % 233280;
      const c = colorAt(y, z, side);
      const j = 0.92 + 0.16 * (s / 233280);
      col.push(c[0] * j, c[1] * j, c[2] * j);
    };
    const quad = (a: number[], b: number[], c: number[], d: number[], side: number) => {
      push(a[0], a[1], a[2], side); push(b[0], b[1], b[2], side); push(c[0], c[1], c[2], side);
      push(a[0], a[1], a[2], side); push(c[0], c[1], c[2], side); push(d[0], d[1], d[2], side);
    };
    const BANDS = 5;
    for (let i = 0; i < st.length - 1; i++) {
      const p = st[i];
      const q = st[i + 1];
      for (let b = 0; b < BANDS; b++) {
        const f0 = b / BANDS, f1 = (b + 1) / BANDS;
        // section: the side bulges from the keel (narrow) to the deck (full half-beam)
        const w = (st2: typeof p, f: number) => st2.half * Math.sqrt(Math.max(0, Math.min(1, f * 1.15)));
        const y = (st2: typeof p, f: number) => st2.keel + (st2.deck - st2.keel) * f;
        for (const side of [-1, 1]) {
          const a = [side * w(p, f0), y(p, f0), p.z];
          const bb = [side * w(q, f0), y(q, f0), q.z];
          const c = [side * w(q, f1), y(q, f1), q.z];
          const d = [side * w(p, f1), y(p, f1), p.z];
          if (side > 0) quad(a, bb, c, d, side);
          else quad(a, d, c, bb, side);
        }
      }
      // deck
      quad([-p.half, p.deck, p.z], [p.half, p.deck, p.z], [q.half, q.deck, q.z], [-q.half, q.deck, q.z], 0);
    }
    // transom
    const t = st[st.length - 1];
    quad([-t.half, t.keel, t.z], [t.half, t.keel, t.z], [t.half, t.deck, t.z], [-t.half, t.deck, t.z], 2);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.parts.push(g);
  }

  merge(): THREE.BufferGeometry {
    for (const p of this.parts) if (!p.getAttribute('normal')) p.computeVertexNormals();
    const g = mergeGeometries(this.parts, false) ?? new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

function raft(): THREE.BufferGeometry {
  const B = new Build();
  for (const sx of [-2.1, 2.1]) {
    B.cylZ(0.85, 10, PAINT.orange, sx, 0.1, 0, 14);
    // pointed pontoon ends
    B.add(new THREE.ConeGeometry(0.85, 1.2, 14), PAINT.orange, sx, 0.1, -5.6, -Math.PI / 2, 0, 0, 0.05);
    B.add(new THREE.ConeGeometry(0.85, 0.8, 14), PAINT.orange, sx, 0.1, 5.4, Math.PI / 2, 0, 0, 0.05);
  }
  B.box(6, 0.25, 11.5, PAINT.steel, 0, 1.05, 0);
  for (let z = -5; z <= 5; z += 2.5) B.box(6.1, 0.35, 0.18, PAINT.orange, 0, 1.2, z);
  // target screen: white with a red cross
  B.box(5.4, 3.2, 0.12, PAINT.white, 0, 3.0, 1.8);
  B.box(0.45, 3.9, 0.14, PAINT.red, 0, 3.0, 1.8, 0, 0, 0.93);
  B.box(0.45, 3.9, 0.14, PAINT.red, 0, 3.0, 1.8, 0, 0, -0.93);
  for (const sx of [-2.6, 2.6]) B.bar({ x: sx, y: 1.2, z: 1.8 }, { x: sx, y: 4.6, z: 1.8 }, 0.14, PAINT.steel);
  // lattice mast + octahedral radar reflector
  const top = { x: 0, y: 6.0, z: -2.6 };
  for (const [bx, bz] of [[-1.4, -4], [1.4, -4], [-1.4, -1.2], [1.4, -1.2]] as const) B.bar({ x: bx, y: 1.2, z: bz }, top, 0.12, PAINT.white);
  B.bar({ x: -1.4, y: 3, z: -4 }, { x: 1.4, y: 3, z: -1.2 }, 0.08, PAINT.white);
  B.bar({ x: 1.4, y: 3, z: -4 }, { x: -1.4, y: 3, z: -1.2 }, 0.08, PAINT.white);
  B.add(new THREE.OctahedronGeometry(0.9, 0), PAINT.grey, top.x, top.y + 0.7, top.z, 0, Math.PI / 4, 0, 0.2);
  // flag pole + flag
  B.bar({ x: 2.6, y: 1.2, z: 4.8 }, { x: 2.6, y: 7.2, z: 4.8 }, 0.08, PAINT.white);
  B.box(0.05, 0.9, 1.4, PAINT.red, 2.6, 6.7, 5.5);
  return B.merge();
}

function hulk(): THREE.BufferGeometry {
  const B = new Build();
  const L = 96, half = 7.25;
  const st: { z: number; half: number; deck: number; keel: number }[] = [];
  const zs = [-48, -46, -43, -39, -34, -28, -20, -10, 0, 10, 20, 30, 38, 43, 46, 48];
  for (const z of zs) {
    const t = (z + L / 2) / L; // 0 bow … 1 stern
    const bowTaper = Math.min(1, t / 0.2);
    const sternTaper = t > 0.88 ? 1 - (t - 0.88) / 0.12 * 0.25 : 1;
    const h = half * Math.sqrt(bowTaper) * sternTaper;
    const sheer = 7.4 + 1.8 * Math.pow(Math.abs(t - 0.55) / 0.55, 2); // freeboard rises at the ends
    st.push({ z, half: Math.max(0.3, h), deck: sheer, keel: z < -44 ? -DRAFT.hulk * 0.3 + (z + 44) * -0.4 : -DRAFT.hulk });
  }
  B.loft(st, (y, z, side) => {
    if (side === 0) return PAINT.deck;
    if (y < 0.4) return PAINT.antifoul;
    if (y < 1.0) return PAINT.black;
    // rust streaks down the side below the rail
    const streak = (Math.sin(z * 1.7) + Math.sin(z * 0.53 + 1.3)) > 1.1;
    return streak ? PAINT.rustDark : PAINT.rust;
  }, 7);
  // big white X on each side (the range marking)
  for (const sx of [-1, 1]) {
    B.box(0.1, 10, 0.9, PAINT.white, sx * (half + 0.02), 4.0, -8, 0.62 * sx, 0, 0);
    B.box(0.1, 10, 0.9, PAINT.white, sx * (half + 0.02), 4.0, -8, -0.62 * sx, 0, 0);
  }
  // hatch coamings
  for (const z of [-30, -17, -4, 9]) B.box(8.5, 1.3, 9, PAINT.rustDark, 0, 8.2, z);
  // king posts and derricks
  for (const z of [-23.5, 2.5]) {
    for (const sx of [-2.6, 2.6]) B.cylY(0.35, 0.45, 9, PAINT.rust, sx, 7.8, z, 8);
    B.box(6, 0.4, 0.4, PAINT.rust, 0, 16.6, z);
    B.bar({ x: 0, y: 8.6, z: z - 1 }, { x: 0, y: 15.5, z: z - 9 }, 0.3, PAINT.rustDark);
  }
  // bridge block, funnel, masts (aft)
  B.box(12, 4.5, 11, PAINT.white, 0, 10.4, 26, 0, 0, 0, 0.18);
  B.box(10, 3, 8, PAINT.white, 0, 14.1, 25, 0, 0, 0, 0.18);
  B.box(12.5, 0.3, 3, PAINT.white, 0, 15.7, 22, 0, 0, 0, 0.1);
  B.box(9.6, 1.1, 0.12, PAINT.dark, 0, 14.6, 20.95); // bridge windows
  B.cylY(1.6, 1.9, 5.5, PAINT.rustDark, 0, 12.6, 33, 12);
  B.box(3.6, 0.8, 4, PAINT.black, 0, 18.4, 33);
  B.cylY(0.18, 0.22, 3.4, PAINT.rust, 0, 15.6, 24, 6);
  // hull breaks: patches of darker plating
  for (const [z, y] of [[-35, 3], [12, 5], [30, 2.5]] as const) for (const sx of [-1, 1]) B.box(0.12, 2.2, 3.5, PAINT.rustDark, sx * (half + 0.03), y, z);
  return B.merge();
}

function sled(): THREE.BufferGeometry {
  const B = new Build();
  for (const sx of [-1.7, 1.7]) {
    B.box(0.6, 1.0, 9, PAINT.orange, sx, -0.15, 0);
    B.box(0.6, 0.6, 1.2, PAINT.orange, sx, 0.2, -4.6, 0.5, 0, 0);
  }
  B.box(4.2, 0.2, 8, PAINT.steel, 0, 0.45, 0.2);
  for (let k = 0; k < 7; k++) B.box(3.6, 0.35, 0.12, k % 2 ? PAINT.red : PAINT.white, 0, 1.2 + k * 0.45, 1.5);
  for (const sx of [-1.8, 1.8]) B.bar({ x: sx, y: 0.8, z: 1.5 }, { x: sx, y: 4.3, z: 1.5 }, 0.12, PAINT.steel);
  B.add(new THREE.OctahedronGeometry(0.55, 0), PAINT.grey, 0, 4.6, 1.5, 0, Math.PI / 4, 0, 0.2);
  // tow bridle
  B.bar({ x: -1.7, y: 0.5, z: -4.6 }, { x: 0, y: 0.5, z: -5.4 }, 0.08, PAINT.dark);
  B.bar({ x: 1.7, y: 0.5, z: -4.6 }, { x: 0, y: 0.5, z: -5.4 }, 0.08, PAINT.dark);
  return B.merge();
}

function tug(): THREE.BufferGeometry {
  const B = new Build();
  const st = [
    { z: -14, half: 0.4, deck: 3.8, keel: 0.5 },
    { z: -12, half: 2.6, deck: 3.5, keel: -1.8 },
    { z: -8, half: 4.0, deck: 3.1, keel: -3.0 },
    { z: -2, half: 4.3, deck: 2.8, keel: -3.4 },
    { z: 6, half: 4.2, deck: 2.6, keel: -3.2 },
    { z: 12, half: 3.6, deck: 2.6, keel: -2.2 },
    { z: 14, half: 3.0, deck: 2.7, keel: -1.0 },
  ];
  B.loft(st, (y, _z, side) => (side === 0 ? PAINT.deck : y < 0.3 ? PAINT.antifoul : PAINT.black), 11);
  B.box(6, 2.6, 7, PAINT.white, 0, 4.1, -3, 0, 0, 0, 0.08);
  B.box(4.6, 2.2, 4.2, PAINT.white, 0, 6.5, -4, 0, 0, 0, 0.08);
  B.box(4.4, 0.8, 0.1, PAINT.dark, 0, 6.9, -6.15);
  B.cylY(0.9, 1.1, 3.2, PAINT.buff, 0, 5.2, 1.6, 10);
  B.box(1.9, 0.5, 2.3, PAINT.black, 0, 8.6, 1.6);
  B.cylY(0.35, 0.4, 1.2, PAINT.dark, 0, 2.7, 10, 8); // towing bitt
  return B.merge();
}

function buoy(): THREE.BufferGeometry {
  const B = new Build();
  B.cylY(1.25, 1.1, 1.6, PAINT.yellow, 0, -0.9, 0, 16);
  B.cylY(0.45, 0.8, 3.4, PAINT.yellow, 0, 0.7, 0, 12);
  B.box(1.6, 0.25, 0.25, PAINT.yellow, 0, 4.7, 0, 0, 0, 0.785);
  B.box(1.6, 0.25, 0.25, PAINT.yellow, 0, 4.7, 0, 0, 0, -0.785);
  B.cylY(0.12, 0.12, 0.4, PAINT.white, 0, 4.1, 0, 8);
  return B.merge();
}

export const NAVAL_RANGE_BUILDERS: Record<SeaKind | 'tug' | 'buoy', () => THREE.BufferGeometry> = { raft, hulk, sled, tug, buoy };

export interface NavalRangeRenderer {
  readonly group: THREE.Group;
  update(range: GunneryRange, camera: THREE.Camera, viewDistance: number, buoyY: (x: number, z: number) => { y: number; pitch: number; roll: number }): void;
  dispose(): void;
}

const DEG = Math.PI / 180;

export function createNavalRangeRenderer(scene: THREE.Scene | null): NavalRangeRenderer {
  const group = new THREE.Group();
  group.name = 'naval-range';
  const geos = new Map<string, THREE.BufferGeometry>();
  const geo = (k: SeaKind | 'tug' | 'buoy') => {
    let g = geos.get(k);
    if (!g) geos.set(k, (g = NAVAL_RANGE_BUILDERS[k]()));
    return g;
  };
  const mats: THREE.MeshStandardMaterial[] = [];
  const mat = () => {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.08 });
    mats.push(m);
    return m;
  };
  const targetMeshes: THREE.Mesh[] = [];
  let tugMesh: THREE.Mesh | null = null;
  let towLine: THREE.Line | null = null;
  const buoyMeshes: THREE.Mesh[] = [];
  const cam = new THREE.Vector3();
  const E = new THREE.Euler(0, 0, 0, 'YXZ');
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
  scene?.add(group);

  const pose = (m: THREE.Object3D, x: number, y: number, z: number, headingDeg: number, pitchDeg: number, rollDeg: number) => {
    m.position.set(x, y, z);
    // three: yaw −heading about +Y, then pitch (bow up = +X rotation), then roll (starboard down = −Z rotation)
    E.set(pitchDeg * DEG, -headingDeg * DEG, -rollDeg * DEG, 'YXZ');
    m.quaternion.setFromEuler(E);
  };

  return {
    group,
    update(range, camera, viewDistance, buoyY) {
      camera.getWorldPosition(cam);
      if (targetMeshes.length !== range.targets.length) {
        for (const m of targetMeshes) group.remove(m);
        targetMeshes.length = 0;
        for (const r of range.targets) {
          const m = new THREE.Mesh(geo(r.plan.kind), mat());
          m.name = `naval-range.${r.plan.kind}`;
          m.castShadow = true;
          m.receiveShadow = true;
          group.add(m);
          targetMeshes.push(m);
        }
        if (!tugMesh) {
          tugMesh = new THREE.Mesh(geo('tug'), mat());
          tugMesh.name = 'naval-range.tug';
          group.add(tugMesh);
          towLine = new THREE.Line(lineGeo, lineMat);
          towLine.frustumCulled = false;
          group.add(towLine);
        }
        if (!buoyMeshes.length) {
          const bm = mat();
          for (const _b of range.plan.buoys) {
            const m = new THREE.Mesh(geo('buoy'), bm);
            m.name = 'naval-range.buoy';
            group.add(m);
            buoyMeshes.push(m);
          }
        }
      }
      const far = (x: number, z: number) => Math.hypot(x - cam.x, z - cam.z) > viewDistance;
      for (let i = 0; i < range.targets.length; i++) {
        const r = range.targets[i];
        const m = targetMeshes[i];
        m.visible = r.phase !== 'sunk' && !far(r.x, r.z);
        if (!m.visible) continue;
        pose(m, r.x, r.y - r.sink, r.z, r.headingDeg, r.pitchDeg, r.rollDeg);
        const mm = m.material as THREE.MeshStandardMaterial;
        const k = 1 - 0.72 * Math.min(1, r.damage * (r.phase === 'afloat' ? 0.7 : 1.4));
        mm.color.setRGB(k, k * 0.97, k * 0.95);
      }
      if (tugMesh && towLine) {
        const t = range.tug;
        tugMesh.visible = !far(t.x, t.z);
        pose(tugMesh, t.x, t.y, t.z, t.headingDeg, t.pitchDeg, t.rollDeg);
        const sled = range.targets.find((r) => r.plan.kind === 'sled');
        const p = lineGeo.getAttribute('position') as THREE.BufferAttribute;
        const h = t.headingDeg * DEG;
        p.setXYZ(0, t.x - Math.sin(h) * 12, t.y + 2.7, t.z + Math.cos(h) * 12);
        if (sled && sled.phase === 'afloat') {
          const hs = sled.headingDeg * DEG;
          p.setXYZ(1, sled.x + Math.sin(hs) * 5.4, sled.y + 0.5, sled.z - Math.cos(hs) * 5.4);
          towLine.visible = tugMesh.visible;
        } else towLine.visible = false;
        p.needsUpdate = true;
      }
      for (let i = 0; i < buoyMeshes.length; i++) {
        const b = range.plan.buoys[i];
        const m = buoyMeshes[i];
        m.visible = !far(b.x, b.z);
        if (!m.visible) continue;
        const w = buoyY(b.x, b.z);
        pose(m, b.x, w.y, b.z, 0, w.pitch, w.roll);
      }
    },
    dispose() {
      group.removeFromParent();
      for (const g of geos.values()) g.dispose();
      for (const m of mats) m.dispose();
      lineGeo.dispose();
      lineMat.dispose();
    },
  };
}
