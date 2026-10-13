/**
 * Berthed ships (PURE, no three.js): when the player isn't driving the cruise ship or the battleship,
 * that ship lies moored at its berth — the cruise ship at the cruise terminal, the battleship at the
 * naval pier. This module says where (from each ship's own hull, `vesselBerth`), how high it floats
 * (its static waterline and trim, the same `staticFloat` the physics uses), and what it is to the
 * physics: an obstacle column over its deck outline at its deck height (from the hull stations; the
 * model's superstructure is added from its drawn geometry by src/game/systems/berthedShips.ts), and a
 * landable deck wherever the deck is clear — a helicopter can set down on the battleship's fantail
 * helipad, a yacht can't sail through the hull. The naval pier's brow joins the ship to the pier.
 *
 * Fleet ids absent from the fleet (the ships are built elsewhere) are simply skipped.
 */
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { stationAt, staticFloat } from '../../physics/hull';
import { vesselBerth, vesselSize, type BerthId, type VesselBerth, type VesselLike, type VesselSize } from '../port';
import { portWorks, PORT_DIMS } from './layout';

/** The fleet ids shown berthed when the player isn't driving them. */
export const BERTHED_SHIP_IDS = ['cruise', 'iowa'] as const;

export interface BerthedShipSpec {
  id: string;
  berth: BerthId;
  pose: VesselBerth;
  size: VesselSize;
  config: Config;
  /** CG height (m MSL) and static trim (deg, + bow up) afloat at rest. */
  y: number;
  pitchDeg: number;
  /** The brow from the pier deck to the deck edge (naval pier), world; null when there is none. */
  brow: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; half: number } | null;
}

/** Tops (m MSL) sampled on a grid in the ship's body frame (x starboard, z aft), e.g. the drawn superstructure. */
export interface HeightGrid {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** Row-major (z rows, x columns); −Infinity = nothing. */
  data: Float32Array;
}

const DEG = Math.PI / 180;

/** Where each berthed ship lies (only the ids present in the fleet, as vessels). */
export function berthedShipSpecs(fleet: readonly VesselLike[], layout: WorldLayout = getLayout(), cfg: Config = CONFIG): BerthedShipSpec[] {
  const out: BerthedShipSpec[] = [];
  for (const id of BERTHED_SHIP_IDS) {
    const def = fleet.find((d) => d.id === id);
    if (!def || !def.config.aircraft.watercraft) continue;
    const size = vesselSize(def.config);
    if (!size) continue;
    const pose = vesselBerth(def, layout, cfg);
    const fl = staticFloat(def.config);
    const spec: BerthedShipSpec = { id, berth: pose.berth, pose, size, config: def.config, y: fl.dy, pitchDeg: fl.pitchDeg, brow: null };
    if (pose.berth === 'naval') spec.brow = browFor(spec, layout, cfg);
    out.push(spec);
  }
  return out;
}

/** Body → world for a berthed ship (level heading, static trim). */
export function shipToWorld(s: BerthedShipSpec, bx: number, by: number, bz: number): { x: number; y: number; z: number } {
  const h = s.pose.headingDeg * DEG;
  const p = s.pitchDeg * DEG;
  // pitch about the body x axis (bow up): y' = y cos p − z sin p, z' = y sin p + z cos p
  const yy = by * Math.cos(p) - bz * Math.sin(p);
  const zz = by * Math.sin(p) + bz * Math.cos(p);
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  // body −z is forward; +x is starboard = (cos h, sin h)
  return { x: s.pose.x + Math.cos(h) * bx - fx * zz, y: s.y + yy, z: s.pose.z + Math.sin(h) * bx - fz * zz };
}

/** The deck height (m MSL) at body z (the deck edge line), and the deck's half-breadth there. */
export function deckAt(s: BerthedShipSpec, bz: number): { y: number; half: number } {
  const st = stationAt(s.config.aircraft.watercraft!.hull.stations, bz);
  return { y: s.y + st.deckY * Math.cos(s.pitchDeg * DEG) - bz * Math.sin(s.pitchDeg * DEG), half: st.deckHalf };
}

/** The naval brow: from 3 m inboard on the T-head to the deck edge a quarter-length aft of midships. */
function browFor(s: BerthedShipSpec, layout: WorldLayout, cfg: Config): BerthedShipSpec['brow'] {
  const n = portWorks(layout, cfg).naval;
  const bz = s.size.sternZ - (s.size.sternZ - s.size.bowZ) * 0.3;
  const d = deckAt(s, bz);
  // the pier is on the starboard side at the naval berth (+x)
  const side = s.pose.side === 'starboard' ? 1 : -1;
  const b = shipToWorld(s, side * (d.half - 0.8), d.y - s.y + 0.1, bz);
  // the pier end: straight in from the ship's point, 3 m onto the deck
  const f = n.face;
  const off = (b.x - f.ax) * f.nx + (b.z - f.az) * f.nz;
  return { ax: b.x - f.nx * (off + 3), ay: n.deckY + 0.1, az: b.z - f.nz * (off + 3), bx: b.x, by: b.y, bz: b.z, half: 1.0 };
}

