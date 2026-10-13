/**
 * "Tater Alpha" offshore production platform (PURE): the dimensions the model is drawn from and the
 * physics reads — what you see is what you hit.
 *
 * Local frame (sites.ts): origin at the jacket's centre at sea level, +X toward the flare end
 * (downwind, bearing 35°), +Z to starboard of that, +Y up. A four-leg steel jacket (legs battered
 * 1:10) carries a three-level topside: cellar deck +20 m, main deck +28 m, weather deck +36 m. The
 * living quarters (four storeys) stand on the upwind end with the helideck on their roof at
 * +51.5 m; the drilling derrick and the process modules in the middle; two pedestal cranes on the
 * long sides; the flare boom cantilevered 70 m off the downwind end, rising 20°.
 *
 * Physics: `platformObstacleTop` is solid for aircraft and hulls (the whole topside footprint is a
 * wall down to the sea bed for a boat); the helideck is a landable DECK (`helideckTop`, registered
 * with `env.registerDeckSource`) and the obstacle answers −∞ over it, so a helicopter's skids stand
 * on it. The deck lies ≥ 8 m inside the solid footprint, so a hull is stopped by the wall long
 * before it could sample the deck as "ground".
 */
import { localToWorld, siteFrame, worldToLocal, type SiteFrame } from './sites';
import { PLATFORM_SITE } from './sites';

export interface Box2 {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Top, m above sea level. */
  top: number;
}

const WATER_DEPTH_NOMINAL = 41;

export const PLATFORM = {
  depth: WATER_DEPTH_NOMINAL,
  /** Deck levels (top of plate), m. */
  cellarY: 20,
  mainY: 28,
  weatherY: 36,
  /** Topside footprint (local). */
  topside: { x0: -40, x1: 36, z0: -20, z1: 20 },
  /** Jacket leg tops (at the cellar deck's underside) and their batter (horizontal per vertical). */
  legs: { x: 26, z: 15, topY: 18.5, batter: 0.1, radius: 1.1 },
  /** Horizontal brace levels of the jacket, m. */
  braceLevels: [9, -6, -22, -38],
  /** Living quarters block on the weather deck. */
  quarters: { x0: -33, x1: -9, z0: -13, z1: 13, storeys: 4, storeyH: 3.2 },
  /** Helideck: an octagon (across the flats), on its support frame above the quarters. */
  helideck: { cx: -21, cz: 0, flats: 22, y: 51.5 },
  /** Drilling derrick (on its substructure: drill floor at +44). */
  derrick: { cx: 12, cz: -5, base: 12, top: 3.2, floorY: 44, height: 44 },
  /** Pedestal cranes: pedestal centre, boom rest direction (local deg, 0 = +X), boom length. */
  cranes: [
    { cx: -4, cz: 17.5, pedestalTop: 47, boomDeg: 0, boom: 38 },
    { cx: 22, cz: -17.5, pedestalTop: 47, boomDeg: 180, boom: 34 },
  ],
  /** Flare boom: root on the downwind end, rising `riseDeg`, `length` long, toward local +X (slightly +Z). */
  flare: { rootX: 36, rootZ: 10, rootY: 38, length: 70, riseDeg: 20, yawDeg: 8 },
  /** Process modules on the weather deck (boxes; tops). */
  modules: [
    { x0: -6, x1: 4, z0: -18, z1: -2, top: 47 },
    { x0: -6, x1: 6, z0: 2, z1: 14, top: 45 },
    { x0: 22, x1: 34, z0: -2, z1: 16, top: 46 },
    { x0: 8, x1: 20, z0: 6, z1: 18, top: 43 },
    { x0: 24, x1: 34, z0: -18, z1: -6, top: 44 },
  ] as Box2[],
} as const;

/** The platform's frame (world placement). */
export const platformFrame = (): SiteFrame => siteFrame(PLATFORM_SITE.x, PLATFORM_SITE.z, PLATFORM_SITE.headingDeg);

const COS_22 = Math.cos(Math.PI / 8);

/** Inside the helideck octagon (local coordinates, relative to its centre)? */
export function inOctagon(dx: number, dz: number, flats: number): boolean {
  const h = flats / 2;
  const ax = Math.abs(dx);
  const az = Math.abs(dz);
  if (ax > h || az > h) return false;
  // the diagonal flats: |x| + |z| ≤ h·√2 (a regular octagon with flats on the axes)
  return (ax + az) * Math.SQRT1_2 <= h;
}

/** Circumradius of the helideck octagon. */
export const helideckCircumradius = (): number => PLATFORM.helideck.flats / 2 / COS_22;

