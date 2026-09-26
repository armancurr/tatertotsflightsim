/**
 * Aids to navigation (PURE, no three.js): the lighthouse on Gull Island, the harbour lights on the
 * marina's breakwater heads, and the lit buoys (IALA region A, as in Europe) — lateral marks along
 * the approaches to the marina entrance, the cruise terminal and the naval pier (red cans to port,
 * green cones to starboard entering from seaward), a safe-water mark at the fairway, and cardinal
 * marks round the islands' shoals. Also their light characters and their physics obstacles.
 *
 * Light characters are written the way a chart writes them ('Fl(2) W 10s', 'Q(6)+LFl W 15s') and
 * parsed into on-intervals over one period: `lightOn(ch, t)` says whether the light shows at time t.
 * The lighthouse is a rotating optic: two beam panels 54° apart turn once every 10 s, so an observer
 * anywhere sees two flashes 1.5 s apart every 10 s — Fl(2) W 10s — from `lighthouseIntensity`.
 *
 * Everything is placed from the layout (the marina frame, the piers in layout.ts, the islands and
 * the heightfield), deterministic, clear of the traffic routes (tests/world/harbour/navaids.test.ts).
 */
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getHeightfield } from '../heightfield';
import { createMarina, toWorld, type WaterWorld, type XZ } from '../traffic/sea';
import { portWorks, pierWorld, BERTH_LIMITS, PORT_DIMS, type PortWorks } from './layout';

// ─── Light characters ────────────────────────────────────────────────────────────────────────────

export type LightColor = 'R' | 'G' | 'W' | 'Y';

export interface LightCharacter {
  /** As charted, e.g. 'Fl(2) W 10s'. */
  label: string;
  color: LightColor;
  /** Seconds. */
  period: number;
  /** [start, end) intervals within one period when the light shows, ascending. */
  on: [number, number][];
}

/** Flash lengths (s): a flash, a long flash, quick (60/min) and very quick (120/min) cycles and their flashes. */
export const LIGHT_TIMING = { flash: 0.5, flashGap: 1.0, longFlash: 2.0, quick: 1.0, quickOn: 0.35, veryQuick: 0.5, veryQuickOn: 0.2 } as const;

const CHAR_RE = /^(F|Iso|Oc|LFl|Fl|VQ|Q)(?:\((\d+)\))?(\+LFl)?\s+([RGWY])(?:\s+(\d+(?:\.\d+)?)s)?$/;

/** Parses a charted light character ('Fl R 4s', 'Fl(2) W 10s', 'LFl W 10s', 'Q W', 'Q(3) W 10s', 'Q(6)+LFl W 15s', 'Iso W 4s', 'Oc R 6s', 'F G'). */
export function parseLight(label: string): LightCharacter {
  const m = CHAR_RE.exec(label.trim());
  if (!m) throw new Error(`unknown light character: ${label}`);
  const [, kind, groupS, plusLfl, color] = m;
  const group = groupS ? Number(groupS) : 1;
  const T = LIGHT_TIMING;
  let period = m[5] ? Number(m[5]) : 0;
  const on: [number, number][] = [];
  switch (kind) {
    case 'F':
      period = period || 1;
      on.push([0, period]);
      break;
    case 'Iso':
      on.push([0, period / 2]);
      break;
    case 'Oc':
      // occulting: light longer than dark; one eclipse of a quarter period (≥ 1 s)
      on.push([0, period - Math.max(1, period / 4)]);
      break;
    case 'Fl':
    case 'LFl': {
      const len = kind === 'LFl' ? T.longFlash : T.flash;
      for (let k = 0; k < group; k++) on.push([k * (len + T.flashGap), k * (len + T.flashGap) + len]);
      break;
    }
    case 'Q':
    case 'VQ': {
      const cyc = kind === 'Q' ? T.quick : T.veryQuick;
      const len = kind === 'Q' ? T.quickOn : T.veryQuickOn;
      // continuous quick when no group is given
      if (!groupS && !plusLfl) {
        period = cyc;
        on.push([0, len]);
        break;
      }
      for (let k = 0; k < group; k++) on.push([k * cyc, k * cyc + len]);
      if (plusLfl) on.push([group * cyc, group * cyc + T.longFlash]);
      break;
    }
  }
  if (!(period > 0) || on[on.length - 1][1] > period + 1e-9) throw new Error(`light character too long for its period: ${label}`);
  return { label, color: color as LightColor, period, on };
}

