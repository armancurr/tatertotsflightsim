/**
 * The player's port (PURE, no three.js): where a boat starts. Boats start like aircraft start on
 * the runway — moored in the visitors' berth at the Port Chateau marina (`playerBerth`: an
 * alongside berth on the visitors' pontoon at the outer end of the central pontoon, bow toward the
 * harbour entrance, so the player casts off and drives straight out), or underway on open water
 * (`seaStart`: 1.5–3 km off the marina entrance, heading out to sea, in deep water clear of the
 * traffic routes and the islands). `portInfo()` names things for the HUD and menus.
 *
 * The berth is reserved in the marina layout (src/world/traffic/sea.ts `MarinaLayout.visitor`):
 * no moored boat is placed there, no route passes within 25 m, and the harbour obstacles
 * (src/world/traffic/harbourObstacles.ts) keep its water free.
 *
 * Poses are the CG of the yacht: x, z world metres, heading clockwise from north (0 = −Z, 90 = +X),
 * the bow (body −Z) pointing along it.
 *
 * Berths by size (`BerthId`): 'visitor' (the marina's visitors' pontoon: yachts, jet skis), 'cruise'
 * (the cruise terminal east of the marina) and 'naval' (the naval pier west of it) — the piers are
 * laid out in src/world/harbour/layout.ts. `berthFor(def)` picks one for a vessel (by fleet id when
 * known, else a warship → naval, else the smallest berth its hull fits), `berthPose(id, size)` puts
 * that hull's CG alongside the berth's face, and `vesselBerth(def)` does both (the app's R / "Back to
 * the berth"). `vesselSize(cfg)` measures a hull from its station table.
 */
import { CONFIG, type Config, type AircraftConfig } from '../config';
import { getLayout, type WorldLayout } from './layout';
import { getHeightfield } from './heightfield';
import { createMarina, defineRoutes, toLocal, toWorld, type MarinaLayout, type WaterWorld } from './traffic/sea';
import { marinaObstacleTop } from './traffic/harbourObstacles';
import { hullGeometry } from '../physics/hull';
import { BERTH_LIMITS, SHIP_UNDER_KEEL, portWorks, type BerthFace } from './harbour/layout';

export interface DockPose {
  x: number;
  z: number;
  headingDeg: number;
}

export interface PlayerBerth extends DockPose {
  /** Index into `MarinaLayout.berths`, or −1: the dedicated visitors' berth (not one of the traffic berths). */
  berthIndex: number;
  /** Size of the reserved berth water (along the pontoon × out from it), m. */
  lengthM: number;
  beamM: number;
  /** Which side of the yacht lies against the pontoon. */
  side: 'port' | 'starboard';
}

/**
 * The yacht the berth is laid out for (Princess V50, src/config.ts makeV50): body z of the bow
 * pulpit and the swim platform (CG at 0), the half beam, and the draft with a margin.
 */
export const BERTH_YACHT = { bowZ: -9.2, sternZ: 6.3, halfBeam: 2.055, draft: 1.2 } as const;
/** Gap between the hull and the pontoon face (fenders), m. */
export const FENDER_GAP = 0.45;
/** Least water under the keel at the berth and the sea start, m. */
export const MIN_UNDER_KEEL = 2.5;
/** Sea start: distance off the marina entrance (m), least depth (m), clearance from routes and islands (m). */
export const SEA_START = { minOff: 1500, maxOff: 3000, minDepth: 15, routeClearance: 500, islandClearance: 1500 } as const;

interface PortCache {
  marina: MarinaLayout;
  berth?: PlayerBerth;
  sea?: DockPose;
  sites?: Record<BerthId, BerthSite>;
}
const caches = new WeakMap<WorldLayout, WeakMap<Config, PortCache>>();
function cache(layout: WorldLayout, cfg: Config): PortCache {
  let byCfg = caches.get(layout);
  if (!byCfg) caches.set(layout, (byCfg = new WeakMap()));
  let c = byCfg.get(cfg);
  if (!c) byCfg.set(cfg, (c = { marina: createMarina(layout, cfg) }));
  return c;
}

