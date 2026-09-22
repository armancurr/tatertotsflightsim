/**
 * Runway geometry from config.world.airport.runway — the one place both the
 * physics (spawn, landing classification) and the world (terrain flattening,
 * markings, lights) get the runway from. Pure.
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
}

export function runwayFrame(cfg: Config = CONFIG): RunwayFrame {
  const ap = cfg.world.airport;
  const rw = ap.runway;
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
    elevation: ap.elevation,
  };
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
  const c = toRunwayCoords(x, z, rw);
  return c.along >= 0 && c.along <= rw.length && Math.abs(c.across) <= rw.halfWidth;
}