/** Does the light show at time t (s)? `phase` shifts it (buoys are not synchronised). */
export function lightOn(ch: LightCharacter, t: number, phase = 0): boolean {
  const p = ch.period;
  const x = ((((t + phase) % p) + p) % p);
  for (const [a, b] of ch.on) if (x >= a && x < b) return true;
  return false;
}

// ─── Lighthouse ─────────────────────────────────────────────────────────────────────────────────

export interface Lighthouse {
  name: string;
  x: number;
  z: number;
  /** Ground under the tower (m MSL) and the tower's height to the lantern gallery (m). */
  groundY: number;
  towerH: number;
  /** Height of the light (the focal plane), m MSL. */
  focalY: number;
  character: LightCharacter;
  /** Rotation period of the optic (s) and the beam panels' azimuth offsets (deg, behind the leading beam). */
  rotationS: number;
  beams: number[];
  /** Angular half-width (Gaussian σ, deg) of a beam as seen by an observer. */
  sigmaDeg: number;
  /** The keeper's house: its floor (m MSL) on the ground beside the tower. */
  houseY: number;
  /** Nominal range (m): how far the light is seen. */
  rangeM: number;
}

/** The lighthouse tower's dimensions (shared by the model and the obstacle). */
export const LIGHTHOUSE_DIMS = { baseR: 3.6, topR: 2.5, towerH: 21, galleryR: 3.3, lanternR: 1.9, lanternH: 3.2, domeH: 1.5, focalAboveGallery: 1.7, house: { dx: 9, dz: 0, len: 11, wid: 7, h: 5.2 } } as const;

/** Azimuth (deg, clockwise from north) of the leading beam at time t: the optic turns clockwise. */
export function lighthouseBeamAzimuth(lh: Lighthouse, t: number): number {
  return ((((t / lh.rotationS) * 360) % 360) + 360) % 360;
}

const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;

/** How bright the light looks (0..1) from bearing `bearingDeg` (from the lighthouse to the observer) at time t. */
export function lighthouseIntensity(lh: Lighthouse, t: number, bearingDeg: number): number {
  const lead = lighthouseBeamAzimuth(lh, t);
  let s = 0;
  for (const off of lh.beams) {
    const d = wrap180(bearingDeg - (lead - off)) / lh.sigmaDeg;
    s += Math.exp(-d * d);
  }
  // the lantern glows a little between the flashes
  return Math.min(1, 0.04 + s);
}

// ─── Buoys ──────────────────────────────────────────────────────────────────────────────────────

export type BuoyKind = 'port' | 'starboard' | 'safe' | 'north' | 'east' | 'south' | 'west';

export interface Buoy {
  id: string;
  kind: BuoyKind;
  x: number;
  z: number;
  character: LightCharacter;
  /** Seconds added to the clock (unsynchronised lights). */
  phase: number;
  /** The channel a lateral mark belongs to, or the hazard a cardinal marks. */
  group: string;
}

/** A buoy's dimensions (shared by the model and the obstacle), m above the waterline. */
export const BUOY_DIMS = { floatR: 1.15, floatTop: 0.75, draft: 1.3, towerTop: 3.3, topmarkTop: 4.5, lampY: 3.55 } as const;

/** A channel: its inbound direction (from seaward `from` to `to`), its half width and where its buoy pairs are (fractions from `from`). */
export interface Channel {
  id: 'marina' | 'cruise' | 'naval';
  from: XZ;
  to: XZ;
  halfWidth: number;
  pairs: number[];
  portLight: string;
  starboardLight: string;
}

