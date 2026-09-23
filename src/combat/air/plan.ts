/**
 * Where the enemy aircraft fly (PURE, deterministic from a seed): two MiG-29 pairs on racetrack
 * CAPs around the range, a Su-25 pair making attack passes at it (run in from an IP, descend,
 * pull off short of the range, climb back round the pattern), and a Mi-24 pair circling low
 * near it. Every path is kept clear of the airport circuit and high enough over the terrain.
 */
import { CONFIG, FT_TO_M } from '../../config';
import { createRng } from '../rng';
import type { AirKind } from '../types';
import { G } from './flight';
import { circlePath, racetrack, samplePath, newPathSample, type FlightPath } from './paths';

const DEG = Math.PI / 180;
type AirCfg = typeof CONFIG.combat.air;

export interface SlotPlan {
  kind: AirKind;
  group: string;
  path: FlightPath;
  /** Along-path start (m). */
  s0: number;
  /** Metres to the right of the path; metres behind the leader. */
  side: number;
  trail: number;
  /** Index of the leader slot, or null. */
  leader: number | null;
  seed: number;
  /** Tactical (bort) number painted on it. */
  bort: number;
}

const dirOf = (deg: number) => ({ x: Math.sin(deg * DEG), z: -Math.cos(deg * DEG) });

/** Smallest distance from any point of the path to (x, z). */
export function pathMinDistance(p: FlightPath, x: number, z: number): number {
  let d = Infinity;
  for (let i = 0; i < p.x.length; i++) d = Math.min(d, Math.hypot(p.x[i] - x, p.z[i] - z));
  return d;
}

/** Highest ground under the path. */
function pathMaxGround(p: FlightPath, ground: (x: number, z: number) => number): number {
  let g = -Infinity;
  for (let i = 0; i < p.x.length; i += 2) g = Math.max(g, ground(p.x[i], p.z[i]));
  return g;
}

/**
 * Plan the slots. `range` = the target range centre; `airport` = the runway centre (the circuit
 * keep-out is around it).
 */