/** The marina the port uses (cached per layout + config). */
export function portMarina(layout: WorldLayout = getLayout(), cfg: Config = CONFIG): MarinaLayout {
  return cache(layout, cfg).marina;
}

/**
 * The player's berth: alongside the visitors' pontoon (its berth face), the hull centred on the
 * pontoon, bow toward the harbour entrance.
 */
export function playerBerth(layout: WorldLayout = getLayout(), cfg: Config = CONFIG): PlayerBerth {
  const c = cache(layout, cfg);
  if (c.berth) return { ...c.berth };
  const m = c.marina;
  const v = m.visitor;
  const u = v.u + v.side * (v.half + FENDER_GAP + BERTH_YACHT.halfBeam);
  // the hull's middle 1.45 m ahead of the CG sits at the pontoon's middle (heading +w)
  const w = (v.w0 + v.w1) / 2 + (BERTH_YACHT.bowZ + BERTH_YACHT.sternZ) / 2;
  const p = toWorld(m.frame, u, w);
  c.berth = {
    x: p.x,
    z: p.z,
    headingDeg: m.frame.headingW,
    berthIndex: -1,
    lengthM: v.berth.w1 - v.berth.w0,
    beamM: v.berth.u1 - v.berth.u0,
    // facing +w, +u is to port; the yacht lies off the pontoon's `side` face, so the pontoon is on its −side
    side: v.side > 0 ? 'starboard' : 'port',
  };
  return { ...c.berth };
}

const defaultWater = (): WaterWorld => {
  const hf = getHeightfield();
  return { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) };
};

/** Water depth at a point (m), or −Infinity on land / off the sea (level ≠ 0). */
export function seaDepth(water: WaterWorld, x: number, z: number): number {
  const wl = water.waterLevel(x, z);
  if (wl === null || Math.abs(wl) > 0.5) return -Infinity;
  return wl - water.groundHeight(x, z);
}

/**
 * Open water off the marina: the candidate 1.5–3 km out from the entrance (on a grid across the
 * approach) that is deep, far from land and the islands, and farthest from every traffic route,
 * heading out to sea along the marina's seaward axis.
 */
export function seaStart(layout: WorldLayout = getLayout(), cfg: Config = CONFIG, water: WaterWorld = defaultWater()): DockPose {
  const c = cache(layout, cfg);
  if (c.sea) return { ...c.sea };
  const m = c.marina;
  const f = m.frame;
  // every route (unvalidated: the same set the traffic draws), sampled every ~40 m
  const pts: { x: number; z: number }[] = [];
  for (const r of defineRoutes(layout, m, cfg)) {
    if (Math.abs(r.level) > 0.5) continue;
    const p = r.path;
    const stride = Math.max(1, Math.round(40 / Math.max(1e-3, p.length / Math.max(1, p.n))));
    for (let i = 0; i < p.n; i += stride) pts.push({ x: p.x[i], z: p.z[i] });
  }
  const routeDist = (x: number, z: number) => {
    let lo = Infinity;
    for (const q of pts) {
      const d = Math.hypot(q.x - x, q.z - z);
      if (d < lo) lo = d;
    }
    return lo;
  };
  let best: { x: number; z: number; score: number } | null = null;
  for (let off = SEA_START.minOff; off <= SEA_START.maxOff + 1e-6; off += 250) {
    for (let lat = -1500; lat <= 1500; lat += 250) {
      const p = toWorld(f, m.entrance.u + lat, m.entrance.w + off);
      if (!deepAround(water, p.x, p.z, f.wx, f.wz)) continue;
      if (layout.islands.some((i) => Math.hypot(i.x - p.x, i.z - p.z) < i.radius + SEA_START.islandClearance)) continue;
      if (p.z - layout.coast.zAt(p.x) < SEA_START.minOff) continue;
      const rd = routeDist(p.x, p.z);
      if (rd < SEA_START.routeClearance) continue;
      // prefer clear water, then close to the marina's axis, then nearer the entrance
      const score = Math.min(rd, 1500) - 0.25 * Math.abs(lat) - 0.1 * (off - SEA_START.minOff);
      if (!best || score > best.score) best = { x: p.x, z: p.z, score };
    }
  }
  if (!best) {
    // (not for the default world) straight out from the entrance
    const p = toWorld(f, m.entrance.u, m.entrance.w + (SEA_START.minOff + SEA_START.maxOff) / 2);
    best = { x: p.x, z: p.z, score: 0 };
  }
  c.sea = { x: best.x, z: best.z, headingDeg: f.headingW };
  return { ...c.sea };
}