export interface HarbourLight {
  id: string;
  x: number;
  y: number;
  z: number;
  character: LightCharacter;
  phase: number;
}

export interface Navaids {
  lighthouse: Lighthouse;
  harbourLights: HarbourLight[];
  channels: Channel[];
  buoys: Buoy[];
}

/** Which side of a channel (entering from seaward) a point lies on: +1 = starboard, −1 = port. */
export function channelSide(ch: Channel, x: number, z: number): number {
  const dx = ch.to.x - ch.from.x;
  const dz = ch.to.z - ch.from.z;
  // facing along d, starboard is (−dz, dx)
  return Math.sign((x - ch.from.x) * -dz + (z - ch.from.z) * dx);
}

function defaultWater(): WaterWorld {
  const hf = getHeightfield();
  return { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) };
}

const depthAt = (w: WaterWorld, x: number, z: number): number => {
  const wl = w.waterLevel(x, z);
  if (wl === null || Math.abs(wl) > 0.5) return -Infinity;
  return wl - w.groundHeight(x, z);
};

/** The island's summit (highest ground within 0.6 of its radius, 10 m grid). */
function summit(water: WaterWorld, cx: number, cz: number, r: number): { x: number; z: number; y: number } {
  let best = { x: cx, z: cz, y: -Infinity };
  for (let dz = -r; dz <= r; dz += 10)
    for (let dx = -r; dx <= r; dx += 10) {
      if (dx * dx + dz * dz > r * r) continue;
      const y = water.groundHeight(cx + dx, cz + dz);
      if (y > best.y) best = { x: cx + dx, z: cz + dz, y };
    }
  return best;
}

/** Marches out from an island along a bearing until the water is `depth` deep, then `beyond` m further. */
function offShoal(water: WaterWorld, cx: number, cz: number, r0: number, bearingDeg: number, depth: number, beyond: number): XZ {
  const b = (bearingDeg * Math.PI) / 180;
  const fx = Math.sin(b);
  const fz = -Math.cos(b);
  // the first spot where the water is `depth` deep there and stays so for `beyond` m further out
  let r = r0;
  const deep = (d: number) => depthAt(water, cx + fx * d, cz + fz * d) >= depth;
  for (; r < r0 + 4000; r += 10) {
    let ok = true;
    for (let s = 0; s <= beyond + 60 && ok; s += 15) ok = deep(r + s);
    if (ok) break;
  }
  r += beyond;
  return { x: cx + fx * r, z: cz + fz * r };
}

const CARDINAL_LIGHT: Record<'north' | 'east' | 'south' | 'west', string> = { north: 'Q W', east: 'Q(3) W 10s', south: 'Q(6)+LFl W 15s', west: 'Q(9) W 15s' };
const CARDINAL_BEARING = { north: 0, east: 90, south: 180, west: 270 } as const;
/** Which cardinal marks each island gets (the others would stand in the way of other work or in nobody's way). */
const ISLAND_MARKS: Record<string, ('north' | 'east' | 'south' | 'west')[]> = {
  'Gull Island': ['north', 'east', 'south', 'west'],
  'Seal Rock': ['north', 'east', 'south'],
  'Long Key': ['north', 'east'],
};