/** Flare boom tip (local): where the flame burns. */
export function flareTipLocal(): { x: number; y: number; z: number } {
  const f = PLATFORM.flare;
  const r = (f.riseDeg * Math.PI) / 180;
  const y = (f.yawDeg * Math.PI) / 180;
  const hl = f.length * Math.cos(r);
  return { x: f.rootX + hl * Math.cos(y), y: f.rootY + f.length * Math.sin(r), z: f.rootZ + hl * Math.sin(y) };
}

/** Everything solid, as local boxes with tops (the helideck octagon is cut out at lookup time). */
export function platformBoxes(): Box2[] {
  const P = PLATFORM;
  const t = P.topside;
  const out: Box2[] = [];
  // topside + walkways, lifeboats and handrails along the edges (+2 m)
  out.push({ x0: t.x0 - 2, x1: t.x1 + 2, z0: t.z0 - 2, z1: t.z1 + 2, top: P.weatherY + 1.2 });
  const q = P.quarters;
  out.push({ x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, top: P.weatherY + q.storeys * q.storeyH + 0.6 });
  for (const m of P.modules) out.push(m);
  const d = P.derrick;
  out.push({ x0: d.cx - d.base / 2, x1: d.cx + d.base / 2, z0: d.cz - d.base / 2, z1: d.cz + d.base / 2, top: d.floorY + d.height + 3 });
  for (const c of P.cranes) {
    out.push({ x0: c.cx - 3, x1: c.cx + 3, z0: c.cz - 3, z1: c.cz + 3, top: c.pedestalTop + 5 });
    // the boom in its rest (lying along the deck, 2 m wide)
    const dir = Math.cos((c.boomDeg * Math.PI) / 180);
    const xa = c.cx;
    const xb = c.cx + dir * c.boom;
    out.push({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), z0: c.cz - 1.5, z1: c.cz + 1.5, top: c.pedestalTop + 2 });
  }
  // flare boom: boxes along its length, as high as the boom is there (+2 m of lattice)
  const f = P.flare;
  const tip = flareTipLocal();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    const xa = f.rootX + (tip.x - f.rootX) * a;
    const xb = f.rootX + (tip.x - f.rootX) * b;
    const za = f.rootZ + (tip.z - f.rootZ) * a;
    const zb = f.rootZ + (tip.z - f.rootZ) * b;
    const top = f.rootY + (tip.y - f.rootY) * b + 2.5;
    out.push({ x0: Math.min(xa, xb) - 0.5, x1: Math.max(xa, xb) + 0.5, z0: Math.min(za, zb) - 2.5, z1: Math.max(za, zb) + 2.5, top });
  }
  // the flare tip structure itself
  out.push({ x0: tip.x - 2, x1: tip.x + 2, z0: tip.z - 2, z1: tip.z + 2, top: tip.y + 3 });
  return out;
}

/** Local bounding box of everything solid (a quick reject). */
function boundsOf(boxes: Box2[]): { x0: number; x1: number; z0: number; z1: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x0);
    x1 = Math.max(x1, b.x1);
    z0 = Math.min(z0, b.z0);
    z1 = Math.max(z1, b.z1);
  }
  return { x0, x1, z0, z1 };
}

export interface PlatformPhysics {
  frame: SiteFrame;
  /** Top (m MSL) of the platform's structure at world x, z, or −∞ (−∞ over the helideck: that is a deck). */
  obstacleTop(x: number, z: number): number;
  /** The helideck surface (m MSL) at world x, z, or −∞ off it. */
  helideckTop(x: number, z: number): number;
  /** Helideck centre, world. */
  helideck: { x: number; y: number; z: number };
  /** Flare tip, world. */
  flareTip: { x: number; y: number; z: number };
}

/** The platform's physics: obstacle and deck lookups (allocation-free). */
export function createPlatformPhysics(frame: SiteFrame = platformFrame()): PlatformPhysics {
  const boxes = platformBoxes();
  const bb = boundsOf(boxes);
  const hd = PLATFORM.helideck;
  const loc = { x: 0, z: 0 };
  const inBounds = (x: number, z: number): boolean => {
    worldToLocal(frame, x, z, loc);
    return loc.x >= bb.x0 && loc.x <= bb.x1 && loc.z >= bb.z0 && loc.z <= bb.z1;
  };
  const w = { x: 0, z: 0 };
  localToWorld(frame, hd.cx, hd.cz, w);
  const helideck = { x: w.x, y: hd.y, z: w.z };
  const tl = flareTipLocal();
  localToWorld(frame, tl.x, tl.z, w);
  const flareTip = { x: w.x, y: tl.y, z: w.z };
  return {
    frame,
    helideck,
    flareTip,
    obstacleTop(x, z) {
      if (!inBounds(x, z)) return -Infinity;
      if (inOctagon(loc.x - hd.cx, loc.z - hd.cz, hd.flats)) return -Infinity;
      let top = -Infinity;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (loc.x >= b.x0 && loc.x <= b.x1 && loc.z >= b.z0 && loc.z <= b.z1 && b.top > top) top = b.top;
      }
      return top;
    },
    helideckTop(x, z) {
      worldToLocal(frame, x, z, loc);
      return inOctagon(loc.x - hd.cx, loc.z - hd.cz, hd.flats) ? hd.y : -Infinity;
    },
  };
}

