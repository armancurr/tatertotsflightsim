/**
 * The full road network the world is drawn and built from: the layout's roads
 * (highway, roads, access, lanes) plus, derived deterministically here,
 * - a street grid in the city and the town (aligned with the town's grid angle,
 *   ragged at the edges, clear of water, the airport and the main roads),
 * - a few winding streets branching off the through roads in villages and hamlets,
 * - farmstead sites scattered over the farmland, each with a gravel driveway to
 *   the nearest country road.
 * PURE (no three.js). Streets/farms depend only on the layout (+ its seed) and
 * `heightAt`, so the towns and the roads modules agree without talking.
 */
import { CONFIG } from '../../config';
import type { WorldLayout, RoadKind, Town } from '../layout';
import { hash2i, mulberry32 } from '../noise';
import { createConstraints, type Constraints } from '../towns/constraints';
import { SegmentGrid, headingOf, pointSegmentDistance, type XZ } from '../towns/geom';

export type NetKind = RoadKind | 'street' | 'drive';

/** Higher rank = drawn on top at junctions, and wins overlaps. */
export const KIND_RANK: Record<NetKind, number> = { highway: 5, road: 4, access: 3, lane: 2, street: 1, drive: 0 };

export interface NetRoad {
  name: string;
  kind: NetKind;
  /** Paved width, m. */
  width: number;
  points: XZ[];
  /** Town index for streets (−1 otherwise). */
  town: number;
  /** Farm index for driveways (−1 otherwise). */
  farm: number;
}

export interface FarmSite {
  /** Yard centre. */
  x: number;
  z: number;
  /** Direction the farmhouse faces (toward its driveway/road). */
  headingDeg: number;
  /** Index of its driveway in `roads`, −1 if none. */
  drive: number;
}

export interface RoadNetwork {
  roads: NetRoad[];
  farms: FarmSite[];
  constraints: Constraints;
}

export type TownsConfig = typeof CONFIG.world.towns;

const DEG = Math.PI / 180;
const STEP = 10; // street point spacing, m

export function buildRoadNetwork(layout: WorldLayout, heightAt: (x: number, z: number) => number, cfg: TownsConfig = CONFIG.world.towns): RoadNetwork {
  const C = createConstraints(layout);
  const roads: NetRoad[] = layout.roads.map((r) => ({ name: r.name, kind: r.kind, width: r.width, points: r.points, town: -1, farm: -1 }));
  const major = new SegmentGrid(128);
  layout.roads.forEach((r, i) => major.addPolyline(r.points, r.width / 2, i));
  major.build();
  const q = major.newQuery();

  layout.towns.forEach((t, ti) => {
    const rnd = mulberry32(((layout.seed | 0) ^ Math.imul(ti + 1, 0x9e3779b1)) >>> 0);
    if (t.kind === 'city' || t.kind === 'town') gridStreets(t, ti, rnd, C, major, roads);
    else organicStreets(t, ti, rnd, C, major, layout, roads);
  });

  const farms = planFarms(layout, heightAt, C, major, cfg, roads);
  void q;
  return { roads, farms, constraints: C };
}

// ─── Grid streets (city, town) ────────────────────────────────────────────────

function townOutline(t: Town, rnd: () => number): (x: number, z: number) => number {
  const p0 = rnd() * 6.283;
  const p1 = rnd() * 6.283;
  const p2 = rnd() * 6.283;
  return (x, z) => {
    const a = Math.atan2(z - t.z, x - t.x);
    return t.radius * (0.88 + 0.08 * Math.sin(2 * a + p0) + 0.06 * Math.sin(3 * a + p1) + 0.04 * Math.sin(5 * a + p2));
  };
}