/** Deep sea at the point, in a 300 m ring around it and 1 km ahead along (dx, dz). */
function deepAround(water: WaterWorld, x: number, z: number, dx: number, dz: number): boolean {
  if (seaDepth(water, x, z) < SEA_START.minDepth) return false;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (seaDepth(water, x + 300 * Math.cos(a), z + 300 * Math.sin(a)) < SEA_START.minDepth) return false;
  }
  for (let s = 100; s <= 1000; s += 100) if (seaDepth(water, x + dx * s, z + dz * s) < SEA_START.minDepth) return false;
  return true;
}

export interface PortInfo {
  /** The town / port name ('Port Chateau'). */
  name: string;
  /** The marina's name, and the berth's, for the HUD and menus. */
  marina: string;
  berth: string;
  /** The harbour entrance (between the beacons), world m. */
  entrance: { x: number; z: number };
  /** Heading out through the entrance, deg. */
  seawardDeg: number;
}

export function portInfo(layout: WorldLayout = getLayout(), cfg: Config = CONFIG): PortInfo {
  const m = portMarina(layout, cfg);
  const e = toWorld(m.frame, m.entrance.u, m.entrance.w);
  return { name: 'Port Chateau', marina: 'Port Chateau Marina', berth: "Visitors' pontoon", entrance: e, seawardDeg: m.frame.headingW };
}