/** Builds every aid to navigation (see the file header). */
export function buildNavaids(layout: WorldLayout, cfg: Config, water: WaterWorld, works: PortWorks = portWorks(layout, cfg, water)): Navaids {
  const m = createMarina(layout, cfg);
  // ── lighthouse on Gull Island's summit ──
  const gull = layout.islands.find((i) => i.name === 'Gull Island') ?? layout.islands[0];
  const top = summit(water, gull.x, gull.z, gull.radius * 0.6);
  const LD = LIGHTHOUSE_DIMS;
  // the tower stands on the lowest ground under its base (sunk a little into the slope)
  let g = top.y;
  for (let a = 0; a < 8; a++) g = Math.min(g, water.groundHeight(top.x + LD.baseR * Math.cos((a * Math.PI) / 4), top.z + LD.baseR * Math.sin((a * Math.PI) / 4)));
  const hs = LD.house;
  let houseY = Infinity;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) houseY = Math.min(houseY, water.groundHeight(top.x + hs.dx + (dx * hs.len) / 2, top.z + hs.dz + (dz * hs.wid) / 2));
  const lighthouse: Lighthouse = {
    name: `${gull.name} lighthouse`,
    x: top.x,
    z: top.z,
    groundY: g - 0.3,
    towerH: LD.towerH,
    focalY: g - 0.3 + LD.towerH + LD.focalAboveGallery,
    character: parseLight('Fl(2) W 10s'),
    rotationS: 10,
    beams: [0, 54],
    sigmaDeg: 6.5,
    houseY: houseY - 0.3,
    rangeM: 40000,
  };
  // ── harbour lights on the breakwater heads (the marina's drawn beacons: red to port entering) ──
  const harbourLights: HarbourLight[] = m.beacons.map((b) => {
    const p = toWorld(m.frame, b.u, b.w);
    const red = b.color === 'red';
    return { id: `marina-${b.color}`, x: p.x, y: 9.0, z: p.z, character: parseLight(red ? 'Fl R 4s' : 'Fl G 4s'), phase: red ? 0 : 2 };
  });
  // ── channels ──
  const axis = (w: number) => toWorld(m.frame, 0.25 * (w - m.entrance.w), w);
  const c = works.cruise;
  const shipLine = c.pier.w1 + PORT_DIMS.cruiseGap + BERTH_LIMITS.cruise.beam / 2;
  const n = works.naval;
  const nTo = { u: n.head.u1 + PORT_DIMS.navalGap + BERTH_LIMITS.naval.beam + 130, w: 0 };
  const channels: Channel[] = [
    { id: 'marina', from: axis(1150), to: axis(420), halfWidth: 110, pairs: [(1150 - 700) / 730, (1150 - 470) / 730], portLight: 'Fl R 3s', starboardLight: 'Fl G 3s' },
    {
      id: 'cruise',
      from: pierWorld(c.frame, c.pier.u1 + 1000, shipLine),
      to: pierWorld(c.frame, c.pier.u1 + 100, shipLine),
      halfWidth: 150,
      pairs: [0.12, 0.58, 0.9],
      portLight: 'Fl(2) R 6s',
      starboardLight: 'Fl(2) G 6s',
    },
    {
      id: 'naval',
      from: pierWorld(n.frame, nTo.u + 700, nTo.w - 450),
      to: pierWorld(n.frame, nTo.u, nTo.w),
      halfWidth: 140,
      pairs: [0.3, 0.75],
      portLight: 'Fl(3) R 10s',
      starboardLight: 'Fl(3) G 10s',
    },
  ];
  const buoys: Buoy[] = [];
  let k = 0;
  const phaseOf = (i: number) => {
    const x = Math.sin(i * 91.7 + 13.1) * 43758.5453;
    return (x - Math.floor(x)) * 10;
  };
  for (const ch of channels) {
    const dx = ch.to.x - ch.from.x;
    const dz = ch.to.z - ch.from.z;
    const l = Math.hypot(dx, dz);
    // starboard unit normal (entering): (−dz, dx)/l
    const sx = -dz / l;
    const sz = dx / l;
    ch.pairs.forEach((t, j) => {
      const px = ch.from.x + dx * t;
      const pz = ch.from.z + dz * t;
      buoys.push({ id: `${ch.id}-${j + 1}-port`, kind: 'port', x: px - sx * ch.halfWidth, z: pz - sz * ch.halfWidth, character: parseLight(ch.portLight), phase: phaseOf(k++), group: ch.id });
      buoys.push({ id: `${ch.id}-${j + 1}-starboard`, kind: 'starboard', x: px + sx * ch.halfWidth, z: pz + sz * ch.halfWidth, character: parseLight(ch.starboardLight), phase: phaseOf(k++), group: ch.id });
    });
  }
  // ── safe-water mark at the fairway, seaward of the marina channel ──
  const fw = axis(1700);
  buoys.push({ id: 'fairway', kind: 'safe', x: fw.x, z: fw.z, character: parseLight('LFl W 10s'), phase: phaseOf(k++), group: 'fairway' });
  // ── cardinal marks round the islands' shoals (6 m of water, then 150 m further) ──
  for (const isl of layout.islands) {
    for (const kind of ISLAND_MARKS[isl.name] ?? []) {
      const p = offShoal(water, isl.x, isl.z, isl.radius * 0.8, CARDINAL_BEARING[kind], 6, 150);
      buoys.push({ id: `${isl.name.toLowerCase().replace(/\s+/g, '-')}-${kind}`, kind, x: p.x, z: p.z, character: parseLight(CARDINAL_LIGHT[kind]), phase: phaseOf(k++), group: isl.name });
    }
  }
  return { lighthouse, harbourLights, channels, buoys };
}

