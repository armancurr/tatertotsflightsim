/**
 * Buildings → GPU instance records. PURE (no three.js); runs in the towns worker.
 *
 * Each building becomes one or more records of INST_STRIDE floats (layout `I`
 * in archetypes.ts) in the set of its near archetype — a setback tower is a
 * base + an inset upper tier; flat roofs get rooftop units, water tanks,
 * penthouses and masts — plus one or more records in the mid-distance set
 * (walls + hip prism). Every set is grouped by square chunks (chunk order =
 * sorted (j, i)), `start[c]…start[c+1]` being chunk c's range, so the
 * renderer can draw the chunks near the camera by copying contiguous ranges.
 * Decoration flags (chimneys, dormers, balconies, shutters…) are chosen
 * deterministically from the building's `rand`.
 */
import { mulberry32 } from '../noise';
import { STYLE, type Building } from './placement';
import { FLAG, I, INST_STRIDE, NEAR_KINDS, DORMER_MIN_RISE, type NearKind } from './archetypes';

export { INST_STRIDE } from './archetypes';

/** Extra facade styles for derived pieces (continuing placement's STYLE ids). */
export const STYLE_X = { hvac: 9, tank: 10, mast: 11, plain: 12 } as const;

const DEG = Math.PI / 180;

export interface InstanceInput {
  b: Building;
  chunk: number;
  /** Index of the building this piece belongs to. */
  parent?: number;
  /** 0 = the building itself, 1 = upper tier, 2 = rooftop piece. */
  piece?: number;
}

export interface InstanceSet {
  data: Float32Array;
  /** Per-chunk start offsets (in instances), length chunkCount + 1. */
  start: Int32Array;
}

export interface InstanceSets {
  chunkSize: number;
  chunkCount: number;
  /** (i, j) per chunk. */
  chunkIJ: Int32Array;
  /** min x, y, z, max x, y, z per chunk (everything drawn in it, near or mid). */
  chunkBox: Float32Array;
  near: Record<NearKind, InstanceSet>;
  mid: InstanceSet;
}

const isPitched = (b: Building): boolean => b.archetype === 'gable' || b.archetype === 'hip' || b.archetype === 'gambrel';

const reddish = (c: number): boolean => {
  const r = (c >> 16) & 255;
  const g = (c >> 8) & 255;
  return r > 120 && r > g * 1.45;
};

/**
 * Decoration flags for a building. With `allowed`, the set of flags its
 * geometry can carry (what the fuzz tests may switch on); otherwise the ones
 * chosen for it (deterministic in `rand`). Geometric flags (doorPX, cone,
 * flatRoof) are added by writeInstance.
 */
export function instanceFlags(b: Building, allowed = false): number {
  const rot = isPitched(b) && b.ridgeAxis === 1;
  const W = rot ? b.depth : b.width; // local width (along the ridge)
  const house = b.use === 'house' || b.use === 'farmhouse';
  let mask = FLAG.side;
  if ((b.archetype === 'gable' && W >= 4) || (b.archetype === 'hip' && W >= 7 && b.use !== 'steeple')) mask |= FLAG.chimney;
  if (b.archetype === 'gable' && b.roofHeight > DORMER_MIN_RISE && W >= 6) mask |= FLAG.dormers;
  if (b.archetype === 'gambrel') mask |= FLAG.cupola;
  if (b.archetype === 'flat') mask |= FLAG.whiteRoof;
  mask |= FLAG.balcony | FLAG.shopfront | FLAG.glass | FLAG.steeple | FLAG.garage | FLAG.shutters | FLAG.siding | FLAG.ribbon | FLAG.brick | FLAG.blank | FLAG.upper | FLAG.harbour;
  if (allowed) return mask;

  const rnd = mulberry32(Math.floor(b.rand * 4294967296) ^ 0x5bd1e995);
  let f = 0;
  if (rnd() < 0.5) f |= FLAG.side;
  if (house || b.use === 'shop') {
    if (rnd() < (house ? 0.72 : 0.4)) f |= FLAG.chimney;
    if (rnd() < 0.45) f |= FLAG.dormers;
  } else if (b.use === 'apartment' && rnd() < 0.5) f |= FLAG.chimney;
  if (b.use === 'barn' && rnd() < 0.45) f |= FLAG.cupola;
  if (b.use === 'apartment' && rnd() < 0.65) f |= FLAG.balcony;
  if (b.use === 'shop') f |= FLAG.shopfront;
  if (b.style === STYLE.office) f |= FLAG.glass;
  else if ((b.use === 'office' || b.use === 'tower') && rnd() < 0.6) f |= FLAG.ribbon;
  if (b.use === 'steeple') f |= FLAG.steeple;
  if (house) {
    if (reddish(b.wallColor)) f |= FLAG.brick;
    else if (rnd() < 0.3) f |= FLAG.siding;
    if (b.farm < 0 && rnd() < 0.3) f |= FLAG.garage;
    if (rnd() < 0.22) f |= FLAG.shutters;
  } else if ((b.use === 'apartment' || b.use === 'shop') && reddish(b.wallColor)) f |= FLAG.brick;
  if (b.archetype === 'flat' && rnd() < (b.use === 'warehouse' || b.use === 'industrial' ? 0.55 : 0.3)) f |= FLAG.whiteRoof;
  return f & mask;
}