/** Samples of a hull footprint at a pose (outline, spaced ≤ 1 m, and a centreline), world xz. */
export function hullFootprint(pose: DockPose, hull: { bowZ: number; sternZ: number; halfBeam: number } = BERTH_YACHT): { x: number; z: number }[] {
  const h = (pose.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const out: { x: number; z: number }[] = [];
  const n = Math.ceil(hull.sternZ - hull.bowZ);
  for (let i = 0; i <= n; i++) {
    const bz = hull.bowZ + ((hull.sternZ - hull.bowZ) * i) / n;
    for (const s of [-1, -0.5, 0, 0.5, 1]) {
      const along = -bz; // body −z is forward
      const across = s * hull.halfBeam;
      out.push({ x: pose.x + fx * along - fz * across, z: pose.z + fz * along + fx * across });
    }
  }
  return out;
}

/** Checks a pose for the yacht: least depth under the footprint and whether any of it is inside a marina structure. */
export function checkDock(pose: DockPose, marina: MarinaLayout, water: WaterWorld = defaultWater()): { minDepth: number; blocked: boolean } {
  let minDepth = Infinity;
  let blocked = false;
  for (const p of hullFootprint(pose)) {
    minDepth = Math.min(minDepth, seaDepth(water, p.x, p.z));
    if (marinaObstacleTop(marina, p.x, p.z) > -1.5) blocked = true;
  }
  return { minDepth, blocked };
}

/** The pose's position in the marina frame (QA / tests). */
export const berthLocal = (m: MarinaLayout, pose: DockPose) => toLocal(m.frame, pose.x, pose.z);

// ─── Berths by size ─────────────────────────────────────────────────────────────────────────────

export type BerthId = 'visitor' | 'cruise' | 'naval';
export const BERTH_IDS: readonly BerthId[] = ['visitor', 'cruise', 'naval'];

/** A hull's size from its station table (body frame, CG at 0, bow −z). */
export interface VesselSize {
  lengthM: number;
  beamM: number;
  /** Static draft to the lowest point (keel or propeller tips), m. */
  draftM: number;
  bowZ: number;
  sternZ: number;
  halfBeam: number;
  /** Deck edge above the static waterline at mid-length, m. */
  freeboardM: number;
}

/** The size of a vessel's hull, or null for an aircraft. */
export function vesselSize(cfg: Config | AircraftConfig): VesselSize | null {
  const ac = 'aircraft' in cfg ? cfg.aircraft : cfg;
  const wc = ac.watercraft;
  if (!wc || wc.hull.stations.length < 2) return null;
  const st = wc.hull.stations;
  let bowZ = Infinity, sternZ = -Infinity, halfBeam = 0, low = Infinity;
  for (const s of st) {
    bowZ = Math.min(bowZ, s.z);
    sternZ = Math.max(sternZ, s.z);
    halfBeam = Math.max(halfBeam, s.deckHalf, s.chineHalf);
    low = Math.min(low, s.keelY);
  }
  for (const p of wc.propulsors) low = Math.min(low, p.position.y - p.diameter / 2);
  const g = hullGeometry(wc, ac.mass);
  const mid = st.reduce((a, s) => (Math.abs(s.z - (bowZ + sternZ) / 2) < Math.abs(a.z - (bowZ + sternZ) / 2) ? s : a), st[0]);
  return { lengthM: sternZ - bowZ, beamM: 2 * halfBeam, draftM: g.waterlineY - low, bowZ, sternZ, halfBeam, freeboardM: mid.deckY - g.waterlineY };
}

/** What a berth takes and where its face is. */
export interface BerthSite {
  id: BerthId;
  name: string;
  /** Largest vessel it takes (m). */
  maxLengthM: number;
  maxBeamM: number;
  maxDraftM: number;
  /** The quay face (world): the vessel lies alongside it, bow toward (bx, bz), `side` to it. */
  face: BerthFace;
  /** The reserved water of the largest vessel + a margin (world polygon, 4 corners): no route, buoy or structure. */
  reserved: { x: number; z: number }[];
}

/** Fleet ids with a known berth (the cruise ship and the battleship are built elsewhere; absent ids are fine). */
export const BERTH_BY_ID: Readonly<Record<string, BerthId>> = { v50: 'visitor', seadoo: 'visitor', cruise: 'cruise', iowa: 'naval' };

/** Every berth site (cached per layout + config). */
export function portBerths(layout: WorldLayout = getLayout(), cfg: Config = CONFIG): Record<BerthId, BerthSite> {
  const c = cache(layout, cfg);
  if (c.sites) return c.sites;
  const m = c.marina;
  const v = m.visitor;
  // the visitors' pontoon face (+u side), bow toward the entrance (+w)
  const f = m.frame;
  const edge = v.u + v.side * v.half;
  const A = toWorld(f, edge, v.w0);
  const B = toWorld(f, edge, v.w1);
  const C = toWorld(f, edge, (v.w0 + v.w1) / 2);
  const visitorFace: BerthFace = { ax: A.x, az: A.z, bx: B.x, bz: B.z, nx: f.ux * v.side, nz: f.uz * v.side, headingDeg: f.headingW, cx: C.x, cz: C.z, gap: FENDER_GAP, side: v.side > 0 ? 'starboard' : 'port' };
  const vb = v.berth;
  const visitorReserved = [toWorld(f, vb.u0, vb.w0), toWorld(f, vb.u1, vb.w0), toWorld(f, vb.u1, vb.w1), toWorld(f, vb.u0, vb.w1)];
  const works = portWorks(layout, cfg);
  const site = (id: BerthId, name: string, face: BerthFace): BerthSite => {
    const lim = BERTH_LIMITS[id];
    return { id, name, maxLengthM: lim.length, maxBeamM: lim.beam, maxDraftM: lim.draft, face, reserved: id === 'visitor' ? visitorReserved : reservedBox(face, lim.length, lim.beam) };
  };
  c.sites = {
    visitor: site('visitor', "Visitors' pontoon", visitorFace),
    cruise: site('cruise', 'Cruise terminal', works.cruise.face),
    naval: site('naval', 'Naval pier', works.naval.face),
  };
  return c.sites;
}

/** The water a berth reserves: along the face, the largest hull ± 10 m, from the face out past its beam by 10 m. */
function reservedBox(face: BerthFace, length: number, beam: number): { x: number; z: number }[] {
  const h = (face.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const a = length / 2 + 10;
  const out = face.gap + beam + 10;
  const p = (along: number, off: number) => ({ x: face.cx + fx * along + face.nx * off, z: face.cz + fz * along + face.nz * off });
  return [p(-a, 0), p(a, 0), p(a, out), p(-a, out)];
}

/** Does a hull fit a berth? */
export function fitsBerth(id: BerthId, s: VesselSize): boolean {
  const lim = BERTH_LIMITS[id];
  return s.lengthM <= lim.length && s.beamM <= lim.beam && s.draftM <= lim.draft;
}

/** Anything with a fleet id and a config (an `AircraftDef`). */
export interface VesselLike {
  id: string;
  config: Config;
}

/**
 * The berth for a vessel: its fleet id's berth when known ('v50', 'seadoo' → visitor, 'cruise' →
 * cruise, 'iowa' → naval); else a warship (a naval gun battery) → naval; else the smallest berth its
 * hull fits (visitor, then cruise), and naval (the deepest) for anything bigger.
 */
export function berthFor(v: VesselLike): BerthId {
  const known = BERTH_BY_ID[v.id];
  if (known) return known;
  const s = vesselSize(v.config);
  if (!s) return 'visitor';
  if (v.config.weapons?.naval) return 'naval';
  if (fitsBerth('visitor', s)) return 'visitor';
  if (fitsBerth('cruise', s)) return 'cruise';
  return 'naval';
}

export interface VesselBerth extends PlayerBerth {
  berth: BerthId;
}

/**
 * A hull's CG at a berth: alongside the face (the hull's widest point `gap` off it), the middle of the
 * hull on the berth's centre, bow along the face's heading.
 */
export function berthPose(id: BerthId, size: Pick<VesselSize, 'bowZ' | 'sternZ' | 'halfBeam'>, layout: WorldLayout = getLayout(), cfg: Config = CONFIG): VesselBerth {
  const site = portBerths(layout, cfg)[id];
  const f = site.face;
  const h = (f.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const off = f.gap + size.halfBeam;
  // hull middle (body z = zm) at the centre: CG = centre + forward · zm
  const zm = (size.bowZ + size.sternZ) / 2;
  const lengthM = Math.hypot(f.bx - f.ax, f.bz - f.az);
  return {
    x: f.cx + f.nx * off + fx * zm,
    z: f.cz + f.nz * off + fz * zm,
    headingDeg: f.headingDeg,
    berthIndex: -1,
    lengthM: id === 'visitor' ? playerBerth(layout, cfg).lengthM : lengthM,
    beamM: id === 'visitor' ? playerBerth(layout, cfg).beamM : f.gap + site.maxBeamM + 10,
    side: f.side,
    berth: id,
  };
}

/**
 * Where a vessel starts (R, "Back to the berth"): its berth (`berthFor`), its CG from its own hull
 * size. The Princess V50 — the yacht the visitors' pontoon was laid out for — gets `playerBerth()`
 * exactly.
 */
export function vesselBerth(v: VesselLike, layout: WorldLayout = getLayout(), cfg: Config = CONFIG): VesselBerth {
  const id = berthFor(v);
  if (id === 'visitor' && v.id === 'v50') return { ...playerBerth(layout, cfg), berth: 'visitor' };
  const s = vesselSize(v.config);
  return berthPose(id, s ?? BERTH_YACHT, layout, cfg);
}

/** Least water under a ship's keel at the cruise / naval berths, m (the visitors' berth keeps MIN_UNDER_KEEL). */
export { SHIP_UNDER_KEEL, BERTH_LIMITS };

/** Least depth under a hull footprint at a pose, and whether any of it stands in a marina structure or in `obstacleTop`. */
export function checkHull(
  pose: DockPose,
  size: Pick<VesselSize, 'bowZ' | 'sternZ' | 'halfBeam'>,
  water: WaterWorld = defaultWater(),
  obstacleTop?: (x: number, z: number) => number,
): { minDepth: number; blocked: boolean } {
  let minDepth = Infinity;
  let blocked = false;
  for (const p of hullFootprint(pose, size)) {
    minDepth = Math.min(minDepth, seaDepth(water, p.x, p.z));
    if (obstacleTop && obstacleTop(p.x, p.z) > -1.5) blocked = true;
  }
  return { minDepth, blocked };
}