/** A light on the platform (local position; the renderer adds them as point sprites). */
export interface PlatformLight {
  x: number;
  y: number;
  z: number;
  kind: 'obstruction' | 'perimeter' | 'flood' | 'deck' | 'status';
}

/**
 * The platform's lights: red aviation obstruction lights on the derrick crown, the flare boom tip,
 * the crane booms and the quarters' corners; green helideck perimeter lights (ICAO) round the
 * octagon; white floods on the deck; warm deck lights along every level (a platform at night is a
 * lit-up town at sea).
 */
export function platformLights(): PlatformLight[] {
  const P = PLATFORM;
  const out: PlatformLight[] = [];
  const d = P.derrick;
  out.push({ x: d.cx, y: d.floorY + d.height + 2.2, z: d.cz, kind: 'obstruction' });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) out.push({ x: d.cx + (sx * d.base) / 4, y: d.floorY + d.height * 0.55, z: d.cz + (sz * d.base) / 4, kind: 'obstruction' });
  const tip = flareTipLocal();
  out.push({ x: tip.x, y: tip.y - 1.5, z: tip.z + 2.2, kind: 'obstruction' });
  for (const c of P.cranes) {
    const dir = Math.cos((c.boomDeg * Math.PI) / 180);
    out.push({ x: c.cx + dir * c.boom, y: c.pedestalTop + 1.6, z: c.cz, kind: 'obstruction' });
    out.push({ x: c.cx, y: c.pedestalTop + 5.4, z: c.cz, kind: 'obstruction' });
  }
  const q = P.quarters;
  const qTop = P.weatherY + q.storeys * q.storeyH;
  for (const [x, z] of [[q.x0, q.z0], [q.x1, q.z0], [q.x1, q.z1], [q.x0, q.z1]]) out.push({ x, y: qTop + 0.5, z, kind: 'obstruction' });
  // helideck perimeter: 3 per side of the octagon (24), just outside the deck edge
  const hd = P.helideck;
  const R = helideckCircumradius() + 0.3;
  for (let k = 0; k < 8; k++) {
    const a0 = ((k + 0.5) / 8) * Math.PI * 2;
    const a1 = ((k + 1.5) / 8) * Math.PI * 2;
    for (let j = 0; j < 3; j++) {
      const t = j / 3;
      const x = R * (Math.cos(a0) * (1 - t) + Math.cos(a1) * t);
      const z = R * (Math.sin(a0) * (1 - t) + Math.sin(a1) * t);
      out.push({ x: hd.cx + x, y: hd.y + 0.25, z: hd.cz + z, kind: 'perimeter' });
    }
  }
  // floods on the quarters' roof edge, lighting the deck
  out.push({ x: q.x1 + 0.5, y: qTop + 1.2, z: q.z0 + 3, kind: 'flood' });
  out.push({ x: q.x1 + 0.5, y: qTop + 1.2, z: q.z1 - 3, kind: 'flood' });
  // deck lights: rows along the three decks' edges
  const t = P.topside;
  for (const y of [P.cellarY + 2.6, P.mainY + 2.6, P.weatherY + 3]) {
    for (let x = t.x0 + 3; x <= t.x1 - 2; x += 7) {
      out.push({ x, y, z: t.z0 + 0.3, kind: 'deck' });
      out.push({ x, y, z: t.z1 - 0.3, kind: 'deck' });
    }
    for (let z = t.z0 + 5; z <= t.z1 - 5; z += 8) {
      out.push({ x: t.x0 + 0.3, y, z, kind: 'deck' });
      out.push({ x: t.x1 - 0.3, y, z, kind: 'deck' });
    }
  }
  // status lights on the modules
  for (const m of P.modules) out.push({ x: (m.x0 + m.x1) / 2, y: m.top + 0.4, z: (m.z0 + m.z1) / 2, kind: 'status' });
  return out;
}

/** Skid-level landing spot on the helideck (world) — used by QA spawns and tests. */
export function helideckSpot(): { x: number; y: number; z: number; headingDeg: number } {
  const p = createPlatformPhysics();
  // land facing into the wind (from 215°)
  return { ...p.helideck, headingDeg: 215 };
}
