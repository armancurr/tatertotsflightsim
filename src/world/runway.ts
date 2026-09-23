/**
 * Runway geometry from config.world.airport.runway (36/18, the default for
 * spawn and reset) and config.world.airport.runways (every runway, incl. the
 * crossing 03/21) — the one place both the physics (spawn, landing
 * classification) and the world (terrain flattening, landcover, markings,
 * lights) get the runways from. Pure.
 */
import { CONFIG, type Config } from '../config';

export interface RunwayFrame {
  center: { x: number; z: number };
  /** Unit vector (x, z) pointing along the runway in the direction of runway 36 travel. */
  dir: { x: number; z: number };
  /** Unit vector (x, z) to the right of the centreline when facing `dir`. */
  right: { x: number; z: number };
  /** Start of runway 36 (the end you take off from heading 36). */
  threshold: { x: number; z: number };
  /** Opposite end (threshold of 18). */
  farEnd: { x: number; z: number };
  length: number;
  width: number;
  halfLength: number;
  halfWidth: number;
  headingDeg: number;
  elevation: number;
  /** Runway name, e.g. '36/18'. */
  name: string;
}

export interface RunwaySpec {
  center: { x: number; z: number };
  headingDeg: number;
  length: number;
  width: number;
  name: string;
}

export function runwayFrame(cfg: Config = CONFIG): RunwayFrame {
  return frameOf(cfg.world.airport.runway, cfg.world.airport.elevation);
}

/** Frame of a runway spec: `dir` points along `headingDeg` (the first-named end's take-off direction). */
export function frameOf(rw: RunwaySpec, elevation: number): RunwayFrame {
  const h = (rw.headingDeg * Math.PI) / 180;
  const dir = { x: Math.sin(h), z: -Math.cos(h) };
  const right = { x: Math.cos(h), z: Math.sin(h) };
  const halfLength = rw.length / 2;
  return {
    center: { x: rw.center.x, z: rw.center.z },
    dir,
    right,
    threshold: { x: rw.center.x - dir.x * halfLength, z: rw.center.z - dir.z * halfLength },
    farEnd: { x: rw.center.x + dir.x * halfLength, z: rw.center.z + dir.z * halfLength },
    length: rw.length,
    width: rw.width,
    halfLength,
    halfWidth: rw.width / 2,
    headingDeg: rw.headingDeg,
    elevation,
    name: rw.name,
  };
}

const framesCache = new WeakMap<Config, RunwayFrame[]>();
/** Every runway: `runway` (36/18) first, then the others of `runways` (deduped by name). */
export function runwayFrames(cfg: Config = CONFIG): RunwayFrame[] {
  const hit = framesCache.get(cfg);
  if (hit) return hit;
  const ap = cfg.world.airport;
  const main = runwayFrame(cfg);
  const list: readonly RunwaySpec[] = (ap as { runways?: readonly RunwaySpec[] }).runways ?? [];
  const out = [main, ...list.filter((r) => r.name !== main.name).map((r) => frameOf(r, ap.elevation))];
  framesCache.set(cfg, out);
  return out;
}

/** The two designators of a runway frame: [threshold end, far end], e.g. ['36', '18'], ['3', '21']. */
export function endDesignators(rw: RunwayFrame): [string, string] {
  return [designatorOf(rw.headingDeg), designatorOf(rw.headingDeg + 180)];
}

/** Runway designator for a heading: tens of degrees, 36 for north, no leading zero. */
export function designatorOf(headingDeg: number): string {
  const micro = Math.round((((headingDeg % 360) + 360) % 360) * 1e6); // integer micro-degrees
  let n = Math.floor((micro + 5_000_000) / 10_000_000) % 36;
  if (n === 0) n = 36;
  return String(n);
}

/** The frame of the same runway seen from its other end (threshold ↔ far end, heading + 180°). */
export function reversedFrame(rw: RunwayFrame): RunwayFrame {
  return frameOf({ center: rw.center, headingDeg: (rw.headingDeg + 180) % 360, length: rw.length, width: rw.width, name: rw.name }, rw.elevation);
}

export interface RunwayEnd {
  designator: string;
  /** Departure frame: threshold at this end, `dir` pointing down the runway. */
  frame: RunwayFrame;
}

/** All runway ends (36, 18, 3, 21 …) with their departure frames. */
export function runwayEnds(cfg: Config = CONFIG): RunwayEnd[] {
  const out: RunwayEnd[] = [];
  for (const rw of runwayFrames(cfg)) {
    const [d0, d1] = endDesignators(rw);
    out.push({ designator: d0, frame: rw }, { designator: d1, frame: reversedFrame(rw) });
  }
  return out;
}

/** Departure frame of a runway end by designator ('36', '3' or '03', '21' …), or null. */
export function runwayEndFrame(designator: string | null | undefined, cfg: Config = CONFIG): RunwayFrame | null {
  if (!designator) return null;
  const n = Number(designator.replace(/[LRC]$/i, ''));
  if (!Number.isFinite(n)) return null;
  const e = runwayEnds(cfg).find((r) => Number(r.designator) === n);
  return e ? e.frame : null;
}

/** Point where the centrelines of two runways cross (null if parallel or outside either runway). */
export function runwayCrossing(a: RunwayFrame, b: RunwayFrame): { x: number; z: number } | null {
  const den = a.dir.x * b.dir.z - a.dir.z * b.dir.x;
  if (Math.abs(den) < 1e-9) return null;
  const dx = b.threshold.x - a.threshold.x;
  const dz = b.threshold.z - a.threshold.z;
  const t = (dx * b.dir.z - dz * b.dir.x) / den;
  const u = (dx * a.dir.z - dz * a.dir.x) / den;
  if (t < 0 || t > a.length || u < 0 || u > b.length) return null;
  return { x: a.threshold.x + a.dir.x * t, z: a.threshold.z + a.dir.z * t };
}

/** The runway whose pavement contains (x, z) (the first listed wins at an intersection), or null. */
export function runwayAt(x: number, z: number, cfg: Config = CONFIG): RunwayFrame | null {
  for (const rw of runwayFrames(cfg)) if (isOnRunway(x, z, rw)) return rw;
  return null;
}

/** True on the pavement of any runway. */
export function isOnAnyRunway(x: number, z: number, cfg: Config = CONFIG): boolean {
  return runwayAt(x, z, cfg) !== null;
}

const DEFAULT = runwayFrame();

/**
 * World x,z → runway coordinates: `along` = metres past the runway-36 threshold
 * (0 at the threshold, `length` at the far end), `across` = metres right of the
 * centreline when facing runway 36.
 */
export function toRunwayCoords(x: number, z: number, rw: RunwayFrame = DEFAULT): { along: number; across: number } {
  const dx = x - rw.threshold.x;
  const dz = z - rw.threshold.z;
  return { along: dx * rw.dir.x + dz * rw.dir.z, across: dx * rw.right.x + dz * rw.right.z };
}

export function fromRunwayCoords(along: number, across: number, rw: RunwayFrame = DEFAULT): { x: number; z: number } {
  return {
    x: rw.threshold.x + rw.dir.x * along + rw.right.x * across,
    z: rw.threshold.z + rw.dir.z * along + rw.right.z * across,
  };
}

export function isOnRunway(x: number, z: number, rw: RunwayFrame = DEFAULT): boolean {
  // a micrometre of tolerance so points exactly on an edge don't flip with rounding
  const c = toRunwayCoords(x, z, rw);
  return c.along >= -1e-6 && c.along <= rw.length + 1e-6 && Math.abs(c.across) <= rw.halfWidth + 1e-6;
}