export function planAir(range: { x: number; z: number }, ground: (x: number, z: number) => number, cfg: AirCfg = CONFIG.combat.air, airport = { x: 0, z: 0 }, seed = cfg.seed): SlotPlan[] {
  const rng = createRng(seed);
  const slots: SlotPlan[] = [];
  const keep = cfg.airportKeepOutM + 400;
  /** Move (cx, cz) away from the airport until `make(cx, cz)` clears the keep-out. */
  const clear = (cx: number, cz: number, make: (x: number, z: number) => FlightPath): FlightPath => {
    let x = cx, z = cz;
    let p = make(x, z);
    for (let k = 0; k < 60 && pathMinDistance(p, airport.x, airport.z) < keep; k++) {
      const d = Math.hypot(x - airport.x, z - airport.z) || 1;
      x += ((x - airport.x) / d) * 250;
      z += ((z - airport.z) / d) * 250;
      p = make(x, z);
    }
    return p;
  };
  const bort = () => 10 + Math.floor(rng.next() * 89);

  // ── MiG-29 CAPs ──
  const fs = cfg.flight.fighter;
  cfg.caps.forEach((c, i) => {
    const b = c.bearingDeg + rng.sym(8);
    const dist = c.distanceM * (0.92 + 0.16 * rng.next());
    const d = dirOf(b);
    const axis = c.axisDeg + rng.sym(12);
    const radius = (fs.cruise * fs.cruise) / (G * Math.tan(fs.cruiseBankDeg * DEG * 0.8));
    let alt = c.altFt * FT_TO_M * (0.94 + 0.12 * rng.next());
    const make = (x: number, z: number) => racetrack(x, z, axis, c.legM, radius, () => ({ alt, speed: fs.cruise }));
    const cx0 = range.x + d.x * dist, cz0 = range.z + d.z * dist;
    let path = clear(cx0, cz0, make);
    // High enough over the terrain under the whole orbit.
    const floor = pathMaxGround(path, ground) + fs.minAglM + 250;
    if (alt < floor) {
      alt = floor;
      path = clear(cx0, cz0, make);
    }
    const s0 = rng.next() * path.length;
    const lead = slots.length;
    const w = cfg.wingman;
    slots.push({ kind: 'fighter', group: `cap-${i + 1}`, path, s0, side: 0, trail: 0, leader: null, seed: (seed ^ (0x1000 + i * 7919)) >>> 0, bort: bort() });
    slots.push({ kind: 'fighter', group: `cap-${i + 1}`, path, s0: s0 - w.trailM, side: w.sideM, trail: w.trailM, leader: lead, seed: (seed ^ (0x2000 + i * 7919)) >>> 0, bort: bort() });
  });

  // ── Su-25 attack passes ──
  {
    const a = cfg.attack;
    const as = cfg.flight.attack;
    const ipB = a.ipBearingDeg + rng.sym(10);
    const ipD = dirOf(ipB);
    const ip = { x: range.x + ipD.x * a.ipDistanceM, z: range.z + ipD.z * a.ipDistanceM };
    // Run in from the IP toward the range, ending pullOffM short.
    const axis = ipB + 180;
    const f = dirOf(axis);
    const leg = a.ipDistanceM - a.pullOffM;
    // Pull off away from the airport: turn toward the side the airport is not on.
    const rightX = Math.cos(axis * DEG), rightZ = Math.sin(axis * DEG);
    const airportRight = (airport.x - range.x) * rightX + (airport.z - range.z) * rightZ > 0;
    const left = airportRight;
    const side = left ? -1 : 1;
    const mid = { x: ip.x + f.x * (leg / 2), z: ip.z + f.z * (leg / 2) };
    const cx = mid.x + rightX * side * a.turnRadiusM;
    const cz = mid.z + rightZ * side * a.turnRadiusM;
    const total = 2 * leg + 2 * Math.PI * a.turnRadiusM;
    const uLeg = leg / total;
    const pattern = Math.max(a.patternFt * FT_TO_M, ground(range.x, range.z) + 600);
    const runIn = ground(range.x, range.z) + a.runInAglFt * FT_TO_M;
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const profile = (u: number) => {
      if (u <= uLeg) {
        const k = smooth(0.2, 0.95, u / uLeg);
        return { alt: pattern + (runIn - pattern) * k, speed: as.cruise + 20 * k };
      }
      const k = smooth(0, 0.45, (u - uLeg) / (1 - uLeg));
      return { alt: runIn + (pattern - runIn) * k, speed: as.cruise - 10 };
    };
    const path = racetrack(cx, cz, axis, leg, a.turnRadiusM, profile, left, 50);
    const s0 = rng.next() * path.length;
    const lead = slots.length;
    slots.push({ kind: 'attack', group: 'attack', path, s0, side: 0, trail: 0, leader: null, seed: (seed ^ 0x3001) >>> 0, bort: bort() });
    slots.push({ kind: 'attack', group: 'attack', path, s0: s0 - a.trailM, side: 60, trail: a.trailM, leader: lead, seed: (seed ^ 0x3002) >>> 0, bort: bort() });
  }

  // ── Mi-24 circling low ──
  {
    const h = cfg.helo;
    const hs = cfg.flight.helo;
    const d = dirOf(h.bearingDeg + rng.sym(15));
    const cx0 = range.x + d.x * h.distanceM, cz0 = range.z + d.z * h.distanceM;
    const r = h.radiusM * (0.9 + 0.2 * rng.next());
    const p1 = clear(cx0, cz0, (x, z) => circlePath(x, z, r, h.aglFt[0] * FT_TO_M, hs.cruise));
    const cx = (p1.x[0] + p1.x[Math.floor(p1.x.length / 2)]) / 2;
    const cz = (p1.z[0] + p1.z[Math.floor(p1.z.length / 2)]) / 2;
    const p2 = circlePath(cx, cz, r, h.aglFt[1] * FT_TO_M, hs.cruise * 0.95);
    const s0 = rng.next() * p1.length;
    slots.push({ kind: 'helo', group: 'helo', path: p1, s0, side: 0, trail: 0, leader: null, seed: (seed ^ 0x4001) >>> 0, bort: bort() });
    slots.push({ kind: 'helo', group: 'helo', path: p2, s0: s0 + p2.length / 2, side: 0, trail: 0, leader: null, seed: (seed ^ 0x4002) >>> 0, bort: bort() });
  }
  return slots;
}

/** Start point (x, z, altitude MSL, heading) of a slot at along-path s. */
export function slotPoint(p: SlotPlan, s: number, ground: (x: number, z: number) => number): { x: number; y: number; z: number; heading: number; speed: number } {
  const q = samplePath(p.path, s, newPathSample());
  const x = q.x + Math.cos(q.heading) * p.side;
  const z = q.z + Math.sin(q.heading) * p.side;
  const y = p.path.agl ? ground(x, z) + q.alt : q.alt;
  return { x, y, z, heading: q.heading, speed: q.speed };
}