export interface BerthedObstacles {
  top(x: number, z: number): number;
  deckTop(x: number, z: number): number;
  /** Sets the drawn superstructure's tops for a ship (from its model). */
  setRaster(id: string, grid: HeightGrid | null): void;
}

/** A landable deck is within this of the hull's deck line (m): above that, it is superstructure. */
export const DECK_CLEAR_M = 1.0;

/**
 * The berthed ships as obstacles and decks. `active(id)` says whether a ship is lying at its berth
 * (false while the player drives it: then it isn't there).
 */
export function berthedObstacles(specs: readonly BerthedShipSpec[], active: (id: string) => boolean): BerthedObstacles {
  const raster = new Map<string, HeightGrid | null>();
  const boxes = specs.map((s) => {
    const r = Math.hypot(s.size.lengthM / 2 + 5, s.size.halfBeam + 5);
    return { minX: s.pose.x - r, maxX: s.pose.x + r, minZ: s.pose.z - r, maxZ: s.pose.z + r };
  });
  /** Hull deck (or −∞) and the raster top at a world point, for one ship. */
  const probe = (s: BerthedShipSpec, x: number, z: number, out: { deck: number; ras: number }): void => {
    out.deck = -Infinity;
    out.ras = -Infinity;
    const h = s.pose.headingDeg * DEG;
    const dx = x - s.pose.x;
    const dz = z - s.pose.z;
    const bx = dx * Math.cos(h) + dz * Math.sin(h);
    const bz = -(dx * Math.sin(h) - dz * Math.cos(h));
    if (bz >= s.size.bowZ && bz <= s.size.sternZ) {
      const d = deckAt(s, bz);
      if (Math.abs(bx) <= d.half) out.deck = d.y;
    }
    const g = raster.get(s.id);
    if (g) {
      const i = Math.floor((bx - g.x0) / g.cell);
      const j = Math.floor((bz - g.z0) / g.cell);
      if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) out.ras = g.data[j * g.nx + i];
    }
  };
  const tmp = { deck: -Infinity, ras: -Infinity };
  const browTop = (s: BerthedShipSpec, x: number, z: number): number => {
    const b = s.brow;
    if (!b) return -Infinity;
    const vx = b.bx - b.ax;
    const vz = b.bz - b.az;
    const L2 = vx * vx + vz * vz || 1;
    const t = ((x - b.ax) * vx + (z - b.az) * vz) / L2;
    if (t < 0 || t > 1) return -Infinity;
    const d = Math.hypot(x - b.ax - vx * t, z - b.az - vz * t);
    if (d > b.half) return -Infinity;
    // the walkway and its handrails
    return b.ay + (b.by - b.ay) * t + (d > b.half - 0.15 ? 1.05 : 0.05);
  };
  return {
    top(x, z) {
      let top = -Infinity;
      for (let i = 0; i < specs.length; i++) {
        const bb = boxes[i];
        if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
        const s = specs[i];
        if (!active(s.id)) continue;
        probe(s, x, z, tmp);
        const t = Math.max(tmp.deck, tmp.ras, browTop(s, x, z));
        if (t > top) top = t;
      }
      return top;
    },
    deckTop(x, z) {
      let top = -Infinity;
      for (let i = 0; i < specs.length; i++) {
        const bb = boxes[i];
        if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
        const s = specs[i];
        if (!active(s.id)) continue;
        probe(s, x, z, tmp);
        if (tmp.deck === -Infinity) continue;
        // clear deck: nothing drawn above it (or only a little: deck fittings, the helipad's markings)
        const ras = tmp.ras;
        if (ras > tmp.deck + DECK_CLEAR_M) continue;
        const t = Math.max(tmp.deck, ras);
        if (t > top) top = t;
      }
      return top;
    },
    setRaster(id, grid) {
      raster.set(id, grid);
    },
  };
}

/** Deck lights of a berthed ship (body frame): floodlights along both deck edges, two masthead lights. */
export function deckLightPoints(s: BerthedShipSpec): { x: number; y: number; z: number; masthead: boolean }[] {
  const out: { x: number; y: number; z: number; masthead: boolean }[] = [];
  const L = s.size.sternZ - s.size.bowZ;
  const n = Math.max(3, Math.round(L / 24));
  for (let k = 0; k <= n; k++) {
    const bz = s.size.bowZ + 6 + ((L - 12) * k) / n;
    const st = stationAt(s.config.aircraft.watercraft!.hull.stations, bz);
    for (const side of [-1, 1]) out.push({ x: side * Math.max(0, st.deckHalf - 1), y: st.deckY + 2.5, z: bz, masthead: false });
  }
  // (a moored ship shows its deck lighting, not its navigation lights; two masthead-height lamps fore and aft)
  const fb = s.size.freeboardM;
  out.push({ x: 0, y: fb + 30, z: s.size.bowZ + L * 0.3, masthead: true }, { x: 0, y: fb + 22, z: s.size.bowZ + L * 0.72, masthead: true });
  return out;
}

/** The pier gap the ship lies off (m), for QA. */
export const berthGap = (id: BerthId): number => (id === 'naval' ? PORT_DIMS.navalGap : id === 'cruise' ? PORT_DIMS.cruiseGap : 0.45);