/** Writes one instance record for building `b` at arr[o…]. Returns the record's local (W, D) axes swap state. */
export function writeInstance(arr: Float32Array, o: number, input: InstanceInput, flagsOverride?: number): void {
  const b = input.b;
  let heading = b.headingDeg * DEG;
  let W = b.width;
  let D = b.depth;
  let flags = flagsOverride ?? instanceFlags(b);
  if (isPitched(b) && b.ridgeAxis === 1) {
    heading += Math.PI / 2;
    W = b.depth;
    D = b.width;
    flags |= FLAG.doorPX;
  }
  if (b.archetype === 'silo' && b.ridge < 0.5) flags |= FLAG.cone;
  if (b.archetype === 'flat') flags |= FLAG.flatRoof;
  heading = ((heading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  arr[o + I.x] = b.x;
  arr[o + I.y] = b.y;
  arr[o + I.z] = b.z;
  arr[o + I.heading] = heading;
  arr[o + I.W] = W;
  arr[o + I.D] = D;
  arr[o + I.Hw] = b.wallHeight;
  arr[o + I.Hr] = b.roofHeight;
  arr[o + I.wall] = b.wallColor;
  arr[o + I.roof] = b.roofColor;
  arr[o + I.rand] = b.rand;
  arr[o + I.style] = b.style;
  arr[o + I.ridge] = b.archetype === 'hip' || b.archetype === 'silo' ? b.ridge : 1;
  arr[o + I.floorH] = b.floorHeight;
  arr[o + I.flags] = flags;
  arr[o + I.plinth] = b.plinth ?? 0;
  arr[o + I.chunk] = input.chunk;
  arr[o + I.aux0] = input.parent ?? 0;
  arr[o + I.aux1] = input.piece ?? 0;
  arr[o + I.aux2] = 0;
}

interface Piece {
  kind: NearKind;
  b: Building;
  flags: number;
  piece: number;
}

/** A piece standing on the roof of `p` at local offset (lx, lz) (frame: x → −width axis, z → front). */
function onRoof(p: Building, deckY: number, lx: number, lz: number, over: Partial<Building>): Building {
  const h = p.headingDeg * DEG;
  const c = Math.cos(h);
  const s = Math.sin(h);
  return {
    ...p,
    x: p.x - c * lx + s * lz,
    z: p.z - s * lx - c * lz,
    y: deckY,
    plinth: 0,
    tierHeight: undefined,
    tierInset: undefined,
    ridge: 1,
    ridgeAxis: 0,
    ...over,
  };
}

/** The near pieces of one building (itself, its upper tier, its rooftop units). */
export function buildingPieces(b: Building): Piece[] {
  const own = instanceFlags(b);
  const out: Piece[] = [];
  const tier = b.archetype === 'flat' && (b.tierHeight ?? 0) > 0 ? b.tierHeight! : 0;
  let top = b; // the building whose roof carries the clutter
  if (tier > 0) {
    const ins = b.tierInset ?? 0;
    out.push({ kind: 'flat', b: { ...b, wallHeight: tier, tierHeight: undefined, tierInset: undefined }, flags: own, piece: 0 });
    top = { ...b, width: b.width - 2 * ins, depth: b.depth - 2 * ins, tierHeight: undefined, tierInset: undefined };
    out.push({ kind: 'flat', b: top, flags: own | FLAG.upper, piece: 1 });
  } else out.push({ kind: b.archetype, b, flags: own, piece: 0 });
  if (b.archetype !== 'flat') return out;

  // ── rooftop clutter on the (top) deck ──
  const rnd = mulberry32(Math.floor(b.rand * 4294967296) ^ 0x2c1b3c6d);
  const deck = top.y + top.wallHeight;
  const inner = (w: number, d: number) => ({ hw: top.width / 2 - 0.5 - w / 2, hd: top.depth / 2 - 0.5 - d / 2 });
  const place = (w: number, d: number): [number, number] | null => {
    const r = inner(w, d);
    if (r.hw <= 0 || r.hd <= 0) return null;
    return [(rnd() * 2 - 1) * r.hw, (rnd() * 2 - 1) * r.hd];
  };
  const blank = FLAG.blank | FLAG.upper | FLAG.flatRoof;
  const area = top.width * top.depth;
  const big = b.use === 'tower' || b.use === 'office';
  const grey = [0x9ea3a6, 0xb7babb, 0x8d9295, 0xc5c7c6];
  // penthouse / lift overrun on towers and offices
  if (big && area > 200) {
    const w = top.width * (0.3 + rnd() * 0.2);
    const d = top.depth * (0.3 + rnd() * 0.15);
    const at = place(w, d);
    if (at) {
      const pb = onRoof(top, deck, at[0] * 0.4, at[1] * 0.4, { width: w, depth: d, wallHeight: 3.5 + rnd() * 2, roofHeight: 0.5, style: STYLE_X.plain, floorHeight: 0 });
      out.push({ kind: 'flat', b: pb, flags: blank, piece: 2 });
    }
    // a mast on some towers
    if (b.use === 'tower' && rnd() < 0.3) {
      const at2 = place(1, 1);
      if (at2) out.push({ kind: 'flat', b: onRoof(top, deck, at2[0] * 0.2, at2[1] * 0.2, { width: 0.9, depth: 0.9, wallHeight: 10 + rnd() * 16, roofHeight: 0.1, style: STYLE_X.mast, floorHeight: 0 }), flags: blank, piece: 2 });
    }
  }
  // HVAC units
  const industrial = b.use === 'warehouse' || b.use === 'industrial';
  const nUnits = industrial ? 2 + Math.floor(rnd() * 5) : big ? 1 + Math.floor(rnd() * 4) : Math.floor(rnd() * 3);
  for (let k = 0; k < nUnits; k++) {
    const w = 1.8 + rnd() * 2.6;
    const d = 1.4 + rnd() * 1.6;
    const at = place(w, d);
    if (!at) continue;
    const ub = onRoof(top, deck, at[0], at[1], { width: w, depth: d, wallHeight: 1.1 + rnd() * 1.1, roofHeight: 0.08, style: STYLE_X.hvac, floorHeight: 0, wallColor: grey[Math.floor(rnd() * grey.length)] });
    out.push({ kind: 'flat', b: ub, flags: blank, piece: 2 });
  }
  // wooden/steel water tanks on older apartment blocks and offices
  if ((b.use === 'apartment' || (big && b.style !== STYLE.office)) && rnd() < 0.3) {
    const dia = 3 + rnd() * 1.6;
    const at = place(dia, dia);
    if (at) {
      const tb = onRoof(top, deck, at[0], at[1], { width: dia, depth: dia, wallHeight: 3.2 + rnd() * 1.4, roofHeight: 0.9, archetype: 'silo', ridge: 0, style: STYLE_X.tank, floorHeight: 0, wallColor: rnd() < 0.6 ? 0x6e5a44 : 0x8f969a, roofColor: 0x3d3a36 });
      out.push({ kind: 'silo', b: tb, flags: FLAG.cone | FLAG.upper, piece: 2 });
    }
  }
  return out;
}

/** The mid-distance record(s): flat roofs fold the parapet into the walls, silos become boxes. */
function midPieces(pieces: Piece[]): { b: Building; flags: number }[] {
  const out: { b: Building; flags: number }[] = [];
  for (const p of pieces) {
    const b = p.b;
    if (p.piece === 2 && b.style !== STYLE_X.plain && b.style !== STYLE_X.mast) continue; // small rooftop units: near only
    const flags = p.flags & ~(FLAG.chimney | FLAG.dormers | FLAG.cupola);
    if (b.archetype === 'flat') out.push({ b: { ...b, wallHeight: b.wallHeight + b.roofHeight, roofHeight: 0, ridge: 1 }, flags });
    else if (b.archetype === 'silo') out.push({ b: { ...b, archetype: 'flat', wallHeight: b.wallHeight + 0.5 * b.roofHeight, roofHeight: 0, ridge: 1 }, flags: flags & ~FLAG.cone });
    else if (b.archetype === 'gambrel') out.push({ b: { ...b, archetype: 'gable', ridge: 1 }, flags });
    else out.push({ b, flags });
  }
  return out;
}

/** Groups everything by chunk and writes the instance arrays. */
export function buildInstances(buildings: readonly Building[], chunkSize: number): InstanceSets {
  // chunk of each building, chunks sorted by (j, i)
  const keyOf = new Map<string, { i: number; j: number; list: number[] }>();
  buildings.forEach((b, idx) => {
    const i = Math.floor(b.x / chunkSize);
    const j = Math.floor(b.z / chunkSize);
    const k = `${i},${j}`;
    let c = keyOf.get(k);
    if (!c) keyOf.set(k, (c = { i, j, list: [] }));
    c.list.push(idx);
  });
  const chunks = [...keyOf.values()].sort((a, b) => a.j - b.j || a.i - b.i);
  const chunkCount = chunks.length;
  const chunkIJ = new Int32Array(chunkCount * 2);
  const chunkBox = new Float32Array(chunkCount * 6);
  const nearLists: Record<NearKind, InstanceInput[][]> = { gable: [], hip: [], flat: [], gambrel: [], silo: [] };
  const nearFlags: Record<NearKind, number[][]> = { gable: [], hip: [], flat: [], gambrel: [], silo: [] };
  const midList: InstanceInput[][] = [];
  const midFlags: number[][] = [];
  chunks.forEach((c, ci) => {
    chunkIJ[ci * 2] = c.i;
    chunkIJ[ci * 2 + 1] = c.j;
    for (const k of NEAR_KINDS) {
      nearLists[k].push([]);
      nearFlags[k].push([]);
    }
    midList.push([]);
    midFlags.push([]);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const idx of c.list) {
      const b = buildings[idx];
      const pieces = buildingPieces(b);
      for (const p of pieces) {
        nearLists[p.kind][ci].push({ b: p.b, chunk: ci, parent: idx, piece: p.piece });
        nearFlags[p.kind][ci].push(p.flags);
        // bounds: circumscribed circle + overhang allowance, base to top + chimney/cupola allowance
        const r = Math.hypot(p.b.width, p.b.depth) / 2 + 1;
        x0 = Math.min(x0, p.b.x - r);
        x1 = Math.max(x1, p.b.x + r);
        z0 = Math.min(z0, p.b.z - r);
        z1 = Math.max(z1, p.b.z + r);
        y0 = Math.min(y0, p.b.y - 0.1);
        y1 = Math.max(y1, p.b.y + p.b.wallHeight + p.b.roofHeight + 3);
      }
      for (const m of midPieces(pieces)) {
        midList[ci].push({ b: m.b, chunk: ci, parent: idx, piece: 0 });
        midFlags[ci].push(m.flags);
      }
    }
    chunkBox.set([x0, y0, z0, x1, y1, z1], ci * 6);
  });
  const pack = (lists: InstanceInput[][], flags?: number[][]): InstanceSet => {
    let n = 0;
    for (const l of lists) n += l.length;
    const data = new Float32Array(n * INST_STRIDE);
    const start = new Int32Array(lists.length + 1);
    let k = 0;
    lists.forEach((l, ci) => {
      start[ci] = k;
      l.forEach((inp, li) => {
        writeInstance(data, k * INST_STRIDE, inp, flags ? flags[ci][li] : undefined);
        k++;
      });
    });
    start[lists.length] = k;
    return { data, start };
  };
  const near = {} as Record<NearKind, InstanceSet>;
  for (const k of NEAR_KINDS) near[k] = pack(nearLists[k], nearFlags[k]);
  return { chunkSize, chunkCount, chunkIJ, chunkBox, near, mid: pack(midList, midFlags) };
}