function gridStreets(t: Town, ti: number, rnd: () => number, C: Constraints, major: SegmentGrid, out: NetRoad[]): void {
  const R = t.radius;
  const B = t.blockSize;
  const th = t.gridAngleDeg * DEG;
  const e = [
    { x: Math.cos(th), z: Math.sin(th) },
    { x: -Math.sin(th), z: Math.cos(th) },
  ];
  const outline = townOutline(t, rnd);
  const n = Math.ceil((1.2 * R) / B);
  const shift = [rnd() < 0.5 ? 0 : B / 2, rnd() < 0.5 ? 0 : B / 2];
  const q = major.newQuery();
  const city = t.kind === 'city';
  let count = 0;
  for (let fam = 0; fam < 2; fam++) {
    const dir = e[fam];
    const nrm = e[1 - fam];
    for (let k = -n; k <= n; k++) {
      const o = k * B + shift[fam];
      const arterial = ((k % 4) + 4) % 4 === 0;
      const width = city ? (arterial ? 10 : 7.5) : arterial ? 8 : 6.5;
      const at = (s: number): XZ => ({ x: t.x + nrm.x * o + dir.x * s, z: t.z + nrm.z * o + dir.z * s });
      let run: XZ[] | null = null;
      const flush = () => {
        if (run && run.length >= 2) {
          out.push({ name: `${t.name} street ${++count}`, kind: 'street', width, points: run, town: ti, farm: -1 });
        }
        run = null;
      };
      for (let j = -n; j < n; j++) {
        const s0 = j * B + shift[1 - fam];
        const mid = at(s0 + B / 2);
        const r = Math.hypot(mid.x - t.x, mid.z - t.z) / outline(mid.x, mid.z);
        const keep = r < 0.55 ? 0.97 : 1 - (r - 0.55) * 1.25;
        const roll = rnd();
        let valid = r < 1 && roll < keep;
        const steps = Math.ceil(B / STEP);
        if (valid) {
          for (let i = 0; i <= steps && valid; i++) {
            const p = at(s0 + (B * i) / steps);
            if (Math.hypot(p.x - t.x, p.z - t.z) > 1.15 * R) valid = false;
            else if (C.waterClearance(p.x, p.z) < width / 2 + 8) valid = false;
            else if (C.inAirport(p.x, p.z, 30)) valid = false;
            else if (i > 0 && i < steps && major.nearest(p.x, p.z, 40, q) && q.d < q.halfWidth + width / 2 + 12 && Math.abs(dir.x * q.dx + dir.z * q.dz) > 0.9) valid = false;
          }
        }
        if (!valid) {
          flush();
          continue;
        }
        if (!run) run = [at(s0)];
        for (let i = 1; i <= steps; i++) run.push(at(s0 + (B * i) / steps));
      }
      flush();
    }
  }
}

// ─── Organic streets (village, hamlet) ────────────────────────────────────────

function organicStreets(t: Town, ti: number, rnd: () => number, C: Constraints, major: SegmentGrid, layout: WorldLayout, out: NetRoad[]): void {
  const R = t.radius;
  const village = t.kind === 'village';
  const anchors: { p: XZ; dx: number; dz: number }[] = [];
  for (const road of layout.roads) {
    const pts = road.points;
    for (let i = 1; i < pts.length - 1; i++) {
      if (Math.hypot(pts[i].x - t.x, pts[i].z - t.z) > 0.5 * R) continue;
      const dx = pts[i + 1].x - pts[i - 1].x;
      const dz = pts[i + 1].z - pts[i - 1].z;
      const l = Math.hypot(dx, dz) || 1;
      anchors.push({ p: pts[i], dx: dx / l, dz: dz / l });
    }
  }
  if (anchors.length === 0) {
    const a = rnd() * Math.PI * 2;
    anchors.push({ p: { x: t.x, z: t.z }, dx: Math.cos(a), dz: Math.sin(a) });
  }
  const mine: XZ[][] = [];
  const nearMine = (p: XZ, skip: XZ[] | null): boolean => {
    for (const s of mine) {
      if (s === skip) continue;
      for (let i = 1; i < s.length; i++) if (pointSegmentDistance(p.x, p.z, s[i - 1].x, s[i - 1].z, s[i].x, s[i].z) < 14) return true;
    }
    return false;
  };
  const q = major.newQuery();
  let count = 0;
  const walk = (start: XZ, angle: number, len: number, curv: number, parent: XZ[] | null): XZ[] | null => {
    const pts: XZ[] = [{ x: start.x, z: start.z }];
    let a = angle;
    let p = start;
    for (let s = STEP; s <= len; s += STEP) {
      a += curv * STEP;
      const np = { x: p.x + Math.cos(a) * STEP, z: p.z + Math.sin(a) * STEP };
      if (Math.hypot(np.x - t.x, np.z - t.z) > 1.1 * R) break;
      if (C.waterClearance(np.x, np.z) < 6 / 2 + 8 || C.inAirport(np.x, np.z, 30)) break;
      if (s > 30 && major.nearest(np.x, np.z, 30, q) && q.d < q.halfWidth + 10) break;
      if (s > 20 && nearMine(np, parent)) break;
      pts.push(np);
      p = np;
    }
    if (pts.length < 5) return null;
    mine.push(pts);
    out.push({ name: `${t.name} street ${++count}`, kind: 'street', width: village ? 6 : 5, points: pts, town: ti, farm: -1 });
    return pts;
  };
  const spokes = village ? 3 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < spokes * 3 && count < spokes; i++) {
    const an = anchors[Math.floor(rnd() * anchors.length)];
    const side = rnd() < 0.5 ? 1 : -1;
    const base = Math.atan2(an.dz, an.dx) + side * (Math.PI / 2) + (rnd() - 0.5) * 0.6;
    const len = R * (village ? 0.6 + 0.5 * rnd() : 0.55 + 0.4 * rnd());
    const curv = ((rnd() - 0.5) * 1.4) / len;
    if (C.waterClearance(an.p.x, an.p.z) < 11 || C.inAirport(an.p.x, an.p.z, 30)) continue;
    const pts = walk(an.p, base, len, curv, null);
    if (pts && village && rnd() < 0.55 && pts.length > 8) {
      const m = pts[Math.floor(pts.length / 2)];
      const b = pts[Math.floor(pts.length / 2) + 1];
      const dir = Math.atan2(b.z - m.z, b.x - m.x) + (rnd() < 0.5 ? 1 : -1) * (Math.PI / 2);
      walk(m, dir, R * (0.3 + 0.25 * rnd()), ((rnd() - 0.5) * 0.8) / R, pts);
    }
  }
}