const cache = new WeakMap<WorldLayout, WeakMap<Config, Navaids>>();

/** Every aid to navigation for the default world (cached per layout + config). */
export function navaids(layout: WorldLayout = getLayout(), cfg: Config = CONFIG): Navaids {
  let byCfg = cache.get(layout);
  if (!byCfg) cache.set(layout, (byCfg = new WeakMap()));
  let n = byCfg.get(cfg);
  if (!n) {
    n = buildNavaids(layout, cfg, defaultWater(), portWorks(layout, cfg));
    byCfg.set(cfg, n);
  }
  return n;
}

// ─── Obstacles ──────────────────────────────────────────────────────────────────────────────────

export interface NavaidObstacles {
  top(x: number, z: number): number;
}

const HASH = 200;

/** The buoys (a disc each: float, tower and topmark) and the lighthouse (tower, keeper's house) as obstacle columns. */
export function navaidObstacles(n: Navaids): NavaidObstacles {
  const cells = new Map<number, number[]>();
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  const R = BUOY_DIMS.floatR;
  n.buoys.forEach((b, idx) => {
    for (let i = Math.floor((b.x - R) / HASH); i <= Math.floor((b.x + R) / HASH); i++)
      for (let j = Math.floor((b.z - R) / HASH); j <= Math.floor((b.z + R) / HASH); j++) {
        const k = key(i, j);
        const l = cells.get(k);
        if (l) l.push(idx);
        else cells.set(k, [idx]);
      }
  });
  const lh = n.lighthouse;
  const LD = LIGHTHOUSE_DIMS;
  const towerTop = lh.groundY + LD.towerH + LD.lanternH + LD.domeH + 0.9;
  const hs = LD.house;
  return {
    top(x, z) {
      let top = -Infinity;
      const l = cells.get(key(Math.floor(x / HASH), Math.floor(z / HASH)));
      if (l) {
        for (const idx of l) {
          const b = n.buoys[idx];
          const dx = x - b.x;
          const dz = z - b.z;
          if (dx * dx + dz * dz <= R * R) top = Math.max(top, BUOY_DIMS.topmarkTop);
        }
      }
      const dx = x - lh.x;
      const dz = z - lh.z;
      if (Math.abs(dx) < 20 && Math.abs(dz) < 20) {
        const r2 = dx * dx + dz * dz;
        if (r2 <= LD.baseR * LD.baseR) top = Math.max(top, towerTop);
        else if (r2 <= (LD.baseR + 0.9) * (LD.baseR + 0.9)) top = Math.max(top, lh.groundY + 0.6);
        if (Math.abs(dx - hs.dx) <= hs.len / 2 + 0.3 && Math.abs(dz - hs.dz) <= hs.wid / 2 + 0.3) top = Math.max(top, lh.houseY + hs.h + 1.6);
      }
      return top;
    },
  };
}