// ─── Farmsteads ───────────────────────────────────────────────────────────────

function planFarms(layout: WorldLayout, heightAt: (x: number, z: number) => number, C: Constraints, major: SegmentGrid, cfg: TownsConfig, roads: NetRoad[]): FarmSite[] {
  if (cfg.farmsteadChance <= 0) return [];
  const S = cfg.farmsteadSpacing;
  const seed = (layout.seed ^ 0xfa12) | 0;
  const q = major.newQuery();
  const slopeMax = cfg.maxSlope * 80;
  const nearTown = (x: number, z: number, pad: number): boolean => {
    for (const t of layout.towns) if (Math.hypot(x - t.x, z - t.z) < t.radius + pad) return true;
    return false;
  };
  const ok = (x: number, z: number): boolean => {
    if (C.waterClearance(x, z) < 150) return false;
    if (C.inAirport(x, z, 500)) return false;
    if (nearTown(x, z, 350)) return false;
    const h = heightAt(x, z);
    if (!(h < cfg.farmMaxHeight) || h < 1) return false;
    if (Math.abs(heightAt(x + 40, z) - heightAt(x - 40, z)) > slopeMax) return false;
    if (Math.abs(heightAt(x, z + 40) - heightAt(x, z - 40)) > slopeMax) return false;
    if (major.pointClearance(x, z, 60) < 45) return false;
    return true;
  };
  interface Site {
    x: number;
    z: number;
    headingDeg: number;
    drive: XZ[] | null;
    keep: number;
  }
  const sites: Site[] = [];
  const tooClose = (x: number, z: number): boolean => {
    for (let k = sites.length - 1; k >= 0; k--) {
      const f = sites[k];
      if (Math.abs(f.x - x) < 360 && Math.abs(f.z - z) < 360 && Math.hypot(f.x - x, f.z - z) < 360) return true;
    }
    return false;
  };
  /** A gently bent track from a to b (points every STEP m), or null if it gets wet / hits the airport or a town. */
  const track = (ax: number, az: number, bx: number, bz: number, bendKey: number): XZ[] | null => {
    const D = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / D;
    const dz = (bz - az) / D;
    const n = Math.max(2, Math.ceil(D / STEP));
    const bend = (bendKey - 0.5) * Math.min(40, D * 0.08);
    const pts: XZ[] = [];
    for (let k = 0; k <= n; k++) {
      const s = k / n;
      const off = Math.sin(Math.PI * s) * bend;
      const px = ax + dx * D * s - dz * off;
      const pz = az + dz * D * s + dx * off;
      if (k > 0 && (C.waterClearance(px, pz) < 8 || C.inAirport(px, pz, 100) || nearTown(px, pz, 40))) return null;
      pts.push({ x: px, z: pz });
    }
    return pts;
  };
  const x0 = Math.floor(-36000 / S);
  const x1 = Math.ceil(36000 / S);
  const z0 = Math.floor(-32000 / S);
  const z1 = Math.ceil(20000 / S);
  for (let j = z0; j < z1; j++)
    for (let i = x0; i < x1; i++) {
      if (hash2i(i, j, seed) >= cfg.farmsteadChance) continue;
      const x = (i + 0.15 + 0.7 * hash2i(i, j, seed + 1)) * S;
      const z = (j + 0.15 + 0.7 * hash2i(i, j, seed + 2)) * S;
      if (layout.coast.zAt(x) - z < 400) continue;
      if (!ok(x, z)) continue;
      const pick = hash2i(i, j, seed + 3);
      const keep = hash2i(i, j, seed + 5);
      if (major.nearest(x, z, 650, q) && layout.roads[q.id].kind !== 'highway') {
        let dx = x - q.px;
        let dz = z - q.pz;
        const l = Math.hypot(dx, dz);
        if (l < 1e-6) {
          dx = -q.dz;
          dz = q.dx;
        } else {
          dx /= l;
          dz /= l;
        }
        const D = q.halfWidth + 70 + 160 * pick;
        const fx = q.px + dx * D;
        const fz = q.pz + dz * D;
        if (!ok(fx, fz) || tooClose(fx, fz)) continue;
        const pts = track(q.px, q.pz, fx, fz, hash2i(i, j, seed + 4));
        if (!pts) continue;
        sites.push({ x: fx, z: fz, headingDeg: headingOf(-dx, -dz), drive: pts, keep });
      } else {
        if (tooClose(x, z)) continue;
        sites.push({ x, z, headingDeg: Math.floor(keep * 4) * 90 + 15 * pick, drive: null, keep });
      }
    }
  // Farm tracks: connect isolated farms to the nearest point of an existing driveway/track.
  for (let pass = 0; pass < 8; pass++) {
    let progress = false;
    for (let fi = 0; fi < sites.length; fi++) {
      const f = sites[fi];
      if (f.drive) continue;
      let best = 1500 * 1500;
      let bx = 0;
      let bz = 0;
      for (const o of sites) {
        if (!o.drive || o === f) continue;
        if (Math.abs(o.x - f.x) > 1600 || Math.abs(o.z - f.z) > 1600) continue;
        // connect to a vertex at least 30 m before the other farm's yard
        const d = o.drive;
        for (let k = 0; k < d.length - 3; k++) {
          const e = (d[k].x - f.x) ** 2 + (d[k].z - f.z) ** 2;
          if (e < best) {
            best = e;
            bx = d[k].x;
            bz = d[k].z;
          }
        }
      }
      if (best >= 1500 * 1500 || best < 60 * 60) continue;
      const pts = track(bx, bz, f.x, f.z, f.keep);
      if (!pts) continue;
      f.drive = pts;
      const e = pts[pts.length - 2];
      f.headingDeg = headingOf(e.x - f.x, e.z - f.z);
      progress = true;
    }
    if (!progress) break;
  }
  const farms: FarmSite[] = [];
  for (const f of sites) {
    if (!f.drive && f.keep < 0.5) continue;
    const fi = farms.length;
    farms.push({ x: f.x, z: f.z, headingDeg: f.headingDeg, drive: f.drive ? roads.length : -1 });
    if (f.drive) roads.push({ name: `Farm track ${fi + 1}`, kind: 'drive', width: 3.6, points: f.drive, town: -1, farm: fi });
  }
  return farms;
}

// ─── Shared cache ─────────────────────────────────────────────────────────────

const cache = new WeakMap<WorldLayout, WeakMap<(x: number, z: number) => number, RoadNetwork>>();

/** The network for (layout, heightAt), built once and shared by createTowns/createRoads. */
export function getRoadNetwork(layout: WorldLayout, heightAt: (x: number, z: number) => number): RoadNetwork {
  let inner = cache.get(layout);
  if (!inner) cache.set(layout, (inner = new WeakMap()));
  let net = inner.get(heightAt);
  if (!net) inner.set(heightAt, (net = buildRoadNetwork(layout, heightAt)));
  return net;
}
